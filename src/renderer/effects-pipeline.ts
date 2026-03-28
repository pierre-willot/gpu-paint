// src/renderer/effects-pipeline.ts
// GPU effects with D3 live-preview support (snapshot / restore).
//
// Blur and Hue/Sat both run on the CPU — GPU readback → process → writeTexture.
// This avoids storage-texture format compatibility issues (bgra8unorm on Windows
// does not support STORAGE_BINDING without optional features) and the need to
// ship a compute shader. Performance is adequate for ≤4k canvases.
//
// Snapshots are always stored as Uint8Array with 4 bytes/pixel (BGRA uint8),
// regardless of the GPU texture format. For rgba16float textures the conversion
// is handled transparently in snapshotTexture / restoreTexture so that history,
// undo/redo, effects, and CheckpointManager all remain format-agnostic.

// ── Float16 helpers ───────────────────────────────────────────────────────────

/** Decode a single IEEE 754 half-float (u16) to a JS number. */
function decodeFloat16(h: number): number {
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    let val: number;
    if (e === 0)       val = (m / 1024) * Math.pow(2, -14);
    else if (e === 31) val = m ? NaN : Infinity;
    else               val = (1 + m / 1024) * Math.pow(2, e - 15);
    return (h >> 15) ? -val : val;
}

/** Encode a JS number (clamped 0..1) to an IEEE 754 half-float u16. */
function encodeFloat16(v: number): number {
    v = Math.max(0, Math.min(1, v));
    if (v === 0) return 0;
    if (v >= 1)  return 0x3c00;                           // 1.0 exactly
    const e = Math.floor(Math.log2(v));
    const exp = e + 15;
    if (exp <= 0) {                                        // subnormal
        return Math.round(v / Math.pow(2, -14) * 1024) & 0x3ff;
    }
    const m = Math.round((v / Math.pow(2, e) - 1) * 1024);
    return ((exp & 0x1f) << 10) | (m & 0x3ff);
}

export class EffectsPipeline {
    constructor(private device: GPUDevice) {}

    // ── D3 — Snapshot / Restore ───────────────────────────────────────────────

    /**
     * Reads the entire texture into a CPU Uint8Array (always 4 bytes/pixel BGRA).
     * For rgba16float textures the float values are decoded and converted to uint8.
     * Called once when an effect panel opens, stored in menu.ts.
     */
    public async snapshotTexture(texture: GPUTexture): Promise<Uint8Array> {
        const w = texture.width, h = texture.height;
        const isF16 = texture.format === 'rgba16float';
        const bytesPerRow = alignTo256(w * (isF16 ? 8 : 4));

        const staging = this.device.createBuffer({
            size:  bytesPerRow * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const enc = this.device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, [w, h]);
        this.device.queue.submit([enc.finish()]);

        await staging.mapAsync(GPUMapMode.READ);
        const mappedBuf = staging.getMappedRange();
        const pixels = new Uint8Array(w * h * 4);

        if (isF16) {
            // Decode float16 RGBA → uint8 BGRA (BGRA matches bgra8unorm convention)
            const view = new DataView(mappedBuf);
            for (let row = 0; row < h; row++) {
                const rowOff = row * bytesPerRow;
                const dstOff = row * w * 4;
                for (let x = 0; x < w; x++) {
                    const src = rowOff + x * 8;
                    const dst = dstOff + x * 4;
                    const r = decodeFloat16(view.getUint16(src + 0, true));
                    const g = decodeFloat16(view.getUint16(src + 2, true));
                    const b = decodeFloat16(view.getUint16(src + 4, true));
                    const a = decodeFloat16(view.getUint16(src + 6, true));
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

        staging.unmap();
        staging.destroy();
        return pixels;
    }

    /**
     * Writes a CPU snapshot (4 bytes/pixel BGRA) back into a GPU texture.
     * For rgba16float textures the uint8 values are encoded back to float16.
     * Called by Cancel / Reset to undo any applied effect.
     */
    public restoreTexture(texture: GPUTexture, snapshot: Uint8Array): void {
        const w = texture.width, h = texture.height;
        const isF16 = texture.format === 'rgba16float';

        if (isF16) {
            // Encode uint8 BGRA → float16 RGBA
            const bytesPerRow = alignTo256(w * 8);
            const buf = new ArrayBuffer(bytesPerRow * h);
            const view = new DataView(buf);
            for (let row = 0; row < h; row++) {
                const srcOff = row * w * 4;
                const dstOff = row * bytesPerRow;
                for (let x = 0; x < w; x++) {
                    const src = srcOff + x * 4;
                    const dst = dstOff + x * 8;
                    // Input is BGRA; output is RGBA float16
                    view.setUint16(dst + 0, encodeFloat16(snapshot[src + 2] / 255), true); // R
                    view.setUint16(dst + 2, encodeFloat16(snapshot[src + 1] / 255), true); // G
                    view.setUint16(dst + 4, encodeFloat16(snapshot[src + 0] / 255), true); // B
                    view.setUint16(dst + 6, encodeFloat16(snapshot[src + 3] / 255), true); // A
                }
            }
            this.device.queue.writeTexture({ texture, origin: [0, 0, 0] }, buf, { bytesPerRow }, [w, h]);
        } else {
            const bytesPerRow = alignTo256(w * 4);
            let data: Uint8Array;
            if (bytesPerRow === w * 4) {
                data = snapshot;
            } else {
                data = new Uint8Array(bytesPerRow * h);
                for (let row = 0; row < h; row++) {
                    data.set(
                        snapshot.subarray(row * w * 4, row * w * 4 + w * 4),
                        row * bytesPerRow
                    );
                }
            }
            this.device.queue.writeTexture({ texture, origin: [0, 0, 0] }, data, { bytesPerRow }, [w, h]);
        }
    }

    // ── Gaussian blur ─────────────────────────────────────────────────────────

    public async gaussianBlur(texture: GPUTexture, radius: number): Promise<void> {
        if (radius <= 0) return;
        const w   = texture.width, h = texture.height;
        const src = await this.snapshotTexture(texture);
        const dst = separableBoxBlur(src, w, h, Math.round(radius));
        this.restoreTexture(texture, dst);
        await this.device.queue.onSubmittedWorkDone();
    }

    // ── Hue / Saturation ──────────────────────────────────────────────────────

    public async hueSaturation(
        texture: GPUTexture,
        hDeg:    number,   // −180…+180
        sDelta:  number,   // −1…+1
        lDelta:  number    // −1…+1
    ): Promise<void> {
        const src    = await this.snapshotTexture(texture);
        const result = applyHueSat(src, hDeg, sDelta, lDelta);
        this.restoreTexture(texture, result);
        await this.device.queue.onSubmittedWorkDone();
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function alignTo256(n: number): number { return Math.ceil(n / 256) * 256; }

// ── Separable box blur ────────────────────────────────────────────────────────

function separableBoxBlur(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
    const tmp = new Float32Array(w * h * 4);
    const dst = new Uint8Array(w * h * 4);

    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
            for (let dx = -r; dx <= r; dx++) {
                const xi = Math.max(0, Math.min(w - 1, x + dx));
                const i  = (y * w + xi) * 4;
                sr += src[i]; sg += src[i+1]; sb += src[i+2]; sa += src[i+3]; n++;
            }
            const o = (y * w + x) * 4;
            tmp[o] = sr/n; tmp[o+1] = sg/n; tmp[o+2] = sb/n; tmp[o+3] = sa/n;
        }
    }

    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) {
            let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
            for (let dy = -r; dy <= r; dy++) {
                const yi = Math.max(0, Math.min(h - 1, y + dy));
                const i  = (yi * w + x) * 4;
                sr += tmp[i]; sg += tmp[i+1]; sb += tmp[i+2]; sa += tmp[i+3]; n++;
            }
            const o = (y * w + x) * 4;
            dst[o] = sr/n; dst[o+1] = sg/n; dst[o+2] = sb/n; dst[o+3] = sa/n;
        }
    }

    return dst;
}

// ── Hue / Saturation ──────────────────────────────────────────────────────────

function applyHueSat(pixels: Uint8Array, hDeg: number, sDelta: number, lDelta: number): Uint8Array {
    const out = new Uint8Array(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i] / 255, g = pixels[i+1] / 255, b = pixels[i+2] / 255;
        let [h, s, l] = rgbToHsl(r, g, b);
        h = ((h + hDeg / 360) % 1 + 1) % 1;
        s = Math.max(0, Math.min(1, s + sDelta));
        l = Math.max(0, Math.min(1, l + lDelta));
        const [nr, ng, nb] = hslToRgb(h, s, l);
        out[i]   = Math.round(nr * 255);
        out[i+1] = Math.round(ng * 255);
        out[i+2] = Math.round(nb * 255);
        out[i+3] = pixels[i+3];
    }
    return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return [0, 0, l];
    const d  = mx - mn;
    const s  = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    const h  = (mx === r ? (g - b) / d + (g < b ? 6 : 0)
              : mx === g ? (b - r) / d + 2
                         : (r - g) / d + 4) / 6;
    return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t: number) => {
        t = ((t % 1) + 1) % 1;
        return t < 1/6 ? p + (q-p)*6*t : t < 1/2 ? q : t < 2/3 ? p + (q-p)*(2/3-t)*6 : p;
    };
    return [f(h + 1/3), f(h), f(h - 1/3)];
}
