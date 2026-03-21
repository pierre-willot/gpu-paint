// Stamp layout (64 bytes per instance):
//   @location(0)  pos            vec2<f32>   offset  0
//   @location(1)  pressure       f32         offset  8
//   @location(2)  size           f32         offset 12
//   @location(3)  color          vec4<f32>   offset 16
//   @location(4)  tilt           vec2<f32>   offset 32
//   @location(5)  opacity        f32         offset 40
//   @location(6)  stampAngle     f32         offset 44
//   @location(7)  roundness      f32         offset 48
//   @location(8)  grainDepthScl  f32         offset 52
//
// Blend state: src-alpha, one-minus-src-alpha (non-premultiplied).
// Fragment MUST return vec4(color.rgb, alpha) — NOT premultiplied.
// Returning premultiplied alpha with this blend state double-multiplies alpha
// and produces a dark outline ring at stamp edges.

const PI: f32 = 3.14159265358979;

struct VertexOut {
    @builtin(position) position:      vec4<f32>,
    @location(0)       uv:            vec2<f32>,
    @location(1)       color:         vec4<f32>,
    @location(2)       radius_px:     f32,
    @location(3)       tilt:          vec2<f32>,
    @location(4)       finalAngle:    f32,
    @location(5)       hardness:      f32,
    @location(6)       roundness:     f32,
    @location(7)       grainDepthScl: f32,
};

// Uniforms — 64 bytes (16 f32 / u32 fields)
// offset  0: resolution       vec2<f32>
// offset  8: hardness         f32
// offset 12: grainDepth       f32
// offset 16: grainScale       f32
// offset 20: grainRotation    f32   (radians)
// offset 24: grainContrast    f32
// offset 28: grainBrightness  f32
// offset 32: grainBlendMode   u32   (0=multiply 1=screen 2=overlay 3=normal)
// offset 36: grainStatic      u32   (0=moving 1=fixed to canvas)
// offset 40: useTipTex        u32
// offset 44: usePickup        u32   (0=no pickup, 1=use pickup texture)
// offset 48: pickupWetness    f32   (0..1 wet mixing strength)
// offset 52: _pad0            f32
// offset 56: _pad1            f32
// offset 60: _pad2            f32
struct Uniforms {
    resolution:      vec2<f32>,
    hardness:        f32,
    grainDepth:      f32,
    grainScale:      f32,
    grainRotation:   f32,
    grainContrast:   f32,
    grainBrightness: f32,
    grainBlendMode:  u32,
    grainStatic:     u32,
    useTipTex:       u32,
    usePickup:       u32,
    pickupWetness:   f32,
    _pad0:           f32,
    _pad1:           f32,
    _pad2:           f32,
};

@group(0) @binding(0) var<uniform> u:          Uniforms;
@group(0) @binding(1) var          maskTex:    texture_2d<f32>;
@group(0) @binding(2) var          maskSmp:    sampler;
@group(0) @binding(3) var          grainTex:   texture_2d<f32>;
@group(0) @binding(4) var          grainSmp:   sampler;
@group(0) @binding(5) var          tipTex:     texture_2d<f32>;
@group(0) @binding(6) var          tipSmp:     sampler;
@group(0) @binding(7) var          pickupTex:  texture_2d<f32>;
@group(0) @binding(8) var          pickupSmp:  sampler;

@vertex
fn vs_main(
    @builtin(vertex_index) vi: u32,
    @location(0) pos:          vec2<f32>,
    @location(1) pressure:     f32,
    @location(2) size:         f32,
    @location(3) color:        vec4<f32>,
    @location(4) tilt:         vec2<f32>,
    @location(5) opacity:      f32,
    @location(6) stampAngle:   f32,
    @location(7) roundness:    f32,
    @location(8) grainDepthScl: f32,
) -> VertexOut {
    var quad = array<vec2<f32>, 4>(
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0)
    );

    let center     = vec2<f32>(pos.x * 2.0 - 1.0, -(pos.y * 2.0 - 1.0));
    let radius_px  = size * u.resolution.x * 0.5;
    let tilt_mag   = length(tilt);
    let tilt_aspect = 1.0 + (tilt_mag / 90.0) * 2.0;
    // Effective roundness: clamped away from zero to avoid degenerate shapes.
    let r_eff      = max(roundness, 0.02);

    // Bounding quad covers the full rotated ellipse at any angle.
    // Conservative bound: max of x-extent (tilt_aspect) and y-extent (1/r_eff).
    let quad_r     = radius_px * max(tilt_aspect, 1.0 / r_eff);
    let off_x      = quad_r * 2.0 / u.resolution.x;
    let off_y      = quad_r * 2.0 / u.resolution.y;

    let tilt_az   = select(0.0, atan2(tilt.y, tilt.x), tilt_mag > 0.5);
    let finalAng  = tilt_az + stampAngle;

    // UV in "normalized brush radius" space.
    // Fragment uses: dist = length(vec2(rot_uv.x / tilt_aspect, rot_uv.y / roundness))
    // quad[vi] * quad_r gives enough range to cover the full ellipse at any rotation.
    var out: VertexOut;
    out.position     = vec4<f32>(center.x + quad[vi].x * off_x, center.y + quad[vi].y * off_y, 0.0, 1.0);
    out.uv           = quad[vi] * quad_r / radius_px; // normalized by radius
    out.color        = vec4<f32>(color.rgb, color.a * opacity);
    out.radius_px    = radius_px;
    out.tilt         = tilt;
    out.finalAngle   = finalAng;
    out.hardness     = u.hardness;
    out.roundness    = r_eff;
    out.grainDepthScl = grainDepthScl;
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    // Selection mask — discard outside selection when active.
    let canvas_uv = in.position.xy / u.resolution;
    let mask_val  = textureSampleLevel(maskTex, maskSmp, canvas_uv, 0.0).r;
    if mask_val < 0.004 { discard; }

    // ── Stamp shape ──────────────────────────────────────────────────────
    let tilt_mag    = length(in.tilt);
    let tilt_aspect = 1.0 + (tilt_mag / 90.0) * 2.0;

    let c       = cos(-in.finalAngle);
    let s       = sin(-in.finalAngle);
    let rot_uv  = vec2<f32>(in.uv.x * c - in.uv.y * s, in.uv.x * s + in.uv.y * c);
    let dist    = length(vec2<f32>(rot_uv.x / tilt_aspect, rot_uv.y / in.roundness));

    // ── Stamp alpha ───────────────────────────────────────────────────────
    var alpha_base: f32;
    if u.useTipTex != 0u {
        // Image tip: sample texture in rotated stamp space, masked by circle falloff
        let tipUV = rot_uv * 0.5 + 0.5;
        let tipAlpha = textureSampleLevel(tipTex, tipSmp, tipUV, 0.0).r;
        // Compute circle falloff (same as procedural path) to mask the tip texture
        let aa_width_tip  = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
        let hard_mask_tip = smoothstep(1.0, 1.0 - aa_width_tip, dist);
        let gaussian_tip  = exp(-dist * dist * 5.54);
        let circle_alpha  = mix(gaussian_tip, hard_mask_tip, in.hardness);
        alpha_base = tipAlpha * circle_alpha;
    } else {
        if dist > 1.0 { discard; }
        let aa_width   = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
        let hard_mask  = smoothstep(1.0, 1.0 - aa_width, dist);
        let gaussian   = exp(-dist * dist * 5.54);
        alpha_base = mix(gaussian, hard_mask, in.hardness);
    }

    var alpha = alpha_base * in.color.a * mask_val;

    // ── Color + grain ─────────────────────────────────────────────────────
    var finalColor = in.color.rgb;

    if u.grainDepth > 0.001 {
        var grainUV: vec2<f32>;
        if u.grainStatic != 0u {
            // Fixed to canvas — scales with canvas UV
            grainUV = canvas_uv * u.grainScale;
        } else {
            // Moves with brush stamp — UV relative to stamp center, scaled
            grainUV = in.uv * u.grainScale * 0.25 + 0.5;
        }

        // Rotate grain pattern around its center
        let gc = cos(u.grainRotation);
        let gs = sin(u.grainRotation);
        let guv = grainUV - 0.5;
        let rotGuv = vec2<f32>(guv.x * gc - guv.y * gs, guv.x * gs + guv.y * gc) + 0.5;

        let grainVal = textureSampleLevel(grainTex, grainSmp, rotGuv, 0.0).r;
        let g = clamp((grainVal - 0.5) * u.grainContrast + 0.5 + u.grainBrightness, 0.0, 1.0);

        let depth = u.grainDepth * in.grainDepthScl;

        // Grain is an alpha mask: light grain = paint sticks, dark = transparent.
        // Applying to RGB darkens the stroke; applying to alpha cuts holes — correct.
        var gAlpha: f32;
        switch u.grainBlendMode {
            case 1u: { // screen — grain lightens mask (smoother texture)
                gAlpha = 1.0 - (1.0 - g) * (1.0 - g);
            }
            case 2u: { // overlay — pushes grain toward hard threshold at midtones
                gAlpha = select(
                    1.0 - 2.0 * (1.0 - g) * (1.0 - g),
                    2.0 * g * g,
                    g < 0.5
                );
            }
            case 3u: { // normal — use grain value directly as opacity
                gAlpha = g;
            }
            default: { // 0u = multiply — linear alpha mask (standard chalk/pencil)
                gAlpha = g;
            }
        }
        alpha *= mix(1.0, gAlpha, depth);
    }

    // ── Wet mixing (canvas color pickup) ─────────────────────────────────
    if u.usePickup != 0u && u.pickupWetness > 0.0 {
        let pickupRaw = textureSampleLevel(pickupTex, pickupSmp, canvas_uv, 0.0);
        // bgra8unorm textures on Windows/DX12: bytes are stored BGRA but WebGPU
        // exposes them as .r=B .g=G .b=R .a=A in the sampler — swap R↔B channels.
        let pickupColor = vec3<f32>(pickupRaw.b, pickupRaw.g, pickupRaw.r);
        // Blend brush color toward picked-up canvas color by wetness * 0.6
        finalColor = mix(finalColor, pickupColor, u.pickupWetness * 0.6);
    }

    // Return NON-PREMULTIPLIED. The blend state is src-alpha / one-minus-src-alpha.
    return vec4<f32>(finalColor, alpha);
}
