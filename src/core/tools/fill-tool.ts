import type { PaintPipeline }  from '../../renderer/pipeline';
import type { BrushBlendMode } from '../../renderer/brush-descriptor';
import type { Tool }           from '../tool';

// ── Float16 helpers (needed for rgba16float layer textures) ───────────────────

function decodeF16(h: number): number {
    const e = (h >> 10) & 0x1f, m = h & 0x3ff;
    let v: number;
    if (e === 0)       v = (m / 1024) * Math.pow(2, -14);
    else if (e === 31) v = m ? NaN : Infinity;
    else               v = (1 + m / 1024) * Math.pow(2, e - 15);
    return (h >> 15) ? -v : v;
}

function encodeF16(v: number): number {
    v = Math.max(0, Math.min(1, v));
    if (v === 0) return 0;
    if (v >= 1)  return 0x3c00;
    const e = Math.floor(Math.log2(v)), exp = e + 15;
    if (exp <= 0) return Math.round(v / Math.pow(2, -14) * 1024) & 0x3ff;
    return ((exp & 0x1f) << 10) | (Math.round((v / Math.pow(2, e) - 1) * 1024) & 0x3ff);
}

export class FillTool implements Tool {
    public readonly blendMode: BrushBlendMode = 'normal';
    public get isActive(): boolean { return false; }

    // Tolerance: 0–255 per-channel distance, default ~15%
    public tolerance = 30;

    private filling = false;

    onPointerDown(x: number, y: number, _p: number, pipeline: PaintPipeline): void {
        if (this.filling) return;
        this.doFill(x, y, pipeline).catch(err =>
            console.warn('[FillTool] Fill error:', err)
        );
    }

    onPointerMove(_x: number, _y: number, _p: number, _pl: PaintPipeline): void {}

    async onPointerUp(_x: number, _y: number, _p: number, _pl: PaintPipeline): Promise<Float32Array | null> {
        return null;
    }

    renderTick(_pipeline: PaintPipeline): Float32Array { return new Float32Array(); }
    getPrediction(): Float32Array { return new Float32Array(); }
    reset(_pipeline: PaintPipeline): void {}

    // ── Private ───────────────────────────────────────────────────────────────

    private async doFill(nx: number, ny: number, pipeline: PaintPipeline): Promise<void> {
        this.filling = true;
        try {
            const layer = pipeline.layerManager.getActiveLayer();
            if (!layer) return;

            const { device, canvasWidth: w, canvasHeight: h, format } = pipeline;

            // Read active layer pixels via GPU readback
            const pixels = await this.readTexture(device, layer.texture, w, h);
            const isBGRA = format === 'bgra8unorm';

            // Canvas pixel coordinates
            const px = Math.max(0, Math.min(w - 1, Math.floor(nx * w)));
            const py = Math.max(0, Math.min(h - 1, Math.floor(ny * h)));

            // Get fill color from pipeline's brush color state
            const [fr, fg, fb, fa] = pipeline.currentFillColor ?? [0, 0, 0, 255];

            // Flood fill
            const result = scanlineFill(pixels, w, h, px, py, fr, fg, fb, fa, this.tolerance, isBGRA);

            // Write result back to layer texture
            await this.writeTexture(device, layer.texture, result, w, h);

            pipeline.markDirty();
        } finally {
            this.filling = false;
        }
    }

    private async readTexture(
        device: GPUDevice, texture: GPUTexture, w: number, h: number
    ): Promise<Uint8Array> {
        const isF16       = texture.format === 'rgba16float';
        const bytesPerRow = Math.ceil(w * (isF16 ? 8 : 4) / 256) * 256;

        const stagingBuffer = device.createBuffer({
            size:  bytesPerRow * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture, origin: [0, 0, 0] },
            { buffer: stagingBuffer, bytesPerRow },
            [w, h]
        );
        device.queue.submit([encoder.finish()]);

        await stagingBuffer.mapAsync(GPUMapMode.READ);
        const mappedBuf = stagingBuffer.getMappedRange();
        const pixels = new Uint8Array(w * h * 4);

        if (isF16) {
            // Decode float16 RGBA → uint8 BGRA (BGRA matches existing platform convention)
            const view = new DataView(mappedBuf);
            for (let row = 0; row < h; row++) {
                const rowOff = row * bytesPerRow, dstOff = row * w * 4;
                for (let x = 0; x < w; x++) {
                    const src = rowOff + x * 8, dst = dstOff + x * 4;
                    const r = decodeF16(view.getUint16(src + 0, true));
                    const g = decodeF16(view.getUint16(src + 2, true));
                    const b = decodeF16(view.getUint16(src + 4, true));
                    const a = decodeF16(view.getUint16(src + 6, true));
                    pixels[dst + 0] = Math.round(Math.min(1, Math.max(0, b)) * 255);
                    pixels[dst + 1] = Math.round(Math.min(1, Math.max(0, g)) * 255);
                    pixels[dst + 2] = Math.round(Math.min(1, Math.max(0, r)) * 255);
                    pixels[dst + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
                }
            }
        } else {
            const mapped = new Uint8Array(mappedBuf);
            for (let row = 0; row < h; row++) {
                pixels.set(
                    mapped.subarray(row * bytesPerRow, row * bytesPerRow + w * 4),
                    row * w * 4
                );
            }
        }

        stagingBuffer.unmap();
        stagingBuffer.destroy();
        return pixels;
    }

    private async writeTexture(
        device: GPUDevice, texture: GPUTexture, pixels: Uint8Array, w: number, h: number
    ): Promise<void> {
        const isF16 = texture.format === 'rgba16float';

        if (isF16) {
            // Encode uint8 BGRA → float16 RGBA
            const bytesPerRow = Math.ceil(w * 8 / 256) * 256;
            const buf = new ArrayBuffer(bytesPerRow * h);
            const view = new DataView(buf);
            for (let row = 0; row < h; row++) {
                const srcOff = row * w * 4, dstOff = row * bytesPerRow;
                for (let x = 0; x < w; x++) {
                    const src = srcOff + x * 4, dst = dstOff + x * 8;
                    view.setUint16(dst + 0, encodeF16(pixels[src + 2] / 255), true); // R
                    view.setUint16(dst + 2, encodeF16(pixels[src + 1] / 255), true); // G
                    view.setUint16(dst + 4, encodeF16(pixels[src + 0] / 255), true); // B
                    view.setUint16(dst + 6, encodeF16(pixels[src + 3] / 255), true); // A
                }
            }
            device.queue.writeTexture({ texture, origin: [0, 0, 0] }, buf, { bytesPerRow }, [w, h]);
        } else {
            const bytesPerRow = Math.ceil(w * 4 / 256) * 256;
            let data: Uint8Array;
            if (bytesPerRow === w * 4) {
                data = pixels;
            } else {
                data = new Uint8Array(bytesPerRow * h);
                for (let row = 0; row < h; row++) {
                    data.set(
                        pixels.subarray(row * w * 4, row * w * 4 + w * 4),
                        row * bytesPerRow
                    );
                }
            }
            device.queue.writeTexture({ texture, origin: [0, 0, 0] }, data, { bytesPerRow }, [w, h]);
        }

        await device.queue.onSubmittedWorkDone();
    }
}

// ── Scanline flood fill ───────────────────────────────────────────────────────

function colorDist(
    r1: number, g1: number, b1: number, a1: number,
    r2: number, g2: number, b2: number, a2: number
): number {
    return Math.max(Math.abs(r1-r2), Math.abs(g1-g2), Math.abs(b1-b2), Math.abs(a1-a2));
}

function matches(
    pixels: Uint8Array, idx: number,
    sr: number, sg: number, sb: number, sa: number,
    tol: number
): boolean {
    return colorDist(pixels[idx], pixels[idx+1], pixels[idx+2], pixels[idx+3], sr, sg, sb, sa) <= tol;
}

function scanlineFill(
    pixels:  Uint8Array,
    w:       number,
    h:       number,
    sx:      number, sy:    number,
    fr:      number, fg:    number, fb: number, fa: number,
    tol:     number,
    isBGRA:  boolean
): Uint8Array {
    const result = new Uint8Array(pixels);

    // Get seed color (handle BGRA)
    const si = (sy * w + sx) * 4;
    const seedR = isBGRA ? pixels[si+2] : pixels[si];
    const seedG = pixels[si+1];
    const seedB = isBGRA ? pixels[si]   : pixels[si+2];
    const seedA = pixels[si+3];

    // Convert fill color to the texture's byte order
    const wr = isBGRA ? fb : fr;
    const wg = fg;
    const wb = isBGRA ? fr : fb;
    const wa = fa;

    // If seed already matches fill color → nothing to do
    if (colorDist(seedR, seedG, seedB, seedA, fr, fg, fb, fa) <= tol) return result;

    const visited = new Uint8Array(w * h);
    const queue: number[] = [sy * w + sx];

    while (queue.length > 0) {
        const pos = queue.pop()!;
        if (visited[pos]) continue;

        const y  = Math.floor(pos / w);
        const cx = pos % w;

        // Scan left to find span start
        let xl = cx;
        while (xl > 0) {
            const li = (y * w + xl - 1) * 4;
            if (visited[y * w + xl - 1] || !matches(pixels, li, seedR, seedG, seedB, seedA, tol)) break;
            xl--;
        }

        // Scan right, fill, and enqueue above/below
        let spanAbove = false, spanBelow = false;
        let xr = xl;

        while (xr < w) {
            const pi = (y * w + xr) * 4;
            if (visited[y * w + xr] || !matches(pixels, pi, seedR, seedG, seedB, seedA, tol)) break;

            // Fill pixel
            result[pi]   = wr;
            result[pi+1] = wg;
            result[pi+2] = wb;
            result[pi+3] = wa;
            visited[y * w + xr] = 1;

            // Check above
            if (y > 0) {
                const ai  = ((y-1) * w + xr) * 4;
                const can = !visited[(y-1) * w + xr] && matches(pixels, ai, seedR, seedG, seedB, seedA, tol);
                if (can && !spanAbove) { queue.push((y-1) * w + xr); spanAbove = true; }
                else if (!can) spanAbove = false;
            }

            // Check below
            if (y < h - 1) {
                const bi  = ((y+1) * w + xr) * 4;
                const can = !visited[(y+1) * w + xr] && matches(pixels, bi, seedR, seedG, seedB, seedA, tol);
                if (can && !spanBelow) { queue.push((y+1) * w + xr); spanBelow = true; }
                else if (!can) spanBelow = false;
            }

            xr++;
        }
    }

    return result;
}
