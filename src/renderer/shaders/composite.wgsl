struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Per-layer uniforms written before every draw call.
// Packed into 16 bytes to satisfy WebGPU uniform alignment rules:
//   bytes  0- 3 : opacity   f32  (0.0 → 1.0)
//   bytes  4- 7 : blendMode u32  (0=normal, 1=multiply, 2=screen, 3=overlay)
//   bytes  8-11 : padding   f32
//   bytes 12-15 : padding   f32
struct LayerUniforms {
    opacity:   f32,
    blendMode: u32,
    _pad0:     f32,
    _pad1:     f32,
};

@group(0) @binding(0) var samp:          sampler;
@group(0) @binding(1) var tex:           texture_2d<f32>;
@group(0) @binding(2) var<uniform> layer: LayerUniforms;

// ── Vertex shader ─────────────────────────────────────────────────────────────
// Hardcoded fullscreen quad. No uniforms needed — clip space and UV always
// cover the full canvas. Completely immune to aspect ratio or canvas size.

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 4>(
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0)
    );
    var uv = array<vec2<f32>, 4>(
        vec2<f32>(0.0, 0.0),
        vec2<f32>(1.0, 0.0),
        vec2<f32>(0.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );
    var out: VertexOutput;
    out.position = vec4<f32>(pos[i], 0.0, 1.0);
    out.uv       = uv[i];
    return out;
}

// ── Blend mode functions ──────────────────────────────────────────────────────
// All functions operate on the layer's own RGB in 0→1 range.
// The GPU alpha-blend stage (one, one-minus-src-alpha) then mixes the result
// onto whatever is already on the canvas below.

// Multiply: dark areas darken, white (1.0) is neutral.
// Useful for shadows, ink, and darkening effects.
fn blend_multiply(rgb: vec3<f32>) -> vec3<f32> {
    return rgb * rgb;
}

// Screen: bright areas brighten, black (0.0) is neutral.
// Useful for glows, light leaks, and brightening effects.
fn blend_screen(rgb: vec3<f32>) -> vec3<f32> {
    return 1.0 - (1.0 - rgb) * (1.0 - rgb);
}

// Overlay: combines multiply and screen split at 0.5 per channel.
// Dark areas darken, bright areas brighten, midtones stay roughly neutral.
// select() is branchless — evaluates both branches, picks by condition.
fn blend_overlay(rgb: vec3<f32>) -> vec3<f32> {
    return select(
        2.0 * rgb * rgb,
        1.0 - 2.0 * (1.0 - rgb) * (1.0 - rgb),
        rgb >= vec3<f32>(0.5)
    );
}

// ── Fragment shader ───────────────────────────────────────────────────────────

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var color = textureSample(tex, samp, in.uv);

    // Apply blend mode to RGB — alpha is unaffected by blend mode.
    // blendMode == 0u (normal): color.rgb passes through unchanged.
    if      (layer.blendMode == 1u) { color = vec4<f32>(blend_multiply(color.rgb), color.a); }
    else if (layer.blendMode == 2u) { color = vec4<f32>(blend_screen(color.rgb),   color.a); }
    else if (layer.blendMode == 3u) { color = vec4<f32>(blend_overlay(color.rgb),  color.a); }

    // Apply opacity: scales both RGB and alpha uniformly.
    // The GPU blend stage receives the scaled result and mixes it onto the
    // canvas using (one, one-minus-src-alpha) — correct for pre-multiplied alpha.
    return color * layer.opacity;
}