// ── BrushDescriptor ───────────────────────────────────────────────────────────
// Single source of truth for all brush parameters.
//
// Design principles:
//   • Fully serializable to JSON — no Float32Arrays or class instances
//   • Structured-cloned by postMessage to the stroke worker
//   • DynamicsLUTs (Float32Array) are built from CurveSpecs by dynamics-lut.ts
//     and transferred separately — never stored here

export type BrushBlendMode = 'normal' | 'erase';
export type GrainBlendMode = 'multiply' | 'screen' | 'overlay' | 'normal';
export type GlazeMode = 'off' | 'light' | 'uniform' | 'heavy' | 'intense';

// ── CurveSpec ─────────────────────────────────────────────────────────────────
// JSON-serializable description of a 1D response curve mapping input [0..1]
// to output [min..max].  Converted to a 256-entry Float32Array LUT at runtime
// by `curveSpecToLUT` in dynamics-lut.ts.

export interface CurveSpec {
    /** 'off' = identity (1.0), 'linear' = straight ramp, 'bezier' = CSS cubic */
    mode:  'off' | 'linear' | 'bezier';
    p1x?:  number;   // bezier control point 1 x (default 0.42)
    p1y?:  number;   // bezier control point 1 y (default 0.0)
    p2x?:  number;   // bezier control point 2 x (default 0.58)
    p2y?:  number;   // bezier control point 2 y (default 1.0)
    min:   number;   // output minimum (default 0)
    max:   number;   // output maximum (default 1)
}

export const CURVE_OFF:    CurveSpec = { mode: 'off',    min: 0, max: 1 };
export const CURVE_LINEAR: CurveSpec = { mode: 'linear', min: 0, max: 1 };

// ── BrushDescriptor ───────────────────────────────────────────────────────────

export interface BrushDescriptor {

    // ── Geometry ──────────────────────────────────────────────────────────────
    /** Base size as fraction of canvas logical width (0.001..1.0) */
    size:            number;
    /** Stamp spacing as fraction of current stamp diameter (0.05..2.0) */
    spacing:         number;
    /** Hardness: 0 = fully soft (gaussian falloff), 1 = hard edge */
    hardness:        number;
    /** Fixed stamp rotation in degrees (0..360) */
    angle:           number;
    /** Ellipse minor/major axis ratio (0..1). 1 = perfect circle */
    roundness:       number;

    // ── Size dynamics ─────────────────────────────────────────────────────────
    /** Minimum size multiplier after all dynamics (0..1) */
    sizeMin:              number;
    /** Maximum size multiplier after all dynamics (0..1) */
    sizeMax:              number;
    /** Backward-compat: linear pressure→size strength (0=none, 1=full).
     *  Active only when sizePressureCurve.mode === 'off'. */
    pressureSize:         number;
    /** Curve: pressure → size multiplier (overrides pressureSize when mode ≠ 'off') */
    sizePressureCurve:    CurveSpec;
    /** Curve: tilt magnitude (0..90° normalised to 0..1) → size multiplier */
    sizeTiltCurve:        CurveSpec;
    /** Curve: stroke speed (normalised, max ~2 canvas-width units/sec) → size multiplier */
    sizeSpeedCurve:       CurveSpec;

    // ── Opacity dynamics ──────────────────────────────────────────────────────
    /** Base opacity of each stamp (0..1) */
    opacity:              number;
    /** Minimum opacity multiplier after all dynamics */
    opacityMin:           number;
    /** Maximum opacity multiplier after all dynamics */
    opacityMax:           number;
    /** Backward-compat: linear pressure→opacity strength. Active when opacityPressureCurve.mode==='off'. */
    pressureOpacity:      number;
    /** Curve: pressure → opacity multiplier */
    opacityPressureCurve: CurveSpec;
    /** Curve: speed → opacity multiplier */
    opacitySpeedCurve:    CurveSpec;

    // ── Flow dynamics ─────────────────────────────────────────────────────────
    /** Base flow / density per stamp (0..1) */
    flow:                 number;
    /** Minimum flow multiplier */
    flowMin:              number;
    /** Maximum flow multiplier */
    flowMax:              number;
    /** Curve: pressure → flow multiplier */
    flowPressureCurve:    CurveSpec;

    // ── Tip ───────────────────────────────────────────────────────────────────
    /** Atlas index for image tip. -1 = procedural soft/hard circle */
    tipIndex:             number;

    // ── Rotation ──────────────────────────────────────────────────────────────
    /** Stamp angle follows stroke direction (tangent) */
    followStroke:         boolean;
    /** 0..1 — how much tilt azimuth contributes to stamp angle */
    tiltAngleInfluence:   number;
    /** Backward-compat: tiltAngle bool — enable full tilt-to-angle mapping */
    tiltAngle:            boolean;

    // ── Roundness dynamics ────────────────────────────────────────────────────
    /** Minimum per-stamp roundness (clamp floor, prevents complete collapse) */
    roundnessMin:         number;
    /** Curve: tilt magnitude (0..1 norm) → roundness multiplier */
    roundnessTiltCurve:   CurveSpec;
    /** Curve: pressure → roundness multiplier */
    roundnessPressureCurve: CurveSpec;
    /** Backward-compat: tilt squishes roundness proportionally */
    tiltShape:            boolean;
    /** Master switch — when false all tilt inputs are ignored (size, shape, angle, cursor) */
    tiltEnabled:          boolean;

    // ── Color ─────────────────────────────────────────────────────────────────
    /** Base (foreground) color [r, g, b, a] normalised 0..1 */
    color:                [number, number, number, number];

    // ── Color jitter — per tip ────────────────────────────────────────────────
    hueJitter:            number;   // 0..180 degrees
    satJitter:            number;   // 0..1
    valJitter:            number;   // 0..1
    sizeJitter:           number;   // 0..1
    opacityJitter:        number;   // 0..1

    // ── Color jitter — per stroke ─────────────────────────────────────────────
    hueJitterPerStroke:   number;   // 0..180 degrees (applied once at stroke start)
    satJitterPerStroke:   number;   // 0..1
    valJitterPerStroke:   number;   // 0..1

    // ── Stabilization ─────────────────────────────────────────────────────────
    /** Pull-string length (0 = off, >0 = string must be pulled past this distance) */
    pullStringLength:     number;
    /** When true, string slowly drifts toward pointer even inside pull radius */
    catchUpEnabled:       boolean;

    // ── Grain / texture ───────────────────────────────────────────────────────
    /** Grain texture index in the library (-1 = no grain) */
    grainIndex:           number;
    /** Grain texture scale multiplier (0.1..4.0) */
    grainScale:           number;
    /** Grain texture rotation in degrees */
    grainRotation:        number;
    /** true = grain fixed to canvas UV; false = grain moves with stroke */
    grainStatic:          boolean;
    /** Overall grain depth / strength (0..1) */
    grainDepth:           number;
    /** Grain contrast multiplier (0.5..2.0) */
    grainContrast:        number;
    /** Grain brightness offset (−0.5..0.5) */
    grainBrightness:      number;
    /** How grain texture blends with brush color */
    grainBlendMode:       GrainBlendMode;

    // ── Wet mixing ────────────────────────────────────────────────────────────
    /** Dilution: 0 = opaque/dry, 1 = maximum wet blending */
    wetness:              number;
    /** Paint charge: how much paint is loaded (0..1, depletes over stroke) */
    paintLoad:            number;
    /** Curve: pressure → wetness multiplier */
    wetnessPressureCurve: CurveSpec;

    // ── Smoothing ─────────────────────────────────────────────────────────────
    /** Input-point smoothing strength (0 = raw, 1 = maximum). Exponential moving
     *  average applied to each incoming pointer position before stamping. */
    smoothing:            number;

    // ── Wet edge ──────────────────────────────────────────────────────────────
    /** 0..1 strength of the wet-edge accumulation effect.
     *  Tracks per-stroke paint density and boosts opacity at stroke boundaries
     *  to simulate watercolour pigment migration to the drying edge. */
    wetEdge:              number;

    // ── Blend mode ────────────────────────────────────────────────────────────
    blendMode:            BrushBlendMode;

    // ── Accumulation / Glaze ─────────────────────────────────────────────────
    /** Per-pixel accumulation model. 'off' = classic opacity blend. */
    glazeMode:            GlazeMode;

    // ── Smudge ───────────────────────────────────────────────────────────────
    /** Pull: deposit blend weight (0=nothing deposited, 1=carry fully replaces layer) */
    smudge:          number;
    /** Charge: pickup absorption rate (0=carry unchanged, 1=fully absorbed into layer) */
    smudgeCharge:    number;
    /** Dilution: carry fade-out per stamp (0=persistent, 1=rapid fade) */
    smudgeDilution:  number;
    /** Attack: ramp-in distance in normalised canvas units (0=instant) */
    smudgeAttack:    number;
    /** Grade: decay distance in normalised canvas units (0=no decay) */
    smudgeGrade:     number;
}

// ── Factory / defaults ────────────────────────────────────────────────────────

export function defaultBrushDescriptor(): BrushDescriptor {
    return {
        size:            0.05,
        spacing:         0.01,
        hardness:        0.95,
        angle:           0,
        roundness:       1.0,

        sizeMin:              0,
        sizeMax:              1,
        pressureSize:         0.0,
        sizePressureCurve:    { ...CURVE_OFF },
        sizeTiltCurve:        { ...CURVE_OFF },
        sizeSpeedCurve:       { ...CURVE_OFF },

        opacity:              1.0,
        opacityMin:           0,
        opacityMax:           1,
        pressureOpacity:      0.0,
        opacityPressureCurve: { ...CURVE_OFF },
        opacitySpeedCurve:    { ...CURVE_OFF },

        flow:                 1.0,
        flowMin:              0,
        flowMax:              1,
        flowPressureCurve:    { ...CURVE_OFF },

        tipIndex:             -1,

        followStroke:         false,
        tiltAngleInfluence:   0,
        tiltAngle:            false,

        roundnessMin:         0.05,
        roundnessTiltCurve:   { ...CURVE_OFF },
        roundnessPressureCurve: { ...CURVE_OFF },
        tiltShape:            false,
        tiltEnabled:          false,

        color:                [0, 0, 0, 1],

        hueJitter:            0,
        satJitter:            0,
        valJitter:            0,
        sizeJitter:           0,
        opacityJitter:        0,

        hueJitterPerStroke:   0,
        satJitterPerStroke:   0,
        valJitterPerStroke:   0,

        pullStringLength:     0,
        catchUpEnabled:       false,

        grainIndex:           -1,
        grainScale:           1.0,
        grainRotation:        0,
        grainStatic:          true,
        grainDepth:           0,
        grainContrast:        1.0,
        grainBrightness:      0,
        grainBlendMode:       'multiply',

        wetness:              0,
        paintLoad:            1,
        wetnessPressureCurve: { ...CURVE_OFF },

        smoothing:            0,

        wetEdge:              0,

        blendMode:            'normal',
        glazeMode:            'off',
        smudge:          0,
        smudgeCharge:    0.8,
        smudgeDilution:  1.0,
        smudgeAttack:    0,
        smudgeGrade:     0,
    };
}

export function defaultEraserDescriptor(): BrushDescriptor {
    return {
        ...defaultBrushDescriptor(),
        hardness:  0.95,
        blendMode: 'erase',
        color:     [1, 1, 1, 1],
    };
}

/** Deep-clone a descriptor (safe for postMessage structured clone). */
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
    return { ...defaultBrushDescriptor(), ...parsed };
}
