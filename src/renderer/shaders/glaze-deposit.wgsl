// glaze-deposit.wgsl — Pass B: deposit accumulated flow onto the layer texture
//
// Full-screen quad (vertex_index only, no vertex buffer).
// Reads glazeBuffer (r16float, per-pixel accumulated flow b(x,y)) and
// strokeBaseLayer (snapshot of layer at stroke start).
// Outputs: lerp(base, brushColor, glazeCurve(b)) — non-premultiplied.
// Blend: one / zero (overwrite).  Scissor rect supplied by CPU.
// Pixels with b < 0.001 are discarded (leave layer unchanged in scissor rect).

fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let lo = c / 12.92;
    let hi = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(hi, lo, c <= vec3<f32>(0.04045));
}

fn glazeCurve(mode: u32, x: f32) -> f32 {
    let v = clamp(x, 0.0, 1.0);
    switch mode {
        case 1u: { return 1.0 - exp(-2.5 * v); }              // light   — gentle ramp, caps ~0.92
        case 2u: { return pow(v, 0.75); }                      // uniform — slight lift, feels even
        case 3u: { return pow(v, 0.5); }                       // heavy   — square-root lift
        case 4u: { return pow(v, 0.35); }                      // intense — strong early punch
        default: { return pow(v, 0.75); }
    }
}

// ── Uniforms ──────────────────────────────────────────────────────────────────
// offset  0: resolution   vec2<f32>  (canvas size in pixels)
// offset  8: glazeMode    u32        (0=off/uniform, 1=light, 2=uniform, 3=heavy, 4=intense)
// offset 12: _pad         f32
// offset 16: brushColor   vec4<f32>  (sRGB 0..1, from descriptor)
struct GlazeDepositUniforms {
    resolution:  vec2<f32>,
    glazeMode:   u32,
    _pad:        f32,
    brushColor:  vec4<f32>,
};

@group(0) @binding(0) var<uniform> u:       GlazeDepositUniforms;
@group(0) @binding(1) var          glazeTex: texture_2d<f32>;
@group(0) @binding(2) var          glazeSmp: sampler;
@group(0) @binding(3) var          baseTex:  texture_2d<f32>;
@group(0) @binding(4) var          baseSmp:  sampler;

// ── Vertex shader — full-screen quad via vertex_index ─────────────────────────

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
    var pos = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0), vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0, -1.0), vec2<f32>( 1.0,  1.0), vec2<f32>(-1.0,  1.0)
    );
    return vec4<f32>(pos[vi], 0.0, 1.0);
}

// ── Fragment shader ───────────────────────────────────────────────────────────

@fragment
fn fs_main(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
    let uv    = fragPos.xy / u.resolution;
    // Log-space buffer: value = sum of log(1 - d_i) ≤ 0
    // Convert: b = 1 - exp(log_sum) = 1 - prod(1 - d_i)
    let log_r_raw = textureSample(glazeTex, glazeSmp, uv).r;
    if log_r_raw >= 0.0 { discard; }  // Untouched pixels (log(1-0) = 0)
    // Clamp accumulated log range: prevents exp() underflow (-20 ≈ full opacity anyway)
    // and keeps gradient smooth near saturation.
    let log_r = clamp(log_r_raw, -12.0, 0.0);
    let b_raw = clamp(1.0 - exp(log_r), 0.0, 1.0);
    if b_raw < 0.001 { discard; }

    let b     = glazeCurve(u.glazeMode, b_raw);
    let base  = textureSample(baseTex, baseSmp, uv);
    let brush = srgb_to_linear(u.brushColor.rgb);
    let alpha = clamp(b, 0.0, 1.0);

    let out_rgb = mix(base.rgb, brush, alpha);
    let out_a   = mix(base.a, 1.0, alpha);
    return vec4<f32>(out_rgb, out_a);
}
