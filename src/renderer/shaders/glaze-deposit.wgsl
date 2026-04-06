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
    switch mode {
        case 1u: { return 1.0 - exp(-2.0 * x); }                          // light
        case 2u: { return clamp(x, 0.0, 1.0); }                           // uniform
        case 3u: { return clamp(pow(max(x, 0.0), 0.7), 0.0, 1.0); }      // heavy
        case 4u: { return clamp(pow(max(x, 0.0), 0.4), 0.0, 1.0); }      // intense
        default: { return clamp(x, 0.0, 1.0); }
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
    let b_raw = textureSample(glazeTex, glazeSmp, uv).r;
    if b_raw < 0.001 { discard; }

    let b     = glazeCurve(u.glazeMode, b_raw);
    let base  = textureSample(baseTex, baseSmp, uv);
    let brush = srgb_to_linear(u.brushColor.rgb);
    let alpha = clamp(b, 0.0, 1.0);

    let out_rgb = mix(base.rgb, brush, alpha);
    let out_a   = mix(base.a, 1.0, alpha);
    return vec4<f32>(out_rgb, out_a);
}
