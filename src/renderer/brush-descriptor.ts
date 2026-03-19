// ── BrushDescriptor ───────────────────────────────────────────────────────────
// The single source of truth for all brush parameters.
//
// Design principles:
//   • Fully serializable to JSON — can be saved in .gpaint manifests and
//     shared as preset files
//   • Sent to the stroke worker via postMessage as a plain object (structured
//     clone) — no classes, no non-serializable fields except pressureLUT which
//     is sent separately as a transferable Float32Array
//   • All per-stamp decisions are made in the worker using this descriptor —
//     zero main-thread math in the hot path
//   • blendMode is part of the descriptor so eraser is just a brush with
//     blendMode:'erase' — no special-case code

export type BrushBlendMode = 'normal' | 'erase';

export interface BrushDescriptor {
    // ── Geometry ──────────────────────────────────────────────────────────────
    /** Base size as fraction of canvas logical width (0.001..1.0) */
    size:            number;
    /** Stamp spacing as fraction of current stamp diameter (0.05..2.0) */
    spacing:         number;
    /** Hardness: 0 = fully soft (gaussian falloff), 1 = hard edge */
    hardness:        number;
    /** Fixed stamp rotation in degrees (0..360). 0 = auto from tilt */
    angle:           number;
    /** Ellipse minor/major axis ratio (0..1). 1 = circle */
    roundness:       number;

    // ── Opacity ───────────────────────────────────────────────────────────────
    /** Base opacity of each stamp (0..1) */
    opacity:         number;
    /** Flow: fraction of opacity applied per stamp when building up (0..1) */
    flow:            number;

    // ── Pressure dynamics ─────────────────────────────────────────────────────
    /** How much pressure affects size (0 = none, 1 = full range) */
    pressureSize:    number;
    /** How much pressure affects opacity (0 = none, 1 = full range) */
    pressureOpacity: number;

    // ── Tilt dynamics ─────────────────────────────────────────────────────────
    /** Whether tilt controls stamp angle (azimuth → rotation) */
    tiltAngle:       boolean;
    /** Whether tilt controls stamp shape (tilt magnitude → aspect ratio) */
    tiltShape:       boolean;

    // ── Jitter / randomness ───────────────────────────────────────────────────
    /** Size randomness per stamp (0..1) */
    sizeJitter:      number;
    /** Opacity randomness per stamp (0..1) */
    opacityJitter:   number;
    /** Hue shift randomness per stamp in degrees (0..180) */
    hueJitter:       number;
    /** Saturation randomness per stamp (0..1) */
    satJitter:       number;
    /** Value randomness per stamp (0..1) */
    valJitter:       number;
    /** Angle randomness per stamp in degrees (0..180) */
    angleJitter:     number;

    // ── Tip ───────────────────────────────────────────────────────────────────
    /** Atlas index for texture tip. -1 = procedural circular/elliptical tip */
    tipIndex:        number;

    // ── Color ─────────────────────────────────────────────────────────────────
    /** Base stroke color [r, g, b, a] normalized 0..1 */
    color:           [number, number, number, number];

    // ── Blend mode ────────────────────────────────────────────────────────────
    blendMode:       BrushBlendMode;

    // ── Smudge ───────────────────────────────────────────────────────────────
    /** Smudge amount (0 = no smudge, 1 = maximum smudge). Tool-specific. */
    smudge:          number;
}

// ── Factory / presets ─────────────────────────────────────────────────────────

export function defaultBrushDescriptor(): BrushDescriptor {
    return {
        size:            0.05,
        spacing:         0.35,
        hardness:        0.95,
        angle:           0,
        roundness:       1.0,
        opacity:         1.0,
        flow:            1.0,
        pressureSize:    1.0,
        pressureOpacity: 0.0,
        tiltAngle:       false,
        tiltShape:       true,
        sizeJitter:      0,
        opacityJitter:   0,
        hueJitter:       0,
        satJitter:       0,
        valJitter:       0,
        angleJitter:     0,
        tipIndex:        -1,
        color:           [0, 0, 0, 1],
        blendMode:       'normal',
        smudge:          0,
    };
}

export function defaultEraserDescriptor(): BrushDescriptor {
    return {
        ...defaultBrushDescriptor(),
        hardness:    0.95,
        blendMode:   'erase',
        color:       [1, 1, 1, 1],
    };
}

/** Deep clone a descriptor (safe for postMessage structured clone). */
export function cloneDescriptor(d: BrushDescriptor): BrushDescriptor {
    return {
        ...d,
        color: [...d.color] as [number, number, number, number],
    };
}

// ── Serialization ─────────────────────────────────────────────────────────────

export function descriptorToJSON(d: BrushDescriptor): string {
    return JSON.stringify(d);
}

export function descriptorFromJSON(json: string): BrushDescriptor {
    const parsed = JSON.parse(json) as Partial<BrushDescriptor>;
    // Merge with defaults so old/partial preset files still work
    return { ...defaultBrushDescriptor(), ...parsed };
}
