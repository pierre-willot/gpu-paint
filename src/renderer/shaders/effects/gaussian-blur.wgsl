// ── gaussian-blur.wgsl ────────────────────────────────────────────────────────
// Separable Gaussian blur: horizontal pass then vertical pass.
// Each pass is one compute dispatch with workgroup size [16, 16, 1].
//
// The kernel weights are computed from sigma at each invocation — no fixed
// kernel array needed so any radius is supported without shader recompilation.
// Maximum practical radius: 64px (sigma ≤ ~22). Use downscale for larger.

struct Uniforms {
    resolution:  vec2<u32>,  // source texture width, height
    radius:      u32,        // kernel half-width in pixels
    horizontal:  u32,        // 1 = horizontal pass, 0 = vertical pass
};

@group(0) @binding(0) var<uniform> u:   Uniforms;
@group(0) @binding(1) var          src: texture_2d<f32>;
@group(0) @binding(2) var          dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let coord = vec2<i32>(gid.xy);
    let size  = vec2<i32>(u.resolution);
    if coord.x >= size.x || coord.y >= size.y { return; }

    let r     = i32(u.radius);
    // sigma = radius/3 gives a kernel that reaches ~0 at the edges (99.7% rule)
    var sigma = max(0.01, f32(r) / 3.0);

    var weightSum: f32      = 0.0;
    var color:     vec4<f32> = vec4<f32>(0.0);

    for (var k = -r; k <= r; k++) {
        let w = exp(-f32(k * k) / (2.0 * sigma * sigma));

        let offset = select(vec2<i32>(0, k), vec2<i32>(k, 0), u.horizontal == 1u);
        let sc     = clamp(coord + offset, vec2<i32>(0), size - vec2<i32>(1));

        color     += textureLoad(src, sc, 0) * w;
        weightSum += w;
    }

    textureStore(dst, coord, color / weightSum);
}
