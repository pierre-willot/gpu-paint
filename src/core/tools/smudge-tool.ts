import { BaseTool }                           from './base-tool';
import { defaultBrushDescriptor }             from '../../renderer/brush-descriptor';
import type { BrushDescriptor }               from '../../renderer/brush-descriptor';
import type { PaintPipeline }                 from '../../renderer/pipeline';
import { FLOATS_PER_STAMP }                  from '../../renderer/pipeline-cache';

export class SmudgeTool extends BaseTool {
    private _descriptor: BrushDescriptor;

    // Previous stamp position — carried across renderTick batches so each
    // batch's first stamp knows where to sample carry from.
    private lastStampX = -1;
    private lastStampY = -1;

    constructor() {
        super();
        this._descriptor = {
            ...defaultBrushDescriptor(),
            size:            0.05,
            hardness:        0.5,   // softer default for natural smear
            spacing:         0.10,  // tight spacing for smooth, gapless drag
            opacity:         1.0,
            flow:            1.0,
            pressureSize:    0.5,   // pressure narrows the brush tip
            pressureOpacity: 0.0,
            smudge:          0.8,   // pickup strength (0 = none, 1 = full transfer)
            blendMode:       'normal',
        };
    }

    public getDescriptor(): BrushDescriptor { return this._descriptor; }

    public setSize(v: number):     void { this._descriptor.size     = v; this.pushDescriptor(); }
    public setHardness(v: number): void { this._descriptor.hardness = v; this.pushDescriptor(); }
    public setStrength(v: number): void { this._descriptor.smudge   = v; this.pushDescriptor(); }
    public setSpacing(v: number):  void { this._descriptor.spacing  = v; this.pushDescriptor(); }
    public setOpacity(v: number):  void { this._descriptor.opacity  = v; this.pushDescriptor(); }

    // ── BaseTool hooks ────────────────────────────────────────────────────────

    /** Seed carry texture from active layer before first stamp is drawn. */
    protected onBeforeStroke(pipeline: PaintPipeline): void {
        this.lastStampX = -1; // reset so first stamp uses its own position
        this.lastStampY = -1;
        pipeline.beginSmudgeStroke();
    }

    /**
     * Encodes the previous stamp center into the color slot (floats 4-5) of each
     * stamp, then routes through SmudgeRenderer.
     *
     * The smudge shader samples carry from in.prev_center (the previous stamp's
     * normalized position) rather than the fragment's own UV. This advects the
     * carried color forward along the stroke — the fundamental mechanism for
     * moving pixels.
     */
    protected drawToLayer(stamps: Float32Array, pipeline: PaintPipeline): void {
        if (!stamps.length) return;

        const patched = new Float32Array(stamps); // copy so we don't mutate the original

        for (let i = 0; i < patched.length; i += FLOATS_PER_STAMP) {
            const cx = patched[i];     // current stamp normalized x
            const cy = patched[i + 1]; // current stamp normalized y

            // For stamp 0 in this batch: use lastStampX/Y from previous batch.
            // If no previous stamp exists yet, use the current position (no drag on first stamp).
            const prevX = (i === 0)
                ? (this.lastStampX < 0 ? cx : this.lastStampX)
                : patched[i - FLOATS_PER_STAMP];
            const prevY = (i === 0)
                ? (this.lastStampY < 0 ? cy : this.lastStampY)
                : patched[i - FLOATS_PER_STAMP + 1];

            patched[i + 4] = prevX; // color.r repurposed as prev_center.x
            patched[i + 5] = prevY; // color.g repurposed as prev_center.y
        }

        // Remember last stamp position for next batch
        const last = patched.length - FLOATS_PER_STAMP;
        this.lastStampX = patched[last];
        this.lastStampY = patched[last + 1];

        pipeline.drawSmudge(patched, this._descriptor);
    }
}
