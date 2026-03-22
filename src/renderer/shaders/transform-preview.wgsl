struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// 2×4 affine inverse matrix:
//   src.x = dot(row0.xyz, vec3(dst.uv, 1.0))
//   src.y = dot(row1.xyz, vec3(dst.uv, 1.0))
// Computed on CPU from { cx, cy, scaleX, scaleY, rotation }.
struct TransformUniforms {
    row0: vec4<f32>,
    row1: vec4<f32>,
};

@group(0) @binding(0) var samp:           sampler;
@group(0) @binding(1) var srcTex:         texture_2d<f32>;
@group(0) @binding(2) var<uniform> xform: TransformUniforms;

// Full-screen quad — no vertex buffer needed.
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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let srcUV = vec2<f32>(
        dot(xform.row0.xyz, vec3<f32>(in.uv, 1.0)),
        dot(xform.row1.xyz, vec3<f32>(in.uv, 1.0))
    );
    // textureSampleLevel has no uniform-control-flow requirement (unlike textureSample).
    // Sample unconditionally at mip 0, then mask out-of-bounds pixels to transparent.
    let color    = textureSampleLevel(srcTex, samp, srcUV, 0.0);
    let inBounds = all(srcUV >= vec2<f32>(0.0)) && all(srcUV <= vec2<f32>(1.0));
    return select(vec4<f32>(0.0, 0.0, 0.0, 0.0), color, inBounds);
}
