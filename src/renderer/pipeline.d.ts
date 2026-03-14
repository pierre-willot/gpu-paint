export declare class PaintPipeline {
    private device;
    private context;
    private format;
    private renderTarget;
    private pipeline;
    private bindGroup;
    private resolutionBuffer;
    constructor(device: GPUDevice, context: GPUCanvasContext, format: GPUTextureFormat, canvasWidth: number, canvasHeight: number);
    updateUniforms(w: number, h: number, size: number): void;
    private initCanvas;
    draw(stamps: Float32Array): void;
    resize(newWidth: number, newHeight: number, currentBrushSize: number): void;
    clear(): void;
    saveImage(): Promise<void>;
}
//# sourceMappingURL=pipeline.d.ts.map