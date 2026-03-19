// Stamp layout (48 bytes per instance):
//   @location(0)  pos        vec2<f32>   offset  0
//   @location(1)  pressure   f32         offset  8
//   @location(2)  size       f32         offset 12
//   @location(3)  color      vec4<f32>   offset 16
//   @location(4)  tilt       vec2<f32>   offset 32
//   @location(5)  opacity    f32         offset 40
//   @location(6)  stampAngle f32         offset 44
//
// Blend state: src-alpha, one-minus-src-alpha (non-premultiplied).
// Fragment MUST return vec4(color.rgb, alpha) — NOT premultiplied.
// Returning premultiplied alpha with this blend state double-multiplies alpha
// and produces a dark outline ring at stamp edges.

const PI: f32 = 3.14159265358979;

struct VertexOut {
    @builtin(position) position:   vec4<f32>,
    @location(0)       uv:         vec2<f32>,
    @location(1)       color:      vec4<f32>,
    @location(2)       radius_px:  f32,
    @location(3)       tilt:       vec2<f32>,
    @location(4)       finalAngle: f32,
    @location(5)       hardness:   f32,
};

struct Uniforms {
    resolution: vec2<f32>,
    hardness:   f32,
    _pad:       f32,
};

@group(0) @binding(0) var<uniform> u:       Uniforms;
@group(0) @binding(1) var          maskTex: texture_2d<f32>;
@group(0) @binding(2) var          maskSmp: sampler;

@vertex
fn vs_main(
    @builtin(vertex_index) vi:  u32,
    @location(0) pos:        vec2<f32>,
    @location(1) pressure:   f32,
    @location(2) size:       f32,
    @location(3) color:      vec4<f32>,
    @location(4) tilt:       vec2<f32>,
    @location(5) opacity:    f32,
    @location(6) stampAngle: f32
) -> VertexOut {
    var quad = array<vec2<f32>, 4>(
        vec2<f32>(-1.0,  1.0), vec2<f32>( 1.0,  1.0),
        vec2<f32>(-1.0, -1.0), vec2<f32>( 1.0, -1.0)
    );

    let center    = vec2<f32>(pos.x * 2.0 - 1.0, -(pos.y * 2.0 - 1.0));
    let radius_px = size * u.resolution.x * 0.5;
    let tilt_mag  = length(tilt);
    let aspect    = 1.0 + (tilt_mag / 90.0) * 2.0;
    let quad_r    = radius_px * aspect;
    let off_x     = quad_r * 2.0 / u.resolution.x;
    let off_y     = quad_r * 2.0 / u.resolution.y;

    let tilt_az  = select(0.0, atan2(tilt.y, tilt.x) * (PI / 180.0), tilt_mag > 0.5);
    let finalAng = tilt_az + stampAngle;

    var out: VertexOut;
    out.position   = vec4<f32>(center.x + quad[vi].x * off_x, center.y + quad[vi].y * off_y, 0.0, 1.0);
    out.uv         = quad[vi] * aspect;
    // Combine base color alpha with per-stamp opacity — stored straight (not premultiplied)
    out.color      = vec4<f32>(color.rgb, color.a * opacity);
    out.radius_px  = radius_px;
    out.tilt       = tilt;
    out.finalAngle = finalAng;
    out.hardness   = u.hardness;
    return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
    // Selection mask — discard outside selection when active.
    // canvas_uv maps fragment screen position back to 0..1 canvas UV.
    let canvas_uv = in.position.xy / u.resolution;
    let mask_val  = textureSample(maskTex, maskSmp, canvas_uv).r;
    if mask_val < 0.004 { discard; }

    // Stamp shape
    let tilt_mag = length(in.tilt);
    var dist: f32;

    if tilt_mag < 0.5 && in.finalAngle == 0.0 {
        dist = length(in.uv);
    } else {
        let aspect = 1.0 + (tilt_mag / 90.0) * 2.0;
        let c      = cos(-in.finalAngle);
        let s      = sin(-in.finalAngle);
        let rot_uv = vec2<f32>(in.uv.x * c - in.uv.y * s, in.uv.x * s + in.uv.y * c);
        dist = length(vec2<f32>(rot_uv.x / aspect, rot_uv.y));
    }

    if dist > 1.0 { discard; }

    // Hardness-driven edge
    let aa_width   = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
    let hard_mask  = smoothstep(1.0, 1.0 - aa_width, dist);
    let gaussian   = exp(-dist * dist * 5.54);
    let alpha_base = mix(gaussian, hard_mask, in.hardness);

    // Final alpha: shape × stamp opacity × mask
    let alpha = alpha_base * in.color.a * mask_val;

    // Return NON-PREMULTIPLIED. The blend state is src-alpha / one-minus-src-alpha.
    // Returning premultiplied here would double-multiply alpha and produce a dark ring.
    return vec4<f32>(in.color.rgb, alpha);
}
