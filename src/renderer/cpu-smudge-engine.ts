// src/renderer/cpu-smudge-engine.ts
//
// CPU-based directional pixel-dragging smudge engine.
//
// Algorithm (per stamp):
//   1. Compute brush alpha mask: linear falloff from stamp center to radius
//   2. Sample source pixels from P_prev (previous stamp center)
//   3. Mix source with the persistent "lifted" paint buffer
//   4. Lerp the destination pixels at P_current toward the effective source
//   5. Update the lifted buffer by blending in the just-written P_current pixels
//
// This is a directional drag, NOT a blur — pixels are transported from P_prev
// to P_current. Sampling from P_current would produce no movement.

function alignTo256(n: number): number {
    return Math.ceil(n / 256) * 256;
}

export class CpuSmudgeEngine {
    private pixels:     Uint8Array | null   = null;  // CPU copy of layer (BGRA on Windows)
    private liftBuf:    Float32Array | null = null;  // lifted paint per-offset (BGRA floats)
    private liftRadius: number              = 0;
    private width:      number              = 0;
    private height:     number              = 0;
    private _ready:     boolean             = false;

    public get ready(): boolean { return this._ready; }

    // ── Stroke lifecycle ──────────────────────────────────────────────────────

    /**
     * Read the active layer texture into a CPU buffer.
     * Called once at stroke start — ~1ms for typical canvas sizes.
     * drawCpuSmudge() is safe to call immediately; it buffers stamps until ready.
     */
    public async initFromTexture(device: GPUDevice, texture: GPUTexture): Promise<void> {
        this._ready     = false;
        this.liftBuf    = null;
        this.liftRadius = 0;
        this.width      = texture.width;
        this.height     = texture.height;

        const w   = this.width, h = this.height;
        const bpr = alignTo256(w * 4);

        const staging = device.createBuffer({
            size:  bpr * h,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow: bpr }, [w, h]);
        device.queue.submit([enc.finish()]);

        await staging.mapAsync(GPUMapMode.READ);
        const mapped = new Uint8Array(staging.getMappedRange());
        this.pixels  = new Uint8Array(w * h * 4);
        for (let row = 0; row < h; row++) {
            this.pixels.set(
                mapped.subarray(row * bpr, row * bpr + w * 4),
                row * w * 4
            );
        }
        staging.unmap();
        staging.destroy();
        this._ready = true;
    }

    /**
     * Upload the modified CPU pixel buffer back to the GPU layer texture.
     * Called after each stamp batch so the composite renderer sees the changes.
     */
    public uploadToTexture(device: GPUDevice, texture: GPUTexture): void {
        if (!this.pixels) return;
        const w   = this.width, h = this.height;
        const bpr = alignTo256(w * 4);
        if (bpr === w * 4) {
            device.queue.writeTexture({ texture }, this.pixels, { bytesPerRow: bpr }, [w, h]);
        } else {
            const buf = new Uint8Array(bpr * h);
            for (let row = 0; row < h; row++) {
                buf.set(
                    this.pixels.subarray(row * w * 4, (row + 1) * w * 4),
                    row * bpr
                );
            }
            device.queue.writeTexture({ texture }, buf, { bytesPerRow: bpr }, [w, h]);
        }
    }

    /** Free lifted paint buffer and CPU pixel copy. Call at stroke end. */
    public endStroke(): void {
        this.liftBuf    = null;
        this.liftRadius = 0;
        this._ready     = false;
        this.pixels     = null;
    }

    // ── Stamp processing ──────────────────────────────────────────────────────

    /**
     * Apply a batch of stamps to the CPU pixel buffer.
     *
     * Stamp layout (from pipeline-cache.ts FLOATS_PER_STAMP=16):
     *   [0]  x             — current stamp center X, normalized 0..1
     *   [1]  y             — current stamp center Y, normalized 0..1
     *   [3]  size          — brush radius in normalized canvas units
     *   [4]  prev_center.x — previous stamp X, set by SmudgeTool (repurposed color.r)
     *   [5]  prev_center.y — previous stamp Y, set by SmudgeTool (repurposed color.g)
     *   [10] opacity       — per-stamp opacity (not used here; strength drives blend)
     */
    public applyStamps(
        stamps:    Float32Array,
        strength:  number,   // BrushDescriptor.smudge  (0..1)
        hardness:  number,   // BrushDescriptor.hardness (0=soft falloff, 1=sharp edge)
        liftCarry: number,   // BrushDescriptor.wetness  (0=no carry, 1=full paint carry)
    ): void {
        if (!this.pixels || !this._ready) return;
        const FPS = 16; // FLOATS_PER_STAMP
        for (let i = 0; i < stamps.length; i += FPS) {
            this.applyStamp(
                stamps[i],     stamps[i + 1],  // cx, cy
                stamps[i + 4], stamps[i + 5],  // px, py (prev_center)
                stamps[i + 3],                 // size
                strength, hardness, liftCarry
            );
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private applyStamp(
        cx: number, cy: number,   // current stamp center, normalized 0..1
        px: number, py: number,   // previous stamp center, normalized 0..1
        sizeNorm:  number,        // brush size in normalized canvas units
        strength:  number,        // smudge blend strength
        hardness:  number,        // falloff sharpness
        liftCarry: number,        // lifted paint carry amount
    ): void {
        const buf  = this.pixels!;
        const w    = this.width, h = this.height;
        const ACCUMULATION_RATE = 0.2;

        // Brush radius in pixels
        const radius = Math.max(1, Math.round(sizeNorm * w * 0.5));

        // Stamp centers in pixel space
        const cxPx = Math.round(cx * w);
        const cyPx = Math.round(cy * h);
        const pxPx = Math.round(px * w);
        const pyPx = Math.round(py * h);

        // Initialize lifted buffer on first stamp or if radius changed
        if (!this.liftBuf || this.liftRadius !== radius) {
            this.initLiftedBuffer(pxPx, pyPx, radius);
        }

        const diameter = 2 * radius + 1;

        // Temporary buffer to store the newly-written destination values
        // so we can update the lifted buffer after all writes are complete.
        const written  = new Float32Array(diameter * diameter * 4); // BGRA floats

        // ── Steps 3–5: sample → mix → lerp → write ──────────────────────────
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > radius) continue;

                // Brush alpha — linear falloff modulated by hardness
                // hardness=0: fully linear cone; hardness=1: near-uniform disc
                const t     = 1.0 - dist / radius;
                const gamma = 1.0 - hardness * 0.92; // gamma ∈ [0.08, 1.0]
                const brushAlpha  = Math.pow(t, gamma);
                const blendFactor = strength * brushAlpha;
                if (blendFactor < 0.001) continue;

                const oi = ((dy + radius) * diameter + (dx + radius)) * 4;

                // Step 3: sample source pixels from P_prev
                const si  = this.clampedIdx(pxPx + dx, pyPx + dy);
                const s0  = buf[si], s1 = buf[si + 1], s2 = buf[si + 2], s3 = buf[si + 3];

                // Step 5a: mix source with lifted paint buffer
                const lc  = liftCarry;
                const lft = this.liftBuf!;
                const e0  = s0 * (1 - lc) + lft[oi]     * lc;
                const e1  = s1 * (1 - lc) + lft[oi + 1] * lc;
                const e2  = s2 * (1 - lc) + lft[oi + 2] * lc;
                const e3  = s3 * (1 - lc) + lft[oi + 3] * lc;

                // Step 4: lerp destination at P_current toward effective source
                const dstX = cxPx + dx;
                const dstY = cyPx + dy;
                if (dstX < 0 || dstX >= w || dstY < 0 || dstY >= h) continue;
                const di = (dstY * w + dstX) * 4;

                const f  = blendFactor;
                const r0 = buf[di]     + (e0 - buf[di])     * f;
                const r1 = buf[di + 1] + (e1 - buf[di + 1]) * f;
                const r2 = buf[di + 2] + (e2 - buf[di + 2]) * f;
                const r3 = buf[di + 3] + (e3 - buf[di + 3]) * f;

                buf[di]     = r0 < 0 ? 0 : r0 > 255 ? 255 : r0;
                buf[di + 1] = r1 < 0 ? 0 : r1 > 255 ? 255 : r1;
                buf[di + 2] = r2 < 0 ? 0 : r2 > 255 ? 255 : r2;
                buf[di + 3] = r3 < 0 ? 0 : r3 > 255 ? 255 : r3;

                // Record new value for lifted buffer update
                written[oi]     = buf[di];
                written[oi + 1] = buf[di + 1];
                written[oi + 2] = buf[di + 2];
                written[oi + 3] = buf[di + 3];
            }
        }

        // Step 5b: update lifted buffer — slowly picks up newly-written colors
        const ar  = ACCUMULATION_RATE;
        const lft = this.liftBuf!;
        for (let k = 0; k < lft.length; k++) {
            lft[k] = lft[k] * (1 - ar) + written[k] * ar;
        }
    }

    /**
     * Initialize the lifted paint buffer from canvas pixels at the first stamp position.
     * This seeds the buffer so the very first stamp can carry paint from stroke start.
     */
    private initLiftedBuffer(pxPx: number, pyPx: number, radius: number): void {
        const buf      = this.pixels!;
        const diameter = 2 * radius + 1;
        this.liftBuf    = new Float32Array(diameter * diameter * 4);
        this.liftRadius = radius;

        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                const oi = ((dy + radius) * diameter + (dx + radius)) * 4;
                const si = this.clampedIdx(pxPx + dx, pyPx + dy);
                this.liftBuf[oi]     = buf[si];
                this.liftBuf[oi + 1] = buf[si + 1];
                this.liftBuf[oi + 2] = buf[si + 2];
                this.liftBuf[oi + 3] = buf[si + 3];
            }
        }
    }

    /** Return byte index for (x, y), clamped to canvas bounds. */
    private clampedIdx(x: number, y: number): number {
        const cx = x < 0 ? 0 : x >= this.width  ? this.width  - 1 : x;
        const cy = y < 0 ? 0 : y >= this.height ? this.height - 1 : y;
        return (cy * this.width + cx) * 4;
    }
}
