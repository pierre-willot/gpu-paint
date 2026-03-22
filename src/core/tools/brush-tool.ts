import { BaseTool }                  from './base-tool';
import { defaultBrushDescriptor, cloneDescriptor } from '../../renderer/brush-descriptor';
import type { BrushDescriptor }      from '../../renderer/brush-descriptor';
import type { PaintPipeline }        from '../../renderer/pipeline';
import { FLOATS_PER_STAMP }         from '../../renderer/pipeline-cache';

export class BrushTool extends BaseTool {
    private _descriptor: BrushDescriptor = defaultBrushDescriptor();

    // Previous smudge-stamp position for inter-batch carry advection.
    // Reset at each stroke start so each stroke seeds fresh from the layer.
    private lastSmudgeX = -1;
    private lastSmudgeY = -1;

    public getDescriptor(): BrushDescriptor {
        return this._descriptor;
    }

    public getPrediction(): Float32Array {
        return this.strokeEngine.getPredictedStamps();
    }

    // ── Property setters — each pushes descriptor to worker ──────────────────

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

    public setMix(mix: number): void {
        this._descriptor.smudge = Math.max(0, Math.min(1, mix));
        this.pushDescriptor();
    }

    /** Replace the entire descriptor (loading a brush preset). */
    public loadDescriptor(d: BrushDescriptor): void {
        this._descriptor = cloneDescriptor(d);
        this.pushDescriptor();
    }

    // ── BaseTool hooks — smudge pass when mix > 0 ─────────────────────────────

    protected override onBeforeStroke(pipeline: PaintPipeline): void {
        this.lastSmudgeX = -1;
        this.lastSmudgeY = -1;
        if (this._descriptor.smudge > 0) pipeline.beginSmudgeStroke();
    }

    /**
     * When mix > 0: smudge pass first (drag existing paint), then paint on top.
     * Paint opacity is scaled by (1 - mix) so at mix=1 only smudge runs (pure drag),
     * at mix=0.5 smudge at half strength + paint at half opacity — both visible.
     * Without the opacity scale, full-opacity paint covers the smudge completely.
     */
    protected override drawToLayer(stamps: Float32Array, pipeline: PaintPipeline): void {
        const mix = this._descriptor.smudge;
        if (mix > 0 && stamps.length >= FLOATS_PER_STAMP) {
            const smudgeStamps = new Float32Array(stamps);
            for (let i = 0; i < smudgeStamps.length; i += FLOATS_PER_STAMP) {
                const prevX = (i === 0)
                    ? (this.lastSmudgeX < 0 ? smudgeStamps[i] : this.lastSmudgeX)
                    : stamps[i - FLOATS_PER_STAMP];
                const prevY = (i === 0)
                    ? (this.lastSmudgeY < 0 ? smudgeStamps[i + 1] : this.lastSmudgeY)
                    : stamps[i - FLOATS_PER_STAMP + 1];
                smudgeStamps[i + 4] = prevX;
                smudgeStamps[i + 5] = prevY;
            }
            const last = smudgeStamps.length - FLOATS_PER_STAMP;
            this.lastSmudgeX = smudgeStamps[last];
            this.lastSmudgeY = smudgeStamps[last + 1];
            pipeline.drawSmudge(smudgeStamps, this._descriptor);

            // Mix=1: pure smudge, no new paint
            if (mix >= 1) return;

            // Mix 0..1: paint at reduced opacity so smudge shows through
            const paintStamps  = new Float32Array(stamps);
            const paintOpacity = 1 - mix;
            for (let i = 0; i < paintStamps.length; i += FLOATS_PER_STAMP) {
                paintStamps[i + 10] *= paintOpacity; // float[10] = per-stamp opacity
            }
            pipeline.draw(paintStamps);
        } else {
            pipeline.draw(stamps);
        }
    }
}
