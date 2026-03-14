export interface Point {
    x: number;
    y: number;
    p: number;
}

export class StrokePredictor {
    private lastPoint: Point | null = null;
    private velocity: Point = { x: 0, y: 0, p: 0 };
    
    private readonly lookAhead = 1.2; 
    private readonly damping = 0.8;

    public update(currentPoint: Point) {
        if (this.lastPoint) {
            this.velocity = {
                x: (currentPoint.x - this.lastPoint.x) * this.damping,
                y: (currentPoint.y - this.lastPoint.y) * this.damping,
                p: (currentPoint.p - this.lastPoint.p) * this.damping
            };
        }
        this.lastPoint = currentPoint;
    }

    public getPrediction(steps: number = 5): Float32Array {
        // Return empty if we aren't moving or don't have enough data
        if (!this.lastPoint || (Math.abs(this.velocity.x) < 0.0001 && Math.abs(this.velocity.y) < 0.0001)) {
            return new Float32Array([]);
        }

        const predictionData = new Float32Array(steps * 3);
        for (let i = 0; i < steps; i++) {
            const t = (i + 1) / steps;
            predictionData[i * 3 + 0] = this.lastPoint.x + (this.velocity.x * this.lookAhead * t);
            predictionData[i * 3 + 1] = this.lastPoint.y + (this.velocity.y * this.lookAhead * t);
            predictionData[i * 3 + 2] = this.lastPoint.p + (this.velocity.p * this.lookAhead * t);
        }
        return predictionData;
    }

    public reset() {
        this.lastPoint = null;
        this.velocity = { x: 0, y: 0, p: 0 };
    }
}