// Procreate-style GPU wet-brush shader.
//
// Two GPU passes per stamp — both share this vertex shader:
//
//   fs_wet_mix — reads carryTex (tex_a) + live layerTex (tex_b)
//                Implements the per-step evolution of brush_color:
//                  Step B: brush_color = lerp(carry@prev_center, canvas, pull × mask)
//                  Step C: brush_color = lerp(brush_color, user_color, charge)
//                Carry is sampled from the PREVIOUS stamp center so colors are
//                advected forward along the stroke (spatial transport).
//                Overwrites carry; loadOp:'load' preserves non-stamp areas.
//
//   fs_deposit — reads scratchTex (tex_a) + selMask (tex_b)
//                Step D: deposits carry onto canvas at dilution × dynstr × mask.
//                Premultiplied alpha-blend (one / one-minus-src-alpha).
//
// Stamp color.xy = prev_center (packed by UnifiedBrushTool).
// Stamp color.z  = dynstr (attack × grade; 1.0 for plain paint).

const PI: f32 = 3.14159265358979;

struct Uniforms {
    resolution: vec2<f32>,
    hardness:   f32,
    charge:     f32,    // Step C: how much fresh paint is injected per stamp
    pull:       f32,    // Step B: how strongly canvas color is absorbed into carry
    dilution:   f32,    // Step D: deposit strength onto canvas
    _pad:       vec2<f32>,
    user_color: vec4<f32>, // fresh paint, non-premultiplied RGBA (offset 32)
};

struct VertexOut {
    @builtin(position) clip_pos:    vec4<f32>,
    @location(0)       uv:          vec2<f32>,
    @location(1)       opacity:     f32,
    @location(2)       radius_px:   f32,
    @location(3)       tilt:        vec2<f32>,
    @location(4)       angle:       f32,
    // Normalised (0..1) position of the PREVIOUS stamp center.
    // Carry is sampled here so colors are advected forward along the stroke.
    @location(5)       prev_center: vec2<f32>,
    // Per-stamp dynamic strength: attack × grade (1.0 for plain paint).
    @location(6)       dynstr:      f32,
};

@group(0) @binding(0) var<uniform> u:       Uniforms;
@group(0) @binding(1) var          tex_a:   texture_2d<f32>;
@group(0) @binding(2) var          tex_b:   texture_2d<f32>;
@group(0) @binding(3) var          texSmp:  sampler;
@group(0) @binding(4) var          maskSmp: sampler;

@vertex
fn vs_main(
    @builtin(vertex_index) vi:  u32,
    @location(0) pos:        vec2<f32>,
    @location(1) pressure:   f32,
    @location(2) size:       f32,
    // color.xy = prev stamp center (normalised 0..1), packed by UnifiedBrushTool.
    // color.z  = dynstr (attack × grade).
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
    out.prev_center = color.xy;
    out.dynstr      = color.z;
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

// ── Wet Mix ───────────────────────────────────────────────────────────────────
// tex_a = carryTex  (current brush_color state, premultiplied)
// tex_b = layerTex  (live canvas, premultiplied)
//
// Step B: carry = lerp(carry@prev_center, canvas,     pull   × mask)
// Step C: carry = lerp(carry,             user_color, charge)
//
// Carry is sampled from the previous stamp's center — this spatial offset is
// what transports colors along the stroke (smear / wet-drag effect).
// user_color is non-premultiplied in the uniform — converted before the lerp.
// No blend state (overwrite). loadOp:'load' preserves non-stamp carry values.
@fragment
fn fs_wet_mix(in: VertexOut) -> @location(0) vec4<f32> {
    let mask = stamp_mask(in);
    if mask < 0.001 { discard; }

    let frag_uv = in.clip_pos.xy / u.resolution;

    // Live canvas color at this pixel (premultiplied)
    let layer = textureSample(tex_b, texSmp, frag_uv);

    // Carry sampled from PREVIOUS stamp center — advects color forward
    let carry = textureSample(tex_a, texSmp, in.prev_center);

    // Step B — absorb canvas into carry
    let pulled = mix(carry, layer, u.pull * mask);

    // Step C — inject fresh paint (convert user_color to premultiplied)
    let uc_pm   = vec4(u.user_color.rgb * u.user_color.a, u.user_color.a);
    let charged = mix(pulled, uc_pm, u.charge);

    return charged;
}

// ── Deposit ───────────────────────────────────────────────────────────────────
// tex_a = scratchTex (updated carry from wet_mix pass, premultiplied)
// tex_b = selMask    (R8Unorm — 1×1 white when no selection)
//
// Step D: result = lerp(canvas, carry, dilution × dynstr × mask × opacity)
// Implemented via premultiplied blend (one / one-minus-src-alpha):
//   output   = vec4(carry.rgb × eff, carry.a × eff)
//   result   = output.rgb + canvas.rgb × (1 - output.a)
//            ≈ carry.rgb × eff + canvas.rgb × (1 - eff)   [carry.a ≈ 1]
@fragment
fn fs_deposit(in: VertexOut) -> @location(0) vec4<f32> {
    let uv       = in.clip_pos.xy / u.resolution;
    let mask_val = textureSample(tex_b, maskSmp, uv).r;
    if mask_val < 0.004 { discard; }

    let mask = stamp_mask(in);
    if mask < 0.001 { discard; }

    let carry = textureSample(tex_a, texSmp, uv);
    let eff   = u.dilution * in.dynstr * mask * in.opacity * mask_val;
    return vec4<f32>(carry.rgb * eff, carry.a * eff);
}
