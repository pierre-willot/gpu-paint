import { PaintPipeline } from "../renderer/pipeline";
import { BrushBlendMode } from "../renderer/pipeline-cache";

export interface Tool {
    onPointerDown(
        x:        number,
        y:        number,
        pressure: number,
        pipeline: PaintPipeline,
        tiltX:    number,
        tiltY:    number
    ): void;

    onPointerMove(
        x:        number,
        y:        number,
        pressure: number,
        pipeline: PaintPipeline,
        tiltX:    number,
        tiltY:    number
    ): void;

    onPointerUp(
        x:        number,
        y:        number,
        pressure: number,
        pipeline: PaintPipeline
    ): Promise<Float32Array | null>;

    reset(pipeline: PaintPipeline): void;
    renderTick(pipeline: PaintPipeline): Float32Array;
    getPrediction(): Float32Array;

    readonly blendMode: BrushBlendMode;
    readonly isActive:  boolean;
}
