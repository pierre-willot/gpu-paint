import selectionShaderSource from './shaders/selection.wgsl?raw';

// ── SelectionMode ─────────────────────────────────────────────────────────────
// Exported as a const object (not a type-only alias) so Vite's ESM bundler can
// re-export it from pipeline.ts without hitting "does not provide an export"
// errors. Consumers can use the string literals directly or reference the object.

export const SelectionMode = {
    replace:   'replace',
    add:       'add',
    subtract:  'subtract',
    intersect: 'intersect',
} as const;

export type SelectionMode = typeof SelectionMode[keyof typeof SelectionMode];

// ── SelectionManager ──────────────────────────────────────────────────────────
// Owns the selection state for the entire canvas.
//
// Architecture:
//   • CPU mask  : Uint8Array(width × height), one byte per pixel
//                 0 = unselected, 255 = fully selected
//   • GPU mask  : R8Unorm GPUTexture, kept in sync after every CPU operation
//   • Ants pass : animated marching-ants border rendered after compositing
//
// Selection state is EPHEMERAL — not saved to .gpaint, not undoable in Tier A.

export class SelectionManager {
    private maskTexture:    GPUTexture | null = null;
    private _hasMask        = false;

    private maskData:       Uint8Array;
    private maskWidth:      number;
    private maskHeight:     number;

    private antsPipeline:   GPURenderPipeline | null = null;
    private antsBindGroup:  GPUBindGroup | null      = null;
    private antsUniformBuf: GPUBuffer   | null       = null;
    private antsSampler:    GPUSampler  | null       = null;
    private sessionStart    = performance.now();

    constructor(
        private device: GPUDevice,
        private format: GPUTextureFormat,
        width:  number,
        height: number
    ) {
        this.maskWidth  = width;
        this.maskHeight = height;
        this.maskData   = new Uint8Array(width * height);
        this.createMaskTexture();
        this.initAntsPipeline();
    }

    // ── Public — state ────────────────────────────────────────────────────────

    public get hasMask():    boolean           { return this._hasMask;    }
    public getMaskTexture(): GPUTexture | null  { return this.maskTexture; }
    public getMaskData():    Uint8Array         { return this.maskData;    }

    public selectAll(): void {
        this.maskData.fill(255);
        this._hasMask = true;
        this.uploadToGPU();
    }

    public deselect(): void {
        this.maskData.fill(0);
        this._hasMask = false;
        this.uploadToGPU();
    }

    public invertSelection(): void {
        if (!this._hasMask) { this.selectAll(); return; }
        for (let i = 0; i < this.maskData.length; i++) {
            this.maskData[i] = 255 - this.maskData[i];
        }
        this._hasMask = this.maskData.some(v => v > 0);
        this.uploadToGPU();
    }

    public setRect(
        x: number, y: number, w: number, h: number,
        mode: SelectionMode = 'replace'
    ): void {
        // x,y,w,h are normalized 0..1 — convert to pixel space
        const px = Math.round(x * this.maskWidth);
        const py = Math.round(y * this.maskHeight);
        const pw = Math.round(w * this.maskWidth);
        const ph = Math.round(h * this.maskHeight);
        this.combine(this.rasterizeRect(px, py, pw, ph), mode);
        this._hasMask = this.maskData.some(v => v > 0);
        this.uploadToGPU();
    }

    public setLasso(points: number[], mode: SelectionMode = 'replace'): void {
        if (points.length < 6) return;
        // points are normalized 0..1 pairs — scale to pixel space
        const px: number[] = [];
        for (let i = 0; i < points.length; i += 2) {
            px.push(points[i] * this.maskWidth, points[i + 1] * this.maskHeight);
        }
        this.combine(this.rasterizePolygon(px), mode);
        this._hasMask = this.maskData.some(v => v > 0);
        this.uploadToGPU();
    }

    public getMaskSnapshot(): { data: Uint8Array; hasMask: boolean } {
        return { data: this.maskData.slice(), hasMask: this._hasMask };
    }

    public restoreFromSnapshot(snapshot: { data: Uint8Array; hasMask: boolean }): void {
        if (snapshot.data.length !== this.maskData.length) return;
        this.maskData.set(snapshot.data);
        this._hasMask = snapshot.hasMask;
        this.uploadToGPU();
    }

    // ── Public — marching ants ────────────────────────────────────────────────

    public renderOverlay(targetView: GPUTextureView, _nowMs?: number): void {
        if (!this._hasMask) return;
        if (!this.antsPipeline || !this.antsBindGroup || !this.antsUniformBuf) return;

        const timeSec = (performance.now() - this.sessionStart) / 1000;
        this.device.queue.writeBuffer(
            this.antsUniformBuf, 0,
            new Float32Array([this.maskWidth, this.maskHeight, timeSec, 0])
        );

        const encoder = this.device.createCommandEncoder();
        const pass    = encoder.beginRenderPass({
            colorAttachments: [{ view: targetView, loadOp: 'load', storeOp: 'store' }]
        });
        pass.setPipeline(this.antsPipeline);
        pass.setBindGroup(0, this.antsBindGroup);
        pass.draw(3); // full-screen triangle — no vertex buffer
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    // ── Public — resize ───────────────────────────────────────────────────────

    public resize(width: number, height: number): void {
        this.maskWidth  = width;
        this.maskHeight = height;
        this.maskData   = new Uint8Array(width * height);
        this._hasMask   = false;
        this.maskTexture?.destroy();
        this.createMaskTexture();
        this.rebuildAntsBindGroup();
    }

    // ── Private — GPU texture ─────────────────────────────────────────────────

    private createMaskTexture(): void {
        this.maskTexture = this.device.createTexture({
            size:   [this.maskWidth, this.maskHeight],
            format: 'r8unorm',
            usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        this.uploadToGPU();
    }

    private uploadToGPU(): void {
        if (!this.maskTexture) return;
        const w           = this.maskWidth;
        const h           = this.maskHeight;
        const bytesPerRow = Math.ceil(w / 256) * 256;

        let data: Uint8Array;
        if (bytesPerRow === w) {
            data = this.maskData;
        } else {
            data = new Uint8Array(bytesPerRow * h);
            for (let row = 0; row < h; row++) {
                data.set(this.maskData.subarray(row * w, row * w + w), row * bytesPerRow);
            }
        }
        this.device.queue.writeTexture({ texture: this.maskTexture }, data, { bytesPerRow }, [w, h]);
    }

    // ── Private — CPU rasterization ───────────────────────────────────────────

    private rasterizeRect(rx: number, ry: number, rw: number, rh: number): Uint8Array {
        const region = new Uint8Array(this.maskWidth * this.maskHeight);
        const x0 = Math.max(0, rx),             x1 = Math.min(this.maskWidth,  rx + rw);
        const y0 = Math.max(0, ry),             y1 = Math.min(this.maskHeight, ry + rh);
        for (let y = y0; y < y1; y++) {
            region.fill(255, y * this.maskWidth + x0, y * this.maskWidth + x1);
        }
        return region;
    }

    private rasterizePolygon(points: number[]): Uint8Array {
        const w = this.maskWidth, h = this.maskHeight;

        let canvas: OffscreenCanvas | HTMLCanvasElement;
        let ctx:    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

        if (typeof OffscreenCanvas !== 'undefined') {
            canvas = new OffscreenCanvas(w, h);
            ctx    = (canvas as OffscreenCanvas).getContext('2d') as OffscreenCanvasRenderingContext2D;
        } else {
            canvas = document.createElement('canvas');
            (canvas as HTMLCanvasElement).width  = w;
            (canvas as HTMLCanvasElement).height = h;
            ctx = (canvas as HTMLCanvasElement).getContext('2d')!;
        }

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) ctx.lineTo(points[i], points[i + 1]);
        ctx.closePath();
        ctx.fill('evenodd');

        const imageData = ctx.getImageData(0, 0, w, h);
        const region    = new Uint8Array(w * h);
        for (let i = 0; i < region.length; i++) region[i] = imageData.data[i * 4];
        return region;
    }

    // ── Private — combine ─────────────────────────────────────────────────────

    private combine(region: Uint8Array, mode: SelectionMode): void {
        const len = this.maskData.length;
        switch (mode) {
            case 'replace':
                this.maskData.set(region); break;
            case 'add':
                for (let i = 0; i < len; i++) this.maskData[i] = Math.min(255, this.maskData[i] + region[i]); break;
            case 'subtract':
                for (let i = 0; i < len; i++) this.maskData[i] = Math.max(0, this.maskData[i] - region[i]); break;
            case 'intersect':
                for (let i = 0; i < len; i++) this.maskData[i] = Math.min(this.maskData[i], region[i]); break;
        }
    }

    // ── Private — marching ants pipeline ──────────────────────────────────────

    private initAntsPipeline(): void {
        const module = this.device.createShaderModule({ code: selectionShaderSource });

        const bgl = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer:  { type: 'uniform' }   },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT,                          texture: { sampleType: 'float', viewDimension: '2d' } },
                { binding: 2, visibility: GPUShaderStage.FRAGMENT,                          sampler: { type: 'non-filtering' } }
            ]
        });

        this.antsPipeline = this.device.createRenderPipeline({
            layout:   this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: {
                module, entryPoint: 'fs_main',
                targets: [{
                    format: this.format,
                    blend:  {
                        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }]
            },
            primitive: { topology: 'triangle-list' }
        });

        this.antsUniformBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.antsSampler    = this.device.createSampler({
            magFilter: 'nearest', minFilter: 'nearest',
            addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge'
        });

        this.rebuildAntsBindGroup();
    }

    private rebuildAntsBindGroup(): void {
        if (!this.antsPipeline || !this.maskTexture || !this.antsUniformBuf || !this.antsSampler) return;
        this.antsBindGroup = this.device.createBindGroup({
            layout: this.antsPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.antsUniformBuf } },
                { binding: 1, resource: this.maskTexture.createView()   },
                { binding: 2, resource: this.antsSampler                }
            ]
        });
    }
}
