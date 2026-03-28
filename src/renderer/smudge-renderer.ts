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
            size:  48, // vec2 res + hardness + charge + pull + dilution + 2 pad + vec4 user_color
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
                module, entryPoint: 'fs_wet_mix',
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

    /**
     * Call once at stroke start — seeds carry from the current layer state.
     * Initialising from the canvas means unvisited carry pixels are neutral
     * (canvas color), so the first stamp produces no outline or inverted-mask
     * artifacts regardless of pull/charge settings.
     */
    public beginStroke(layerTexture: GPUTexture): void {
        const enc = this.device.createCommandEncoder();
        enc.copyTextureToTexture(
            { texture: layerTexture  },
            { texture: this.carryTexture },
            [this.width, this.height]
        );
        this.device.queue.submit([enc.finish()]);
    }

    /** Two-pass GPU wet-brush per batch. Returns the pixel-space dirty rect. */
    public draw(
        stamps:    Float32Array,
        layerTex:  GPUTexture,
        maskTex:   GPUTexture | null,
        pull:      number,
        charge:    number,
        dilution:  number,
        hardness:  number,
        userColor: [number, number, number, number],
    ): DirtyRect | null {
        if (!stamps.length) return null;

        const [r, g, b, a] = userColor;
        this.device.queue.writeBuffer(
            this.uniformBuffer, 0,
            new Float32Array([this.width, this.height, hardness, charge, pull, dilution, 0, 0,
                              r, g, b, a]) // user_color at offset 32 (non-premultiplied sRGB)
        );

        // Upload all stamp data to ring buffer in one shot.
        const dataSize = stamps.byteLength;
        let   ringStart = Math.ceil(this.ringOffset / 4) * 4;
        if (ringStart + dataSize > this.ringSize) ringStart = 0;
        this.device.queue.writeBuffer(this.ringBuffer, ringStart, stamps.buffer, stamps.byteOffset, dataSize);
        this.ringOffset = ringStart + dataSize;

        const maskView  = maskTex ? maskTex.createView() : this.dummyMaskView;
        const layerView = layerTex.createView();

        // Pre-create two views — A=carryTexture, B=scratchTexture — and 4 bind groups.
        // Stamps alternate: even stamps treat A as carry, odd stamps treat B as carry.
        // This avoids N*2 bind group allocations and N queue.submit() calls per stroke.
        const viewA = this.carryTexture.createView();
        const viewB = this.scratchTexture.createView();
        const pickupBG_even  = this._makeBG(viewA, layerView);  // carry=A, read layer
        const depositBG_even = this._makeBG(viewB, maskView);   // scratch=B, read mask
        const pickupBG_odd   = this._makeBG(viewB, layerView);  // carry=B, read layer
        const depositBG_odd  = this._makeBG(viewA, maskView);   // scratch=A, read mask

        // Single command encoder for the entire batch — one queue.submit() for all stamps.
        const enc        = this.device.createCommandEncoder();
        const stampCount = stamps.length / FLOATS_PER_STAMP;

        for (let si = 0; si < stampCount; si++) {
            const byteOffset  = ringStart + si * BYTES_PER_STAMP;
            const isEven      = (si & 1) === 0;
            const singleStamp = stamps.subarray(si * FLOATS_PER_STAMP, (si + 1) * FLOATS_PER_STAMP);
            const bbox        = this.stampPixelBBox(singleStamp);

            // Which GPU texture is currently acting as carry vs scratch for this stamp.
            const carryTex   = isEven ? this.carryTexture   : this.scratchTexture;
            const scratchTex = isEven ? this.scratchTexture : this.carryTexture;
            const scratchView = isEven ? viewB : viewA;

            // Step 1: snapshot carry → scratch (stamp-footprint region only)
            if (bbox) {
                enc.copyTextureToTexture(
                    { texture: carryTex,   origin: [bbox.x, bbox.y, 0] },
                    { texture: scratchTex, origin: [bbox.x, bbox.y, 0] },
                    [bbox.w, bbox.h, 1]
                );
            } else {
                enc.copyTextureToTexture({ texture: carryTex }, { texture: scratchTex }, [this.width, this.height]);
            }

            // Step 2: pickup pass — update carry in scratch
            const pickupPass = enc.beginRenderPass({
                colorAttachments: [{ view: scratchView, loadOp: 'load', storeOp: 'store' }],
            });
            pickupPass.setPipeline(this.pickupPipeline);
            if (bbox) pickupPass.setScissorRect(bbox.x, bbox.y, bbox.w, bbox.h);
            pickupPass.setBindGroup(0, isEven ? pickupBG_even : pickupBG_odd);
            pickupPass.setVertexBuffer(0, this.ringBuffer, byteOffset, BYTES_PER_STAMP);
            pickupPass.draw(4, 1);
            pickupPass.end();

            // Step 3: deposit pass — blend carry onto layer
            const depositPass = enc.beginRenderPass({
                colorAttachments: [{ view: layerView, loadOp: 'load', storeOp: 'store' }],
            });
            depositPass.setPipeline(this.depositPipeline);
            if (bbox) depositPass.setScissorRect(bbox.x, bbox.y, bbox.w, bbox.h);
            depositPass.setBindGroup(0, isEven ? depositBG_even : depositBG_odd);
            depositPass.setVertexBuffer(0, this.ringBuffer, byteOffset, BYTES_PER_STAMP);
            depositPass.draw(4, 1);
            depositPass.end();
        }

        this.device.queue.submit([enc.finish()]);

        // After an odd number of stamps the carry state is in scratchTexture — swap pointers.
        if ((stampCount & 1) === 1) {
            [this.carryTexture, this.scratchTexture] = [this.scratchTexture, this.carryTexture];
        }

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

    private _makeBG(texA: GPUTextureView, texB: GPUTextureView): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: texA                           },
                { binding: 2, resource: texB                           },
                { binding: 3, resource: this.texSampler                },
                { binding: 4, resource: this.maskSampler               },
            ],
        });
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

    /**
     * Per-stamp bounding box in pixel space, expanded to cover both the current
     * stamp footprint and the prev_center (packed in color.xy by unified-brush-tool).
     * Both positions receive the same radius so the carry→scratch copy captures
     * everything the pickup/deposit passes need to read or write.
     */
    private stampPixelBBox(stamp: Float32Array): { x: number; y: number; w: number; h: number } | null {
        const cx    = stamp[0], cy    = stamp[1];   // current center, normalized 0..1
        const size  = stamp[3];
        const prevX = stamp[4], prevY = stamp[5];   // prev_center packed in color.xy
        const tiltX = stamp[8], tiltY = stamp[9];
        const tiltMag = Math.sqrt(tiltX * tiltX + tiltY * tiltY);
        const aspect  = 1 + (tiltMag / 90) * 2;
        const r = size * 0.5 * aspect * 1.1;        // 10 % margin, matches stampsToDirtyRect

        const minX = Math.min(cx - r, prevX - r);
        const maxX = Math.max(cx + r, prevX + r);
        const minY = Math.min(cy - r, prevY - r);
        const maxY = Math.max(cy + r, prevY + r);

        const px = Math.max(0,           Math.floor(minX * this.width));
        const py = Math.max(0,           Math.floor(minY * this.height));
        const pw = Math.min(this.width,  Math.ceil (maxX * this.width))  - px;
        const ph = Math.min(this.height, Math.ceil (maxY * this.height)) - py;
        if (pw <= 0 || ph <= 0) return null;
        return { x: px, y: py, w: pw, h: ph };
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
