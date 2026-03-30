import { PaintPipeline, TransformState }           from '../renderer/pipeline';
import { HistoryManager }                          from './history-manager';
import { NavigationManager }                       from '../input/navigation';
import { setupPointer }                            from '../input/pointer';
import { Tool }                                    from './tool';
import { UnifiedBrushTool }                        from './tools/unified-brush-tool';
import { EraserTool }                              from './tools/eraser-tool';
import { EyedropperTool }                          from './tools/eyedropper-tool';
import { FillTool }                                from './tools/fill-tool';
import { SelectionTool }                           from './tools/selection-tool';
import { TransformTool }                           from './tools/transform-tool';
import { TransformOverlay }                        from '../ui/overlays/transform-overlay';
import { EventBus }                                from './event-bus';
import { AutosaveManager, recordToCommand, recordToCheckpoint } from './autosave-manager';
import { PressureCurve, PRESSURE_PRESETS }         from '../renderer/pressure-curve';
import { BrushCursor }                             from '../ui/overlays/brush-cursor';
import { generateBackground, CanvasSizeOptions }   from '../ui/panels/canvas-size-dialog';

const IDLE_CLEAR_FRAMES   = 10;
const PALM_AREA_THRESHOLD = 400;
const HEADER_H            = 52;
const MAX_DPR             = 2;

interface QueuedMove { x: number; y: number; pressure: number; tiltX: number; tiltY: number; }

export class PaintApp {
    public  pipeline:       PaintPipeline;
    public  history:        HistoryManager;
    public  nav:            NavigationManager;
    public  readonly bus    = new EventBus();
    public  autosave!:      AutosaveManager;

    private _activeTool:    Tool;
    public  brushTool:      UnifiedBrushTool;
    public  eraserTool:     EraserTool;
    public  eyedropperTool: EyedropperTool;
    public  fillTool:       FillTool;
    public  selectionTool:  SelectionTool;

    private brushCursor:    BrushCursor | null = null;
    private clipboard:      { pixels: Uint8Array } | null = null;

    public  transformTool:    TransformTool;
    private transformOverlay: TransformOverlay;
    private _transformBeforePixels:    Uint8Array | null = null;
    private _transformHadSelection: boolean           = false;

    private lastFrameTime   = 0;
    private lastFrameDelta  = 16.6;
    private idleFrameCount  = 0;
    private readonly budgetMs: number;
    private fpsCounter      = document.getElementById('fpsCounter');
    private fpsFrameCount   = 0;
    private fpsAccMs        = 0;

    private pointerMoveQueue: QueuedMove[] = [];
    private isPointerDown              = false;
    private activePointerId:  number | null = null;
    private _hadSelectionAtPointerDown = false;
    private _strokeBeforePixelsPromise: Promise<Uint8Array> | null = null;
    private _selectionBeforeMask: { data: Uint8Array; hasMask: boolean } | null = null;

    private pressureCurve:  PressureCurve;
    private _pickupTexture: GPUTexture | null = null;
    private renderErrorCount  = 0;
    private renderLoopStopped = false;
    private readonly MAX_RENDER_ERRORS = 3;

    constructor(
        private canvas:     HTMLCanvasElement,
        device:             GPUDevice,
        context:            GPUCanvasContext,
        format:             GPUTextureFormat,
        private canvasSize:         { width: number; height: number },
        supportsTimestamps          = false,
        fps                         = 60,
        supportsBlendHalfFloat      = false,
    ) {
        this.budgetMs      = (1000 / fps) * 0.85;
        this.pressureCurve = new PressureCurve(PRESSURE_PRESETS.natural);

        this.pipeline = new PaintPipeline(device, context, format, canvas.width, canvas.height, supportsTimestamps, supportsBlendHalfFloat);
        this.nav      = new NavigationManager(canvas, () => this.updateCanvasTransform());

        this.history = new HistoryManager(
            async cmd  => { this.pipeline.applyCommand(cmd); this.pipeline.markDirty(); this.emitStateChange(); },
            async log  => { await this.pipeline.reconstructFromHistory(log); this.pipeline.markDirty(); this.emitStateChange(); },
            async cmd  => { await this.pipeline.directUndoCommand(cmd); this.emitStateChange(); },
            async cmd  => { await this.pipeline.directRedoCommand(cmd); this.emitStateChange(); },
            {
                onCheckpointNeeded:     len => this.pipeline.createCheckpointIfNeeded(len),
                onOldestCommandDropped: ()  => { this.pipeline.handleCommandDropped();      this.autosave?.onCommandDropped();  },
                onRedoInvalidated:      len => { this.pipeline.handleRedoInvalidated(len); this.autosave?.onRedoInvalidated(); },
                onCommandAppended:      cmd => this.autosave?.onCommandAppended(cmd),
                onCommandUndone:        ()  => this.autosave?.onCommandUndone(),
                onCommandRedone:        ()  => this.autosave?.onCommandRedone(),
            }
        );

        this.brushTool      = new UnifiedBrushTool();
        this.eraserTool     = new EraserTool();
        this.eyedropperTool = new EyedropperTool(this.pipeline, this.bus);
        this.fillTool       = new FillTool();
        this.selectionTool  = new SelectionTool(canvas);

        this.selectionTool.screenToCanvas = (cx, cy) => this.translatePoint(cx, cy);
        this.selectionTool.canvasToScreen = (nx, ny)  => this.canvasToScreen(nx, ny);

        // Wire selection → history so undo/redo works for selections
        this.selectionTool.onSelectionMade = (op) => {
            const isDeselect = op.operation === 'rect' && (op.w ?? 1) < 0.001;
            if (isDeselect && !this._hadSelectionAtPointerDown) {
                // Tapping on an empty canvas — nothing changed, skip pushing to history.
                return;
            }
            const beforeMask = this._selectionBeforeMask;
            this._selectionBeforeMask = null;
            const afterSnapshot = this.pipeline.selectionManager.getMaskSnapshot();
            this.history.execute({
                type:       'selection',
                label:      'Selection',
                operation:  isDeselect ? 'deselect' : op.operation,
                beforeMask: beforeMask?.hasMask ? beforeMask.data : null,
                afterMask:  afterSnapshot.hasMask ? afterSnapshot.data : null,
                maskWidth:  this.pipeline.canvasWidth,
                maskHeight: this.pipeline.canvasHeight,
                timestamp:  this.history.now(),
            });
        };

        this._activeTool = this.brushTool;

        // ── Transform tool & overlay ───────────────────────────────────────────
        this.transformTool    = new TransformTool();
        this.transformOverlay = new TransformOverlay(
            this.transformTool,
            () => this.commitTransform(),
            () => this.cancelTransform()
        );
        this.transformOverlay.canvasToScreen = (nx, ny) => this.canvasToScreen(nx, ny);
        this.transformOverlay.screenToCanvas = (cx, cy) => this.translatePoint(cx, cy);

        // Redraw overlay whenever the transform state changes (GPU update + handles).
        this.transformTool.onTransformChange = (state) => {
            this.pipeline.updateTransform(state);
            this.transformOverlay.draw();
        };

        this.pushPressureLUT();
        this.setupInputs();
    }

    /** Virtual tool name — returns 'SmudgeTool'/'BrushTool' for UnifiedBrushTool based on mode. */
    public get activeToolName(): string {
        if (this._activeTool === this.brushTool) return this.brushTool.toolName;
        return this._activeTool.constructor.name;
    }
    public get activeTool():       Tool             { return this._activeTool; }
    public get activeBrushTool():  UnifiedBrushTool { return this.brushTool; }
    /** Backwards-compat getter — smudge mode is now a mode of brushTool, not a separate instance. */
    public get smudgeTool():       UnifiedBrushTool { return this.brushTool; }

    /** Switch to paint mode and activate brushTool. */
    public usePaintMode(): void {
        this.brushTool.mode = 'paint';
        this.setTool(this.brushTool);
    }

    /** Switch to smudge mode and activate brushTool. Auto-initialises pull to 0.8 on first use. */
    public useSmudgeMode(): void {
        if (this.brushTool.getDescriptor().smudge === 0) {
            this.brushTool.getDescriptor().smudge = 0.8;
        }
        this.brushTool.mode = 'smudge';
        this.setTool(this.brushTool);
    }

    // ── Brush cursor ──────────────────────────────────────────────────────────

    public initBrushCursor(): void {
        this.brushCursor = new BrushCursor(
            this.canvas,
            () => this.canvasSize.width * this.nav.state.zoom
        );
        this.brushCursor.setSize(this.brushTool.getDescriptor().size);
        this.brushCursor.show();
    }

    public setBrushTipBitmap(bmp: ImageBitmap | null): void {
        this.brushCursor?.setTipBitmap(bmp);
    }

    public setBrushTiltActive(v: boolean): void {
        this.brushCursor?.setTiltActive(v);
    }

    public setBrushSizePressureActive(v: boolean): void {
        this.brushCursor?.setSizePressureActive(v);
    }

    // ── Autosave ──────────────────────────────────────────────────────────────

    public connectAutosave(manager: AutosaveManager): void {
        this.autosave = manager;
        this.pipeline.setCheckpointCallback(cp => manager.onCheckpointCreated(cp));
        manager.start();
    }

    // ── Session restore ───────────────────────────────────────────────────────

    public async restoreSession(
        sessionData: Awaited<ReturnType<AutosaveManager['loadSessionData']>>
    ): Promise<void> {
        if (!sessionData) return;
        const { meta, commands: records, checkpoints: cpRecords } = sessionData;
        const checkpoints = cpRecords
            .map(r => recordToCheckpoint(r, meta.checkpointStackOffset))
            .filter(cp => cp.stackLength > 0);
        this.pipeline.loadCheckpointsFromPersisted(checkpoints);
        const commands = records.map(recordToCommand);
        this.history.restoreUndoStack(commands);
        await this.pipeline.reconstructFromHistory(commands);
        this.pipeline.markDirty();
        const seqStack = records.map(r => r.seq);
        this.autosave.restoreState(seqStack, Math.max(...seqStack, -1) + 1);
        this.emitStateChange();
    }

    // ── Project ───────────────────────────────────────────────────────────────

    public async openProject(bytes: ArrayBuffer): Promise<void> {
        await this.pipeline.loadProject(new Uint8Array(bytes));
        this.history.restoreUndoStack([]);
        await this.autosave?.clearSession();
        this.pipeline.markDirty();
        this.emitStateChange();
    }
    public async saveProject(f?: string): Promise<void>     { await this.pipeline.saveProject(f);     }
    public async exportLayersZip(f?: string): Promise<void> { await this.pipeline.exportLayersZip(f); }

    // ── Init ─────────────────────────────────────────────────────────────────

    public async init(): Promise<void> {
        await this.history.execute({ type: 'add-layer', label: 'Initial Layer', layerIndex: 0, timestamp: this.history.now() });
        this.updateCanvasTransform();
        this.renderLoop(performance.now());
    }

    // ── Canvas size (B11) ─────────────────────────────────────────────────────

    public async newCanvas(opts: CanvasSizeOptions): Promise<void> {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const physW = opts.width * dpr, physH = opts.height * dpr;
        this.canvas.width = physW; this.canvas.height = physH;
        this.pipeline.reconfigureContext();
        this.pipeline.resizeInternal(physW, physH, false);
        this.pipeline.applyBackground(generateBackground(physW, physH, opts.bgType, opts.bgColor, opts.noise), physW, physH);
        this.canvasSize = { width: opts.width, height: opts.height };
        this.history.restoreUndoStack([]);
        await this.autosave?.clearSession();
        await this.history.execute({ type: 'add-layer', label: 'Initial Layer', layerIndex: 0, timestamp: this.history.now() });
        this.nav.fitToScreen(opts.width, opts.height);
        this.pipeline.updateUniforms(physW, physH, this.pipeline.currentBrushSize);
        this.brushCursor?.setSize(this.brushTool.getDescriptor().size);
        const stack = document.getElementById('canvasStack');
        if (stack) { stack.style.width = opts.width + 'px'; stack.style.height = opts.height + 'px'; }
        this.emitStateChange();
    }

    public async resizeCanvas(opts: CanvasSizeOptions): Promise<void> {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const physW = opts.width * dpr, physH = opts.height * dpr;
        this.canvas.width = physW; this.canvas.height = physH;
        this.pipeline.reconfigureContext();
        this.pipeline.resizeInternal(physW, physH, true);
        this.canvasSize = { width: opts.width, height: opts.height };
        this.history.restoreUndoStack([]);
        await this.autosave?.clearSession();
        this.nav.fitToScreen(opts.width, opts.height);
        this.pipeline.updateUniforms(physW, physH, this.pipeline.currentBrushSize);
        this.brushCursor?.setSize(this.brushTool.getDescriptor().size);
        const stack = document.getElementById('canvasStack');
        if (stack) { stack.style.width = opts.width + 'px'; stack.style.height = opts.height + 'px'; }
        this.emitStateChange();
    }

    // ── Tool management ───────────────────────────────────────────────────────

    public setTool(tool: Tool): void {
        this._activeTool.reset(this.pipeline);
        this._activeTool = tool;

        const isBrushLike = tool === this.brushTool || tool === this.eraserTool;
        this.brushCursor?.setVisible(isBrushLike);
        // Emit virtual name so isSmudge()/isBrush() checks in UI continue to work.
        this.bus.emit('tool:change', { tool: this.activeToolName });
        this.canvas.style.cursor =
            isBrushLike                  ? 'none'
          : tool === this.eyedropperTool ? 'crosshair'
          : tool === this.fillTool       ? 'cell'
          : tool === this.selectionTool  ? 'crosshair'
          : 'default';
    }

    // ── Pressure ──────────────────────────────────────────────────────────────

    public setPressureCurve(lut: Float32Array): void {
        this.brushTool.setPressureLUT(lut.slice());
        this.eraserTool.setPressureLUT(lut.slice());
    }

    private pushPressureLUT(): void {
        const lut = this.pressureCurve.toLUT();
        this.brushTool.setPressureLUT(lut.slice());
        this.eraserTool.setPressureLUT(lut.slice());
    }

    // ── Events ────────────────────────────────────────────────────────────────

    private emitStateChange(): void {
        this.emitLayerChange();
        this.bus.emit('history:change', { canUndo: this.history.canUndo(), canRedo: this.history.canRedo() });
    }

    public emitLayerChange(): void {
        this.bus.emit('layer:change', { layers: this.pipeline.layers, activeIndex: this.pipeline.activeLayerIndex });
    }

    // ── Render loop ───────────────────────────────────────────────────────────

    private renderLoop = (timestamp: number): void => {
        if (this.renderLoopStopped) return;
        try { this.renderFrame(timestamp); this.renderErrorCount = 0; }
        catch (err) {
            if (++this.renderErrorCount >= this.MAX_RENDER_ERRORS) {
                this.renderLoopStopped = true;
                this.showRenderError(err); return;
            }
        }
        requestAnimationFrame(this.renderLoop);
    };

    private renderFrame(timestamp: number): void {
        const delta = timestamp - this.lastFrameTime;
        this.lastFrameDelta = delta > 0 ? delta : this.lastFrameDelta;
        this.lastFrameTime  = timestamp;

        this.fpsAccMs += this.lastFrameDelta;
        if (++this.fpsFrameCount >= 30) {
            const fps = Math.round(1000 / (this.fpsAccMs / this.fpsFrameCount));
            if (this.fpsCounter) this.fpsCounter.textContent = `${fps} fps`;
            this.fpsFrameCount = 0;
            this.fpsAccMs      = 0;
        }
        const overBudget = Math.max(this.lastFrameDelta, this.pipeline.lastGpuMs) > this.budgetMs;

        if (this.isPointerDown && this.pointerMoveQueue.length > 0) {
            for (const m of this.pointerMoveQueue)
                this._activeTool.onPointerMove(m.x, m.y, m.pressure, this.pipeline, m.tiltX, m.tiltY);
        }
        this.pointerMoveQueue = [];

        const stamps     = this._activeTool.renderTick(this.pipeline);
        const toolActive = this._activeTool.isActive;

        if (stamps.length > 0 || toolActive) this.idleFrameCount = 0;
        else this.idleFrameCount++;

        const isIdle = this.idleFrameCount > IDLE_CLEAR_FRAMES;
        if (!overBudget && !isIdle)
            this.pipeline.drawPrediction(this._activeTool.getPrediction(), toolActive);
        else if (!isIdle)
            this.pipeline.drawPrediction(new Float32Array(), toolActive);

        this.pipeline.composite();
    }

    private showRenderError(err: unknown): void {
        const div = document.createElement('div');
        div.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;color:#fff;font-family:sans-serif;padding:24px;text-align:center;';
        div.innerHTML = `<h2>Render error</h2><p style="opacity:.7;max-width:400px;margin:12px 0">GPU fatal error. Reload to recover.</p><p style="font-size:11px;opacity:.4;font-family:monospace">${err instanceof Error ? err.message : err}</p><button onclick="location.reload()" style="margin-top:20px;padding:10px 24px;background:#fff;color:#000;border:none;border-radius:6px;cursor:pointer">Reload</button>`;
        document.body.appendChild(div);
    }

    // ── Input ─────────────────────────────────────────────────────────────────

    private isPalmRejected(e: PointerEvent): boolean {
        if (e.pointerType === 'touch' && (e.width||1)*(e.height||1) > PALM_AREA_THRESHOLD) return true;
        if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return true;
        return false;
    }

    private setupInputs(): void {
        setupPointer(this.canvas,
            (x, y, p, e) => {
                if (this.nav.isNavigating || e.buttons !== 1) return;
                if (this.isPalmRejected(e)) return;
                const isPainting = this._activeTool !== this.eyedropperTool &&
                                   this._activeTool !== this.fillTool &&
                                   this._activeTool !== this.selectionTool;
                if (isPainting && this.pipeline.layerManager.getActiveLayer()?.locked) return;

                this.isPointerDown   = true;
                this.activePointerId = e.pointerId;
                this.idleFrameCount  = 0;
                this.pointerMoveQueue = [];
                this._hadSelectionAtPointerDown = this.pipeline.selectionManager.hasMask;
                // Capture layer state before any painting begins (for pixel-based undo)
                const isPaintingTool = this._activeTool === this.brushTool ||
                                       this._activeTool === this.eraserTool;
                if (isPaintingTool) {
                    const layer = this.pipeline.layerManager.getActiveLayer();
                    if (layer) {
                        this._strokeBeforePixelsPromise =
                            this.pipeline.effectsPipeline.snapshotTexture(layer.texture);
                        // Wet mixing: GPU-to-GPU copy of layer at stroke start (paint mode only).
                        // Must be synchronous so the pickup texture is ready before the
                        // first stamp is drawn. Do NOT use the async snapshotTexture path.
                        if (this._activeTool === this.brushTool && this.brushTool.mode === 'paint') {
                            const wetness = this.brushTool.getDescriptor().wetness;
                            if (wetness > 0) {
                                this._pickupTexture?.destroy();
                                this._pickupTexture = this.pipeline.device.createTexture({
                                    size:   [layer.texture.width, layer.texture.height],
                                    format: layer.texture.format,
                                    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                                });
                                const enc = this.pipeline.device.createCommandEncoder();
                                enc.copyTextureToTexture(
                                    { texture: layer.texture },
                                    { texture: this._pickupTexture },
                                    [layer.texture.width, layer.texture.height]
                                );
                                this.pipeline.device.queue.submit([enc.finish()]);
                                this.pipeline.brushRenderer.setPickupTexture(this._pickupTexture, wetness);
                            } else {
                                this.pipeline.brushRenderer.setPickupTexture(null, 0);
                            }
                        }
                    }
                    this.pipeline.resetPaintingFlag();
                }
                if (this._activeTool === this.selectionTool) {
                    this._selectionBeforeMask = this.pipeline.selectionManager.getMaskSnapshot();
                }
                const c = this.translatePoint(e.clientX, e.clientY);
                const tiltX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
                const tiltY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
                this._activeTool.onPointerDown(c.x, c.y, p, this.pipeline, tiltX, tiltY);
            },
            (x, y, p, e) => {
                if (this.nav.isNavigating || e.buttons !== 1) return;
                if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
                const events = (e as any).getCoalescedEvents?.() ?? [e];
                for (const ev of events) {
                    const c = this.translatePoint(ev.clientX, ev.clientY);
                    const tiltX = Number.isFinite(ev.tiltX) ? ev.tiltX : 0;
                    const tiltY = Number.isFinite(ev.tiltY) ? ev.tiltY : 0;
                    this.pointerMoveQueue.push({ x: c.x, y: c.y, pressure: e.pointerType === 'mouse' ? 1.0 : (ev.pressure || p), tiltX, tiltY });
                }
            },
            async (x, y, p, e) => {
                if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
                this.isPointerDown   = false;
                this.activePointerId = null;

                if (this.pointerMoveQueue.length > 0) {
                    for (const m of this.pointerMoveQueue)
                        this._activeTool.onPointerMove(m.x, m.y, m.pressure, this.pipeline, m.tiltX, m.tiltY);
                    this.pointerMoveQueue = [];
                }

                const c      = this.translatePoint(e.clientX, e.clientY);
                await this._activeTool.onPointerUp(c.x, c.y, p, this.pipeline);

                if (this._activeTool === this.brushTool && this.brushTool.mode === 'smudge') {
                    const layer = this.pipeline.layerManager.getActiveLayer();
                    if (layer && this._strokeBeforePixelsPromise && this.pipeline.hadPaintingSinceReset) {
                        const [beforePixels, afterPixels] = await Promise.all([
                            this._strokeBeforePixelsPromise,
                            this.pipeline.effectsPipeline.snapshotTexture(layer.texture),
                        ]);
                        this._strokeBeforePixelsPromise = null;
                        await this.history.execute({
                            type:         'smudge',
                            label:        'Smudge Stroke',
                            layerIndex:   this.pipeline.activeLayerIndex,
                            beforePixels,
                            afterPixels,
                            timestamp:    this.history.now(),
                        });
                    }
                } else if (this.pipeline.hadPaintingSinceReset && this._strokeBeforePixelsPromise) {
                    // Pixel-based stroke: capture before+after and push to history.
                    const layer = this.pipeline.layerManager.getActiveLayer();
                    if (layer) {
                        const [beforePixels, afterPixels] = await Promise.all([
                            this._strokeBeforePixelsPromise,
                            this.pipeline.effectsPipeline.snapshotTexture(layer.texture),
                        ]);
                        this._strokeBeforePixelsPromise = null;
                        await this.history.execute({
                            type:         'stroke',
                            label:        'Brush Stroke',
                            layerIndex:   this.pipeline.activeLayerIndex,
                            beforePixels,
                            afterPixels,
                            timestamp:    this.history.now(),
                        });
                    }
                    // Clear wet mixing pickup texture after stroke
                    this.pipeline.brushRenderer.setPickupTexture(null, 0);
                    this._pickupTexture?.destroy();
                    this._pickupTexture = null;
                }
            }
        );
    }

    // ── Layer commands ────────────────────────────────────────────────────────

    public async addLayer(): Promise<void> {
        await this.history.execute({ type: 'add-layer', label: 'Add Layer', layerIndex: this.pipeline.layers.length, timestamp: this.history.now() });
    }

    public async deleteLayer(index: number): Promise<void> {
        if (this.pipeline.layers.length <= 1) return;
        await this.history.execute({ type: 'delete-layer', label: 'Delete Layer', layerIndex: index, timestamp: this.history.now() });
    }

    public setActiveLayer(index: number): void {
        this.pipeline.activeLayerIndex = index;
        this.pipeline.markDirty();
        this.emitLayerChange();
    }

    public reorderLayer(from: number, to: number): void {
        this.pipeline.reorderLayer(from, to);
        this.emitLayerChange();
    }

    // ── Brush setters ─────────────────────────────────────────────────────────

    public setBrushSize(size: number): void {
        this.brushTool.setSize(size);
        this.pipeline.updateUniforms(this.canvas.width, this.canvas.height, size);
        this.brushCursor?.setSize(size);
        this.bus.emit('brush:change', { size, color: Array.from(this.activeBrushTool.getCurrentColor()) });
    }

    public setBrushColor(r: number, g: number, b: number, a = 1.0): void {
        this.brushTool.setColor(r, g, b, a);
        this.pipeline.currentFillColor = [Math.round(r*255), Math.round(g*255), Math.round(b*255), Math.round(a*255)];
        this.bus.emit('brush:change', { size: this.activeBrushTool.getDescriptor().size, color: [r, g, b, a] });
    }

    public setBrushOpacity(opacity: number): void   { this.brushTool.setOpacity(opacity); }
    public setBrushHardness(hardness: number): void  {
        this.brushTool.setHardness(hardness);
        this.pipeline.brushRenderer.setConfig({ blendMode: 'normal', hardness });
    }

    public clearLayer(): void { this._activeTool.reset(this.pipeline); this.pipeline.clear(); }

    /** Delete key: clears selected pixels (or full layer if no selection). Undoable. */
    public async clearPixels(): Promise<void> {
        const layer = this.pipeline.layerManager.getActiveLayer();
        if (!layer) return;
        const beforePixels = await this.pipeline.effectsPipeline.snapshotTexture(layer.texture);
        const afterPixels = beforePixels.slice();
        if (this.pipeline.selectionManager.hasMask) {
            const mask = this.pipeline.selectionManager.getMaskData();
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] > 0) {
                    afterPixels[i * 4]     = 0;
                    afterPixels[i * 4 + 1] = 0;
                    afterPixels[i * 4 + 2] = 0;
                    afterPixels[i * 4 + 3] = 0;
                }
            }
        } else {
            afterPixels.fill(0);
        }
        this.pipeline.effectsPipeline.restoreTexture(layer.texture, afterPixels);
        this.pipeline.markDirty();
        await this.history.execute({
            type:         'cut',
            label:        'Cut',
            layerIndex:   this.pipeline.activeLayerIndex,
            beforePixels,
            afterPixels,
            timestamp:    this.history.now(),
        });
        this.emitStateChange();
    }

    public selectAll(): void {
        const before = this.pipeline.selectionManager.getMaskSnapshot();
        this.pipeline.selectAll();
        const after = this.pipeline.selectionManager.getMaskSnapshot();
        this.history.execute({
            type: 'selection', label: 'Selection', operation: 'selectAll',
            beforeMask: before.hasMask ? before.data : null,
            afterMask:  after.hasMask  ? after.data  : null,
            maskWidth:  this.pipeline.canvasWidth,
            maskHeight: this.pipeline.canvasHeight,
            timestamp:  this.history.now(),
        });
    }

    public deselect(): void {
        if (!this.pipeline.selectionManager.hasMask) return;
        const before = this.pipeline.selectionManager.getMaskSnapshot();
        this.pipeline.deselect();
        this.history.execute({
            type: 'selection', label: 'Selection', operation: 'deselect',
            beforeMask: before.hasMask ? before.data : null,
            afterMask:  null,
            maskWidth:  this.pipeline.canvasWidth,
            maskHeight: this.pipeline.canvasHeight,
            timestamp:  this.history.now(),
        });
    }

    public invertSelection(): void {
        const before = this.pipeline.selectionManager.getMaskSnapshot();
        this.pipeline.invertSelection();
        const after = this.pipeline.selectionManager.getMaskSnapshot();
        this.history.execute({
            type: 'selection', label: 'Selection', operation: 'invertSelection',
            beforeMask: before.hasMask ? before.data : null,
            afterMask:  after.hasMask  ? after.data  : null,
            maskWidth:  this.pipeline.canvasWidth,
            maskHeight: this.pipeline.canvasHeight,
            timestamp:  this.history.now(),
        });
    }

    // ── Copy / Cut / Paste ────────────────────────────────────────────────────

    public async copy(): Promise<void> {
        const layer = this.pipeline.layerManager.getActiveLayer();
        if (!layer) return;
        const pixels = await this.pipeline.effectsPipeline.snapshotTexture(layer.texture);
        if (this.pipeline.selectionManager.hasMask) {
            const mask = this.pipeline.selectionManager.getMaskData();
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] === 0) {
                    pixels[i * 4]     = 0;
                    pixels[i * 4 + 1] = 0;
                    pixels[i * 4 + 2] = 0;
                    pixels[i * 4 + 3] = 0;
                }
            }
        }
        this.clipboard = { pixels };
    }

    public async cut(): Promise<void> {
        const layer = this.pipeline.layerManager.getActiveLayer();
        if (!layer) return;
        const pixels = await this.pipeline.effectsPipeline.snapshotTexture(layer.texture);
        // Keep a clean copy of the before-state for undo
        const beforePixels = pixels.slice();
        // Build the post-cut pixel state (clear selected or all pixels)
        const afterCut = pixels.slice();
        if (this.pipeline.selectionManager.hasMask) {
            const mask = this.pipeline.selectionManager.getMaskData();
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] > 0) {
                    // Clear selected pixels from the layer after cut
                    afterCut[i * 4]     = 0;
                    afterCut[i * 4 + 1] = 0;
                    afterCut[i * 4 + 2] = 0;
                    afterCut[i * 4 + 3] = 0;
                } else {
                    // Clipboard keeps only the selected region — zero unselected
                    pixels[i * 4]     = 0;
                    pixels[i * 4 + 1] = 0;
                    pixels[i * 4 + 2] = 0;
                    pixels[i * 4 + 3] = 0;
                }
            }
        } else {
            // No selection: copy full layer, clear full layer
            afterCut.fill(0);
        }
        this.clipboard = { pixels };
        // Apply the cut to GPU immediately (before pushing to history)
        this.pipeline.effectsPipeline.restoreTexture(layer.texture, afterCut);
        this.pipeline.markDirty();
        await this.history.execute({
            type:         'cut',
            label:        'Cut',
            layerIndex:   this.pipeline.activeLayerIndex,
            beforePixels,
            afterPixels:  afterCut,
            timestamp:    this.history.now(),
        });
        this.emitStateChange();
    }

    public async paste(): Promise<void> {
        if (!this.clipboard) return;
        await this.history.execute({
            type:      'paste', label: 'Paste',
            pixels:    this.clipboard.pixels.slice(),
            timestamp: this.history.now(),
        });
        this.emitStateChange();
    }

    // ── Transform (C4) ───────────────────────────────────────────────────────

    /**
     * Enter free-transform mode on the active layer.
     *
     * When a pixel selection is active and no explicit `sourcePixels` or
     * `initialState` are provided, automatically extracts only the selected
     * pixels, punches a hole in the layer, and positions the bounding box
     * as the initial transform state.
     *
     * @param sourcePixels  Pre-computed source pixels (for image import / history replay).
     * @param initialState  Override the starting transform state.
     */
    public async enterTransform(
        sourcePixels?: Uint8Array,
        initialState?: TransformState
    ): Promise<void> {
        if (this.pipeline.transformActive) return; // already in transform mode
        const layer = this.pipeline.layerManager.getActiveLayer();
        if (!layer) return;

        // Canvas aspect ratio for pixel-correct rotation in TransformTool.
        this.transformTool.canvasAspect  = this.pipeline.canvasWidth / this.pipeline.canvasHeight;
        this._transformHadSelection      = this.pipeline.selectionManager.hasMask;

        if (sourcePixels && initialState) {
            // ── Caller-supplied pixels + state (image import, history replay) ──
            this._transformBeforePixels = sourcePixels.slice();
            this.transformTool.state = initialState;
            this.pipeline.beginTransform(sourcePixels, initialState);

        } else {
            // ── Content-bounded transform (with or without selection) ──────────
            // Computes a bounding box of the content (selected pixels, or all
            // non-transparent pixels when no selection) and remaps the source
            // texture so that UV (0..1) covers exactly the bounding box region.
            // This ensures the content appears at natural 1:1 scale initially.
            const fullPixels = await this.pipeline.effectsPipeline.snapshotTexture(layer.texture);
            this._transformBeforePixels = fullPixels.slice();

            const hasSel = this.pipeline.selectionManager.hasMask;
            const mask   = hasSel ? this.pipeline.selectionManager.getMaskData() : null;
            const W      = this.pipeline.canvasWidth;
            const H      = this.pipeline.canvasHeight;

            // Find bounding box of content.
            let minX = W, minY = H, maxX = -1, maxY = -1;
            for (let py = 0; py < H; py++) {
                for (let px = 0; px < W; px++) {
                    const i      = py * W + px;
                    const inside = mask ? mask[i] > 0 : fullPixels[i * 4 + 3] > 4;
                    if (inside) {
                        if (px < minX) minX = px;
                        if (px > maxX) maxX = px;
                        if (py < minY) minY = py;
                        if (py > maxY) maxY = py;
                    }
                }
            }
            if (maxX < 0) { minX = 0; maxX = W - 1; minY = 0; maxY = H - 1; }

            const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
            const state: TransformState = {
                cx:     (minX + maxX + 1) / 2 / W,
                cy:     (minY + maxY + 1) / 2 / H,
                scaleX: bboxW / W,
                scaleY: bboxH / H,
                rotation: 0,
            };

            // Precompute per-column and per-row canvas index mappings.
            const mapX = new Int32Array(W);
            const mapY = new Int32Array(H);
            for (let sx = 0; sx < W; sx++)
                mapX[sx] = Math.min(W - 1, Math.round(minX + (sx / (W - 1)) * (bboxW - 1)));
            for (let sy = 0; sy < H; sy++)
                mapY[sy] = Math.min(H - 1, Math.round(minY + (sy / (H - 1)) * (bboxH - 1)));

            // Build source pixels: bbox content remapped to fill UV (0..1).
            const srcPixels  = new Uint8Array(W * H * 4);
            const holePixels = mask ? new Uint8Array(W * H * 4) : undefined;

            if (mask) {
                // Hole = unselected pixels stay in the background.
                // fullPixels is premultiplied (BGRA bytes are R*α, G*α, B*α, α).
                // ALL four channels must be scaled by (1-mf) to keep valid premultiplied
                // representation: a pixel with α=0 must also have RGB=0, otherwise
                // the GPU blend (one / one-minus-src-alpha) adds the stale RGB to
                // destinations even when the pixel is fully transparent → glow artefact.
                for (let i = 0; i < W * H; i++) {
                    const i4 = i * 4;
                    const hf = 1 - mask[i] / 255;  // hole factor
                    holePixels![i4]     = Math.round(fullPixels[i4]     * hf);
                    holePixels![i4 + 1] = Math.round(fullPixels[i4 + 1] * hf);
                    holePixels![i4 + 2] = Math.round(fullPixels[i4 + 2] * hf);
                    holePixels![i4 + 3] = Math.round(fullPixels[i4 + 3] * hf);
                }
            }

            for (let sy = 0; sy < H; sy++) {
                const cpy    = mapY[sy];
                const srcRow = cpy * W;
                const dstRow = sy  * W;
                for (let sx = 0; sx < W; sx++) {
                    const cpx  = mapX[sx];
                    const ci4  = (srcRow + cpx) * 4;
                    const si4  = (dstRow + sx)  * 4;
                    // Scale ALL channels by the mask factor. fullPixels is premultiplied,
                    // so unselected (mf=0) pixels must become [0,0,0,0] — not just α=0
                    // with stale RGB — to avoid adding extra colour to the destination.
                    const mf   = mask ? mask[srcRow + cpx] / 255 : 1;
                    srcPixels[si4]     = Math.round(fullPixels[ci4]     * mf);
                    srcPixels[si4 + 1] = Math.round(fullPixels[ci4 + 1] * mf);
                    srcPixels[si4 + 2] = Math.round(fullPixels[ci4 + 2] * mf);
                    srcPixels[si4 + 3] = Math.round(fullPixels[ci4 + 3] * mf);
                }
            }

            this.transformTool.state = state;
            this.pipeline.beginTransform(srcPixels, state, holePixels);
        }

        this.transformOverlay.show();
        this.bus.emit('transform:change', { active: true });
    }

    public async commitTransform(): Promise<void> {
        if (!this.pipeline.transformActive) return;
        const layerIndex   = this.pipeline.activeLayerIndex;
        const beforePixels = this._transformBeforePixels!;
        const afterPixels  = await this.pipeline.commitTransform();
        this.transformOverlay.hide();
        this._transformBeforePixels = null;
        await this.history.execute({
            type:         'transform',
            label:        'Transform',
            layerIndex,
            beforePixels,
            afterPixels,
            timestamp:    this.history.now(),
        });
        // Move the selection to the transformed content's new position.
        if (this._transformHadSelection) this._applySelectionFromTransform();
        this._transformHadSelection = false;
        this.emitStateChange();
        this.bus.emit('transform:change', { active: false });
    }

    public cancelTransform(): void {
        if (!this.pipeline.transformActive || !this._transformBeforePixels) return;
        this.pipeline.cancelTransform(this._transformBeforePixels);
        this.transformOverlay.hide();
        this._transformBeforePixels = null;
        this._transformHadSelection = false;
        this.bus.emit('transform:change', { active: false });
    }

    /** Recompute the selection to cover the transformed region after a commit. */
    private _applySelectionFromTransform(): void {
        const { cx, cy, scaleX, scaleY, rotation } = this.transformTool.state;
        const isAxisAligned = Math.abs(rotation % 360) < 0.5;

        if (isAxisAligned) {
            this.pipeline.setRectSelection(cx - scaleX / 2, cy - scaleY / 2, scaleX, scaleY);
        } else {
            // Build a 4-point lasso from the rotated bounding box corners.
            const ar  = this.pipeline.canvasWidth / this.pipeline.canvasHeight;
            const r   = rotation * Math.PI / 180;
            const cos = Math.cos(r), sin = Math.sin(r);
            const hw  = scaleX / 2, hh = scaleY / 2;
            const pts: number[] = [];
            for (const [lx, ly] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as [number, number][]) {
                pts.push(cx + lx * cos - ly * sin / ar);
                pts.push(cy + lx * sin * ar + ly * cos);
            }
            this.pipeline.setLassoSelection(pts);
        }
    }

    // ── Image Import (D7) ─────────────────────────────────────────────────────

    public async importImage(file: File): Promise<void> {
        const bitmap  = await createImageBitmap(file);
        const imgW    = bitmap.width, imgH = bitmap.height;
        const canvasW = this.pipeline.canvasWidth, canvasH = this.pipeline.canvasHeight;

        // Scale to fit canvas (maintain aspect ratio, never upscale).
        const scale   = Math.min(1, canvasW / imgW, canvasH / imgH);
        const dw      = Math.round(imgW * scale);
        const dh      = Math.round(imgH * scale);

        // Render the image stretched to fill a full-canvas OffscreenCanvas.
        // The transform shader samples from this via UV (0..1), and the
        // initial transform state sets the visible region to (dw/canvasW, dh/canvasH).
        const src = new OffscreenCanvas(canvasW, canvasH);
        const ctx = src.getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0, canvasW, canvasH);
        bitmap.close();

        // Add a new layer and copy the stretched image into it.
        await this.addLayer();
        const layer = this.pipeline.layerManager.getActiveLayer()!;
        this.pipeline.device.queue.copyExternalImageToTexture(
            { source: src },
            { texture: layer.texture, premultipliedAlpha: true },
            [canvasW, canvasH]
        );
        await this.pipeline.device.queue.onSubmittedWorkDone();

        // Snapshot the image pixels — these are the transform source.
        const srcPixels = await this.pipeline.effectsPipeline.snapshotTexture(layer.texture);

        // Enter transform at the fit-to-canvas scale, centered.
        await this.enterTransform(srcPixels, {
            cx:       0.5,
            cy:       0.5,
            scaleX:   dw / canvasW,
            scaleY:   dh / canvasH,
            rotation: 0,
        });
    }

    // ── Coordinate conversion ─────────────────────────────────────────────────

    /** Screen (clientX/Y) → normalized canvas (0..1). Accounts for pan, zoom, rotation. */
    private translatePoint(clientX: number, clientY: number): { x: number; y: number } {
        const wrapW   = window.innerWidth;
        const wrapH   = window.innerHeight - HEADER_H;
        const centerX = wrapW / 2 + this.nav.state.x;
        const centerY = HEADER_H + wrapH / 2 + this.nav.state.y;
        const dx = clientX - centerX, dy = clientY - centerY;
        const rad = -(this.nav.state.rotation * Math.PI / 180);
        const rx  = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ry  = dx * Math.sin(rad) + dy * Math.cos(rad);
        return {
            x: 0.5 + rx / (this.canvasSize.width  * this.nav.state.zoom),
            y: 0.5 + ry / (this.canvasSize.height * this.nav.state.zoom),
        };
    }

    /** Normalized canvas (0..1) → screen CSS pixels. Used by SelectionTool overlay. */
    public canvasToScreen(nx: number, ny: number): { x: number; y: number } {
        const wrapW   = window.innerWidth;
        const wrapH   = window.innerHeight - HEADER_H;
        const centerX = wrapW / 2 + this.nav.state.x;
        const centerY = HEADER_H + wrapH / 2 + this.nav.state.y;
        const lx = (nx - 0.5) * this.canvasSize.width  * this.nav.state.zoom;
        const ly = (ny - 0.5) * this.canvasSize.height * this.nav.state.zoom;
        const rad = this.nav.state.rotation * Math.PI / 180;
        return {
            x: centerX + lx * Math.cos(rad) - ly * Math.sin(rad),
            y: centerY + lx * Math.sin(rad) + ly * Math.cos(rad),
        };
    }

    private updateCanvasTransform(): void {
        const s = this.canvas.style, z = this.nav.state.zoom, r = this.nav.state.rotation;
        s.width     = `${this.canvasSize.width  * z}px`;
        s.height    = `${this.canvasSize.height * z}px`;
        s.left      = `calc(50% + ${this.nav.state.x}px)`;
        s.top       = `calc(50% + ${this.nav.state.y}px)`;
        s.transform = `translate(-50%, -50%) rotate(${r}deg)`;
        s.position  = 'absolute';
        // Keep transform overlay handles aligned with the canvas during pan/zoom/rotate.
        if (this.pipeline.transformActive) this.transformOverlay.draw();
    }
}
