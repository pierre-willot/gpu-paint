import { StrokePredictor, Point } from "./strokePrediction";

export class StrokeEngine {
  private buffer: Point[] = [];
  private stamps: number[] = [];
  private predictor = new StrokePredictor(); 
  public isDrawing = false;

  public beginStroke(x: number, y: number, p: number) {
    this.isDrawing = true;
    this.stamps = [];
    this.predictor.reset();
    
    const startPoint = { x, y, p };
    this.buffer = [startPoint, startPoint, startPoint];
    this.predictor.update(startPoint);
  }

  public addPoint(x: number, y: number, p: number) {
    if (!this.isDrawing) return;

    const currentPoint = { x, y, p };
    this.buffer.push(currentPoint);
    this.predictor.update(currentPoint); 

    if (this.buffer.length >= 4) {
      const p0 = this.buffer[this.buffer.length - 4];
      const p1 = this.buffer[this.buffer.length - 3];
      const p2 = this.buffer[this.buffer.length - 2];
      const p3 = this.buffer[this.buffer.length - 1];

      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const pt = this.catmullRom(p0, p1, p2, p3, t);
        this.stamps.push(pt.x, pt.y, pt.p);
      }
    }
  }
public flush(): Float32Array {
  if (this.stamps.length === 0) return new Float32Array([]);
  
  // Convert the number array to the Float32Array the GPU expects
  const data = new Float32Array(this.stamps);
  
  // CRITICAL: Clear the internal stamps so we don't draw them twice
  this.stamps = [];
  
  return data;
}

public endStroke(x: number, y: number, p: number) {
  this.isDrawing = false;
  // Clear the points buffer so the next stroke doesn't 
  // try to connect to the end of the previous one
  this.buffer = [];
  this.predictor.reset();
}

public getPredictedStamps(): Float32Array {
  const prediction = this.predictor.getPrediction(8);
  
  // Guard: if no prediction OR no points in buffer yet, return empty
  if (prediction.length === 0 || this.buffer.length === 0) {
      return new Float32Array([]);
  }

  const lastPoint = this.buffer[this.buffer.length - 1];

  for (let i = 0; i < prediction.length / 3; i++) {
    const pIndex = i * 3 + 2;
    const falloff = 1.0 - (i / (prediction.length / 3)); 
    
    // Use the last known pressure from the buffer as the base for the fade
    prediction[pIndex] = lastPoint.p * falloff * 0.5;
  }
  
  return prediction;
}
  private catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const t2 = t * t; const t3 = t2 * t;
    const f = (a: number, b: number, c: number, d: number) =>
      0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);

    return {
      x: f(p0.x, p1.x, p2.x, p3.x),
      y: f(p0.y, p1.y, p2.y, p3.y),
      p: f(p0.p, p1.p, p2.p, p3.p)
    };
  }
}