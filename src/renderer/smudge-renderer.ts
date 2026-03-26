import smudgeShaderSource         from './shaders/smudge.wgsl?raw';
import { BYTES_PER_STAMP, FLOATS_PER_STAMP } from './pipeline-cache';
import type { DirtyRect }         from './brush-renderer';

/**
 * Procreate-style GPU smudge renderer.
 *
 * Per stamp batch (drawChunk):
 *   1. copyTextureToTexture(carry → scratch)   — snapshot current carry
 *   2. Pickup render pass (stamp quads → scratch):
 *        new_carry = mix(carry[uv], layer[uv], strength × mask)
 *        Overwrites stamp footprints; loadOp:'load' preserves rest.
 *   3. Deposit render pass (stamp quads → layer):
 *        alpha-blends scratch[uv] onto layer with stamp mask × opacity
 *   4. Swap JS pointers: scratch becomes the authoritative carry for next chunk.
 *
 * The pickup always reads from the LIVE layer (post-previous-deposits), giving
 * Procreate-like chain transport: colors dragged to B can themselves be
 * picked up and dragged to C on back-and-forth strokes.
 */
export class SmudgeRenderer {
    private pickupPipeline:  GPURenderPipeline;
    private depositPipeline: GPURenderPipeline;
    private bindGroupLayout: GPUBindGroupLayout;

    // Ping-pong textures. After each chunk, swap so 'carry' always holds
    // the latest carry state and 'scratch' is free to be overwritten.
    private carryTexture:   GPUTexture;
    private scratchTexture: GPUTexture;

    private ringBuffer:  GPUBuffer;
    private ringSize     = 4 * 1024 * 1024; // 4 MB
    private ringOffset   = 0;

    private uniformBuffer: GPUBuffer; // vec2 res + f32 hardness + f32 strength
    private texSampler:    GPUSampler;
    private maskSampler:   GPUSampler;

    private dummyMaskTex:  GPUTexture;  // 1×1 white — "no selection active"
    private dummyMaskView: GPUTextureView;

    private width:  number;
    private height: number;

    constructor(
        private device: GPUDevice,
        private format: GPUTextureFormat,
        width:  number,
        height: number,
    ) {
        this.width  = width;
        this.height = height;

        this.uniformBuffer = device.createBuffer({
            size:  32, // vec2 resolution + hardness + charge + pull + dilution + 2 pad floats
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        this.ringBuffer = device.createBuffer({
            size:  this.ringSize,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });

        // Filtering sampler for carry + layer (bilinear for smooth color sampling)
        this.texSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
        });
        // Non-filtering sampler for selection mask (crisp edges)
        this.maskSampler = device.createSampler({
            magFilter: 'nearest', minFilter: 'nearest',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
        });

        this.dummyMaskTex = device.createTexture({
            size: [1, 1], format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });
        device.queue.writeTexture(
            { texture: this.dummyMaskTex },
            new Uint8Array([255]),
            { bytesPerRow: 256 }, [1, 1]
        );
        this.dummyMaskView = this.dummyMaskTex.createView();

        this.carryTexture   = this.makeCanvasTex();
        this.scratchTexture = this.makeCanvasTex();

        this.bindGroupLayout = this.makeBindGroupLayout();
        const module         = device.createShaderModule({ code: smudgeShaderSource });
        const layout         = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
        const vb             = this.stampBufferLayout();

        this.pickupPipeline = device.createRenderPipeline({
            layout,
            vertex:    { module, entryPoint: 'vs_main', buffers: [vb] },
            fragment:  {
                module, entryPoint: 'fs_pickup',
                targets: [{ format }], // no blend — overwrite
            },
            primitive: { topology: 'triangle-strip' },
        });

        this.depositPipeline = device.createRenderPipeline({
            layout,
            vertex:   { module, entryPoint: 'vs_main', buffers: [vb] },
            fragment: {
                module, entryPoint: 'fs_deposit',
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                }],
            },
            primitive: { topology: 'triangle-strip' },
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Call once at stroke start — seeds carry from the current layer state. */
    public beginStroke(layerTexture: GPUTexture): void {
        const enc = this.device.createCommandEncoder();
        enc.copyTextureToTexture(
            { texture: layerTexture },
            { texture: this.carryTexture },
            [this.width, this.height]
        );
        this.device.queue.submit([enc.finish()]);
    }

    /** Two-pass GPU smudge per batch. Returns the pixel-space dirty rect. */
    public draw(
        stamps:   Float32Array,
        layerTex: GPUTexture,
        maskTex:  GPUTexture | null,
        pull:     number,
        charge:   number,
        dilution: number,
        hardness: number,
    ): DirtyRect | null {
        if (!stamps.length) return null;

        this.device.queue.writeBuffer(
            this.uniformBuffer, 0,
            new Float32Array([this.width, this.height, hardness, charge, pull, dilution, 0, 0])
        );

        // Process stamps one at a time: each stamp needs its own copy→pickup→deposit
        // cycle so the carry state is correct per-stamp.  Batching multiple stamps
        // in a single pickup pass lets the last stamp to touch an overlapping pixel
        // overwrite earlier stamps' carry results — all stamps in the deposit pass
        // then read the wrong carry, causing over-accumulation and jitter artifacts.
        for (let i = 0; i < stamps.length; i += FLOATS_PER_STAMP)
            this.drawChunk(stamps.slice(i, i + FLOATS_PER_STAMP), layerTex, maskTex);

        return this.stampsToDirtyRect(stamps);
    }

    /** Recreates canvas-sized textures after a canvas resize. */
    public updateResolution(w: number, h: number): void {
        this.width  = w;
        this.height = h;
        this.carryTexture.destroy();
        this.scratchTexture.destroy();
        this.carryTexture   = this.makeCanvasTex();
        this.scratchTexture = this.makeCanvasTex();
    }

    public destroy(): void {
        this.carryTexture.destroy();
        this.scratchTexture.destroy();
        this.ringBuffer.destroy();
        this.uniformBuffer.destroy();
        this.dummyMaskTex.destroy();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private drawChunk(stamps: Float32Array, layerTex: GPUTexture, maskTex: GPUTexture | null): void {
        const dataSize = stamps.byteLength;
        let   start    = Math.ceil(this.ringOffset / 4) * 4;
        if (start + dataSize > this.ringSize) start = 0;

        this.device.queue.writeBuffer(this.ringBuffer, start, stamps.buffer, stamps.byteOffset, dataSize);

        const instanceCount = stamps.length / FLOATS_PER_STAMP;
        const maskView      = maskTex ? maskTex.createView() : this.dummyMaskView;
        const enc           = this.device.createCommandEncoder();

        // ── Step 1: snapshot carry → scratch (full canvas copy) ───────────────
        // Ensures non-stamp-footprint regions of scratch match the current carry.
        // The pickup pass then overwrites only stamp areas, so after the pass
        // scratch = correct new carry state everywhere.
        enc.copyTextureToTexture(
            { texture: this.carryTexture  },
            { texture: this.scratchTexture },
            [this.width, this.height]
        );

        // ── Step 2: pickup pass — blend carry toward live layer ────────────────
        const pickupBG = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer }  },
                { binding: 1, resource: this.carryTexture.createView()  },
                { binding: 2, resource: layerTex.createView()           },
                { binding: 3, resource: this.texSampler                 },
                { binding: 4, resource: this.maskSampler                },
            ],
        });
        const pickupPass = enc.beginRenderPass({
            colorAttachments: [{
                view: this.scratchTexture.createView(), loadOp: 'load', storeOp: 'store',
            }],
        });
        pickupPass.setPipeline(this.pickupPipeline);
        pickupPass.setBindGroup(0, pickupBG);
        pickupPass.setVertexBuffer(0, this.ringBuffer, start, dataSize);
        pickupPass.draw(4, instanceCount);
        pickupPass.end();

        // ── Step 3: deposit pass — paint updated carry onto layer ─────────────
        const depositBG = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer }   },
                { binding: 1, resource: this.scratchTexture.createView() },
                { binding: 2, resource: maskView                         },
                { binding: 3, resource: this.texSampler                  },
                { binding: 4, resource: this.maskSampler                 },
            ],
        });
        const depositPass = enc.beginRenderPass({
            colorAttachments: [{
                view: layerTex.createView(), loadOp: 'load', storeOp: 'store',
            }],
        });
        depositPass.setPipeline(this.depositPipeline);
        depositPass.setBindGroup(0, depositBG);
        depositPass.setVertexBuffer(0, this.ringBuffer, start, dataSize);
        depositPass.draw(4, instanceCount);
        depositPass.end();

        this.device.queue.submit([enc.finish()]);
        this.ringOffset = start + dataSize;

        // ── Step 4: swap — scratch (updated) becomes the new carry ────────────
        [this.carryTexture, this.scratchTexture] = [this.scratchTexture, this.carryTexture];
    }

    private makeCanvasTex(): GPUTexture {
        return this.device.createTexture({
            size:   [this.width, this.height],
            format: this.format,
            usage:
                GPUTextureUsage.TEXTURE_BINDING  |
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.COPY_SRC          |
                GPUTextureUsage.COPY_DST,
        });
    }

    private makeBindGroupLayout(): GPUBindGroupLayout {
        return this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform'        } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering'     } },
                { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } },
            ],
        });
    }

    private stampBufferLayout(): GPUVertexBufferLayout {
        return {
            arrayStride: BYTES_PER_STAMP,
            stepMode:    'instance',
            attributes: [
                { shaderLocation: 0, offset:  0, format: 'float32x2' }, // pos
                { shaderLocation: 1, offset:  8, format: 'float32'   }, // pressure
                { shaderLocation: 2, offset: 12, format: 'float32'   }, // size
                { shaderLocation: 3, offset: 16, format: 'float32x4' }, // color (unused)
                { shaderLocation: 4, offset: 32, format: 'float32x2' }, // tilt
                { shaderLocation: 5, offset: 40, format: 'float32'   }, // opacity
                { shaderLocation: 6, offset: 44, format: 'float32'   }, // angle
            ],
        };
    }

    private stampsToDirtyRect(stamps: Float32Array): DirtyRect | null {
        if (!stamps.length) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < stamps.length; i += FLOATS_PER_STAMP) {
            const x = stamps[i], y = stamps[i+1], size = stamps[i+3];
            const tx = stamps[i+8], ty = stamps[i+9];
            const aspect = 1 + (Math.sqrt(tx*tx + ty*ty) / 90) * 2;
            const r = size * 0.5 * aspect * 1.1;
            if (x-r < minX) minX = x-r; if (y-r < minY) minY = y-r;
            if (x+r > maxX) maxX = x+r; if (y+r > maxY) maxY = y+r;
        }
        const px = Math.max(0,          Math.floor(minX * this.width));
        const py = Math.max(0,          Math.floor(minY * this.height));
        const pw = Math.min(this.width,  Math.ceil(maxX * this.width))  - px;
        const ph = Math.min(this.height, Math.ceil(maxY * this.height)) - py;
        if (pw <= 0 || ph <= 0) return null;
        return { x: px, y: py, width: pw, height: ph };
    }
}
