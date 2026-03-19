import { PipelineCache, BrushBlendMode, BrushPipelineConfig, FLOATS_PER_STAMP, BYTES_PER_STAMP } from './pipeline-cache';

export interface DirtyRect { x: number; y: number; width: number; height: number; }

export class BrushRenderer {
    private pipelineCache: PipelineCache;
    private uniformBuffer: GPUBuffer; // vec2 resolution + f32 hardness + f32 pad

    private currentBlendMode: BrushBlendMode = 'normal';
    private currentHardness:  number         = 0.95;

    // ── Mask state ────────────────────────────────────────────────────────────
    // When no selection is active we bind a 1×1 white texture so the shader
    // always has a valid binding without branching.
    // When a selection is set, we swap to the real R8Unorm mask texture.
    // Bind groups are cached per (blendMode, maskVariant) pair.
    private dummyMaskTexture: GPUTexture;
    private dummyMaskView:    GPUTextureView;
    private maskSampler:      GPUSampler;
    private activeMaskView:   GPUTextureView | null = null;

    // Cache: 'normal|dummy', 'erase|dummy', 'normal|mask', 'erase|mask'
    private bindGroupCache = new Map<string, GPUBindGroup>();

    private ringBuffer:     GPUBuffer;
    private ringBufferSize  = 1024 * 1024 * 4; // 4 MB
    private currentOffset   = 0;

    constructor(
        private device:       GPUDevice,
        format:               GPUTextureFormat,
        private canvasWidth:  number,
        private canvasHeight: number
    ) {
        this.uniformBuffer = device.createBuffer({
            size:  16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.ringBuffer = device.createBuffer({
            size:  this.ringBufferSize, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });

        this.pipelineCache = new PipelineCache(device, format);

        // 1×1 white R8Unorm texture — "no selection active"
        this.dummyMaskTexture = device.createTexture({
            size: [1, 1], format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.dummyMaskTexture },
            new Uint8Array([255]),
            { bytesPerRow: 256 }, // min alignment
            [1, 1]
        );
        this.dummyMaskView = this.dummyMaskTexture.createView();

        // Nearest-neighbour sampler — crisp mask edges, no bleeding
        this.maskSampler = device.createSampler({
            magFilter: 'nearest', minFilter: 'nearest',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });

        this.writeUniformBuffer();
        this.buildAllBindGroups();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public setConfig(config: BrushPipelineConfig): void {
        if (config.hardness !== undefined && config.hardness !== this.currentHardness) {
            this.currentHardness = config.hardness;
            this.writeUniformBuffer();
        }
        this.currentBlendMode = config.blendMode;
    }

    /**
     * Sets the active selection mask texture.
     * Pass null to deactivate the mask (draws everywhere).
     * Rebuilds the mask-variant bind groups with the new texture view.
     */
    public setMaskTexture(texture: GPUTexture | null): void {
        this.activeMaskView = texture ? texture.createView() : null;
        this.buildAllBindGroups(); // rebuild 'mask' variant with new view
    }

    public draw(stamps: Float32Array, targetTexture: GPUTexture): DirtyRect | null {
        if (stamps.length === 0) return null;

        const maxPerChunk    = Math.floor(this.ringBufferSize / BYTES_PER_STAMP);
        const floatsPerChunk = maxPerChunk * FLOATS_PER_STAMP;

        for (let i = 0; i < stamps.length; i += floatsPerChunk) {
            this.drawChunk(stamps.slice(i, i + floatsPerChunk), targetTexture.createView());
        }

        return this.stampsToDirtyRect(stamps);
    }

    public updateResolution(w: number, h: number): void {
        this.canvasWidth  = w;
        this.canvasHeight = h;
        this.writeUniformBuffer();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private writeUniformBuffer(): void {
        this.device.queue.writeBuffer(
            this.uniformBuffer, 0,
            new Float32Array([this.canvasWidth, this.canvasHeight, this.currentHardness, 0])
        );
    }

    private buildAllBindGroups(): void {
        this.bindGroupCache.clear();
        const modes: BrushBlendMode[] = ['normal', 'erase'];
        for (const mode of modes) {
            this.bindGroupCache.set(`${mode}|dummy`, this.buildBindGroup(mode, this.dummyMaskView));
            if (this.activeMaskView) {
                this.bindGroupCache.set(`${mode}|mask`, this.buildBindGroup(mode, this.activeMaskView));
            }
        }
    }

    private buildBindGroup(blendMode: BrushBlendMode, maskView: GPUTextureView): GPUBindGroup {
        return this.device.createBindGroup({
            layout: this.pipelineCache.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: maskView                      },
                { binding: 2, resource: this.maskSampler              }
            ]
        });
    }

    private getBindGroup(): GPUBindGroup {
        const maskKey = this.activeMaskView ? 'mask' : 'dummy';
        const key     = `${this.currentBlendMode}|${maskKey}`;
        return this.bindGroupCache.get(key)
            ?? this.bindGroupCache.get(`${this.currentBlendMode}|dummy`)!;
    }

    private stampsToDirtyRect(stamps: Float32Array): DirtyRect | null {
        if (stamps.length === 0) return null;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let i = 0; i < stamps.length; i += FLOATS_PER_STAMP) {
            const x       = stamps[i], y = stamps[i+1];
            const size    = stamps[i+3];
            const tiltX   = stamps[i+8], tiltY = stamps[i+9];
            const tiltMag = Math.sqrt(tiltX*tiltX + tiltY*tiltY);
            const aspect  = 1 + (tiltMag / 90) * 2;
            const r       = size * 0.5 * aspect * 1.1; // 10% margin

            if (x-r < minX) minX = x-r; if (y-r < minY) minY = y-r;
            if (x+r > maxX) maxX = x+r; if (y+r > maxY) maxY = y+r;
        }

        const px = Math.max(0,                 Math.floor(minX * this.canvasWidth));
        const py = Math.max(0,                 Math.floor(minY * this.canvasHeight));
        const pw = Math.min(this.canvasWidth,  Math.ceil (maxX * this.canvasWidth))  - px;
        const ph = Math.min(this.canvasHeight, Math.ceil (maxY * this.canvasHeight)) - py;
        if (pw <= 0 || ph <= 0) return null;
        return { x: px, y: py, width: pw, height: ph };
    }

    private drawChunk(stamps: Float32Array, targetView: GPUTextureView): void {
        const dataSize = stamps.byteLength;
        let   start    = Math.ceil(this.currentOffset / 4) * 4;
        if (start + dataSize > this.ringBufferSize) start = 0;

        this.device.queue.writeBuffer(
            this.ringBuffer, start, stamps.buffer, stamps.byteOffset, dataSize
        );

        const pipeline  = this.pipelineCache.getOrCreate(this.currentBlendMode);
        const bindGroup = this.getBindGroup();

        const encoder = this.device.createCommandEncoder();
        const pass    = encoder.beginRenderPass({
            colorAttachments: [{ view: targetView, loadOp: 'load', storeOp: 'store' }]
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, this.ringBuffer, start, dataSize);
        pass.draw(4, stamps.length / FLOATS_PER_STAMP);
        pass.end();

        this.device.queue.submit([encoder.finish()]);
        this.currentOffset = start + dataSize;
    }
}
