import { BaseTool }                  from './base-tool';
import { defaultBrushDescriptor, cloneDescriptor } from '../../renderer/brush-descriptor';
import type { BrushDescriptor }      from '../../renderer/brush-descriptor';

export class BrushTool extends BaseTool {
    private _descriptor: BrushDescriptor = defaultBrushDescriptor();

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

    /** Replace the entire descriptor (loading a brush preset). */
    public loadDescriptor(d: BrushDescriptor): void {
        this._descriptor = cloneDescriptor(d);
        this.pushDescriptor();
    }
}
