import transformPreviewShader from './shaders/transform-preview.wgsl?raw';

export interface TransformState {
    cx:       number;   // normalized 0..1 canvas coords — horizontal center
    cy:       number;   // normalized 0..1 canvas coords — vertical center
    scaleX:   number;   // content width  in normalized canvas units (1.0 = full canvas width)
    scaleY:   number;   // content height in normalized canvas units (1.0 = full canvas height)
    rotation: number;   // degrees, clockwise
}

export class TransformPipeline {
    private pipeline:        GPURenderPipeline;
    private blendPipeline:   GPURenderPipeline;
    private bindGroupLayout: GPUBindGroupLayout;
    private sampler:         GPUSampler;
    private uniformBuffer:   GPUBuffer;
    private bindGroupCache = new WeakMap<GPUTexture, GPUBindGroup>();

    constructor(private device: GPUDevice, format: GPUTextureFormat) {
        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

        // 32 bytes: row0 vec4<f32> + row1 vec4<f32>
        this.uniformBuffer = device.createBuffer({
            size:  32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' } },
            ]
        });

        const module = device.createShaderModule({ code: transformPreviewShader });
        const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

        // No-blend pipeline: clears dst then writes transformed pixels directly.
        this.pipeline = device.createRenderPipeline({
            layout,
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
            primitive: { topology: 'triangle-strip' },
        });

        // Blend pipeline: used when a hole texture provides the background.
        // Loads dst (hole pixels), then alpha-composites transformed pixels on top.
        this.blendPipeline = device.createRenderPipeline({
            layout,
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: {
                module, entryPoint: 'fs_main',
                targets: [{
                    format,
                    blend: {
                        color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
                        alpha: { operation: 'add', srcFactor: 'one',       dstFactor: 'one-minus-src-alpha' },
                    },
                }],
            },
            primitive: { topology: 'triangle-strip' },
        });
    }

    /**
     * Renders srcTexture into dstTexture according to the transform state.
     * If holeTex is provided, it is copied to dstTexture first (as background),
     * and the transformed source is alpha-composited on top.
     */
    public render(
        srcTexture: GPUTexture,
        dstTexture: GPUTexture,
        state:      TransformState,
        canvasAspect = 1,
        holeTex?:   GPUTexture,
    ): void {
        this.writeUniforms(state, canvasAspect);
        const encoder = this.device.createCommandEncoder();

        if (holeTex) {
            // Copy hole background into dst first.
            encoder.copyTextureToTexture(
                { texture: holeTex },
                { texture: dstTexture },
                [dstTexture.width, dstTexture.height],
            );
        }

        const pass = encoder.beginRenderPass({
            colorAttachments: [{
                view:       dstTexture.createView(),
                loadOp:     holeTex ? 'load' : 'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 0 },
                storeOp:    'store',
            }]
        });
        pass.setPipeline(holeTex ? this.blendPipeline : this.pipeline);
        pass.setBindGroup(0, this.getBindGroup(srcTexture));
        pass.draw(4);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    // ── Inverse affine matrix ─────────────────────────────────────────────────
    //
    // All geometry is done in PIXEL space (not raw normalized UV) to avoid
    // distortion on non-square canvases (ar = canvasWidth / canvasHeight).
    //
    // Forward (pixel-correct): local (lx,ly) in normalized canvas units → dest UV
    //   dest_x = cx + lx*cos - ly*sin/ar
    //   dest_y = cy + lx*sin*ar + ly*cos
    //
    // Inverse (dest UV → src UV, what the shader samples):
    //   dx = destUV.x - cx,  dy = destUV.y - cy
    //   lx =  dx*cos + dy*sin/ar
    //   ly = -dx*sin*ar + dy*cos
    //   src.x = lx / scaleX + 0.5
    //   src.y = ly / scaleY + 0.5
    //
    // Written as two affine rows for (destUV.x, destUV.y, 1):
    //   row0 = [cos/scaleX,        sin/(scaleX*ar),   0.5 - cx*cos/scaleX - cy*sin/(scaleX*ar)]
    //   row1 = [-sin*ar/scaleY,    cos/scaleY,         0.5 + cx*sin*ar/scaleY - cy*cos/scaleY ]

    private writeUniforms(s: TransformState, ar: number): void {
        const r    = s.rotation * Math.PI / 180;
        const cosr = Math.cos(r), sinr = Math.sin(r);
        const { cx, cy, scaleX, scaleY } = s;

        const data = new Float32Array(8);
        data[0] =  cosr / scaleX;
        data[1] =  sinr / (scaleX * ar);
        data[2] =  0.5 - cx * cosr / scaleX - cy * sinr / (scaleX * ar);
        data[3] =  0;
        data[4] = -sinr * ar / scaleY;
        data[5] =  cosr / scaleY;
        data[6] =  0.5 + cx * sinr * ar / scaleY - cy * cosr / scaleY;
        data[7] =  0;
        this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
    }

    private getBindGroup(texture: GPUTexture): GPUBindGroup {
        if (!this.bindGroupCache.has(texture)) {
            this.bindGroupCache.set(texture, this.device.createBindGroup({
                layout:  this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: this.sampler },
                    { binding: 1, resource: texture.createView() },
                    { binding: 2, resource: { buffer: this.uniformBuffer } },
                ]
            }));
        }
        return this.bindGroupCache.get(texture)!;
    }
}
