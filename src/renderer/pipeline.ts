import { createPersistentTexture } from "./texture";
// Ensure you have vite-env.d.ts or use this casting if TS still complains
import brushShaderSource from "../brush/brush.wgsl?raw";
import { downloadTexture } from "../utils/export";

export class PaintPipeline {
  private renderTarget: GPUTexture;
  private pipeline: GPURenderPipeline;
  private bindGroup: GPUBindGroup;
  private resolutionBuffer: GPUBuffer;

  constructor(
    private device: GPUDevice,
    private context: GPUCanvasContext,
    private format: GPUTextureFormat,
    canvasWidth: number,
    canvasHeight: number
  ) {
    this.renderTarget = createPersistentTexture(device, canvasWidth, canvasHeight, format);

    // Initialize Uniform Buffer
    this.resolutionBuffer = this.device.createBuffer({
      label: "Uniform Resolution and Size Buffer",
      size: 16, 
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Write initial data
    this.device.queue.writeBuffer(
      this.resolutionBuffer,
      0, 
      new Float32Array([canvasWidth, canvasHeight, 0.05, 0])
    );

    const shaderModule = this.device.createShaderModule({
      label: "Brush Shader",
      code: brushShaderSource 
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 12,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' }, // x, y
            { shaderLocation: 1, offset: 8, format: 'float32' }   // pressure
          ]
        }]
      },
      fragment: {
        module: shaderModule,
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

    // Create Bind Group
    this.bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{
        binding: 0,
        resource: { buffer: this.resolutionBuffer }
      }]
    });

    this.initCanvas();
  }

  updateUniforms(w: number, h: number, size: number) {
    this.device.queue.writeBuffer(
      this.resolutionBuffer,
      0,
      new Float32Array([w, h, size, 0])
    );
  }

  private initCanvas() {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.renderTarget.createView(),
        loadOp: 'clear', 
        clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }, 
        storeOp: 'store'
      }]
    });
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  draw(stamps: Float32Array) {
    if (stamps.length === 0) return;

    const canvasTexture = this.context.getCurrentTexture();

    // Resize sync safety
    if (this.renderTarget.width !== canvasTexture.width || 
        this.renderTarget.height !== canvasTexture.height) {
      this.resize(canvasTexture.width, canvasTexture.height, 0.05); 
    }

    const instanceBuffer = this.device.createBuffer({
      size: stamps.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    
    // FIX: Cast stamps to Float32Array to satisfy GPUAllowSharedBufferSource
    this.device.queue.writeBuffer(instanceBuffer, 0, stamps.buffer, stamps.byteOffset, stamps.byteLength);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.renderTarget.createView(),
        loadOp: 'load', 
        storeOp: 'store'
      }]
    });
    
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup); 
    pass.setVertexBuffer(0, instanceBuffer);
    pass.draw(4, stamps.length / 3); 
    pass.end();

    encoder.copyTextureToTexture(
      { texture: this.renderTarget },
      { texture: canvasTexture },
      [canvasTexture.width, canvasTexture.height, 1]
    );

    this.device.queue.submit([encoder.finish()]);
    instanceBuffer.destroy(); 
  }

  resize(newWidth: number, newHeight: number, currentBrushSize: number) {
    const newRenderTarget = this.device.createTexture({
      size: [newWidth, newHeight],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | 
             GPUTextureUsage.COPY_SRC | 
             GPUTextureUsage.COPY_DST | 
             GPUTextureUsage.TEXTURE_BINDING,
    });

    const encoder = this.device.createCommandEncoder();
    const clearPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: newRenderTarget.createView(),
        loadOp: 'clear',
        clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        storeOp: 'store'
      }]
    });
    clearPass.end();

    const copyWidth = Math.min(this.renderTarget.width, newWidth);
    const copyHeight = Math.min(this.renderTarget.height, newHeight);

    encoder.copyTextureToTexture(
      { texture: this.renderTarget },
      { texture: newRenderTarget },
      [copyWidth, copyHeight, 1]
    );

    const canvasTexture = this.context.getCurrentTexture();
    encoder.copyTextureToTexture(
      { texture: newRenderTarget },
      { texture: canvasTexture },
      [Math.min(newWidth, canvasTexture.width), Math.min(newHeight, canvasTexture.height), 1]
    );

    this.device.queue.submit([encoder.finish()]);
    this.renderTarget.destroy();
    this.renderTarget = newRenderTarget;
    this.updateUniforms(newWidth, newHeight, currentBrushSize);
  }

  clear() {
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.renderTarget.createView(),
        loadOp: 'clear',
        clearValue: { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        storeOp: 'store'
      }]
    });
    pass.end();

    const canvasTexture = this.context.getCurrentTexture();
    encoder.copyTextureToTexture(
      { texture: this.renderTarget },
      { texture: canvasTexture },
      [this.renderTarget.width, this.renderTarget.height, 1]
    );

    this.device.queue.submit([encoder.finish()]);
  }

  async saveImage() {
    await downloadTexture(this.device, this.renderTarget, "my-webgpu-art.png");
  }
}