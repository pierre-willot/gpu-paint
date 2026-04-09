struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Per-layer uniforms written before every draw call.
// Packed into 16 bytes to satisfy WebGPU uniform alignment rules:
//   bytes  0- 3 : opacity   f32  (0.0 → 1.0)
//   bytes  4- 7 : blendMode u32  (0=normal, 1=multiply, 2=screen, 3=overlay)
//   bytes  8-11 : swapRB    u32  (1 = swap R↔B channels at output)
//   bytes 12-15 : padding   f32
struct LayerUniforms {
    opacity:   f32,
    blendMode: u32,
    swapRB:    u32,
    _pad1:     f32,
};

@group(0) @binding(0) var samp:           sampler;
@group(0) @binding(1) var tex:            texture_2d<f32>;
@group(0) @binding(2) var<uniform> layer: LayerUniforms;
// Backdrop = backingTexture content BEFORE this layer is applied.
// Only read when blendMode != 0. Normal layers bind a 1×1 white dummy here.
@group(0) @binding(3) var backdropTex:    texture_2d<f32>;

// ── Vertex shader ─────────────────────────────────────────────────────────────
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

// ── Color space ───────────────────────────────────────────────────────────────

// Encode linear light to sRGB. Used only in the final canvas blit (fs_blit_srgb).
fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let lo = c * 12.92;
    let hi = 1.055 * pow(max(c, vec3<f32>(0.0)), vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(hi, lo, c <= vec3<f32>(0.0031308));
}

// ── Blend mode functions ──────────────────────────────────────────────────────
// All operate on NON-PREMULTIPLIED linear RGB.
// src = current layer, dst = backdrop (composited layers below).

fn blend_multiply(src: vec3<f32>, dst: vec3<f32>) -> vec3<f32> { return src * dst; }
fn blend_screen  (src: vec3<f32>, dst: vec3<f32>) -> vec3<f32> { return src + dst - src * dst; }

// Overlay splits on the BACKDROP value (dst), not the source.
fn blend_overlay(src: vec3<f32>, dst: vec3<f32>) -> vec3<f32> {
    return select(
        2.0 * src * dst,
        1.0 - 2.0 * (1.0 - src) * (1.0 - dst),
        dst >= vec3<f32>(0.5)
    );
}

// ── Fragment shader ───────────────────────────────────────────────────────────
//
// Outputs LINEAR PREMULTIPLIED values.
//
// Normal blend mode (blendMode == 0):
//   GPU blend state (one, one-minus-src-alpha) composites in linear space — correct.
//
// Non-normal blend modes (blendMode != 0):
//   GPU blend state is (one, zero) — Porter-Duff "over" is computed here instead.
//   Reads backdropTex to get the current composited state below this layer.
//
// sRGB encoding happens ONLY in the final canvas blit (fs_blit_srgb), not here.

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var color = textureSample(tex, samp, in.uv);

    // Unpremultiply — blend modes operate on non-premultiplied linear RGB.
    let a_safe     = max(color.a, 0.0001);
    let rgb_linear = select(vec3<f32>(0.0), color.rgb / a_safe, color.a > 0.0001);

    if layer.blendMode != 0u {
        // ── Non-normal blend mode: read backdrop, blend, Porter-Duff in shader ─
        //
        // backingTexture is bgra8unorm: shader .r = B, .g = G, .b = R.
        // rgba16float layers have .r = R, .b = B.
        // When swapRB is set, we swap backdrop channels to match the layer's
        // logical (R,G,B) space before blending, then swap the output back.
        let backdrop = textureSample(backdropTex, samp, in.uv);
        let dst_a    = backdrop.a;
        // Transparent backdrop → white (canvas paper colour behind all layers).
        var dst_rgb  = select(vec3<f32>(1.0), backdrop.rgb / max(dst_a, 0.0001), dst_a > 0.0001);

        // Match channel layout: swap backdrop to RGBA space if needed.
        if layer.swapRB != 0u { dst_rgb = dst_rgb.bgr; }

        var blended: vec3<f32>;
        if      layer.blendMode == 1u { blended = blend_multiply(rgb_linear, dst_rgb); }
        else if layer.blendMode == 2u { blended = blend_screen  (rgb_linear, dst_rgb); }
        else if layer.blendMode == 3u { blended = blend_overlay (rgb_linear, dst_rgb); }
        else                          { blended = rgb_linear; }

        // Porter-Duff "over" in shader (GPU does not do it; blend is one/zero).
        let src_a  = color.a * layer.opacity;
        let out_a  = src_a + dst_a * (1.0 - src_a);
        var out_rgb: vec3<f32>;
        if out_a > 0.0001 {
            out_rgb = (blended * src_a + dst_rgb * dst_a * (1.0 - src_a)) / out_a;
        }

        // Re-premultiply and swap back to bgra layout if needed.
        if layer.swapRB != 0u {
            return vec4<f32>(out_rgb.b * out_a, out_rgb.g * out_a, out_rgb.r * out_a, out_a);
        }
        return vec4<f32>(out_rgb * out_a, out_a);
    }

    // ── Normal blend mode: output linear premultiplied ─────────────────────────
    // GPU blend (one, one-minus-src-alpha) handles Porter-Duff "over" in linear space.
    var out_color = vec4<f32>(rgb_linear * color.a, color.a) * layer.opacity;

    if layer.swapRB != 0u {
        out_color = vec4<f32>(out_color.b, out_color.g, out_color.r, out_color.a);
    }
    return out_color;
}

// ── Final canvas blit ─────────────────────────────────────────────────────────
//
// Reads linear-premultiplied backingTexture and writes sRGB-premultiplied to the
// canvas swap chain (bgra8unorm, alphaMode: 'premultiplied').
//
// This is the ONLY place sRGB encoding happens — all layer composite passes above
// accumulate in linear space so that hardware blending is mathematically correct.
//
// backingTexture is bgra8unorm: .r=B, .g=G, .b=R in shader registers.
// linear_to_srgb is per-component so channel ordering does not affect correctness.
@fragment
fn fs_blit_srgb(in: VertexOutput) -> @location(0) vec4<f32> {
    let color  = textureSample(tex, samp, in.uv);
    let a_safe = max(color.a, 0.0001);
    let rgb    = select(vec3<f32>(0.0), color.rgb / a_safe, color.a > 0.0001);
    let srgb   = linear_to_srgb(rgb);
    return vec4<f32>(srgb * color.a, color.a);
}
