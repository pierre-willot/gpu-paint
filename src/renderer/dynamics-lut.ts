// ── DynamicsLUT — curve-to-LUT conversion and packed dynamics buffer ──────────
//
// All per-stamp dynamic modifiers are encoded as 256-entry Float32Array LUTs.
// `buildDynamicsLUTs` packs all 12 LUTs into one Float32Array(3072) that is
// transferred as a single transferable to the stroke worker.

import type { CurveSpec }       from './brush-descriptor';
import type { BrushDescriptor } from './brush-descriptor';

// ── Slot indices inside the packed Float32Array (each slot = 256 entries) ────
export const DLUT_SIZE_PRESSURE     =  0;
export const DLUT_SIZE_TILT         =  1;
export const DLUT_SIZE_SPEED        =  2;
export const DLUT_OPACITY_PRESSURE  =  3;
export const DLUT_OPACITY_SPEED     =  4;
export const DLUT_FLOW_PRESSURE     =  5;
export const DLUT_ROUNDNESS_TILT    =  6;
export const DLUT_ROUNDNESS_PRESSURE=  7;
export const DLUT_SCATTER_PRESSURE  =  8;
export const DLUT_GRAIN_DEPTH       =  9;
export const DLUT_WETNESS_PRESSURE  = 10;
export const DLUT_COLOR_MIX         = 11;
export const NUM_DLUTS              = 12;
export const DLUT_TOTAL_FLOATS      = NUM_DLUTS * 256; // 3072

// ── Public utilities ──────────────────────────────────────────────────────────

/** Linearly sample a single LUT slot from the packed array at normalised t. */
export function sampleDynLUT(packed: Float32Array, slot: number, t: number): number {
    const base = slot * 256;
    const idx  = Math.max(0, Math.min(1, t)) * 255;
    const lo   = Math.floor(idx);
    const hi   = Math.min(lo + 1, 255);
    return packed[base + lo] + (idx - lo) * (packed[base + hi] - packed[base + lo]);
}

/** Convert a CurveSpec to a 256-entry Float32Array LUT mapping [0..1] → [min..max]. */
export function curveSpecToLUT(spec: CurveSpec): Float32Array {
    const lut  = new Float32Array(256);
    const mn   = spec.min ?? 0;
    const mx   = spec.max ?? 1;
    const p1x  = spec.p1x ?? 0.42, p1y = spec.p1y ?? 0.0;
    const p2x  = spec.p2x ?? 0.58, p2y = spec.p2y ?? 1.0;
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const y = spec.mode === 'linear' ? t
                : spec.mode === 'bezier' ? cubicBezier(t, p1x, p1y, p2x, p2y)
                : 1.0; // 'off' → identity
        lut[i] = mn + y * (mx - mn);
    }
    return lut;
}

/**
 * Build the full packed dynamics LUT array from a BrushDescriptor.
 * Returns a Float32Array(3072) with NUM_DLUTS × 256 entries.
 * 'off' curves produce an identity LUT (all 1.0 values).
 */
export function buildDynamicsLUTs(d: BrushDescriptor): Float32Array {
    const packed = new Float32Array(DLUT_TOTAL_FLOATS);

    const fill = (slot: number, spec: CurveSpec | undefined) => {
        const base = slot * 256;
        if (!spec || spec.mode === 'off') {
            packed.fill(1.0, base, base + 256);
        } else {
            const lut = curveSpecToLUT(spec);
            packed.set(lut, base);
        }
    };

    fill(DLUT_SIZE_PRESSURE,      d.sizePressureCurve);
    fill(DLUT_SIZE_TILT,          d.sizeTiltCurve);
    fill(DLUT_SIZE_SPEED,         d.sizeSpeedCurve);
    fill(DLUT_OPACITY_PRESSURE,   d.opacityPressureCurve);
    fill(DLUT_OPACITY_SPEED,      d.opacitySpeedCurve);
    fill(DLUT_FLOW_PRESSURE,      d.flowPressureCurve);
    fill(DLUT_ROUNDNESS_TILT,     d.roundnessTiltCurve);
    fill(DLUT_ROUNDNESS_PRESSURE, d.roundnessPressureCurve);
    fill(DLUT_SCATTER_PRESSURE,   d.scatterPressureCurve);
    fill(DLUT_GRAIN_DEPTH,        d.grainDepthCurve);
    fill(DLUT_WETNESS_PRESSURE,   d.wetnessPressureCurve);
    fill(DLUT_COLOR_MIX,          d.colorMixPressureCurve);

    return packed;
}

// ── Internal: CSS cubic-bezier timing function (Newton-Raphson) ───────────────

function cubicBezier(x: number, p1x: number, p1y: number, p2x: number, p2y: number): number {
    let t = x;
    for (let i = 0; i < 8; i++) {
        const fx = bComp(t, p1x, p2x) - x;
        if (Math.abs(fx) < 1e-5) break;
        const df = bDeriv(t, p1x, p2x);
        if (Math.abs(df) < 1e-7) break;
        t -= fx / df;
        t  = Math.max(0, Math.min(1, t));
    }
    return bComp(t, p1y, p2y);
}

function bComp(t: number, p1: number, p2: number): number {
    return 3 * t * (1 - t) * (1 - t) * p1 + 3 * t * t * (1 - t) * p2 + t * t * t;
}

function bDeriv(t: number, p1: number, p2: number): number {
    return 3 * (1 - t) * (1 - t) * p1 + 6 * t * (1 - t) * (p2 - p1) + 3 * t * t * (1 - p2);
}
