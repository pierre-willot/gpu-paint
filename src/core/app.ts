import { PaintPipeline }              from "../renderer/pipeline";
import { HistoryManager }             from "./history-manager";
import { NavigationManager }          from "../input/navigation";
import { setupPointer }               from "../input/pointer";
import { Tool }                       from "./tool";
import { BaseTool }                   from "./tools/base-tool";
import { BrushTool }                  from "./tools/brush-tool";
import { EraserTool }                 from "./tools/eraser-tool";
import { EventBus }                   from "./event-bus";
import { PressureCurve, PressureCurvePreset, PRESSURE_PRESETS } from "../renderer/pressure-curve";
import { FLOATS_PER_STAMP }           from "../renderer/pipeline-cache";

const IDLE_CLEAR_FRAMES = 10;

// ── Palm rejection ────────────────────────────────────────────────────────────
// A touch contact area above this threshold (in CSS pixels²) is treated as a
// palm and rejected. Apple Pencil contacts are ~1-4 px², palm contacts are
// typically 2000-20000 px² depending on how the hand rests.
// 400 px² is a conservative threshold that won't reject intentional touches
// from fingertip drawing but will reliably catch palm rests.
const PALM_AREA_THRESHOLD = 400;

// ── Queued pointer event ──────────────────────────────────────────────────────
interface QueuedMove {
    x: number; y: number; pressure: number;
    tiltX: number; tiltY: number;
}

export class PaintApp {
    public  pipeline:    PaintPipeline;
    public  history:     HistoryManager;
    public  nav:         NavigationManager;
    public  readonly bus = new EventBus();

    private activeTool:  Tool;
    public  brushTool:   BrushTool;
    public  eraserTool:  EraserTool;

    private cachedRect:  DOMRect | null = null;

    private lastFrameTime:  number = 0;
    private lastFrameDelta: number = 16.6;
    private idleFrameCount: number = 0;

    private readonly budgetMs: number;

    // ── Pointer event buffer (Safari compatibility) ───────────────────────────
    private pointerMoveQueue: QueuedMove[] = [];
    private isPointerDown:    boolean      = false;
    // Track the active pointer ID so we can reject a simultaneous palm touch
    // that starts while a stroke is in progress.
    private activePointerId:  number | null = null;

    // ── Pressure curve ────────────────────────────────────────────────────────
    // One PressureCurve instance shared by all tools.
    // The LUT is re-sent to each tool's worker whenever the curve changes.
    private pressureCurve: PressureCurve;

    // ── Render loop error boundary ────────────────────────────────────────────
    private renderErrorCount:  number  = 0;
    private readonly MAX_RENDER_ERRORS = 3;
    private renderLoopStopped: boolean = false;

    constructor(
        private canvas:          HTMLCanvasElement,
        device:                  GPUDevice,
        context:                 GPUCanvasContext,
        format:                  GPUTextureFormat,
        private canvasSize:      { width: number; height: number },
        supportsTimestamps:      boolean = false,
        fps:                     number  = 60
    ) {
        this.budgetMs     = (1000 / fps) * 0.85;
        this.pressureCurve = new PressureCurve(PRESSURE_PRESETS.natural);

        console.info(`[PaintApp] Frame budget: ${this.budgetMs.toFixed(1)}ms (${fps}Hz)`);

        this.pipeline = new PaintPipeline(
            device, context, format,
            canvas.width, canvas.height,
            supportsTimestamps
        );

        this.nav = new NavigationManager(canvas, () => this.updateCanvasTransform());

        this.history = new HistoryManager(
            async (cmd) => {
                this.pipeline.applyCommand(cmd);
                this.pipeline.markDirty();
                this.emitStateChange();
            },
            async (log) => {
                await this.pipeline.reconstructFromHistory(log);
                this.pipeline.markDirty();
                this.emitStateChange();
            },
            {
                onCheckpointNeeded:     (len) => this.pipeline.createCheckpointIfNeeded(len),
                onOldestCommandDropped: ()    => this.pipeline.handleCommandDropped(),
                onRedoInvalidated:      (len) => this.pipeline.handleRedoInvalidated(len)
            }
        );

        this.brushTool  = new BrushTool(this.bus);
        this.eraserTool = new EraserTool();

        this.wireTool(this.brushTool);
        this.wireTool(this.eraserTool);
        this.activeTool = this.brushTool;

        // Push initial pressure LUT to both tool workers
        this.pushPressureLUT();

        new ResizeObserver(() => { this.cachedRect = null; }).observe(this.canvas);
        this.setupInputs();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────────

    public async init() {
        await this.history.execute({
            type: 'add-layer', label: 'Initial Layer', layerIndex: 0
        });
        this.renderLoop(performance.now());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TOOL MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    public setTool(tool: Tool) {
        this.activeTool.reset(this.pipeline);
        this.activeTool = tool;
        this.bus.emit('tool:change', { tool: tool.constructor.name });
    }

    private wireTool(tool: BaseTool) {
        tool.onPartialFlush = (stamps, layerIndex, blendMode) => {
            this.history.execute({
                type: 'stroke', label: 'Brush Stroke',
                layerIndex, stamps, blendMode,
                floatsPerStamp: FLOATS_PER_STAMP,
                timestamp:      this.history.now(),
                selectionMask:  this.pipeline.selectionSnapshot,
            });
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRESSURE CURVE — public API for UI
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Sets the pressure curve from a preset name.
     * Call this from a UI control (e.g. a dropdown with 'natural', 'soft', etc.)
     */
    public setPressurePreset(name: keyof typeof PRESSURE_PRESETS) {
        this.pressureCurve.update(PRESSURE_PRESETS[name]);
        this.pushPressureLUT();
    }

    /**
     * Sets the pressure curve from custom Bézier control points.
     * Call this from a pressure curve editor widget.
     */
    public setPressureCurve(preset: PressureCurvePreset) {
        this.pressureCurve.update(preset);
        this.pushPressureLUT();
    }

    /**
     * Sends the current pressure LUT to every tool's worker thread.
     * Each call generates one LUT copy per tool (cheap — 256 floats).
     */
    private pushPressureLUT() {
        this.brushTool.strokeEngine.setPressureLUT(this.pressureCurve.toLUT());
        this.eraserTool.strokeEngine.setPressureLUT(this.pressureCurve.toLUT());
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EVENT EMISSION
    // ─────────────────────────────────────────────────────────────────────────

    private emitStateChange() {
        this.bus.emit('layer:change', {
            layers:      this.pipeline.layers,
            activeIndex: this.pipeline.activeLayerIndex
        });
        this.bus.emit('history:change', {
            canUndo: this.history.canUndo(),
            canRedo: this.history.canRedo()
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RENDER LOOP — with error boundary
    // ─────────────────────────────────────────────────────────────────────────

    private renderLoop = (timestamp: number) => {
        if (this.renderLoopStopped) return;
        try {
            this.renderFrame(timestamp);
            this.renderErrorCount = 0;
        } catch (err) {
            this.renderErrorCount++;
            console.error(`[RenderLoop] Error (${this.renderErrorCount}/${this.MAX_RENDER_ERRORS}):`, err);
            if (this.renderErrorCount >= this.MAX_RENDER_ERRORS) {
                this.renderLoopStopped = true;
                this.showRenderError(err);
                return;
            }
        }
        requestAnimationFrame(this.renderLoop);
    };

    private renderFrame(timestamp: number) {
        const delta         = timestamp - this.lastFrameTime;
        this.lastFrameDelta = delta > 0 ? delta : this.lastFrameDelta;
        this.lastFrameTime  = timestamp;

        const worstCaseMs = Math.max(this.lastFrameDelta, this.pipeline.lastGpuMs);
        const overBudget  = worstCaseMs > this.budgetMs;

        // Drain pointer move queue (Safari + all browsers)
        if (this.isPointerDown && this.pointerMoveQueue.length > 0) {
            for (const move of this.pointerMoveQueue) {
                this.activeTool.onPointerMove(
                    move.x, move.y, move.pressure,
                    this.pipeline,
                    move.tiltX, move.tiltY
                );
            }
        }
        this.pointerMoveQueue = [];

        const stamps     = this.activeTool.renderTick(this.pipeline);
        const toolActive = this.activeTool.isActive;

        if (stamps.length > 0 || toolActive) this.idleFrameCount = 0;
        else this.idleFrameCount++;

        const isIdle = this.idleFrameCount > IDLE_CLEAR_FRAMES;

        if (!overBudget && !isIdle) {
            this.pipeline.drawPrediction(this.activeTool.getPrediction(), toolActive);
        } else if (!isIdle) {
            this.pipeline.drawPrediction(new Float32Array(), toolActive);
        }

        this.pipeline.composite();
    }

    private showRenderError(err: unknown) {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;
            flex-direction:column;align-items:center;justify-content:center;
            z-index:9999;font-family:sans-serif;color:#fff;padding:24px;text-align:center;
        `;
        overlay.innerHTML = `
            <h2 style="margin:0 0 12px;font-size:20px">Render error</h2>
            <p style="margin:0 0 20px;opacity:.75;max-width:400px">
                The GPU encountered a fatal error. Your work is preserved —
                reload the page to recover.
            </p>
            <p style="margin:0 0 24px;font-size:12px;opacity:.4;font-family:monospace;max-width:480px">
                ${err instanceof Error ? err.message : String(err)}
            </p>
            <button onclick="location.reload()"
                style="padding:10px 24px;background:#fff;color:#000;border:none;
                       border-radius:6px;font-size:15px;cursor:pointer">
                Reload
            </button>
        `;
        document.body.appendChild(overlay);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INPUT HANDLING
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns true if this pointer event should be rejected as a palm.
     *
     * Two rejection rules:
     *   1. Large contact area — pointerType 'touch' with width×height above
     *      threshold. Apple Pencil always reports pointerType 'pen', so this
     *      rule never fires for stylus input.
     *   2. Second simultaneous pointer — a new pointerdown while a stroke is
     *      already active on a different pointer ID. This catches the case where
     *      the palm lands just after the pen, which would otherwise start a
     *      second unwanted stroke.
     */
    private isPalmRejected(e: PointerEvent): boolean {
        if (e.pointerType === 'touch') {
            const area = (e.width || 1) * (e.height || 1);
            if (area > PALM_AREA_THRESHOLD) return true;
        }
        if (this.activePointerId !== null && e.pointerId !== this.activePointerId) {
            return true;
        }
        return false;
    }

    /**
     * Extracts tilt from a PointerEvent.
     *
     * Availability by platform:
     *   Apple Pencil (iPadOS Safari)  — tiltX, tiltY reported correctly
     *   Windows Ink stylus (Chrome)   — tiltX, tiltY reported correctly
     *   Mouse / trackpad              — both 0 (no tilt)
     *   Touch                         — both 0 (no tilt)
     *
     * Values are in degrees, range -90..90.
     * A missing or NaN value is treated as 0 (vertical pen = circular stamp).
     */
    private extractTilt(e: PointerEvent): { tiltX: number; tiltY: number } {
        const tiltX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
        const tiltY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
        return { tiltX, tiltY };
    }

    private setupInputs() {
        setupPointer(
            this.canvas,

            // POINTER DOWN
            (x, y, p, e) => {
                if (this.nav.isNavigating || e.buttons !== 1) return;
                if (this.isPalmRejected(e)) return;

                this.isPointerDown    = true;
                this.activePointerId  = e.pointerId;
                this.idleFrameCount   = 0;
                this.pointerMoveQueue = [];

                const c = this.translatePoint(e.clientX, e.clientY);
                const { tiltX, tiltY } = this.extractTilt(e);
                this.activeTool.onPointerDown(c.x, c.y, p, this.pipeline, tiltX, tiltY);
            },

            // POINTER MOVE — queue for rAF drain
            (x, y, p, e) => {
                if (this.nav.isNavigating || e.buttons !== 1) return;
                if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

                const events = (e as any).getCoalescedEvents?.() ?? [e];
                for (const ev of events) {
                    const c = this.translatePoint(ev.clientX, ev.clientY);
                    const { tiltX, tiltY } = this.extractTilt(ev);
                    this.pointerMoveQueue.push({
                        x: c.x, y: c.y,
                        pressure: ev.pressure || p,
                        tiltX, tiltY
                    });
                }
            },

            // POINTER UP
            async (x, y, p, e) => {
                if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

                this.isPointerDown   = false;
                this.activePointerId = null;

                // Drain remaining queued moves before finalizing
                if (this.pointerMoveQueue.length > 0) {
                    for (const move of this.pointerMoveQueue) {
                        this.activeTool.onPointerMove(
                            move.x, move.y, move.pressure,
                            this.pipeline,
                            move.tiltX, move.tiltY
                        );
                    }
                    this.pointerMoveQueue = [];
                }

                const c      = this.translatePoint(e.clientX, e.clientY);
                const stamps = await this.activeTool.onPointerUp(c.x, c.y, p, this.pipeline);

                if (stamps && stamps.length > 0) {
                    await this.history.execute({
                        type:           'stroke',
                        label:          'Brush Stroke',
                        layerIndex:     this.pipeline.activeLayerIndex,
                        stamps,
                        blendMode:      this.activeTool.blendMode,
                        floatsPerStamp: FLOATS_PER_STAMP,
                        timestamp:      this.history.now(),
                        selectionMask:  this.pipeline.selectionSnapshot,
                    });
                }
            }
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COMMAND DISPATCHERS
    // ─────────────────────────────────────────────────────────────────────────

    public async addLayer() {
        await this.history.execute({
            type: 'add-layer', label: 'Add Layer',
            layerIndex: this.pipeline.layers.length
        });
    }

    public async deleteLayer(index: number) {
        if (this.pipeline.layers.length <= 1) return;
        await this.history.execute({
            type: 'delete-layer', label: 'Delete Layer', layerIndex: index
        });
    }

    public setActiveLayer(index: number) {
        this.pipeline.activeLayerIndex = index;
        this.pipeline.markDirty();
        this.bus.emit('layer:change', {
            layers:      this.pipeline.layers,
            activeIndex: this.pipeline.activeLayerIndex
        });
    }

    public setBrushSize(size: number) {
        this.pipeline.updateUniforms(this.canvas.width, this.canvas.height, size);
        this.bus.emit('brush:change', { size, color: this.pipeline.currentBrushColor });
    }

    public setBrushColor(r: number, g: number, b: number, a: number = 1.0) {
        this.pipeline.currentBrushColor = [r, g, b, a];
        this.bus.emit('brush:change', {
            size: this.pipeline.currentBrushSize, color: [r, g, b, a]
        });
    }

    public clearLayer() {
        this.activeTool.reset(this.pipeline);
        this.pipeline.clear();
    }

    public setBrushSmoothing(strength: number) {
        this.brushTool.setSmoothing(strength);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // COORDINATE TRANSLATION
    // ─────────────────────────────────────────────────────────────────────────

    private translatePoint(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.getCanvasRect();
        return {
            x: (clientX - rect.left) / rect.width,
            y: (clientY - rect.top)  / rect.height
        };
    }

    private getCanvasRect(): DOMRect {
        if (!this.cachedRect) this.cachedRect = this.canvas.getBoundingClientRect();
        return this.cachedRect;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CANVAS TRANSFORM
    // ─────────────────────────────────────────────────────────────────────────

    private updateCanvasTransform() {
        const s    = this.canvas.style;
        const zoom = this.nav.state.zoom;
        s.width     = `${this.canvasSize.width  * zoom}px`;
        s.height    = `${this.canvasSize.height * zoom}px`;
        s.left      = `calc(50% + ${this.nav.state.x}px)`;
        s.top       = `calc(50% + ${this.nav.state.y}px)`;
        s.transform = `translate(-50%, -50%)`;
        s.position  = 'absolute';
        this.cachedRect = null;
    }
}
