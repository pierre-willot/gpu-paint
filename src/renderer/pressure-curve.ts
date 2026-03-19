// ── PressureCurve ─────────────────────────────────────────────────────────────
// Maps raw pointer pressure [0,1] to effective pressure [0,1] via a cubic
// Bézier curve with control points P1=(x1,y1) and P2=(x2,y2).
// P0=(0,0) and P3=(1,1) are always fixed.
//
// This is the same model used by CSS transition-timing-function and by
// Procreate's pressure curve editor — familiar and predictable.
//
// The curve is precomputed into a 256-entry LUT at construction time so
// map() is a single array lookup + linear interpolation — O(1), suitable
// for use inside the Worker hot path.

export interface PressureCurvePreset {
    x1: number; y1: number;
    x2: number; y2: number;
}

// ── Built-in presets ──────────────────────────────────────────────────────────

export const PRESSURE_PRESETS = {
    // Identity — raw pressure, no remapping
    linear:   { x1: 0.00, y1: 0.00, x2: 1.00, y2: 1.00 },

    // Light touch → full pressure quickly (good for light stylus users)
    soft:     { x1: 0.00, y1: 0.50, x2: 1.00, y2: 1.00 },

    // Needs firm pressure to reach full output (good for heavy-handed users)
    firm:     { x1: 0.00, y1: 0.00, x2: 0.50, y2: 0.50 },

    // S-curve: gentle start, steep middle, gentle end (most natural feel)
    natural:  { x1: 0.25, y1: 0.10, x2: 0.75, y2: 0.90 },
} satisfies Record<string, PressureCurvePreset>;

export type PressurePresetName = keyof typeof PRESSURE_PRESETS;

// ── LUT resolution ─────────────────────────────────────────────────────────────
const LUT_SIZE = 256;

export class PressureCurve {
    private lut: Float32Array;

    constructor(preset: PressureCurvePreset = PRESSURE_PRESETS.natural) {
        this.lut = new Float32Array(LUT_SIZE);
        this.buildLUT(preset.x1, preset.y1, preset.x2, preset.y2);
    }

    /**
     * Maps a raw pressure value [0,1] to an effective pressure [0,1].
     * Uses the precomputed LUT with linear interpolation between entries —
     * safe to call in the Worker hot path.
     */
    public map(pressure: number): number {
        const p     = Math.max(0, Math.min(1, pressure));
        const index = p * (LUT_SIZE - 1);
        const lo    = Math.floor(index);
        const hi    = Math.min(lo + 1, LUT_SIZE - 1);
        const frac  = index - lo;
        return this.lut[lo] * (1 - frac) + this.lut[hi] * frac;
    }

    /**
     * Returns the LUT as a transferable Float32Array for posting to a Worker.
     * The Worker receives this and uses it directly without storing the full
     * PressureCurve object.
     */
    public toLUT(): Float32Array {
        return this.lut.slice(); // copy so transfer is safe
    }

    /** Rebuilds the curve from new control points. */
    public update(preset: PressureCurvePreset): void {
        this.buildLUT(preset.x1, preset.y1, preset.x2, preset.y2);
    }

    // ── Private — LUT construction ────────────────────────────────────────────

    /**
     * Precomputes the LUT by numerically inverting the cubic Bézier x→t
     * mapping and evaluating y at each t.
     *
     * The cubic Bézier in 1D:
     *   x(t) = 3(1-t)²t·x1 + 3(1-t)t²·x2 + t³
     *   y(t) = 3(1-t)²t·y1 + 3(1-t)t²·y2 + t³
     *
     * For each sample x in [0,1], we find t with Newton–Raphson and evaluate y(t).
     */
    private buildLUT(x1: number, y1: number, x2: number, y2: number): void {
        for (let i = 0; i < LUT_SIZE; i++) {
            const x   = i / (LUT_SIZE - 1);
            const t   = this.solveT(x, x1, x2);
            this.lut[i] = this.evalY(t, y1, y2);
        }
    }

    private solveT(targetX: number, x1: number, x2: number): number {
        if (targetX <= 0) return 0;
        if (targetX >= 1) return 1;

        let t = targetX; // good initial guess for well-behaved curves
        for (let i = 0; i < 8; i++) {
            const x  = this.evalX(t, x1, x2);
            const dx = this.evalDX(t, x1, x2);
            if (Math.abs(dx) < 1e-6) break;
            t -= (x - targetX) / dx;
            t  = Math.max(0, Math.min(1, t));
        }
        return t;
    }

    private evalX(t: number, x1: number, x2: number): number {
        const mt = 1 - t;
        return 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
    }

    private evalY(t: number, y1: number, y2: number): number {
        const mt = 1 - t;
        return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
    }

    private evalDX(t: number, x1: number, x2: number): number {
        const mt = 1 - t;
        return 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
    }
}
