import { StrokePredictor, Point } from './strokePrediction';
import { FLOATS_PER_STAMP }        from './pipeline-cache';
import type { BrushDescriptor }    from './brush-descriptor';

// ── Internal point type ───────────────────────────────────────────────────────
interface FullPoint extends Point {
    tiltX:    number;
    tiltY:    number;
    velocity: number; // pixels/second estimate, computed on addPoint
}

// ── Simple seeded PRNG (xorshift32) ──────────────────────────────────────────
// Used for per-stamp jitter. Fast, deterministic, suitable for audio-rate use.
// Does NOT need cryptographic quality — just needs to be cheap and uncorrelated.
function xorshift(seed: number): number {
    let x = seed;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return (x >>> 0) / 0xFFFFFFFF;
}

// ── StrokeEngine ──────────────────────────────────────────────────────────────

export class StrokeEngine {
    private buffer:    FullPoint[] = [];
    private stamps:    number[]    = [];
    private predictor  = new StrokePredictor();
    public  isDrawing  = false;

    private descriptor: BrushDescriptor | null = null;
    private pressureLUT: Float32Array | null    = null;

    // Adaptive spacing
    private distanceCarry: number = 0;

    // Jitter seed — advanced per stamp so consecutive stamps are uncorrelated
    private jitterSeed = 0;

    // Velocity tracking
    private lastPointTime: number = 0;

    public smoothingStrength: number = 0;

    // ── Configuration ─────────────────────────────────────────────────────────

    public setDescriptor(d: BrushDescriptor): void {
        this.descriptor = d;
    }

    public setPressureLUT(lut: Float32Array): void {
        this.pressureLUT = lut;
    }

    // ── Stroke lifecycle ──────────────────────────────────────────────────────

    public beginStroke(
        x: number, y: number, p: number,
        tiltX = 0, tiltY = 0
    ): void {
        if (!this.descriptor) return;
        this.isDrawing     = true;
        this.stamps        = [];
        this.distanceCarry = 0;
        this.jitterSeed    = (Math.random() * 0xFFFFFFFF) >>> 0;
        this.lastPointTime = performance.now();
        this.predictor.reset();

        const start: FullPoint = { x, y, p, tiltX, tiltY, velocity: 0 };
        this.buffer = [start, start, start];
        this.predictor.update(start);
    }

    public addPoint(x: number, y: number, p: number, tiltX = 0, tiltY = 0): void {
        if (!this.isDrawing || !this.descriptor) return;

        const now      = performance.now();
        const dt       = Math.max(1, now - this.lastPointTime);
        const prev     = this.buffer[this.buffer.length - 1];
        const dx       = x - prev.x, dy = y - prev.y;
        const velocity = Math.sqrt(dx*dx + dy*dy) / dt * 1000; // px/sec

        const smoothed = this.smoothPoint(x, y, p, tiltX, tiltY, velocity);
        this.buffer.push(smoothed);
        this.predictor.update(smoothed);
        this.lastPointTime = now;

        if (this.buffer.length >= 4) {
            const len = this.buffer.length;
            this.stampSegment(
                this.buffer[len-4], this.buffer[len-3],
                this.buffer[len-2], this.buffer[len-1]
            );
        }
    }

    public flush(): Float32Array {
        if (this.stamps.length === 0) return new Float32Array();
        const data  = new Float32Array(this.stamps);
        this.stamps = [];
        return data;
    }

    public endStroke(): void {
        this.isDrawing     = false;
        this.buffer        = [];
        this.distanceCarry = 0;
        this.predictor.reset();
    }

    public getPredictedStamps(): Float32Array {
        if (!this.descriptor) return new Float32Array();
        const raw = this.predictor.getPrediction(8);
        if (raw.length === 0 || this.buffer.length === 0) return new Float32Array();

        const last  = this.buffer[this.buffer.length - 1];
        const count = raw.length / 3;
        const res   = new Float32Array(count * FLOATS_PER_STAMP);
        const d     = this.descriptor;

        for (let i = 0; i < count; i++) {
            const s       = i * 3, dst = i * FLOATS_PER_STAMP;
            const falloff = 1.0 - (i / count);
            res[dst]      = raw[s];
            res[dst+1]    = raw[s+1];
            res[dst+2]    = last.p * falloff * 0.5;
            res[dst+3]    = d.size;
            res[dst+4]    = d.color[0]; res[dst+5] = d.color[1];
            res[dst+6]    = d.color[2]; res[dst+7] = d.color[3];
            res[dst+8]    = last.tiltX; res[dst+9]  = last.tiltY;
            res[dst+10]   = d.opacity * falloff * 0.5;
            res[dst+11]   = 0;
        }
        return res;
    }

    // ── Adaptive stamping ─────────────────────────────────────────────────────

    private stampSegment(p0: FullPoint, p1: FullPoint, p2: FullPoint, p3: FullPoint): void {
        const d = this.descriptor!;
        const minP    = Math.max(0.05, Math.min(p0.p, p1.p, p2.p, p3.p));
        const spacing = d.size * minP * 0.5 * d.spacing;
        if (spacing <= 0) return;

        const STEPS = 16;
        const arc   = new Float32Array(STEPS + 1);
        let   prev  = this.catmullRom(p0, p1, p2, p3, 0);

        for (let i = 1; i <= STEPS; i++) {
            const cur = this.catmullRom(p0, p1, p2, p3, i / STEPS);
            const dx  = cur.x - prev.x, dy = cur.y - prev.y;
            arc[i]    = arc[i-1] + Math.sqrt(dx*dx + dy*dy);
            prev      = cur;
        }

        const total = arc[STEPS];
        if (total < 1e-9) return;

        const carry = Math.min(this.distanceCarry, spacing - 1e-9);
        let   dist  = carry > 0 ? spacing - carry : 0;

        while (dist <= total) {
            const pt = this.catmullRom(p0, p1, p2, p3, this.arcLengthToT(arc, STEPS, dist));
            this.pushStamp(pt.x, pt.y, pt.p, pt.tiltX, pt.tiltY, pt.velocity);
            dist += spacing;
        }

        this.distanceCarry = total - (dist - spacing);
    }

    // ── Per-stamp dynamics ────────────────────────────────────────────────────

    private pushStamp(
        x: number, y: number, p: number,
        tiltX: number, tiltY: number, velocity: number
    ): void {
        const d = this.descriptor!;

        // Advance jitter seed
        this.jitterSeed = (this.jitterSeed * 1664525 + 1013904223) >>> 0;

        // ── Pressure remapping ────────────────────────────────────────────────
        const effP = this.pressureLUT ? this.mapPressure(p) : p;

        // ── Size dynamics ─────────────────────────────────────────────────────
        const sizeMultiplier = 1.0 - d.pressureSize * (1.0 - effP);
        const jitterSize     = 1.0 - d.sizeJitter * xorshift(this.jitterSeed);
        const finalSize      = d.size * sizeMultiplier * jitterSize;

        // ── Opacity dynamics ──────────────────────────────────────────────────
        const opacityMultiplier = 1.0 - d.pressureOpacity * (1.0 - effP);
        const jitterOpacity     = 1.0 - d.opacityJitter * xorshift(this.jitterSeed + 1);
        const finalOpacity      = d.opacity * d.flow * opacityMultiplier * jitterOpacity;

        // ── Color jitter ──────────────────────────────────────────────────────
        // Applied in HSV space then converted back to RGB
        let [r, g, b] = [d.color[0], d.color[1], d.color[2]];
        if (d.hueJitter > 0 || d.satJitter > 0 || d.valJitter > 0) {
            const hsv   = rgbToHsv(r, g, b);
            const hJit  = (xorshift(this.jitterSeed + 2) - 0.5) * 2 * d.hueJitter;
            const sJit  = (xorshift(this.jitterSeed + 3) - 0.5) * 2 * d.satJitter;
            const vJit  = (xorshift(this.jitterSeed + 4) - 0.5) * 2 * d.valJitter;
            const rgb   = hsvToRgb(
                (hsv.h + hJit + 360) % 360,
                Math.max(0, Math.min(1, hsv.s + sJit)),
                Math.max(0, Math.min(1, hsv.v + vJit))
            );
            r = rgb.r; g = rgb.g; b = rgb.b;
        }

        // ── Stamp angle ───────────────────────────────────────────────────────
        const angleRad   = d.angle * (Math.PI / 180);
        const jitterAng  = (xorshift(this.jitterSeed + 5) - 0.5) * 2 * d.angleJitter * (Math.PI / 180);
        const finalAngle = angleRad + jitterAng;

        this.stamps.push(
            x, y, effP, finalSize,
            r, g, b, d.color[3],
            tiltX, tiltY,
            finalOpacity, finalAngle
        );
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private smoothPoint(x: number, y: number, p: number, tiltX: number, tiltY: number, velocity: number): FullPoint {
        if (this.smoothingStrength === 0 || this.buffer.length === 0) {
            return { x, y, p, tiltX, tiltY, velocity };
        }
        const prev = this.buffer[this.buffer.length - 1];
        const s    = this.smoothingStrength;
        return {
            x:        x     * (1-s) + prev.x     * s,
            y:        y     * (1-s) + prev.y     * s,
            p,
            tiltX:    tiltX * (1-s) + prev.tiltX * s,
            tiltY:    tiltY * (1-s) + prev.tiltY * s,
            velocity: velocity * (1-s) + prev.velocity * s
        };
    }

    private mapPressure(p: number): number {
        const lut   = this.pressureLUT!;
        const index = Math.max(0, Math.min(1, p)) * (lut.length - 1);
        const lo    = Math.floor(index);
        const hi    = Math.min(lo + 1, lut.length - 1);
        return lut[lo] * (1 - (index - lo)) + lut[hi] * (index - lo);
    }

    private arcLengthToT(arc: Float32Array, steps: number, d: number): number {
        const total = arc[steps];
        if (d <= 0) return 0; if (d >= total) return 1;
        let lo = 0, hi = steps;
        while (lo + 1 < hi) { const mid = (lo+hi)>>1; if (arc[mid] <= d) lo=mid; else hi=mid; }
        const range = arc[hi] - arc[lo];
        if (range < 1e-10) return lo / steps;
        return (lo + (d - arc[lo]) / range) / steps;
    }

    private catmullRom(p0: FullPoint, p1: FullPoint, p2: FullPoint, p3: FullPoint, t: number): FullPoint {
        const t2 = t*t, t3 = t2*t;
        const f  = (a: number, b: number, c: number, d: number) =>
            0.5 * ((2*b) + (-a+c)*t + (2*a-5*b+4*c-d)*t2 + (-a+3*b-3*c+d)*t3);
        return {
            x:        f(p0.x,        p1.x,        p2.x,        p3.x),
            y:        f(p0.y,        p1.y,        p2.y,        p3.y),
            p:        f(p0.p,        p1.p,        p2.p,        p3.p),
            tiltX:    f(p0.tiltX,    p1.tiltX,    p2.tiltX,    p3.tiltX),
            tiltY:    f(p0.tiltY,    p1.tiltY,    p2.tiltY,    p3.tiltY),
            velocity: f(p0.velocity, p1.velocity, p2.velocity, p3.velocity)
        };
    }
}

// ── Color conversion helpers ──────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
        if      (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else               h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
    }
    return { h, s: mx > 0 ? d / mx : 0, v: mx };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
    const k = (n: number) => (n + h / 60) % 6;
    const f = (n: number) => v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
    return { r: f(5), g: f(3), b: f(1) };
}
