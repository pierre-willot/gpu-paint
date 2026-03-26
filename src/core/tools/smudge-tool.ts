import { BaseTool }                           from './base-tool';
import { defaultBrushDescriptor }             from '../../renderer/brush-descriptor';
import type { BrushDescriptor }               from '../../renderer/brush-descriptor';
import type { PaintPipeline }                 from '../../renderer/pipeline';
import { FLOATS_PER_STAMP }                  from '../../renderer/pipeline-cache';

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

export class SmudgeTool extends BaseTool {
    private _descriptor: BrushDescriptor;

    // Previous stamp position — carried across renderTick batches so each
    // batch's first stamp knows where to sample carry from.
    private lastStampX = -1;
    private lastStampY = -1;

    // Accumulated normalised stroke distance since stroke start — drives attack/grade.
    private strokeDistNorm = 0;

    constructor() {
        super();
        this._descriptor = {
            ...defaultBrushDescriptor(),
            size:            0.05,
            hardness:        0.5,
            spacing:         0.10,
            opacity:         1.0,
            flow:            1.0,
            pressureSize:    0.5,
            pressureOpacity: 0.0,
            smudge:          0.8,   // pull
            smudgeCharge:    0.8,
            smudgeDilution:  0.0,
            smudgeAttack:    0.0,
            smudgeGrade:     0.0,
            blendMode:       'normal',
        };
    }

    public getDescriptor(): BrushDescriptor { return this._descriptor; }

    public setSize(v: number):     void { this._descriptor.size          = v; this.pushDescriptor(); }
    public setHardness(v: number): void { this._descriptor.hardness      = v; this.pushDescriptor(); }
    public setStrength(v: number): void { this._descriptor.smudge        = v; this.pushDescriptor(); }
    public setCharge(v: number):   void { this._descriptor.smudgeCharge  = v; }
    public setDilution(v: number): void { this._descriptor.smudgeDilution = v; }
    public setAttack(v: number):   void { this._descriptor.smudgeAttack  = v; }
    public setGrade(v: number):    void { this._descriptor.smudgeGrade   = v; }
    public setSpacing(v: number):  void { this._descriptor.spacing       = v; this.pushDescriptor(); }
    public setOpacity(v: number):  void { this._descriptor.opacity       = v; this.pushDescriptor(); }

    // ── BaseTool hooks ────────────────────────────────────────────────────────

    /** Seed carry texture from active layer before first stamp is drawn. */
    protected onBeforeStroke(pipeline: PaintPipeline): void {
        this.lastStampX    = -1;
        this.lastStampY    = -1;
        this.strokeDistNorm = 0;
        pipeline.beginSmudgeStroke();
    }

    /**
     * Encodes per-stamp data into repurposed color slots before GPU submission:
     *   color.xy (stamp[4..5]) — previous stamp centre (advects carry forward)
     *   color.z  (stamp[6])    — dynstr = attack × grade (CPU stroke dynamics)
     *
     * Attack ramps from 0→1 over the first smudgeAttack normalised canvas units.
     * Grade decays from 1→0 over smudgeGrade normalised canvas units.
     * Both are 1.0 when the respective distance is 0 (disabled).
     */
    protected drawToLayer(stamps: Float32Array, pipeline: PaintPipeline): void {
        if (!stamps.length) return;

        const patched = new Float32Array(stamps);
        const d = this._descriptor;

        for (let i = 0; i < patched.length; i += FLOATS_PER_STAMP) {
            const cx = patched[i];
            const cy = patched[i + 1];

            const prevX = (i === 0)
                ? (this.lastStampX < 0 ? cx : this.lastStampX)
                : patched[i - FLOATS_PER_STAMP];
            const prevY = (i === 0)
                ? (this.lastStampY < 0 ? cy : this.lastStampY)
                : patched[i - FLOATS_PER_STAMP + 1];

            // Accumulate stroke distance in normalised canvas units
            const dx = cx - prevX, dy = cy - prevY;
            this.strokeDistNorm += Math.sqrt(dx * dx + dy * dy);

            // Attack: smoothstep ramp-in over first smudgeAttack units
            const atk = d.smudgeAttack > 0
                ? smoothstep(0, d.smudgeAttack, this.strokeDistNorm)
                : 1.0;

            // Grade: linear decay over smudgeGrade units from stroke start
            const grd = d.smudgeGrade > 0
                ? Math.max(0, 1 - this.strokeDistNorm / d.smudgeGrade)
                : 1.0;

            patched[i + 4] = prevX;       // color.r → prev_center.x
            patched[i + 5] = prevY;       // color.g → prev_center.y
            patched[i + 6] = atk * grd;   // color.z → dynstr
        }

        // Remember last stamp position for next batch
        const last = patched.length - FLOATS_PER_STAMP;
        this.lastStampX = patched[last];
        this.lastStampY = patched[last + 1];

        pipeline.drawSmudge(patched, d);
    }
}
