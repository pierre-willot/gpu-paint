import { createPersistentTexture }             from './texture';
import { downloadTexture }                      from '../utils/export';
import { serializeProject, deserializeProject,
         serializeLayeredPngs, downloadBytes }  from '../utils/project-format';
import { Command }                              from '../core/history-manager';
import { LayerManager, LayerState, BlendMode }  from './layer-manager';
import { BrushRenderer, DirtyRect }             from './brush-renderer';
import { SmudgeRenderer }                       from './smudge-renderer';
import { CompositeRenderer }                    from './composite-renderer';
import { CheckpointManager, Checkpoint }        from './checkpoint-manager';
import { SelectionManager, SelectionMode }      from './selection-manager';
import { EffectsPipeline }                      from './effects-pipeline';
import { TransformPipeline, TransformState }    from './transform-pipeline';
import type { BrushDescriptor }                 from './brush-descriptor';

export { SelectionMode };
export type { TransformState };

interface GPUTiming {
    querySet:    GPUQuerySet;
    queryBuffer: GPUBuffer;
    readBuffer:  GPUBuffer;
    pending:     boolean;
}

export class PaintPipeline {
    public  layerManager:      LayerManager;
    public  brushRenderer:     BrushRenderer;
    public  smudgeRenderer:    SmudgeRenderer;
    public  selectionManager:  SelectionManager;
    public  effectsPipeline:   EffectsPipeline;
    private compositeRenderer: CompositeRenderer;
    private checkpointManager: CheckpointManager;

    private overlayTexture:  GPUTexture;
    private backingTexture:  GPUTexture;
    private needsRedraw      = true;

    // ── Transform mode state ─────────────────────────────────────────────────
    private transformPipelineInstance: TransformPipeline | null = null;
    private transformSourceTex:        GPUTexture | null        = null;
    private transformPreviewTex:       GPUTexture | null        = null;
    private transformHoleTex:          GPUTexture | null        = null;
    private _transformLayerIdx:        number                   = -1;
    public  get transformActive(): boolean { return this.transformPreviewTex !== null; }

    private frameDirtyRect:  DirtyRect | null = null;
    private prevOverlayRect: DirtyRect | null = null;

    public  lastGpuMs        = 0;
    private gpuTiming:       GPUTiming | null = null;

    public  currentBrushSize  = 0.05;
    /** Set by draw()/drawSmudge() — checked in app.ts to decide whether to push to history. */
    public hadPaintingSinceReset = false;
    public resetPaintingFlag(): void { this.hadPaintingSinceReset = false; }
    /** Fill color [r,g,b,a] in 0–255 range, updated by app.setBrushColor(). */
    public  currentFillColor: [number, number, number, number] = [0, 0, 0, 255];

    get layers():           LayerState[] { return this.layerManager.layers;           }
    get activeLayerIndex(): number       { return this.layerManager.activeLayerIndex; }
    set activeLayerIndex(v: number)      { this.layerManager.activeLayerIndex = v;    }
    get device(): GPUDevice              { return this._device;                        }
    get format(): GPUTextureFormat       { return this._format;                        }
    /** Format used for all layer/carry textures.
     *  rgba16float gives full float precision during brush accumulation;
     *  the composite shader encodes back to sRGB for the canvas output. */
    get layerFormat(): GPUTextureFormat  {
        // rgba16float requires 'texture-blend-half-float' for blend states on render attachments.
        // Fall back to the canvas format (bgra8unorm / rgba8unorm) when unsupported.
        return this._supportsBlendHalfFloat ? 'rgba16float' : this._format;
    }

    constructor(
        private _device:                GPUDevice,
        private context:                GPUCanvasContext,
        private _format:                GPUTextureFormat,
        public  canvasWidth:            number,
        public  canvasHeight:           number,
        supportsTimestamps              = false,
        private _supportsBlendHalfFloat = false,
    ) {
        const lf = this.layerFormat;
        this.layerManager      = new LayerManager(_device, lf, canvasWidth, canvasHeight);
        this.brushRenderer     = new BrushRenderer(_device, lf, canvasWidth, canvasHeight);
        this.smudgeRenderer    = new SmudgeRenderer(_device, lf, canvasWidth, canvasHeight);
        this.compositeRenderer = new CompositeRenderer(_device, _format);
        this.checkpointManager = new CheckpointManager();
        this.selectionManager  = new SelectionManager(_device, _format, canvasWidth, canvasHeight);
        this.effectsPipeline   = new EffectsPipeline(_device);
        this.overlayTexture    = createPersistentTexture(_device, canvasWidth, canvasHeight, lf);

        this.backingTexture = _device.createTexture({
            size:   [canvasWidth, canvasHeight],
            format: _format,
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING   |
                GPUTextureUsage.COPY_SRC          |
                GPUTextureUsage.COPY_DST
        });

        if (supportsTimestamps) this.initGPUTiming();
    }

    // ── D3: snapshot / restore for live effect preview ────────────────────────

    public async snapshotActiveLayer(): Promise<Uint8Array | null> {
        const layer = this.layerManager.getActiveLayer();
        if (!layer) return null;
        return this.effectsPipeline.snapshotTexture(layer.texture);
    }

    public restoreActiveLayer(snapshot: Uint8Array): void {
        const layer = this.layerManager.getActiveLayer();
        if (!layer) return;
        this.effectsPipeline.restoreTexture(layer.texture, snapshot);
        this.markDirty();
    }

    // ── Transform (C4) ───────────────────────────────────────────────────────

    /**
     * Enter transform mode. Stores `sourcePixels` (the content to transform)
     * in a GPU source texture, clears the live layer so the composite shows
     * only the transform preview, and renders the initial preview.
     *
     * @param holePixels  Optional — when transforming a selection, this is the
     *                    layer-minus-selection pixels to write to the live layer
     *                    (instead of clearing it completely to transparent).
     */
    public beginTransform(
        sourcePixels: Uint8Array,
        initialState: TransformState,
        holePixels?: Uint8Array,
    ): void {
        // Lazy-create the transform pipeline (needs format, created once).
        // Must use layerFormat so render targets match the layer texture format.
        if (!this.transformPipelineInstance) {
            this.transformPipelineInstance = new TransformPipeline(this._device, this.layerFormat);
        }
        this._transformLayerIdx = this.activeLayerIndex;

        // Source texture: stores the pre-transform pixel data in GPU memory.
        this.transformSourceTex = this._device.createTexture({
            size:   [this.canvasWidth, this.canvasHeight],
            format: this.layerFormat,
            usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        this.effectsPipeline.restoreTexture(this.transformSourceTex, sourcePixels);

        // Preview texture: the composite uses this instead of the live layer.
        // COPY_DST is required so the hole texture can be copied here each frame.
        this.transformPreviewTex = this._device.createTexture({
            size:   [this.canvasWidth, this.canvasHeight],
            format: this.layerFormat,
            usage:  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
                  | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });

        // Hole texture: unselected (or empty) background shown during transform.
        // Always clear the live layer — the preview texture merges hole + content.
        if (holePixels) {
            this.transformHoleTex = this._device.createTexture({
                size:   [this.canvasWidth, this.canvasHeight],
                format: this.layerFormat,
                usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
            });
            this.effectsPipeline.restoreTexture(this.transformHoleTex, holePixels);
        }
        this.layerManager.clearLayer(this._transformLayerIdx);

        // Render initial preview (with hole as background if present).
        const ar = this.canvasWidth / this.canvasHeight;
        this.transformPipelineInstance.render(
            this.transformSourceTex, this.transformPreviewTex, initialState, ar,
            this.transformHoleTex ?? undefined,
        );
        this.markDirty();
    }

    /** Update the transform — call on every pointer move while in transform mode. */
    public updateTransform(state: TransformState): void {
        if (!this.transformPipelineInstance || !this.transformSourceTex || !this.transformPreviewTex) return;
        const ar = this.canvasWidth / this.canvasHeight;
        this.transformPipelineInstance.render(
            this.transformSourceTex, this.transformPreviewTex, state, ar,
            this.transformHoleTex ?? undefined,
        );
        this.markDirty();
    }

    /**
     * Commit the current transform: copy preview → live layer.
     * Returns the after-pixels for history.
     */
    public async commitTransform(): Promise<Uint8Array> {
        if (!this.transformPreviewTex) return new Uint8Array();
        const layer = this.layerManager.layers[this._transformLayerIdx];
        if (layer) {
            const enc = this._device.createCommandEncoder();
            enc.copyTextureToTexture(
                { texture: this.transformPreviewTex },
                { texture: layer.texture },
                [this.canvasWidth, this.canvasHeight]
            );
            this._device.queue.submit([enc.finish()]);
            await this._device.queue.onSubmittedWorkDone();
        }
        const afterPixels = layer
            ? await this.effectsPipeline.snapshotTexture(layer.texture)
            : new Uint8Array();
        this._cleanupTransform();
        this.markDirty();
        return afterPixels;
    }

    /** Cancel transform: restore the original pixels to the live layer. */
    public cancelTransform(sourcePixels: Uint8Array): void {
        const layer = this.layerManager.layers[this._transformLayerIdx];
        if (layer) this.effectsPipeline.restoreTexture(layer.texture, sourcePixels);
        this._cleanupTransform();
        this.markDirty();
    }

    private _cleanupTransform(): void {
        this.transformSourceTex?.destroy();
        this.transformPreviewTex?.destroy();
        this.transformHoleTex?.destroy();
        this.transformSourceTex  = null;
        this.transformPreviewTex = null;
        this.transformHoleTex    = null;
        this._transformLayerIdx  = -1;
    }

    // ── Canvas resize (B11) ───────────────────────────────────────────────────

    public reconfigureContext(): void {
        this.context.configure({
            device:    this._device,
            format:    this._format,
            usage:     GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
            alphaMode: 'premultiplied'
        });
    }

    public resizeInternal(physW: number, physH: number, copyContent: boolean): void {
        const oldStates = this.layers.map(l => ({
            name: l.name, opacity: l.opacity, blendMode: l.blendMode,
            visible: l.visible, locked: l.locked, alphaLock: l.alphaLock,
            texture: l.texture, oldW: l.texture.width, oldH: l.texture.height,
        }));
        const oldActive = Math.min(this.activeLayerIndex, oldStates.length - 1);

        this.layerManager.layers           = [];
        this.layerManager.activeLayerIndex = 0;
        this.layerManager.width            = physW;
        this.layerManager.height           = physH;

        for (const old of oldStates) {
            const layer = this.layerManager.addLayer();
            layer.name = old.name; layer.opacity = old.opacity;
            layer.blendMode = old.blendMode; layer.visible = old.visible;
            layer.locked = old.locked; layer.alphaLock = old.alphaLock;

            if (copyContent && old.texture) {
                const cw = Math.min(old.oldW, physW), ch = Math.min(old.oldH, physH);
                if (cw > 0 && ch > 0) {
                    const enc = this._device.createCommandEncoder();
                    enc.copyTextureToTexture({ texture: old.texture }, { texture: layer.texture }, [cw, ch]);
                    this._device.queue.submit([enc.finish()]);
                }
            }
            old.texture?.destroy();
        }

        if (!this.layers.length) this.layerManager.addLayer();
        this.activeLayerIndex = Math.min(oldActive, this.layers.length - 1);

        this.backingTexture.destroy();
        this.overlayTexture.destroy();
        this.canvasWidth  = physW;
        this.canvasHeight = physH;

        this.backingTexture = this._device.createTexture({
            size: [physW, physH], format: this._format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING |
                   GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
        });
        this.overlayTexture = createPersistentTexture(this._device, physW, physH, this.layerFormat);

        this.brushRenderer.updateResolution(physW, physH);
        this.smudgeRenderer.updateResolution(physW, physH);
        this.selectionManager.resize?.(physW, physH);
        this.checkpointManager.clear?.();

        this.frameDirtyRect = { x: 0, y: 0, width: physW, height: physH };
        this.needsRedraw    = true;
    }

    public applyBackground(pixels: Uint8Array | null, physW: number, physH: number): void {
        if (!pixels) return;
        const layer = this.layers[0]; if (!layer) return;
        // restoreTexture handles both bgra8unorm (pad rows) and rgba16float (encode f16)
        this.effectsPipeline.restoreTexture(layer.texture, pixels);
        this.markDirty();
    }

    // ── Selection ─────────────────────────────────────────────────────────────

    public selectAll(): void       { this.selectionManager.selectAll();      this.syncMask(); this.markDirty(); }
    public deselect(): void        { this.selectionManager.deselect();       this.syncMask(); this.markDirty(); }
    public invertSelection(): void { this.selectionManager.invertSelection(); this.syncMask(); this.markDirty(); }

    public setRectSelection(x: number, y: number, w: number, h: number, mode: SelectionMode = 'replace'): void {
        this.selectionManager.setRect(x, y, w, h, mode); this.syncMask(); this.markDirty();
    }
    public setLassoSelection(points: number[], mode: SelectionMode = 'replace'): void {
        this.selectionManager.setLasso(points, mode); this.syncMask(); this.markDirty();
    }
    public get hasSelection(): boolean { return this.selectionManager.hasMask; }

    private syncMask(): void {
        const tex = this.selectionManager.hasMask ? this.selectionManager.getMaskTexture() : null;
        this.brushRenderer.setMaskTexture(tex);
    }

    // ── Direct undo / redo (pixel-based — no replay needed) ──────────────────

    public async directUndoCommand(cmd: Command): Promise<void> {
        if (cmd.type === 'stroke' || cmd.type === 'smudge' || cmd.type === 'cut' || cmd.type === 'transform') {
            this.activeLayerIndex = cmd.layerIndex;
            const layer = this.layerManager.layers[cmd.layerIndex];
            if (layer) this.effectsPipeline.restoreTexture(layer.texture, cmd.beforePixels);
        } else if (cmd.type === 'selection') {
            const snapshot = cmd.beforeMask
                ? { data: cmd.beforeMask, hasMask: true }
                : { data: new Uint8Array(this.selectionManager.getMaskData().length), hasMask: false };
            this.selectionManager.restoreFromSnapshot(snapshot);
            this.syncMask();
        }
        this.markDirty();
    }

    public async directRedoCommand(cmd: Command): Promise<void> {
        if (cmd.type === 'stroke' || cmd.type === 'smudge' || cmd.type === 'cut' || cmd.type === 'transform') {
            this.activeLayerIndex = cmd.layerIndex;
            const layer = this.layerManager.layers[cmd.layerIndex];
            if (layer) this.effectsPipeline.restoreTexture(layer.texture, cmd.afterPixels);
        } else if (cmd.type === 'selection') {
            const snapshot = cmd.afterMask
                ? { data: cmd.afterMask, hasMask: true }
                : { data: new Uint8Array(this.selectionManager.getMaskData().length), hasMask: false };
            this.selectionManager.restoreFromSnapshot(snapshot);
            this.syncMask();
        }
        this.markDirty();
    }

    // ── Effects ───────────────────────────────────────────────────────────────

    public async applyGaussianBlur(radius: number): Promise<void> {
        const layer = this.layerManager.getActiveLayer(); if (!layer) return;
        await this.effectsPipeline.gaussianBlur(layer.texture, radius);
        this.markDirty();
    }

    public async applyHueSaturation(h: number, s: number, l: number): Promise<void> {
        const layer = this.layerManager.getActiveLayer(); if (!layer) return;
        await this.effectsPipeline.hueSaturation(layer.texture, h, s, l);
        this.markDirty();
    }

    // ── Eyedropper ────────────────────────────────────────────────────────────

    public async sampleColor(nx: number, ny: number): Promise<[number,number,number,number] | null> {
        const px  = Math.floor(Math.max(0, Math.min(1 - 1e-6, nx)) * this.canvasWidth);
        const py  = Math.floor(Math.max(0, Math.min(1 - 1e-6, ny)) * this.canvasHeight);
        const buf = this._device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = this._device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture: this.backingTexture, origin: [px, py, 0] }, { buffer: buf, bytesPerRow: 256 }, [1, 1]);
        this._device.queue.submit([enc.finish()]);
        await buf.mapAsync(GPUMapMode.READ);
        const d = new Uint8Array(buf.getMappedRange());
        const [b0, b1, b2, b3] = [d[0], d[1], d[2], d[3]];
        buf.unmap(); buf.destroy();
        return this._format === 'bgra8unorm'
            ? [b2/255, b1/255, b0/255, b3/255]
            : [b0/255, b1/255, b2/255, b3/255];
    }

    // ── Autosave ──────────────────────────────────────────────────────────────

    public setCheckpointCallback(cb: (cp: Checkpoint) => Promise<void>): void { this.checkpointManager.onCheckpointSaved = cb; }
    public loadCheckpointsFromPersisted(cp: Checkpoint[]): void { this.checkpointManager.loadFromPersisted(cp); }

    public createCheckpointIfNeeded(len: number): void {
        this.checkpointManager.save(len, this.layers, this._device, this.canvasWidth, this.canvasHeight, this.activeLayerIndex)
            .catch(err => console.warn('[Pipeline] Checkpoint failed:', err));
    }
    public handleCommandDropped(): void           { this.checkpointManager.shiftDown();   }
    public handleRedoInvalidated(l: number): void { this.checkpointManager.pruneAbove(l); }

    // ── Smudge ────────────────────────────────────────────────────────────────

    /** Seeds the wet-brush carry texture from the active layer. Call at stroke start. */
    public beginSmudgeStroke(): void {
        const layer = this.layerManager.getActiveLayer();
        if (!layer) return;
        this.smudgeRenderer.beginStroke(layer.texture);
    }

    /** Two-pass GPU wet-brush render (wet_mix + deposit). Call from UnifiedBrushTool.drawToLayer. */
    public drawSmudge(stamps: Float32Array, descriptor: BrushDescriptor): void {
        if (!stamps.length) return;
        this.hadPaintingSinceReset = true;
        const layer = this.layerManager.getActiveLayer();
        if (!layer) return;
        const maskTex = this.selectionManager.hasMask ? this.selectionManager.getMaskTexture() : null;
        const rect    = this.smudgeRenderer.draw(
            stamps, layer.texture, maskTex,
            descriptor.smudge,         // pull
            descriptor.smudgeCharge,   // charge
            descriptor.smudgeDilution, // dilution
            descriptor.hardness,
            descriptor.color,          // user_color
        );
        this.expandDirtyRect(rect);
        this.needsRedraw = true;
    }

    // ── Drawing ───────────────────────────────────────────────────────────────

    public draw(stamps: Float32Array): void {
        if (!stamps.length) return;
        this.hadPaintingSinceReset = true;
        const layer = this.layerManager.getActiveLayer(); if (!layer) return;
        const rect  = this.brushRenderer.draw(stamps, layer.texture);
        this.expandDirtyRect(rect);
        this.needsRedraw = true;
    }

    public drawPrediction(stamps: Float32Array, toolIsActive: boolean): void {
        if (!toolIsActive && !stamps.length) {
            if (this.prevOverlayRect) {
                this.expandDirtyRect(this.prevOverlayRect);
                this.prevOverlayRect = null;
                this.needsRedraw = true;
            }
            return;
        }
        this.layerManager.clearTexture(this.overlayTexture);
        if (this.prevOverlayRect) this.expandDirtyRect(this.prevOverlayRect);
        if (stamps.length) {
            const rect = this.brushRenderer.draw(stamps, this.overlayTexture);
            this.expandDirtyRect(rect);
            this.prevOverlayRect = rect;
            this.needsRedraw = true;
        } else {
            this.prevOverlayRect = null;
        }
    }

    // ── Compositing ───────────────────────────────────────────────────────────

    public composite(): void {
        // Marching ants need a redraw every frame when selection is active
        if (this.selectionManager.hasMask) this.needsRedraw = true;

        if (!this.needsRedraw) return;
        this.needsRedraw = false;

        const cur = this.context.getCurrentTexture(); if (!cur) return;
        const scissor = this.frameDirtyRect; this.frameDirtyRect = null;

        const texOverride = this.transformPreviewTex
            ? { layerIndex: this._transformLayerIdx, texture: this.transformPreviewTex }
            : null;

        if (this.gpuTiming && !this.gpuTiming.pending) {
            this.compositeWithTiming(this.backingTexture.createView(), scissor, texOverride);
        } else {
            this.compositeRenderer.render(this.backingTexture.createView(), this.layers, this.overlayTexture, scissor, undefined, texOverride);
        }

        if (this.selectionManager.hasMask) {
            this.selectionManager.renderOverlay(this.backingTexture.createView(), performance.now());
        }

        const enc = this._device.createCommandEncoder();
        enc.copyTextureToTexture({ texture: this.backingTexture }, { texture: cur }, [this.canvasWidth, this.canvasHeight]);
        this._device.queue.submit([enc.finish()]);
    }

    public markDirty(): void {
        this.needsRedraw = true;
        this.expandDirtyRect(this.fullCanvasRect());
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    public applyCommand(cmd: Command): void {
        if (cmd.type === 'add-layer') {
            this.layerManager.addLayer();
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'delete-layer') {
            this.layerManager.removeLayer(cmd.layerIndex);
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'stroke') {
            // Stroke was already painted live to the GPU texture during the stroke.
            // applyCommand is a no-op — just update active layer and mark dirty.
            this.activeLayerIndex = cmd.layerIndex;
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'selection') {
            // Selection was already applied directly by SelectionTool for immediate
            // visual feedback. applyCommand is only called for new commands (not
            // replay), so we skip double-applying here. syncMask() is already done
            // by the pipeline.setRectSelection/setLassoSelection/deselect calls
            // made by the tool. We just ensure dirty flag is set.
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'smudge') {
            // Smudge already applied live. applyCommand = no-op except dirty flag.
            this.activeLayerIndex = cmd.layerIndex;
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'transform') {
            // Transform committed live. applyCommand = no-op.
            this.activeLayerIndex = cmd.layerIndex;
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'cut') {
            // Cut already applied live. applyCommand = no-op except dirty flag.
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'paste') {
            const layer = this.layerManager.addLayer();
            layer.name  = 'Pasted Layer';
            this.effectsPipeline.restoreTexture(layer.texture, cmd.pixels);
            this.expandDirtyRect(this.fullCanvasRect());
        }
        this.needsRedraw = true;
    }

    public async reconstructFromHistory(history: Command[]): Promise<void> {
        // Clear stale selection state before reconstruction.
        this.selectionManager.restoreFromSnapshot({ data: new Uint8Array(this.selectionManager.getMaskData().length), hasMask: false });
        this.brushRenderer.setMaskTexture(null);

        const cp = this.checkpointManager.findNearest(history.length);
        if (cp) {
            await this.checkpointManager.restore(cp, this.layerManager, this._device, this.canvasWidth, this.canvasHeight);
            for (let i = 0; i < history.length; i++) {
                const cmd = history[i];
                if (cmd.type === 'selection') {
                    // Selection commands are always replayed in order — they're cheap
                    // and not baked into checkpoints.
                    this.replayCommand(cmd);
                } else if (i >= cp.stackLength) {
                    // Post-checkpoint non-selection commands: restore their after-pixels.
                    this.replayCommand(cmd);
                }
                // Pre-checkpoint non-selection commands: skip (pixels baked into checkpoint).
            }
        } else {
            this.layerManager.destroyAll();
            for (const cmd of history) this.replayCommand(cmd);
        }

        this.brushRenderer.setConfig({ blendMode: 'normal' });
        this.syncMask();
        if (!this.layers.length) this.layerManager.addLayer();
        this.activeLayerIndex = Math.min(this.activeLayerIndex, this.layers.length - 1);
        this.frameDirtyRect   = this.fullCanvasRect();
        this.needsRedraw      = true;
    }

    // ── Layer proxies ─────────────────────────────────────────────────────────

    public setLayerOpacity(i: number, v: number): void      { this.layerManager.setOpacity(i, v);    this.markDirty(); }
    public setLayerBlendMode(i: number, m: BlendMode): void  { this.layerManager.setBlendMode(i, m);  this.markDirty(); }
    public setLayerVisible(i: number, v: boolean): void      { this.layerManager.setVisible(i, v);    this.markDirty(); }
    public setLayerName(i: number, n: string): void          { this.layerManager.setName(i, n);                        }
    public setLayerLock(i: number, v: boolean): void         { this.layerManager.setLocked(i, v);                      }
    public setLayerAlphaLock(i: number, v: boolean): void    { this.layerManager.setAlphaLock(i, v);                   }
    public reorderLayer(f: number, t: number): void          { this.layerManager.reorderLayer(f, t);  this.markDirty(); }

    // ── Utilities ─────────────────────────────────────────────────────────────

    public clear(): void {
        this.layerManager.clearLayer(this.activeLayerIndex); this.markDirty();
    }

    public updateUniforms(w: number, h: number, size: number): void {
        this.currentBrushSize = size;
        this.canvasWidth = w; this.canvasHeight = h;
        this.brushRenderer.updateResolution(w, h);
        this.markDirty();
    }

    public async saveImage(): Promise<void> {
        const exp = createPersistentTexture(this._device, this.canvasWidth, this.canvasHeight, this._format);
        const ov  = createPersistentTexture(this._device, this.canvasWidth, this.canvasHeight, this._format);
        this.layerManager.clearTexture(ov);
        this.compositeRenderer.render(exp.createView(), this.layers, ov, null);
        await downloadTexture(this._device, exp, 'artwork.png', this._format);
        exp.destroy(); ov.destroy();
    }

    public async saveProject(filename = 'artwork.gpaint'): Promise<void> {
        downloadBytes(await serializeProject(
            this._device, this.layers, this.activeLayerIndex,
            this.canvasWidth, this.canvasHeight, this._format
        ), filename);
    }

    public async loadProject(zipBytes: Uint8Array): Promise<void> {
        const { manifest, bitmaps } = await deserializeProject(zipBytes);
        this.layerManager.destroyAll();
        this.selectionManager.deselect(); this.syncMask();

        for (let i = 0; i < manifest.layers.length; i++) {
            const meta  = manifest.layers[i];
            const layer = this.layerManager.addLayer();
            await this.bitmapToTexture(bitmaps[i], layer.texture);
            bitmaps[i].close();
            layer.name = meta.name; layer.opacity = meta.opacity;
            layer.blendMode = meta.blendMode as BlendMode; layer.visible = meta.visible;
        }
        this.activeLayerIndex = Math.min(manifest.activeLayerIndex, this.layers.length - 1);
        this.frameDirtyRect   = this.fullCanvasRect();
        this.needsRedraw      = true;
    }

    public async exportLayersZip(filename = 'layers.zip'): Promise<void> {
        downloadBytes(await serializeLayeredPngs(
            this._device, this.layers, this.canvasWidth, this.canvasHeight, this._format
        ), filename);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private replayCommand(cmd: Command): void {
        if (cmd.type === 'add-layer') {
            this.layerManager.addLayer();
        } else if (cmd.type === 'delete-layer') {
            this.layerManager.removeLayer(cmd.layerIndex);
        } else if (cmd.type === 'stroke' || cmd.type === 'smudge' || cmd.type === 'cut' || cmd.type === 'transform') {
            // Pixel-based commands: restore the post-operation snapshot directly.
            this.activeLayerIndex = cmd.layerIndex;
            const layer = this.layerManager.layers[cmd.layerIndex];
            if (layer) this.effectsPipeline.restoreTexture(layer.texture, cmd.afterPixels);
        } else if (cmd.type === 'selection') {
            // Restore selection mask state then sync to brush renderer.
            const snapshot = cmd.afterMask
                ? { data: cmd.afterMask, hasMask: true }
                : { data: new Uint8Array(this.selectionManager.getMaskData().length), hasMask: false };
            this.selectionManager.restoreFromSnapshot(snapshot);
            this.syncMask();
        } else if (cmd.type === 'paste') {
            const layer = this.layerManager.addLayer();
            layer.name  = 'Pasted Layer';
            this.effectsPipeline.restoreTexture(layer.texture, cmd.pixels);
        }
    }

    private async bitmapToTexture(bitmap: ImageBitmap, texture: GPUTexture): Promise<void> {
        this._device.queue.copyExternalImageToTexture(
            { source: bitmap }, { texture, premultipliedAlpha: true },
            [Math.min(bitmap.width, texture.width), Math.min(bitmap.height, texture.height)]
        );
        await this._device.queue.onSubmittedWorkDone();
    }

    private expandDirtyRect(rect: DirtyRect | null): void {
        if (!rect) return;
        if (!this.frameDirtyRect) { this.frameDirtyRect = { ...rect }; return; }
        if (!this.frameDirtyRect.x && !this.frameDirtyRect.y &&
            this.frameDirtyRect.width === this.canvasWidth &&
            this.frameDirtyRect.height === this.canvasHeight) return;
        const x1 = Math.min(this.frameDirtyRect.x, rect.x);
        const y1 = Math.min(this.frameDirtyRect.y, rect.y);
        const x2 = Math.max(this.frameDirtyRect.x + this.frameDirtyRect.width,  rect.x + rect.width);
        const y2 = Math.max(this.frameDirtyRect.y + this.frameDirtyRect.height, rect.y + rect.height);
        this.frameDirtyRect = { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
    }

    private fullCanvasRect(): DirtyRect {
        return { x: 0, y: 0, width: this.canvasWidth, height: this.canvasHeight };
    }

    private initGPUTiming(): void {
        const querySet    = this._device.createQuerySet({ type: 'timestamp', count: 2 });
        const queryBuffer = this._device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
        const readBuffer  = this._device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST    | GPUBufferUsage.MAP_READ  });
        this.gpuTiming    = { querySet, queryBuffer, readBuffer, pending: false };
    }

    private compositeWithTiming(targetView: GPUTextureView, scissor: DirtyRect | null, texOverride?: { layerIndex: number; texture: GPUTexture } | null): void {
        const t = this.gpuTiming!;
        this.compositeRenderer.render(targetView, this.layers, this.overlayTexture, scissor, t.querySet, texOverride);
        const enc = this._device.createCommandEncoder();
        enc.resolveQuerySet(t.querySet, 0, 2, t.queryBuffer, 0);
        enc.copyBufferToBuffer(t.queryBuffer, 0, t.readBuffer, 0, 16);
        this._device.queue.submit([enc.finish()]);
        t.pending = true;
        t.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const data = new BigInt64Array(t.readBuffer.getMappedRange());
            this.lastGpuMs = Number(data[1] - data[0]) / 1_000_000;
            t.readBuffer.unmap(); t.pending = false;
        }).catch(() => { t.pending = false; });
    }
}
