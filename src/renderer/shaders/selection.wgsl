// ── selection.wgsl ────────────────────────────────────────────────────────────
// Renders an animated marching-ants border around the active selection.
// Drawn as a fullscreen quad over the composited canvas.
//
// The boundary detection samples the mask and its 4 neighbours.
// The dash animation uses a screen-space diagonal offset + time so
// the ants appear to march continuously around the selection boundary.

struct Uniforms {
    resolution: vec2<f32>,  // canvas width, height in pixels
    time:       f32,        // seconds since session start (wraps fine)
    _pad:       f32,
};

@group(0) @binding(0) var<uniform> u:       Uniforms;
@group(0) @binding(1) var          maskTex: texture_2d<f32>;
@group(0) @binding(2) var          maskSmp: sampler;

struct VertexOut {
    @builtin(position) position: vec4<f32>,
    @location(0)       uv:       vec2<f32>,
};

// Full-screen triangle (no vertex buffer needed)
var<private> POSITIONS: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
    let pos = POSITIONS[vi];
    var out: VertexOut;
    out.position = vec4<f32>(pos, 0.0, 1.0);
    out.uv       = pos * 0.5 + 0.5;           // 0..1
    out.uv.y     = 1.0 - out.uv.y;            // flip Y: canvas origin top-left
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let dx = 1.0 / u.resolution.x;
    let dy = 1.0 / u.resolution.y;

    // Sample centre and 4 cardinal neighbours
    let c = textureSample(maskTex, maskSmp, uv).r;
    let l = textureSample(maskTex, maskSmp, uv + vec2<f32>(-dx,   0)).r;
    let r = textureSample(maskTex, maskSmp, uv + vec2<f32>( dx,   0)).r;
    let t = textureSample(maskTex, maskSmp, uv + vec2<f32>(  0, -dy)).r;
    let b = textureSample(maskTex, maskSmp, uv + vec2<f32>(  0,  dy)).r;

    let threshold: f32 = 0.5;

    // A pixel is on the boundary if it is selected and at least one
    // cardinal neighbour is NOT selected (or vice-versa — draw on both sides).
    let sel   = c > threshold;
    let nbSel = l > threshold || r > threshold || t > threshold || b > threshold;
    let nbUnsel = l < threshold || r < threshold || t < threshold || b < threshold;
    let isBoundary = (sel && nbUnsel) || (!sel && nbSel);

    if !isBoundary { discard; }

    // ── Marching-ants animation ───────────────────────────────────────────────
    // Approximate arc-length position along the boundary using a diagonal of
    // screen-space coordinates. This is not true arc-length but gives the
    // visual appearance of continuous movement at low cost.
    let dashPos = (uv.x * u.resolution.x + uv.y * u.resolution.y + u.time * 80.0);
    let dashLen: f32 = 8.0; // pixels per dash+gap
    let isWhite = (dashPos % dashLen) < (dashLen * 0.5);

    // Two-colour ants: alternating white and near-black for visibility
    // on any background colour.
    if isWhite {
        return vec4<f32>(1.0, 1.0, 1.0, 0.88);
    } else {
        return vec4<f32>(0.08, 0.08, 0.08, 0.88);
    }
}
