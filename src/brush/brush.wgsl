struct VertexOutput {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

struct CanvasUniforms {
    res: vec2f,
    brushSize: f32,
};

@group(0) @binding(0) var<uniform> canvas: CanvasUniforms;

@vertex
fn vs_main(
    @builtin(vertex_index) v_idx: u32,
    @location(0) p: vec2f,      // Matches float32x2 (x, y)
    @location(1) pressure: f32  // Matches float32 (p)
) -> VertexOutput {
    var out: VertexOutput;

    // 1. Standard Quad Positions
    var pos = array<vec2f, 4>(
        vec2f(-1.0, -1.0), vec2f(1.0, -1.0),
        vec2f(-1.0,  1.0), vec2f(1.0,  1.0)
    );

    let aspect = canvas.res.x / canvas.res.y;
    
    // 2. Combine Brush Size with Pressure
    let size = canvas.brushSize * pressure;

    // 3. Offset and Scale (The "Oval Fix" logic)
    // We scale the X by 1/aspect to keep the brush circular
    let offset = vec2f(
        (pos[v_idx].x * size) / aspect, 
        pos[v_idx].y * size
    );

    // 4. Convert Input Point (0 to 1) to NDC (-1 to 1)
    let center = vec2f(p.x * 2.0 - 1.0, (1.0 - p.y) * 2.0 - 1.0);

    out.pos = vec4f(center + offset, 0.0, 1.0);
    out.uv = pos[v_idx]; // Pass UVs to fragment for circle math

    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let dist = length(in.uv);
    
    // Smooth circle edge
    let alpha = 1.0 - smoothstep(0.9, 1.0, dist);
    
    if (alpha <= 0.0) { discard; }
    
    return vec4f(0.0, 0.0, 0.0, alpha); // Black brush
}