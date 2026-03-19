import { PaintPipeline }                          from '../renderer/pipeline';
import { HistoryManager }                          from './history-manager';
import { NavigationManager }                       from '../input/navigation';
import { setupPointer }                            from '../input/pointer';
import { Tool }                                    from './tool';
import { BaseTool }                                from './tools/base-tool';
import { BrushTool }                               from './tools/brush-tool';
import { EraserTool }                              from './tools/eraser-tool';
import { EyedropperTool }                          from './tools/eyedropper-tool';
import { FillTool }                                from './tools/fill-tool';
import { SelectionTool }                           from './tools/selection-tool';
import { EventBus }                                from './event-bus';
import { AutosaveManager, recordToCommand, recordToCheckpoint } from './autosave-manager';
import { PressureCurve, PRESSURE_PRESETS }         from '../renderer/pressure-curve';
import { FLOATS_PER_STAMP }                        from '../renderer/pipeline-cache';
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
    public  brushTool:      BrushTool;
    public  eraserTool:     EraserTool;
    public  eyedropperTool: EyedropperTool;
    public  fillTool:       FillTool;
    public  selectionTool:  SelectionTool;

    private brushCursor:    BrushCursor | null = null;
    private clipboard:      { pixels: Uint8Array } | null = null;

    private lastFrameTime   = 0;
    private lastFrameDelta  = 16.6;
    private idleFrameCount  = 0;
    private readonly budgetMs: number;

    private pointerMoveQueue: QueuedMove[] = [];
    private isPointerDown     = false;
    private activePointerId:  number | null = null;

    private pressureCurve:  PressureCurve;
    private renderErrorCount  = 0;
    private renderLoopStopped = false;
    private readonly MAX_RENDER_ERRORS = 3;

    constructor(
        private canvas:     HTMLCanvasElement,
        device:             GPUDevice,
        context:            GPUCanvasContext,
        format:             GPUTextureFormat,
        private canvasSize: { width: number; height: number },
        supportsTimestamps  = false,
        fps                 = 60
    ) {
        this.budgetMs      = (1000 / fps) * 0.85;
        this.pressureCurve = new PressureCurve(PRESSURE_PRESETS.natural);

        this.pipeline = new PaintPipeline(device, context, format, canvas.width, canvas.height, supportsTimestamps);
        this.nav      = new NavigationManager(canvas, () => this.updateCanvasTransform());

        this.history = new HistoryManager(
            async cmd  => { this.pipeline.applyCommand(cmd); this.pipeline.markDirty(); this.emitStateChange(); },
            async log  => { await this.pipeline.reconstructFromHistory(log); this.pipeline.markDirty(); this.emitStateChange(); },
            {
                onCheckpointNeeded:     len => this.pipeline.createCheckpointIfNeeded(len),
                onOldestCommandDropped: ()  => { this.pipeline.handleCommandDropped();      this.autosave?.onCommandDropped();  },
                onRedoInvalidated:      len => { this.pipeline.handleRedoInvalidated(len); this.autosave?.onRedoInvalidated(); },
                onCommandAppended:      cmd => this.autosave?.onCommandAppended(cmd),
                onCommandUndone:        ()  => this.autosave?.onCommandUndone(),
                onCommandRedone:        ()  => this.autosave?.onCommandRedone(),
            }
        );

        this.brushTool      = new BrushTool();
        this.eraserTool     = new EraserTool();
        this.eyedropperTool = new EyedropperTool(this.pipeline, this.bus);
        this.fillTool       = new FillTool();
        this.selectionTool  = new SelectionTool(canvas);

        this.selectionTool.screenToCanvas = (cx, cy) => this.translatePoint(cx, cy);
        this.selectionTool.canvasToScreen = (nx, ny)  => this.canvasToScreen(nx, ny);

        this.wireTool(this.brushTool);
        this.wireTool(this.eraserTool);
        this._activeTool = this.brushTool;

        this.pushPressureLUT();
        this.setupInputs();
    }

    // Expose active tool name for bus sync
    public get activeToolName(): string { return this._activeTool.constructor.name; }

    // ── Brush cursor ──────────────────────────────────────────────────────────

    public initBrushCursor(): void {
        this.brushCursor = new BrushCursor(
            this.canvas,
            () => this.canvasSize.width * this.nav.state.zoom
        );
        this.brushCursor.setSize(this.brushTool.getDescriptor().size);
        this.brushCursor.show();
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
        this.bus.emit('tool:change', { tool: tool.constructor.name });

        const isBrushLike = tool === this.brushTool || tool === this.eraserTool;
        this.brushCursor?.setVisible(isBrushLike);
        this.canvas.style.cursor =
            isBrushLike                  ? 'none'
          : tool === this.eyedropperTool ? 'crosshair'
          : tool === this.fillTool       ? 'cell'
          : tool === this.selectionTool  ? 'crosshair'
          : 'default';
    }

    private wireTool(tool: BaseTool): void {
        tool.onPartialFlush = (stamps, layerIndex, blendMode) => {
            this.history.execute({
                type: 'stroke', label: 'Brush Stroke',
                layerIndex, stamps, blendMode,
                floatsPerStamp: FLOATS_PER_STAMP,
                timestamp: this.history.now()
            });
        };
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
                    this.pointerMoveQueue.push({ x: c.x, y: c.y, pressure: ev.pressure || p, tiltX, tiltY });
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
                const stamps = await this._activeTool.onPointerUp(c.x, c.y, p, this.pipeline);

                if (stamps && stamps.length > 0) {
                    await this.history.execute({
                        type: 'stroke', label: 'Brush Stroke',
                        layerIndex:     this.pipeline.activeLayerIndex,
                        stamps,
                        blendMode:      this._activeTool.blendMode,
                        floatsPerStamp: FLOATS_PER_STAMP,
                        timestamp:      this.history.now()
                    });
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
        this.bus.emit('brush:change', { size, color: Array.from(this.brushTool.getCurrentColor()) });
    }

    public setBrushColor(r: number, g: number, b: number, a = 1.0): void {
        this.brushTool.setColor(r, g, b, a);
        this.pipeline.currentFillColor = [Math.round(r*255), Math.round(g*255), Math.round(b*255), Math.round(a*255)];
        this.bus.emit('brush:change', { size: this.brushTool.getDescriptor().size, color: [r, g, b, a] });
    }

    public setBrushOpacity(opacity: number): void   { this.brushTool.setOpacity(opacity); }
    public setBrushHardness(hardness: number): void  {
        this.brushTool.setHardness(hardness);
        this.pipeline.brushRenderer.setConfig({ blendMode: 'normal', hardness });
    }

    public clearLayer(): void { this._activeTool.reset(this.pipeline); this.pipeline.clear(); }

    public selectAll(): void {
        this.history.execute({
            type: 'selection', label: 'Selection',
            operation: 'selectAll', selMode: 'replace',
            timestamp: this.history.now()
        });
    }

    public deselect(): void {
        this.history.execute({
            type: 'selection', label: 'Selection',
            operation: 'deselect', selMode: 'replace',
            timestamp: this.history.now()
        });
    }

    public invertSelection(): void {
        this.history.execute({
            type: 'selection', label: 'Selection',
            operation: 'invertSelection', selMode: 'replace',
            timestamp: this.history.now()
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
                if (mask[i] === 0) pixels[i * 4 + 3] = 0;
            }
        }
        this.clipboard = { pixels };
    }

    public async cut(): Promise<void> {
        const layer = this.pipeline.layerManager.getActiveLayer();
        if (!layer) return;
        const pixels = await this.pipeline.effectsPipeline.snapshotTexture(layer.texture);
        // Build the post-cut pixel state (clear selected or all pixels)
        const afterCut = pixels.slice();
        if (this.pipeline.selectionManager.hasMask) {
            const mask = this.pipeline.selectionManager.getMaskData();
            for (let i = 0; i < mask.length; i++) {
                if (mask[i] > 0)  afterCut[i * 4 + 3] = 0;  // clear selected
                else              pixels[i * 4 + 3]   = 0;  // clipboard: keep only selected
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
            type: 'cut', label: 'Cut',
            layerIndex: this.pipeline.activeLayerIndex,
            pixels:     afterCut,
            timestamp:  this.history.now(),
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
    }
}
