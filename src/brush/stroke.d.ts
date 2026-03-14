export declare class StrokeEngine {
    isDrawing: boolean;
    private lastX;
    private lastY;
    private lastP;
    private stamps;
    private followX;
    private followY;
    private followP;
    private lerpAmount;
    beginStroke(x: number, y: number, p: number): void;
    addPoint(x: number, y: number, p: number): void;
    endStroke(x: number, y: number, p: number): void;
    private stamp;
    flush(): Float32Array;
}
//# sourceMappingURL=stroke.d.ts.map