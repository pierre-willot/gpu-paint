import { WorkerBridge }         from '../../renderer/worker-bridge';
import { PaintPipeline }        from '../../renderer/pipeline';
import { FLOATS_PER_STAMP }     from '../../renderer/pipeline-cache';
import type { BrushBlendMode }  from '../../renderer/brush-descriptor';
import type { BrushDescriptor } from '../../renderer/brush-descriptor';
import { Tool }                 from '../tool';

export abstract class BaseTool implements Tool {
    protected strokeEngine = new WorkerBridge();

    private chunks:     Float32Array[] = [];
    private stampCount: number         = 0;
    private readonly MAX_STAMPS        = 8000;

    public onPartialFlush:
        | ((stamps: Float32Array, layerIndex: number, blendMode: BrushBlendMode) => void)
        | null = null;

    // ── Straight line state (Photoshop-style) ────────────────────────────────
    // Shift+click: draws a line from the last pen-up position to the new click.
    // Shift+drag:  constrains the line to the nearest 45° angle (H, V, diagonal).
    // lastPenUpPos persists across strokes so consecutive Shift+clicks form
    // connected segments (same behaviour as Photoshop).
    private shiftDown      = false;
    private shiftStart:    { x: number; y: number; pressure: number } | null = null;
    private currentPos:    { x: number; y: number; pressure: number } = { x: 0, y: 0, pressure: 1 };
    private straightActive = false;
    private lastPenUpPos:  { x: number; y: number; pressure: number } | null = null;

    constructor() {
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Shift') this.shiftDown = true;
        });
        window.addEventListener('keyup', (e) => {
            if (e.key === 'Shift') {
                this.shiftDown = false;
                // If user releases Shift mid-line, cancel the line gesture cleanly
                if (this.straightActive) {
                    this.straightActive = false;
                    this.shiftStart     = null;
                }
            }
        });
    }

    protected onBeforeStroke(_pipeline: PaintPipeline): void {}
    protected onAfterStroke(_pipeline: PaintPipeline):  void {}
    protected onResetRenderer(_pipeline: PaintPipeline): void {}

    /** Override in subclasses to route stamps to a different renderer. */
    protected drawToLayer(stamps: Float32Array, pipeline: PaintPipeline): void {
        pipeline.draw(stamps);
    }

    public abstract getDescriptor(): BrushDescriptor;

    public get blendMode(): BrushBlendMode { return this.getDescriptor().blendMode; }
    public get isActive():  boolean {
        return this.strokeEngine.isDrawing || this.straightActive;
    }

    public pushDescriptor(): void {
        this.strokeEngine.setDescriptor(this.getDescriptor());
    }

    public setPressureLUT(lut: Float32Array): void {
        this.strokeEngine.setPressureLUT(lut);
    }

    // ── Prediction — used for BOTH stroke prediction AND straight-line preview ─

    public getPrediction(): Float32Array {
        if (this.straightActive && this.shiftStart) {
            // Preview: line from shiftStart (= last pen-up) to constrained current pos
            const end = this.constrainTo45(
                this.shiftStart.x, this.shiftStart.y,
                this.currentPos.x, this.currentPos.y
            );
            return this.generateLineStamps(
                this.shiftStart.x,  this.shiftStart.y,  this.shiftStart.pressure,
                end.x,              end.y,               this.currentPos.pressure,
                0.5 // half opacity for the ghost preview
            );
        }
        // During normal strokes, don't show prediction — it overlaps committed
        // stamps and causes a transparency mismatch before vs after release.
        return new Float32Array();
    }

    // ── Pointer events ────────────────────────────────────────────────────────

    onPointerDown(
        x: number, y: number, pressure: number,
        pipeline: PaintPipeline,
        tiltX = 0, tiltY = 0
    ): void {
        this.currentPos = { x, y, pressure };
        this.pushDescriptor();
        this.onBeforeStroke(pipeline);

        if (this.shiftDown) {
            // Straight-line gesture: start from the last pen-up position so that
            // Shift+click behaves like Photoshop (line from previous endpoint).
            // Fall back to the current pointer position on the very first stroke.
            this.shiftStart     = this.lastPenUpPos ?? { x, y, pressure };
            this.straightActive = true;
            return;
        }

        this.chunks     = [];
        this.stampCount = 0;
        this.strokeEngine.beginStroke(x, y, pressure, tiltX, tiltY);
    }

    onPointerMove(
        x: number, y: number, pressure: number,
        _pipeline: PaintPipeline,
        tiltX = 0, tiltY = 0
    ): void {
        this.currentPos = { x, y, pressure };

        if (this.straightActive) {
            // Only update preview position — no stamps during move
            return;
        }

        this.strokeEngine.addPoint(x, y, pressure, tiltX, tiltY);
    }

    async onPointerUp(
        x: number, y: number, pressure: number,
        pipeline: PaintPipeline
    ): Promise<Float32Array | null> {
        this.currentPos = { x, y, pressure };

        // ── Straight line commit ───────────────────────────────────────────────
        if (this.straightActive && this.shiftStart) {
            this.straightActive = false;
            const start = this.shiftStart;
            this.shiftStart     = null;
            this.chunks         = [];
            this.stampCount     = 0;

            // Apply 45° constraint: snap to nearest horizontal, vertical, or diagonal
            const end = this.constrainTo45(start.x, start.y, x, y);

            // Use worker so the line gets pressure dynamics + pressure curve.
            // The Catmull-Rom spline needs 4 points to emit a segment: buffer starts
            // as [A,A,A] after beginStroke, so one addPoint gives [A,A,A,B] and
            // stamps the A→A segment (zero length). A second addPoint gives [A,A,A,B,B]
            // and stamps the A→B segment — which is the line we want.
            this.strokeEngine.beginStroke(start.x, start.y, start.pressure);
            this.strokeEngine.addPoint(end.x, end.y, pressure);
            this.strokeEngine.addPoint(end.x, end.y, pressure); // forces A→B segment
            const stamps = await this.strokeEngine.endStrokeAndFlush();

            if (stamps.length > 0) {
                this.drawToLayer(stamps, pipeline);
                this.onAfterStroke(pipeline);
                this.lastPenUpPos = { x: end.x, y: end.y, pressure };
                return stamps;
            }
            this.onAfterStroke(pipeline);
            this.lastPenUpPos = { x: end.x, y: end.y, pressure };
            return null;
        }

        // ── Normal stroke commit ───────────────────────────────────────────────
        this.strokeEngine.addPoint(x, y, pressure);
        const finalStamps = await this.strokeEngine.endStrokeAndFlush();

        if (finalStamps.length > 0) {
            this.drawToLayer(finalStamps, pipeline);
            this.chunks.push(finalStamps);
            this.stampCount += finalStamps.length / FLOATS_PER_STAMP;
        }

        this.onAfterStroke(pipeline);
        this.lastPenUpPos = { x, y, pressure };
        return this.mergeAndReset();
    }

    renderTick(pipeline: PaintPipeline): Float32Array {
        if (this.straightActive) return new Float32Array(); // no ticks during line gesture

        const stamps = this.strokeEngine.flush();
        if (stamps.length > 0) {
            this.drawToLayer(stamps, pipeline);
            this.chunks.push(stamps);
            this.stampCount += stamps.length / FLOATS_PER_STAMP;
            if (this.stampCount >= this.MAX_STAMPS) this.triggerPartialFlush(pipeline);
        }
        return stamps;
    }

    reset(pipeline: PaintPipeline): void {
        this.strokeEngine.reset();
        this.chunks         = [];
        this.stampCount     = 0;
        this.straightActive = false;
        this.shiftStart     = null;
        this.onResetRenderer(pipeline);
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Generates evenly-spaced stamp positions along a straight line.
     * Used for both the live straight-line preview and the final commit.
     */
    private generateLineStamps(
        x0: number, y0: number, p0: number,
        x1: number, y1: number, p1: number,
        opacityMultiplier = 1.0
    ): Float32Array {
        const d = this.getDescriptor();
        const dx = x1 - x0, dy = y1 - y0;
        const len = Math.sqrt(dx * dx + dy * dy);
        const spacing = Math.max(0.001, d.size * d.spacing);
        if (len < 1e-6) return new Float32Array();

        const count = Math.max(2, Math.ceil(len / spacing) + 1);
        const stamps = new Float32Array(count * FLOATS_PER_STAMP);
        const angleRad = d.angle * (Math.PI / 180);

        for (let i = 0; i < count; i++) {
            const t   = i / (count - 1);
            const o   = i * FLOATS_PER_STAMP;
            const eff = Math.max(0.05, p0 + (p1 - p0) * t);

            stamps[o]    = x0 + dx * t;
            stamps[o+1]  = y0 + dy * t;
            stamps[o+2]  = eff;
            stamps[o+3]  = d.size * (1 - d.pressureSize * (1 - eff));
            stamps[o+4]  = d.color[0];
            stamps[o+5]  = d.color[1];
            stamps[o+6]  = d.color[2];
            stamps[o+7]  = d.color[3];
            stamps[o+8]  = 0; // tiltX
            stamps[o+9]  = 0; // tiltY
            stamps[o+10] = d.opacity * d.flow * (1 - d.pressureOpacity * (1 - eff)) * opacityMultiplier;
            stamps[o+11] = angleRad;
            stamps[o+12] = d.roundness; // roundness
            stamps[o+13] = 1.0;         // grainDepthScale
            // [o+14], [o+15] = 0 (pad — Float32Array is zero-initialised)
        }

        return stamps;
    }

    /**
     * Snaps the vector (sx,sy)→(ex,ey) to the nearest 45° angle.
     * Returns the new endpoint (distance preserved, angle snapped).
     */
    private constrainTo45(sx: number, sy: number, ex: number, ey: number): { x: number; y: number } {
        const dx = ex - sx, dy = ey - sy;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: ex, y: ey };
        const len     = Math.sqrt(dx * dx + dy * dy);
        const angle   = Math.atan2(dy, dx);
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        return { x: sx + len * Math.cos(snapped), y: sy + len * Math.sin(snapped) };
    }

    private triggerPartialFlush(pipeline: PaintPipeline): void {
        if (this.chunks.length === 0 || !this.onPartialFlush) return;
        const merged    = this.merge(this.chunks);
        this.chunks     = [];
        this.stampCount = 0;
        this.onPartialFlush(merged, pipeline.activeLayerIndex, this.blendMode);
    }

    private mergeAndReset(): Float32Array | null {
        if (this.chunks.length === 0) return null;
        const merged = this.merge(this.chunks);
        this.chunks = []; this.stampCount = 0;
        return merged;
    }

    private merge(chunks: Float32Array[]): Float32Array {
        const total  = chunks.reduce((s, c) => s + c.length, 0);
        const merged = new Float32Array(total);
        let   offset = 0;
        for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
        return merged;
    }
}
