import { PipelineCache, BrushBlendMode, BrushPipelineConfig, FLOATS_PER_STAMP, BYTES_PER_STAMP } from './pipeline-cache';

export interface DirtyRect { x: number; y: number; width: number; height: number; }

// Uniform buffer layout — 64 bytes (matches brush.wgsl Uniforms struct)
// [0]  resolution.x  f32
// [1]  resolution.y  f32
// [2]  hardness      f32
// [3]  grainDepth    f32
// [4]  grainScale    f32
// [5]  grainRotation f32 (radians)
// [6]  grainContrast f32
// [7]  grainBrightness f32
// [8]  grainBlendMode u32  (as float bits — written via u32 view)
// [9]  grainStatic    u32
// [10] useTipTex      u32
// [11] usePickup      u32
// [12] pickupWetness  f32
// [13] _pad0          f32
// [14] _pad1          f32
// [15] _pad2          f32
const UNIFORM_FLOATS = 16;

export class BrushRenderer {
    private pipelineCache: PipelineCache;
    private uniformBuffer: GPUBuffer;

    private currentBlendMode:   BrushBlendMode = 'normal';
    private currentHardness:    number         = 0.95;
    private currentGrainDepth:  number         = 0;
    private currentGrainScale:  number         = 1.0;
    private currentGrainRot:    number         = 0;
    private currentGrainContrast: number       = 1.0;
    private currentGrainBright: number         = 0;
    private currentGrainBlend:  number         = 0;  // 0=multiply
    private currentGrainStatic: boolean        = true;

    // ── Mask state ────────────────────────────────────────────────────────────
    private dummyMaskTexture: GPUTexture;
    private dummyMaskView:    GPUTextureView;
    private maskSampler:      GPUSampler;
    private activeMaskView:   GPUTextureView | null = null;

    // ── Grain state ───────────────────────────────────────────────────────────
    private dummyGrainTexture:      GPUTexture;
    private dummyGrainView:         GPUTextureView;
    private grainSampler:           GPUSampler;
    private activeGrainView:        GPUTextureView | null = null;
    private proceduralGrainTexture: GPUTexture | null = null;
    private grainLibrary:           GPUTexture[]          = [];

    // ── Tip state ─────────────────────────────────────────────────────────────
    private dummyTipTexture:  GPUTexture;
    private dummyTipView:     GPUTextureView;
    private tipSampler:       GPUSampler;
    private activeTipView:    GPUTextureView | null = null;
    private currentUseTipTex: boolean = false;

    // ── Pickup (wet mixing) state ─────────────────────────────────────────────
    private dummyPickupTexture:  GPUTexture;
    private dummyPickupView:     GPUTextureView;
    private pickupSampler:       GPUSampler;
    private activePickupView:    GPUTextureView | null = null;
    private currentUsePickup:    boolean = false;
    private currentPickupWetness: number = 0;

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
            size:  UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
        this.ringBuffer = device.createBuffer({
            size:  this.ringBufferSize, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });

        this.pipelineCache = new PipelineCache(device, format);

        // 1×1 white R8Unorm — "no selection active"
        this.dummyMaskTexture = device.createTexture({
            size: [1, 1], format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.dummyMaskTexture },
            new Uint8Array([255]),
            { bytesPerRow: 256 },
            [1, 1]
        );
        this.dummyMaskView = this.dummyMaskTexture.createView();

        this.maskSampler = device.createSampler({
            magFilter: 'nearest', minFilter: 'nearest',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });

        // 1×1 white rgba8unorm — "no grain active" fallback
        this.dummyGrainTexture = device.createTexture({
            size: [1, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.dummyGrainTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 256 },
            [1, 1]
        );
        this.dummyGrainView = this.dummyGrainTexture.createView();

        // Linear + repeat sampler for grain texture tiling
        this.grainSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear',
            addressModeU: 'repeat', addressModeV: 'repeat'
        });

        // 1×1 white rgba8unorm — "no tip texture" fallback
        this.dummyTipTexture = device.createTexture({
            size: [1, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.dummyTipTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 256 },
            [1, 1]
        );
        this.dummyTipView = this.dummyTipTexture.createView();

        // Linear + clamp sampler for tip texture
        this.tipSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });

        // 1×1 transparent rgba8unorm — "no pickup" fallback
        this.dummyPickupTexture = device.createTexture({
            size: [1, 1], format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.dummyPickupTexture },
            new Uint8Array([0, 0, 0, 0]),
            { bytesPerRow: 256 },
            [1, 1]
        );
        this.dummyPickupView = this.dummyPickupTexture.createView();

        // Linear + clamp sampler for pickup texture
        this.pickupSampler = device.createSampler({
            magFilter: 'linear', minFilter: 'linear',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });

        this.writeUniformBuffer();
        this.initProceduralGrain();
        this.buildAllBindGroups();
    }

    /** Generates a 256×256 white-noise grain texture as the default grain pattern,
     *  and populates the 8-texture grain library. */
    private initProceduralGrain(): void {
        const size = 256;

        // ── Helper: upload pixel data to a new GPU texture ────────────────────
        const makeGrainTex = (pixels: Uint8Array): GPUTexture => {
            const tex = this.device.createTexture({
                size: [size, size], format: 'rgba8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.device.queue.writeTexture(
                { texture: tex },
                pixels, { bytesPerRow: size * 4 }, [size, size]
            );
            return tex;
        };

        // ── Index 0: Soft noise (white noise) ────────────────────────────────
        const noise0 = new Uint8Array(size * size * 4);
        for (let i = 0; i < noise0.length; i += 4) {
            const v = Math.floor(Math.random() * 256);
            noise0[i] = v; noise0[i+1] = v; noise0[i+2] = v; noise0[i+3] = 255;
        }
        this.proceduralGrainTexture = makeGrainTex(noise0);
        this.activeGrainView        = this.proceduralGrainTexture.createView();

        // ── Index 1: Canvas paper (layered sin/cos large-scale) ───────────────
        const paper1 = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const nx = x / size, ny = y / size;
                const v = (
                    Math.sin(nx * 12.3 + ny * 7.8) * 0.25 +
                    Math.cos(nx * 5.1 - ny * 11.2) * 0.25 +
                    Math.sin(nx * 23.7 + ny * 3.1) * 0.15 +
                    Math.random() * 0.35 + 0.45
                );
                const c = Math.max(0, Math.min(255, Math.round(v * 255)));
                const i = (y * size + x) * 4;
                paper1[i] = c; paper1[i+1] = c; paper1[i+2] = c; paper1[i+3] = 255;
            }
        }

        // ── Index 2: Rough paper (high-contrast irregular) ───────────────────
        const paper2 = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const nx = x / size, ny = y / size;
                let v = (
                    Math.sin(nx * 8 + ny * 6) * 0.3 +
                    Math.cos(nx * 15 - ny * 4) * 0.2 +
                    Math.random() * 0.5 + 0.2
                );
                // High contrast: push toward 0 or 1
                v = v > 0.5 ? 0.6 + (v - 0.5) * 0.8 : 0.4 - (0.5 - v) * 0.8;
                const c = Math.max(0, Math.min(255, Math.round(v * 255)));
                const i = (y * size + x) * 4;
                paper2[i] = c; paper2[i+1] = c; paper2[i+2] = c; paper2[i+3] = 255;
            }
        }

        // ── Index 3: Crosshatch (diagonal lines + noise) ─────────────────────
        const cross3 = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const d1 = (x + y) % 12;
                const d2 = (x - y + size) % 12;
                const line = (d1 < 2 || d2 < 2) ? 0.3 : 1.0;
                const v    = line * (0.85 + Math.random() * 0.15);
                const c    = Math.max(0, Math.min(255, Math.round(v * 255)));
                const i    = (y * size + x) * 4;
                cross3[i] = c; cross3[i+1] = c; cross3[i+2] = c; cross3[i+3] = 255;
            }
        }

        // ── Index 4: Stipple (random dots on white) ───────────────────────────
        const stipple4 = new Uint8Array(size * size * 4).fill(255);
        const numDots  = 2400;
        for (let d = 0; d < numDots; d++) {
            const px = Math.floor(Math.random() * size);
            const py = Math.floor(Math.random() * size);
            const r  = 1 + Math.floor(Math.random() * 2);
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (dx*dx + dy*dy > r*r) continue;
                    const nx = (px + dx + size) % size, ny = (py + dy + size) % size;
                    const i = (ny * size + nx) * 4;
                    const c = Math.floor(Math.random() * 60);
                    stipple4[i] = c; stipple4[i+1] = c; stipple4[i+2] = c;
                }
            }
        }

        // ── Index 5: Watercolor (soft irregular blobs) ───────────────────────
        const water5 = new Uint8Array(size * size * 4).fill(200);
        for (let b = 0; b < 60; b++) {
            const cx = Math.random() * size, cy = Math.random() * size;
            const br  = 10 + Math.random() * 30;
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    const dx = x - cx, dy = y - cy;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist < br) {
                        const t   = 1 - dist / br;
                        const idx = (y * size + x) * 4;
                        const cur = water5[idx] / 255;
                        const nv  = cur - t * 0.15;
                        const c   = Math.max(0, Math.min(255, Math.round(nv * 255)));
                        water5[idx] = c; water5[idx+1] = c; water5[idx+2] = c;
                    }
                }
            }
        }
        for (let i = 3; i < water5.length; i += 4) water5[i] = 255;

        // ── Index 6: Charcoal (directional strokes) ───────────────────────────
        const char6 = new Uint8Array(size * size * 4).fill(220);
        for (let s = 0; s < 200; s++) {
            const sx = Math.random() * size, sy = Math.random() * size;
            const len = 20 + Math.random() * 40, thickness = 1 + Math.random() * 2;
            const ang = -0.3 + Math.random() * 0.6; // mostly horizontal with slight tilt
            for (let t = 0; t < len; t++) {
                const px = Math.round(sx + t * Math.cos(ang));
                const py = Math.round(sy + t * Math.sin(ang));
                for (let dy = -thickness; dy <= thickness; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const nx = (px + dx + size) % size, ny = (py + dy + size) % size;
                        const i = (ny * size + nx) * 4;
                        const v = char6[i] - 20 - Math.floor(Math.random() * 30);
                        char6[i] = Math.max(0, v); char6[i+1] = Math.max(0, v); char6[i+2] = Math.max(0, v);
                    }
                }
            }
        }
        for (let i = 3; i < char6.length; i += 4) char6[i] = 255;

        // ── Index 7: Linen (woven grid pattern) ──────────────────────────────
        const linen7 = new Uint8Array(size * size * 4);
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const hLine = y % 8 < 2;
                const vLine = x % 8 < 2;
                let v: number;
                if (hLine && vLine) v = 0.5;
                else if (hLine) v = 0.75 + Math.random() * 0.1;
                else if (vLine) v = 0.65 + Math.random() * 0.1;
                else v = 0.9 + Math.random() * 0.1;
                const c = Math.max(0, Math.min(255, Math.round(v * 255)));
                const i = (y * size + x) * 4;
                linen7[i] = c; linen7[i+1] = c; linen7[i+2] = c; linen7[i+3] = 255;
            }
        }

        // ── Build library ────────────────────────────────────────────────────
        this.grainLibrary = [
            makeGrainTex(noise0),   // 0 soft noise
            makeGrainTex(paper1),   // 1 canvas paper
            makeGrainTex(paper2),   // 2 rough paper
            makeGrainTex(cross3),   // 3 crosshatch
            makeGrainTex(stipple4), // 4 stipple
            makeGrainTex(water5),   // 5 watercolor
            makeGrainTex(char6),    // 6 charcoal
            makeGrainTex(linen7),   // 7 linen
        ];
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public setConfig(config: BrushPipelineConfig): void {
        let dirty = false;

        if (config.hardness !== undefined && config.hardness !== this.currentHardness) {
            this.currentHardness = config.hardness;
            dirty = true;
        }
        if (config.grainDepth !== undefined && config.grainDepth !== this.currentGrainDepth) {
            this.currentGrainDepth = config.grainDepth;
            dirty = true;
        }
        if (config.grainScale !== undefined && config.grainScale !== this.currentGrainScale) {
            this.currentGrainScale = config.grainScale;
            dirty = true;
        }
        if (config.grainRotation !== undefined && config.grainRotation !== this.currentGrainRot) {
            this.currentGrainRot = config.grainRotation;
            dirty = true;
        }
        if (config.grainContrast !== undefined && config.grainContrast !== this.currentGrainContrast) {
            this.currentGrainContrast = config.grainContrast;
            dirty = true;
        }
        if (config.grainBrightness !== undefined && config.grainBrightness !== this.currentGrainBright) {
            this.currentGrainBright = config.grainBrightness;
            dirty = true;
        }
        if (config.grainBlendMode !== undefined && config.grainBlendMode !== this.currentGrainBlend) {
            this.currentGrainBlend = config.grainBlendMode;
            dirty = true;
        }
        if (config.grainStatic !== undefined && config.grainStatic !== this.currentGrainStatic) {
            this.currentGrainStatic = config.grainStatic;
            dirty = true;
        }
        if (dirty) this.writeUniformBuffer();

        this.currentBlendMode = config.blendMode;
    }

    /**
     * Sets the active selection mask texture.
     * Pass null to deactivate (draws everywhere).
     */
    public setMaskTexture(texture: GPUTexture | null): void {
        this.activeMaskView = texture ? texture.createView() : null;
        this.buildAllBindGroups();
    }

    /**
     * Sets the active grain texture.
     * Pass null to use the dummy (no grain visible when grainDepth=0).
     */
    public setGrainTexture(texture: GPUTexture | null): void {
        this.activeGrainView = texture ? texture.createView() : null;
        this.buildAllBindGroups();
    }

    /**
     * Sets the active grain texture from the built-in library by index (0..7).
     * Index -1 resets to the default procedural noise.
     */
    public setGrainIndex(index: number): void {
        if (index < 0 || index >= this.grainLibrary.length) {
            // Reset to default procedural noise
            this.activeGrainView = this.proceduralGrainTexture?.createView() ?? null;
        } else {
            this.activeGrainView = this.grainLibrary[index].createView();
        }
        this.buildAllBindGroups();
    }

    /** Returns the grain library textures (read-only) for UI thumbnail generation. */
    public getGrainLibrary(): GPUTexture[] {
        return this.grainLibrary;
    }

    /**
     * Sets the active tip texture.
     * Pass null to use procedural soft/hard circle.
     */
    public setTipTexture(texture: GPUTexture | null): void {
        this.activeTipView   = texture ? texture.createView() : null;
        this.currentUseTipTex = texture !== null;
        this.writeUniformBuffer();
        this.buildAllBindGroups();
    }

    /**
     * Sets the canvas color pickup texture for wet mixing.
     * Pass null to disable wet color pickup.
     * @param texture  Snapshot of the canvas layer at stroke start
     * @param wetness  0..1 wet mixing strength
     */
    public setPickupTexture(texture: GPUTexture | null, wetness = 0): void {
        this.activePickupView     = texture ? texture.createView() : null;
        this.currentUsePickup     = texture !== null && wetness > 0;
        this.currentPickupWetness = wetness;
        this.writeUniformBuffer();
        this.buildAllBindGroups();
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
        const buf = new ArrayBuffer(UNIFORM_FLOATS * 4);
        const f   = new Float32Array(buf);
        const u   = new Uint32Array(buf);

        f[0]  = this.canvasWidth;
        f[1]  = this.canvasHeight;
        f[2]  = this.currentHardness;
        f[3]  = this.currentGrainDepth;
        f[4]  = this.currentGrainScale;
        f[5]  = this.currentGrainRot;
        f[6]  = this.currentGrainContrast;
        f[7]  = this.currentGrainBright;
        u[8]  = this.currentGrainBlend;
        u[9]  = this.currentGrainStatic ? 1 : 0;
        u[10] = this.currentUseTipTex ? 1 : 0;
        u[11] = this.currentUsePickup ? 1 : 0;
        f[12] = this.currentPickupWetness;
        f[13] = 0;
        f[14] = 0;
        f[15] = 0;

        this.device.queue.writeBuffer(this.uniformBuffer, 0, buf);
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

    private buildBindGroup(_blendMode: BrushBlendMode, maskView: GPUTextureView): GPUBindGroup {
        const grainView   = this.activeGrainView   ?? this.dummyGrainView;
        const pickupView  = this.activePickupView  ?? this.dummyPickupView;
        return this.device.createBindGroup({
            layout: this.pipelineCache.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: maskView                       },
                { binding: 2, resource: this.maskSampler               },
                { binding: 3, resource: grainView                      },
                { binding: 4, resource: this.grainSampler              },
                { binding: 5, resource: (this.activeTipView ?? this.dummyTipView) },
                { binding: 6, resource: this.tipSampler                },
                { binding: 7, resource: pickupView                     },
                { binding: 8, resource: this.pickupSampler             }
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
