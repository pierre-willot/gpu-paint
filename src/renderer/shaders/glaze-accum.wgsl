// glaze-accum.wgsl — Pass A: accumulate stamp alpha deltas into r16float glazeBuffer
//
// Same vertex setup as brush.wgsl.  Fragment implements log-space soft accumulation:
//   output = log(1 - d)   (a negative value in [-0.693, 0])
// GPU additive blend sums all log(1-d_i) contributions across all overlapping stamps,
// including multiple stamps in the same draw call (fast strokes).
// At deposit time: b = 1 - exp(accumulated_log_sum) = 1 - prod(1 - d_i)
// This is identical to sequential soft accumulation but requires no ping-pong.
// Render target format: r16float.  Blend state: additive (one/one).
// loadOp: 'load' — preserves accumulated sum across chunks within the same stroke.

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
// Log-space accumulation: output = log(1 - d)
// Additive blend sums contributions from all overlapping stamps.
// Deposit converts: b = 1 - exp(accumulated_sum) = 1 - prod(1 - d_i)

@fragment
fn fs_main(in: VertexOut) -> @location(0) f32 {
    let canvas_uv = in.position.xy / u.resolution;

    // Selection mask — skip outside selection
    let mask_val = textureSampleLevel(maskTex, maskSmp, canvas_uv, 0.0).r;
    if mask_val < 0.004 { discard; }

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
        if dist > 1.0 { discard; }
        let aa_w      = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
        let hard_mask = smoothstep(1.0, 1.0 - aa_w, dist);
        let gaussian  = exp(-dist * dist * 5.54);
        alpha_base = mix(gaussian, hard_mask, in.hardness);
    }

    // Reduce per-stamp delta slightly to counteract dense fast-stroke over-accumulation.
    // 0.85 factor keeps saturation rate similar to slow strokes.
    var d = clamp(in.delta * pow(alpha_base, 1.5) * mask_val * 0.85, 0.0, 0.45);

    // Grain-aware: when tip texture loaded, modulate delta by grain value directly
    // This makes paint accumulate where grain allows it (dry media realism)
    if u.useTipTex != 0u {
        let grainUV  = rot * 0.5 + 0.5;
        let grainVal = textureSampleLevel(tipTex, tipSmp, grainUV, 0.0).r;
        d *= grainVal;
    }

    // Discard near-zero contributions — avoids polluting the log-sum with
    // log(1-~0) ≈ 0 noise from brush edges across thousands of stamps.
    if d < 0.001 { discard; }

    // Guard: ensure 1-d > 0 before log (d is ≤ 0.45 so this is always true,
    // but epsilon prevents any float precision edge case giving log(0) = -inf).
    let safe_d = min(d, 0.9999);

    // Log-space contribution: log(1 - d) ∈ [-0.693, 0) for d ∈ (0, 0.45]
    // GPU additive blend accumulates all overlapping stamp contributions in one pass.
    // Clamp the per-stamp log contribution so a single full-coverage stamp cannot
    // dominate — keeps the system stable even at pressure=1 over a small area.
    return max(log(1.0 - safe_d), -1.5);
}
