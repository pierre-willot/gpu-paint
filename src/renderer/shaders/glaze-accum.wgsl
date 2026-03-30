// glaze-accum.wgsl — Pass A: accumulate stamp alpha deltas into r16float glazeBuffer
//
// Same vertex setup as brush.wgsl.  Fragment outputs a single f32 = delta × stampMask.
// Render target format: r16float.  Blend state: one + one (additive).
// loadOp: 'load' — preserves accumulation across multiple stamp batches per stroke.

const PI: f32 = 3.14159265358979;

// ── Uniforms ──────────────────────────────────────────────────────────────────
// Smaller uniform struct than brush.wgsl — only fields needed for stamp masking.
struct GlazeAccumUniforms {
    resolution:  vec2<f32>,   // offset  0  canvas size in pixels
    hardness:    f32,          // offset  8
    useTipTex:   u32,          // offset 12
};

@group(0) @binding(0) var<uniform> u:       GlazeAccumUniforms;
@group(0) @binding(1) var          maskTex: texture_2d<f32>;
@group(0) @binding(2) var          maskSmp: sampler;
@group(0) @binding(3) var          tipTex:  texture_2d<f32>;
@group(0) @binding(4) var          tipSmp:  sampler;

// ── Vertex shader ─────────────────────────────────────────────────────────────
// Identical layout to brush.wgsl vertex attributes.

struct VertexOut {
    @builtin(position) position:   vec4<f32>,
    @location(0)       uv:         vec2<f32>,    // normalized brush-radius space
    @location(1)       delta:      f32,           // accumulated delta (= color.a * opacity from stamp)
    @location(2)       radius_px:  f32,
    @location(3)       tilt:       vec2<f32>,
    @location(4)       finalAngle: f32,
    @location(5)       hardness:   f32,
    @location(6)       roundness:  f32,
};

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
    let r_eff      = max(roundness, 0.02);
    let quad_r     = radius_px * max(tilt_aspect, 1.0 / r_eff);
    let off_x      = quad_r * 2.0 / u.resolution.x;
    let off_y      = quad_r * 2.0 / u.resolution.y;

    let tilt_az  = select(0.0, atan2(tilt.y, tilt.x), tilt_mag > 0.5);
    let finalAng = tilt_az + stampAngle;

    var out: VertexOut;
    out.position   = vec4<f32>(center.x + quad[vi].x * off_x, center.y + quad[vi].y * off_y, 0.0, 1.0);
    out.uv         = quad[vi] * quad_r / radius_px;
    // delta = color.a * opacity — in glaze mode color.a=1 so this equals the stamp delta
    out.delta      = color.a * opacity;
    out.radius_px  = radius_px;
    out.tilt       = tilt;
    out.finalAngle = finalAng;
    out.hardness   = u.hardness;
    out.roundness  = r_eff;
    return out;
}

// ── Fragment shader ───────────────────────────────────────────────────────────
// Returns a scalar f32 — the delta contribution to the accumulation buffer.

@fragment
fn fs_main(in: VertexOut) -> @location(0) f32 {
    let canvas_uv = in.position.xy / u.resolution;

    // Selection mask — skip outside selection
    let mask_val = textureSampleLevel(maskTex, maskSmp, canvas_uv, 0.0).r;
    if mask_val < 0.004 { return 0.0; }

    // Stamp shape (same as brush.wgsl)
    let tilt_mag    = length(in.tilt);
    let tilt_aspect = 1.0 + (tilt_mag / 90.0) * 2.0;
    let c     = cos(-in.finalAngle);
    let s     = sin(-in.finalAngle);
    let rot   = vec2<f32>(in.uv.x * c - in.uv.y * s, in.uv.x * s + in.uv.y * c);
    let dist  = length(vec2<f32>(rot.x / tilt_aspect, rot.y / in.roundness));

    var alpha_base: f32;
    if u.useTipTex != 0u {
        let tipUV       = rot * 0.5 + 0.5;
        let tipAlpha    = textureSampleLevel(tipTex, tipSmp, tipUV, 0.0).r;
        let aa_w        = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
        let hard_mask   = smoothstep(1.0, 1.0 - aa_w, dist);
        let gaussian    = exp(-dist * dist * 5.54);
        alpha_base = tipAlpha * mix(gaussian, hard_mask, in.hardness);
    } else {
        if dist > 1.0 { return 0.0; }
        let aa_w      = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
        let hard_mask = smoothstep(1.0, 1.0 - aa_w, dist);
        let gaussian  = exp(-dist * dist * 5.54);
        alpha_base = mix(gaussian, hard_mask, in.hardness);
    }

    return in.delta * alpha_base * mask_val;
}
