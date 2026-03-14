// brush/stroke.ts
export class StrokeEngine {
  public isDrawing = false;

  private lastX = 0;
  private lastY = 0;
  private lastP = 0;
  private stamps: number[] = [];

  private followX = 0;
  private followY = 0;
  private followP = 0;
  private lerpAmount = 0.4; 

  beginStroke(x: number, y: number, p: number) {
    this.isDrawing = true;
    this.lastX = x;
    this.lastY = y;
    this.lastP = p;
    this.followX = x;
    this.followY = y;
    this.followP = p;
    this.stamps = [];
  }

  addPoint(x: number, y: number, p: number) {
    if (!this.isDrawing) return;

    // 1. Stabilizer: Follow the pen
    this.followX += (x - this.followX) * this.lerpAmount;
    this.followY += (y - this.followY) * this.lerpAmount;
    this.followP += (p - this.followP) * this.lerpAmount;

    // 2. Distance in 0.0-1.0 space
    const dx = this.followX - this.lastX;
    const dy = this.followY - this.lastY;
    const dp = this.followP - this.lastP;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // 3. Spacing: 0.001 is dense enough for a smooth line
    const spacing = 0.0015;
    const steps = Math.min(100, Math.max(1, Math.floor(dist / spacing)));

    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      this.stamp(
        this.lastX + dx * t,
        this.lastY + dy * t,
        this.lastP + dp * t
      );
    }

    this.lastX = this.followX;
    this.lastY = this.followY;
    this.lastP = this.followP;
  }

 endStroke(x: number, y: number, p: number) {
  if (!this.isDrawing) return;

  // 1. Force the follower to jump to the final actual position
  // This "closes the gap" created by the smoothing
  this.followX = x;
  this.followY = y;
  this.followP = p;

  // 2. Draw one final segment from the last stamped position to this end position
  this.addPoint(x, y, p);

  this.isDrawing = false;
}

  private stamp(x: number, y: number, p: number) {
    if (isNaN(x) || isNaN(y) || isNaN(p)) return;
    this.stamps.push(x, y, p);
  }

  flush(): Float32Array {
    const data = new Float32Array(this.stamps);
    this.stamps = [];
    return data;
  }
}