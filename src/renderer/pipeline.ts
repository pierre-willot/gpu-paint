import { createPersistentTexture } from "./texture";
import brushShaderSource from "../brush/brush.wgsl?raw";
import { downloadTexture } from "../utils/export";
import { Command } from "./history";

// Simple shader to draw a single texture to the screen
const compositeShaderSource = `
@group(0) @binding(0) var sampler0: sampler;
@group(0) @binding(1) var layerTex: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 4>(
        vec2(-1.0,  1.0), vec2( 1.0,  1.0),
        vec2(-1.0, -1.0), vec2( 1.0, -1.0)
    );
    var uv = array<vec2<f32>, 4>(
        vec2(0.0, 0.0), vec2(1.0, 0.0),
        vec2(0.0, 1.0), vec2(1.0, 1.0)
    );
    var output: VertexOutput;
    output.position = vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    output.uv = uv[vertexIndex];
    return output;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(layerTex, sampler0, uv);
}
`;

export class PaintPipeline {
  public layers: GPUTexture[] = [];
  public activeLayerIndex: number = 0;
  
  private overlayTarget: GPUTexture;
  private brushPipeline: GPURenderPipeline;
  private compositePipeline: GPURenderPipeline;
  private brushBindGroup: GPUBindGroup;
  private resolutionBuffer: GPUBuffer;
  private sampler: GPUSampler;

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    private format: GPUTextureFormat,
    private canvasWidth: number,
    private canvasHeight: number
  ) {
    this.overlayTarget = createPersistentTexture(device, canvasWidth, canvasHeight, format);
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.resolutionBuffer = this.device.createBuffer({
      size: 16, 
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 1. Brush Pipeline
    const brushModule = this.device.createShaderModule({ code: brushShaderSource });
    this.brushPipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: brushModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 12,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32' }
          ]
        }]
      },
      fragment: {
        module: brushModule,
        entryPoint: 'fs_main',
        targets: [{ 
          format: this.format,
          blend: { 
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    // 2. Composite Pipeline (Blends layers onto canvas)
    const compModule = this.device.createShaderModule({ code: compositeShaderSource });
    this.compositePipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: compModule, entryPoint: 'vs_main' },
      fragment: {
        module: compModule,
        entryPoint: 'fs_main',
        targets: [{
          format: this.format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            }
          }
        }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    this.brushBindGroup = this.device.createBindGroup({
      layout: this.brushPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.resolutionBuffer } }]
    });

    this.updateUniforms(canvasWidth, canvasHeight, 0.05);
    
  }

public async reconstructFromHistory(history: Command[]) {
    // 1. Destroy existing layers to start fresh and prevent memory leaks
    this.layers.forEach(l => l.destroy());
    this.layers = [];

    // 2. Process history in order
    for (const cmd of history) {
        if (cmd.type === 'add-layer') {
            this.addLayerInternal(this.layers.length === 0); 
        } 
        else if (cmd.type === 'delete-layer') {
            this.removeLayerInternal(cmd.layerIndex);
        } 
        else if (cmd.type === 'stroke') {
            // Safety: Ensure layer exists before drawing
            if (this.layers[cmd.layerIndex]) {
                const targetView = this.layers[cmd.layerIndex].createView();
                // We use 'load' because reconstruction builds up the layer point-by-point
                this.executeStrokePass(cmd.stamps, targetView, 'load');
            }
        }
    }

    // Ensure at least one layer exists if history ended in a state with zero layers
    if (this.layers.length === 0) {
        this.addLayerInternal(true);
    }

    // Set active index to the last available layer
    this.activeLayerIndex = Math.min(this.activeLayerIndex, this.layers.length - 1);
  }

  // --- INTERNAL HELPERS (No History/UI side effects) ---

  private addLayerInternal(isBackground: boolean = false) {
    const tex = createPersistentTexture(this.device, this.canvasWidth, this.canvasHeight, this.format);
    const clearColor = isBackground ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 0 };
    
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ 
        view: tex.createView(), 
        loadOp: 'clear', 
        clearValue: clearColor, 
        storeOp: 'store' 
      }]
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);

    this.layers.push(tex);
  }

  private removeLayerInternal(index: number) {
    if (this.layers.length <= 1) return;
    this.layers[index].destroy();
    this.layers.splice(index, 1);
  }

  // --- PUBLIC WRAPPERS ---

  public addLayer(isBackground: boolean = false) {
    this.addLayerInternal(isBackground);
    this.activeLayerIndex = this.layers.length - 1;
  }

  public removeLayer(index: number) {
    this.removeLayerInternal(index);
    if (this.activeLayerIndex >= this.layers.length) {
      this.activeLayerIndex = this.layers.length - 1;
    }
  }

private clearLayer(index: number) {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.layers[index].createView(),
        loadOp: 'clear',
        clearValue: index === 0 ? {r:1, g:1, b:1, a:1} : {r:0, g:0, b:0, a:0},
        storeOp: 'store'
      }]
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
}

  draw(stamps: Float32Array) {
    if (stamps.length > 0) {
      const activeTex = this.layers[this.activeLayerIndex];
      this.executeStrokePass(stamps, activeTex.createView(), 'load');
    }
  }

  drawPrediction(stamps: Float32Array) {
    const encoder = this.device.createCommandEncoder();
    const clearPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.overlayTarget.createView(),
        loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 0 }, storeOp: 'store'
      }]
    });
    clearPass.end();
    this.device.queue.submit([encoder.finish()]);

    if (stamps.length > 0) {
      this.executeStrokePass(stamps, this.overlayTarget.createView(), 'load');
    }
  }

  private executeStrokePass(stamps: Float32Array, targetView: GPUTextureView, loadOp: GPULoadOp) {
    const instanceBuffer = this.device.createBuffer({
      size: stamps.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(instanceBuffer, 0, stamps.buffer, stamps.byteOffset, stamps.byteLength);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: targetView, loadOp, storeOp: 'store' }]
    });
    pass.setPipeline(this.brushPipeline);
    pass.setBindGroup(0, this.brushBindGroup); 
    pass.setVertexBuffer(0, instanceBuffer);
    pass.draw(4, stamps.length / 3); 
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    instanceBuffer.destroy();
  }

public composite() {
  const encoder = this.device.createCommandEncoder();
  const canvasView = this.context.getCurrentTexture().createView();

  // If you want the "Paper" to always be white regardless of layers:
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: canvasView,
      loadOp: 'clear',
      // Change this to White {r:1, g:1, b:1, a:1} if you want 
      // a white background even if all layers are deleted.
      clearValue: { r: 1, g: 1, b: 1, a: 1.0 }, 
      storeOp: 'store'
    }]
  });

  pass.setPipeline(this.compositePipeline);

  // Draw every layer in your array
  for (const layer of this.layers) {
    const bindGroup = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: layer.createView() }
      ]
    });
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
  }

  // Draw prediction (ghost)
  const overlayBG = this.device.createBindGroup({
    layout: this.compositePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: this.sampler },
      { binding: 1, resource: this.overlayTarget.createView() }
    ]
  });
  pass.setBindGroup(0, overlayBG);
  pass.draw(4);

  pass.end();
  this.device.queue.submit([encoder.finish()]);
}
  updateUniforms(w: number, h: number, size: number) {
    this.device.queue.writeBuffer(this.resolutionBuffer, 0, new Float32Array([w, h, size, 0]));
  }

  clear() {
    // Clears only the active layer
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.layers[this.activeLayerIndex].createView(),
        loadOp: 'clear', 
        clearValue: this.activeLayerIndex === 0 ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 0 }, 
        storeOp: 'store'
      }]
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    this.composite();
  }

 async saveImage() {
  // 1. Create a temporary "Flattened" texture to hold the final result
  const exportTexture = createPersistentTexture(
    this.device, 
    this.canvasWidth, 
    this.canvasHeight, 
    this.format
  );

  const encoder = this.device.createCommandEncoder();
  
  // 2. Run a "Silent Composite" pass into the exportTexture
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: exportTexture.createView(),
      loadOp: 'clear',
      clearValue: { r: 1, g: 1, b: 1, a: 1.0 }, // Save with a white background
      storeOp: 'store'
    }]
  });

  pass.setPipeline(this.compositePipeline);

  // Draw all permanent layers (but NOT the prediction ghost)
  for (const layer of this.layers) {
    const bindGroup = this.device.createBindGroup({
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: layer.createView() }
      ]
    });
    pass.setBindGroup(0, bindGroup);
    pass.draw(4);
  }

  pass.end();
  this.device.queue.submit([encoder.finish()]);

  // 3. Download the flattened result
  await downloadTexture(this.device, exportTexture, "full-drawing.png");

  // 4. Cleanup memory
  exportTexture.destroy();
}
}