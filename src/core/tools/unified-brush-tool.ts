import { BaseTool }                                 from './base-tool';
import { defaultBrushDescriptor, cloneDescriptor } from '../../renderer/brush-descriptor';
import type { BrushDescriptor }                    from '../../renderer/brush-descriptor';
import type { PaintPipeline }                      from '../../renderer/pipeline';
import { FLOATS_PER_STAMP }                        from '../../renderer/pipeline-cache';

export type StrokeMode = 'paint' | 'smudge';

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * Unified brush tool — handles paint, smudge, and wet-mix paint+smudge in one class.
 *
 * A single BrushDescriptor is shared across all modes:
 *   • Paint mode  — deposits color; optionally runs a smudge pre-pass when smudge > 0.
 *   • Smudge mode — manipulates existing pixels only; no color deposit.
 *
 * Switching modes does NOT reset the descriptor — size, hardness, spacing, smudge
 * params etc. are persistent across mode changes.
 *
 * `toolName` returns a virtual name ('BrushTool' or 'SmudgeTool') so that all
 * existing UI checks (isSmudge(), isEraser(), tool:change bus events) continue
 * to work without modification.
 */
export class UnifiedBrushTool extends BaseTool {
    private _descriptor: BrushDescriptor = defaultBrushDescriptor();
    public  mode: StrokeMode = 'paint';

    // ── Smudge stroke state (reset at each stroke start) ─────────────────────
    private lastSmudgeX    = -1;
    private lastSmudgeY    = -1;
    private strokeDistNorm  = 0;

    /** Virtual tool name for bus events and UI mode checks. */
    public get toolName(): string {
        return this.mode === 'smudge' ? 'SmudgeTool' : 'BrushTool';
    }

    public getDescriptor(): BrushDescriptor { return this._descriptor; }

    /** Returns worker stamp predictions during paint strokes; empty during smudge. */
    public getPrediction(): Float32Array {
        if (this.mode === 'smudge') return super.getPrediction();
        return this.strokeEngine.getPredictedStamps();
    }

    // ── Setters — shared ──────────────────────────────────────────────────────

    public setColor(r: number, g: number, b: number, a = 1): void {
        this._descriptor.color = [r, g, b, a];
        this.pushDescriptor();
    }

    public getCurrentColor(): [number, number, number, number] {
        return [...this._descriptor.color] as [number, number, number, number];
    }

    public setSize(size: number): void {
        this._descriptor.size = Math.max(0.001, Math.min(1, size));
        this.pushDescriptor();
    }

    public setOpacity(opacity: number): void {
        this._descriptor.opacity = Math.max(0, Math.min(1, opacity));
        this.pushDescriptor();
    }

    public setFlow(flow: number): void {
        this._descriptor.flow = Math.max(0, Math.min(1, flow));
        this.pushDescriptor();
    }

    public setHardness(hardness: number): void {
        this._descriptor.hardness = Math.max(0, Math.min(1, hardness));
        this.pushDescriptor();
    }

    public setSpacing(spacing: number): void {
        this._descriptor.spacing = Math.max(0.01, Math.min(2, spacing));
        this.pushDescriptor();
    }

    public setSmoothing(strength: number): void {
        this.strokeEngine.smoothingStrength = Math.max(0, Math.min(1, strength));
    }

    /** Paint wet-mix / smudge pull strength — same descriptor field, different label per mode. */
    public setMix(mix: number): void {
        this._descriptor.smudge = Math.max(0, Math.min(1, mix));
        this.pushDescriptor();
    }

    /** Alias for setMix — used by smudge mode UI bindings. */
    public setStrength(v: number): void { this.setMix(v); }

    // ── Smudge-specific setters ───────────────────────────────────────────────

    public setCharge(v: number):   void { this._descriptor.smudgeCharge   = v; }
    public setDilution(v: number): void { this._descriptor.smudgeDilution = v; }
    public setAttack(v: number):   void { this._descriptor.smudgeAttack   = v; }
    public setGrade(v: number):    void { this._descriptor.smudgeGrade    = v; }

    /** Replace the entire descriptor (loading a brush preset). */
    public loadDescriptor(d: BrushDescriptor): void {
        this._descriptor = cloneDescriptor(d);
        this.pushDescriptor();
    }

    // ── BaseTool hooks ────────────────────────────────────────────────────────

    protected override onBeforeStroke(pipeline: PaintPipeline): void {
        this.lastSmudgeX    = -1;
        this.lastSmudgeY    = -1;
        this.strokeDistNorm  = 0;
        if (this.mode === 'smudge' || this._descriptor.smudge > 0) {
            pipeline.beginSmudgeStroke();
        }
    }

    protected override drawToLayer(stamps: Float32Array, pipeline: PaintPipeline): void {
        if (this.mode === 'smudge') {
            this.smudgePass(stamps, pipeline);
        } else {
            this.paintPass(stamps, pipeline);
        }
    }

    // ── Private passes ────────────────────────────────────────────────────────

    /**
     * Full smudge-only pass: packs prev_center (stamp[4,5]) and dynstr (stamp[6])
     * into the color slots before GPU submission.
     *
     * dynstr = attack × grade — CPU-computed stroke dynamics:
     *   attack: smoothstep ramp-in over the first smudgeAttack normalised units
     *   grade:  linear decay from 1→0 over smudgeGrade normalised units
     */
    private smudgePass(stamps: Float32Array, pipeline: PaintPipeline): void {
        if (!stamps.length) return;

        const patched = new Float32Array(stamps);
        const d       = this._descriptor;

        for (let i = 0; i < patched.length; i += FLOATS_PER_STAMP) {
            const cx = patched[i];
            const cy = patched[i + 1];

            const prevX = (i === 0)
                ? (this.lastSmudgeX < 0 ? cx : this.lastSmudgeX)
                : patched[i - FLOATS_PER_STAMP];
            const prevY = (i === 0)
                ? (this.lastSmudgeY < 0 ? cy : this.lastSmudgeY)
                : patched[i - FLOATS_PER_STAMP + 1];

            const dx = cx - prevX, dy = cy - prevY;
            this.strokeDistNorm += Math.sqrt(dx * dx + dy * dy);

            const atk = d.smudgeAttack > 0
                ? smoothstep(0, d.smudgeAttack, this.strokeDistNorm)
                : 1.0;
            const grd = d.smudgeGrade > 0
                ? Math.max(0, 1 - this.strokeDistNorm / d.smudgeGrade)
                : 1.0;

            patched[i + 4] = prevX;
            patched[i + 5] = prevY;
            patched[i + 6] = atk * grd;
        }

        const last = patched.length - FLOATS_PER_STAMP;
        this.lastSmudgeX = patched[last];
        this.lastSmudgeY = patched[last + 1];

        // Smudge mode never injects fresh paint — force charge=0.
        pipeline.drawSmudge(patched, { ...d, smudgeCharge: 0 });
    }

    /**
     * Paint pass.
     *
     * When pull (smudge) > 0 — Wet-brush path:
     *   Packs prev_center (color.xy) and dynstr=1.0 (color.z) into each stamp,
     *   then routes through drawSmudge.  Per stamp the shader evolves carry:
     *     Step B: carry = lerp(carry@prev_center, canvas, pull × mask)
     *     Step C: carry = lerp(carry, user_color, charge)
     *     Step D: canvas = lerp(canvas, carry, dilution × mask)
     *
     * When pull = 0 — pure paint, use the regular brush renderer.
     */
    private paintPass(stamps: Float32Array, pipeline: PaintPipeline): void {
        if (this._descriptor.smudge <= 0 || !stamps.length) {
            pipeline.draw(stamps);
            return;
        }

        const d         = this._descriptor;
        const wetStamps = new Float32Array(stamps);
        for (let i = 0; i < wetStamps.length; i += FLOATS_PER_STAMP) {
            const cx = wetStamps[i], cy = wetStamps[i + 1];
            const prevX = i === 0
                ? (this.lastSmudgeX < 0 ? cx : this.lastSmudgeX)
                : stamps[i - FLOATS_PER_STAMP];
            const prevY = i === 0
                ? (this.lastSmudgeY < 0 ? cy : this.lastSmudgeY)
                : stamps[i - FLOATS_PER_STAMP + 1];

            const dx = cx - prevX, dy = cy - prevY;
            this.strokeDistNorm += Math.sqrt(dx * dx + dy * dy);

            const atk = d.smudgeAttack > 0
                ? smoothstep(0, d.smudgeAttack, this.strokeDistNorm)
                : 1.0;
            const grd = d.smudgeGrade > 0
                ? Math.max(0, 1 - this.strokeDistNorm / d.smudgeGrade)
                : 1.0;

            wetStamps[i + 4] = prevX;      // color.x = prev_center.x
            wetStamps[i + 5] = prevY;      // color.y = prev_center.y
            wetStamps[i + 6] = atk * grd; // color.z = dynstr
        }
        const last = wetStamps.length - FLOATS_PER_STAMP;
        this.lastSmudgeX = wetStamps[last];
        this.lastSmudgeY = wetStamps[last + 1];

        pipeline.drawSmudge(wetStamps, this._descriptor);
    }
}
