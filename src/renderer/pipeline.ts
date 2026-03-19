import { createPersistentTexture }             from './texture';
import { downloadTexture }                      from '../utils/export';
import { serializeProject, deserializeProject,
         serializeLayeredPngs, downloadBytes }  from '../utils/project-format';
import { Command }                              from '../core/history-manager';
import { LayerManager, LayerState, BlendMode }  from './layer-manager';
import { BrushRenderer, DirtyRect }             from './brush-renderer';
import { CompositeRenderer }                    from './composite-renderer';
import { CheckpointManager, Checkpoint }        from './checkpoint-manager';
import { SelectionManager, SelectionMode }      from './selection-manager';
import { EffectsPipeline }                      from './effects-pipeline';

export { SelectionMode };

interface GPUTiming {
    querySet:    GPUQuerySet;
    queryBuffer: GPUBuffer;
    readBuffer:  GPUBuffer;
    pending:     boolean;
}

export class PaintPipeline {
    public  layerManager:      LayerManager;
    public  brushRenderer:     BrushRenderer;
    public  selectionManager:  SelectionManager;
    public  effectsPipeline:   EffectsPipeline;
    private compositeRenderer: CompositeRenderer;
    private checkpointManager: CheckpointManager;

    private overlayTexture:  GPUTexture;
    private backingTexture:  GPUTexture;
    private needsRedraw      = true;

    private frameDirtyRect:  DirtyRect | null = null;
    private prevOverlayRect: DirtyRect | null = null;

    public  lastGpuMs        = 0;
    private gpuTiming:       GPUTiming | null = null;

    public  currentBrushSize  = 0.05;
    /** Fill color [r,g,b,a] in 0–255 range, updated by app.setBrushColor(). */
    public  currentFillColor: [number, number, number, number] = [0, 0, 0, 255];

    get layers():           LayerState[] { return this.layerManager.layers;           }
    get activeLayerIndex(): number       { return this.layerManager.activeLayerIndex; }
    set activeLayerIndex(v: number)      { this.layerManager.activeLayerIndex = v;    }
    get device(): GPUDevice              { return this._device;                        }
    get format(): GPUTextureFormat       { return this._format;                        }

    constructor(
        private _device:      GPUDevice,
        private context:      GPUCanvasContext,
        private _format:      GPUTextureFormat,
        public  canvasWidth:  number,
        public  canvasHeight: number,
        supportsTimestamps    = false
    ) {
        this.layerManager      = new LayerManager(_device, _format, canvasWidth, canvasHeight);
        this.brushRenderer     = new BrushRenderer(_device, _format, canvasWidth, canvasHeight);
        this.compositeRenderer = new CompositeRenderer(_device, _format);
        this.checkpointManager = new CheckpointManager();
        this.selectionManager  = new SelectionManager(_device, _format, canvasWidth, canvasHeight);
        this.effectsPipeline   = new EffectsPipeline(_device);
        this.overlayTexture    = createPersistentTexture(_device, canvasWidth, canvasHeight, _format);

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
        this.overlayTexture = createPersistentTexture(this._device, physW, physH, this._format);

        this.brushRenderer.updateResolution(physW, physH);
        this.selectionManager.resize?.(physW, physH);
        this.checkpointManager.clear?.();

        this.frameDirtyRect = { x: 0, y: 0, width: physW, height: physH };
        this.needsRedraw    = true;
    }

    public applyBackground(pixels: Uint8Array | null, physW: number, physH: number): void {
        if (!pixels) return;
        const layer = this.layers[0]; if (!layer) return;
        const bpr = Math.ceil(physW * 4 / 256) * 256;
        let data  = pixels;
        if (bpr !== physW * 4) {
            data = new Uint8Array(bpr * physH);
            for (let r = 0; r < physH; r++)
                data.set(pixels.subarray(r * physW * 4, r * physW * 4 + physW * 4), r * bpr);
        }
        this._device.queue.writeTexture({ texture: layer.texture }, data, { bytesPerRow: bpr }, [physW, physH]);
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

    // ── Drawing ───────────────────────────────────────────────────────────────

    public draw(stamps: Float32Array): void {
        if (!stamps.length) return;
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

        if (this.gpuTiming && !this.gpuTiming.pending) {
            this.compositeWithTiming(this.backingTexture.createView(), scissor);
        } else {
            this.compositeRenderer.render(this.backingTexture.createView(), this.layers, this.overlayTexture, scissor);
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
            this.activeLayerIndex = cmd.layerIndex;
            const layer = this.layerManager.getActiveLayer();
            if (layer) {
                this.brushRenderer.setConfig({ blendMode: cmd.blendMode });
                this.expandDirtyRect(this.brushRenderer.draw(cmd.stamps, layer.texture));
                this.brushRenderer.setConfig({ blendMode: 'normal' });
            }
        } else if (cmd.type === 'selection') {
            // Selection was already applied directly by SelectionTool for immediate
            // visual feedback. applyCommand is only called for new commands (not
            // replay), so we skip double-applying here. syncMask() is already done
            // by the pipeline.setRectSelection/setLassoSelection/deselect calls
            // made by the tool. We just ensure dirty flag is set.
            this.expandDirtyRect(this.fullCanvasRect());
        } else if (cmd.type === 'cut') {
            // Cut was already applied to the GPU texture before pushing to history.
            // Just mark dirty to trigger recomposite.
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
        // Clear selection mask from brush renderer before replaying —
        // strokes recorded before a selection was made must not be clipped by it.
        this.brushRenderer.setMaskTexture(null);

        const cp = this.checkpointManager.findNearest(history.length);
        if (cp) {
            await this.checkpointManager.restore(cp, this.layerManager, this._device, this.canvasWidth, this.canvasHeight);
            for (const cmd of history.slice(cp.stackLength)) this.replayCommand(cmd);
        } else {
            this.layerManager.destroyAll();
            for (const cmd of history) this.replayCommand(cmd);
        }
        this.brushRenderer.setConfig({ blendMode: 'normal' });
        // Re-sync mask after replay — selection is preserved across undo/redo
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
        await downloadTexture(this._device, exp, 'artwork.png');
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
        } else if (cmd.type === 'stroke') {
            this.activeLayerIndex = cmd.layerIndex;
            const layer = this.layerManager.getActiveLayer();
            if (layer) {
                this.brushRenderer.setConfig({ blendMode: cmd.blendMode });
                this.brushRenderer.draw(cmd.stamps, layer.texture);
                this.brushRenderer.setConfig({ blendMode: 'normal' });
            }
        } else if (cmd.type === 'selection') {
            // Update selectionManager state only — syncMask() called after all commands replayed
            this.applySelectionCommand(cmd);
        } else if (cmd.type === 'cut') {
            const layer = this.layerManager.layers[cmd.layerIndex];
            if (layer) this.effectsPipeline.restoreTexture(layer.texture, cmd.pixels);
        } else if (cmd.type === 'paste') {
            const layer = this.layerManager.addLayer();
            layer.name  = 'Pasted Layer';
            this.effectsPipeline.restoreTexture(layer.texture, cmd.pixels);
        }
    }

    private applySelectionCommand(cmd: Extract<Command, { type: 'selection' }>): void {
        switch (cmd.operation) {
            case 'rect':
                this.selectionManager.setRect(cmd.x ?? 0, cmd.y ?? 0, cmd.w ?? 0, cmd.h ?? 0, cmd.selMode as any);
                break;
            case 'lasso':
                if (cmd.points && cmd.points.length >= 6)
                    this.selectionManager.setLasso(cmd.points, cmd.selMode as any);
                break;
            case 'selectAll':
                this.selectionManager.selectAll();
                break;
            case 'deselect':
                this.selectionManager.deselect();
                break;
            case 'invertSelection':
                this.selectionManager.invertSelection();
                break;
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

    private compositeWithTiming(targetView: GPUTextureView, scissor: DirtyRect | null): void {
        const t = this.gpuTiming!;
        this.compositeRenderer.render(targetView, this.layers, this.overlayTexture, scissor, t.querySet);
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
