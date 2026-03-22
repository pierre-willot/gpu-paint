// Procreate-style GPU smudge shader.
//
// Two GPU passes per stamp batch — both share this vertex shader:
//
//   fs_pickup  — reads carryTex (tex_a) + live layerTex (tex_b)
//                → writes updated carry to scratchTex (overwrite, no blend)
//                → loadOp:'load' preserves non-stamp carry values
//
//   fs_deposit — reads scratchTex/new carry (tex_a) + selMask (tex_b)
//                → blends carried color onto layer (premultiplied: one / one-minus-src-alpha)
//
// Stamp layout (48 bytes per instance) — identical to brush.wgsl.

const PI: f32 = 3.14159265358979;

struct Uniforms {
    resolution: vec2<f32>,
    hardness:   f32,
    strength:   f32,   // smudge pickup amount (0 = none, 1 = full)
};

struct VertexOut {
    @builtin(position) clip_pos:   vec4<f32>,
    @location(0)       uv:         vec2<f32>,
    @location(1)       opacity:    f32,
    @location(2)       radius_px:  f32,
    @location(3)       tilt:       vec2<f32>,
    @location(4)       angle:      f32,
    // Normalized (0..1) position of the PREVIOUS stamp center.
    // Carry is sampled here so colors are advected forward along the stroke.
    @location(5)       prev_center: vec2<f32>,
};

@group(0) @binding(0) var<uniform> u:       Uniforms;
@group(0) @binding(1) var          tex_a:   texture_2d<f32>; // carry (both) | layer (pickup)
@group(0) @binding(2) var          tex_b:   texture_2d<f32>; // layer (pickup) | selMask (deposit)
@group(0) @binding(3) var          texSmp:  sampler;          // filtering — carry + layer
@group(0) @binding(4) var          maskSmp: sampler;          // non-filtering — selMask

@vertex
fn vs_main(
    @builtin(vertex_index) vi:  u32,
    @location(0) pos:        vec2<f32>,
    @location(1) pressure:   f32,
    @location(2) size:       f32,
    // color.xy repurposed as the PREVIOUS stamp's normalized (0..1) center.
    // color.zw unused. Encoded by SmudgeTool.drawToLayer before submission.
    @location(3) color:      vec4<f32>,
    @location(4) tilt:       vec2<f32>,
    @location(5) opacity:    f32,
    @location(6) stampAngle: f32
) -> VertexOut {
    var quad = array<vec2<f32>, 4>(
        vec2(-1.0,  1.0), vec2( 1.0,  1.0),
        vec2(-1.0, -1.0), vec2( 1.0, -1.0)
    );
    let center    = vec2(pos.x * 2.0 - 1.0, -(pos.y * 2.0 - 1.0));
    let radius_px = size * u.resolution.x * 0.5;
    let tilt_mag  = length(tilt);
    let aspect    = 1.0 + (tilt_mag / 90.0) * 2.0;
    let quad_r    = radius_px * aspect;
    let off_x     = quad_r * 2.0 / u.resolution.x;
    let off_y     = quad_r * 2.0 / u.resolution.y;
    let tilt_az   = select(0.0, atan2(tilt.y, tilt.x) * (PI / 180.0), tilt_mag > 0.5);

    var out: VertexOut;
    out.clip_pos    = vec4(center.x + quad[vi].x * off_x, center.y + quad[vi].y * off_y, 0.0, 1.0);
    out.uv          = quad[vi] * aspect;
    out.opacity     = opacity;
    out.radius_px   = radius_px;
    out.tilt        = tilt;
    out.angle       = tilt_az + stampAngle;
    out.prev_center = color.xy;  // encoded by SmudgeTool: previous stamp's normalized pos
    return out;
}

fn stamp_mask(in: VertexOut) -> f32 {
    let tilt_mag = length(in.tilt);
    var dist: f32;
    if tilt_mag < 0.5 && in.angle == 0.0 {
        dist = length(in.uv);
    } else {
        let aspect = 1.0 + (tilt_mag / 90.0) * 2.0;
        let c      = cos(-in.angle);
        let s      = sin(-in.angle);
        let rot    = vec2(in.uv.x * c - in.uv.y * s, in.uv.x * s + in.uv.y * c);
        dist       = length(vec2(rot.x / aspect, rot.y));
    }
    if dist > 1.0 { return 0.0; }
    let aa    = clamp(1.5 / max(in.radius_px, 1.0), 0.01, 0.5);
    let hard  = smoothstep(1.0, 1.0 - aa, dist);
    let gauss = exp(-dist * dist * 5.54);
    return mix(gauss, hard, u.hardness);
}

// ── Pickup ────────────────────────────────────────────────────────────────────
// tex_a = carryTex (current carry state)
// tex_b = layerTex (live layer — already includes previous deposits this stroke)
//
// Layer textures store PREMULTIPLIED colors (brush.wgsl uses src-alpha blend,
// producing premultiplied results). Carry is seeded from the layer, so carry
// is also premultiplied. Simple linear mix is correct for premultiplied values.
// No blend state: overwrite. loadOp:'load' preserves non-stamp carry values.
@fragment
fn fs_pickup(in: VertexOut) -> @location(0) vec4<f32> {
    let mask = stamp_mask(in);
    if mask < 0.001 { discard; }

    let frag_uv = in.clip_pos.xy / u.resolution;
    let layer   = textureSample(tex_b, texSmp, frag_uv);

    // Sample carry from the PREVIOUS stamp's center position.
    // This advects color forward along the stroke: the color that was
    // "on the finger" from prev position gets transported to curr position.
    // For the very first stamp prev_center == current center → carry = layer → no drag (correct seed).
    let carry = textureSample(tex_a, texSmp, in.prev_center);

    // Both layer and carry are premultiplied — simple mix is correct.
    // Do NOT convert to/from straight alpha: layer.rgb is already rgb×alpha.
    let t = u.strength * mask;
    return mix(layer, carry, t);
}

// ── Deposit ───────────────────────────────────────────────────────────────────
// tex_a = scratchTex (updated carry from pickup pass)
// tex_b = selMask    (R8Unorm — 1×1 white when no selection)
//
// Writes carry onto the layer using PREMULTIPLIED blend (one / one-minus-src-alpha).
// carry is premultiplied; scale by eff uniformly so transparent areas fade correctly.
// Using straight-alpha blend on premultiplied carry would double-apply alpha → black.
@fragment
fn fs_deposit(in: VertexOut) -> @location(0) vec4<f32> {
    let uv       = in.clip_pos.xy / u.resolution;
    let mask_val = textureSample(tex_b, maskSmp, uv).r;
    if mask_val < 0.004 { discard; }

    let mask = stamp_mask(in);
    if mask < 0.001 { discard; }

    // carry is premultiplied — scale rgb and a uniformly by eff.
    // Blend state: one / one-minus-src-alpha (premultiplied compositing).
    let carry = textureSample(tex_a, texSmp, uv);
    let eff   = mask * in.opacity * mask_val;
    return vec4<f32>(carry.rgb * eff, carry.a * eff);
}
