import { BaseTool }                 from './base-tool';
import { defaultEraserDescriptor } from '../../renderer/brush-descriptor';
import type { BrushDescriptor }    from '../../renderer/brush-descriptor';
import type { PaintPipeline }      from '../../renderer/pipeline';

export class EraserTool extends BaseTool {
    private _descriptor: BrushDescriptor = defaultEraserDescriptor();

    public getDescriptor(): BrushDescriptor { return this._descriptor; }

    public getPrediction(): Float32Array { return new Float32Array(); }

    // Eraser blend mode comes from the descriptor — no need to call
    // brushRenderer.setConfig() manually anymore.
    protected onBeforeStroke(pipeline: PaintPipeline): void {
        pipeline.brushRenderer.setConfig({ blendMode: 'erase', hardness: this._descriptor.hardness });
    }
    protected onAfterStroke(pipeline: PaintPipeline): void {
        pipeline.brushRenderer.setConfig({ blendMode: 'normal' });
    }
    protected onResetRenderer(pipeline: PaintPipeline): void {
        pipeline.brushRenderer.setConfig({ blendMode: 'normal' });
    }

    public setSize(size: number): void {
        this._descriptor.size = Math.max(0.001, Math.min(1, size));
        this.pushDescriptor();
    }

    public setHardness(hardness: number): void {
        this._descriptor.hardness = Math.max(0, Math.min(1, hardness));
        this.pushDescriptor();
    }
}
