// src/utils/export.ts

// ── textureToBytes ─────────────────────────────────────────────────────────────
// Reads a GPUTexture to a row-packed Uint8Array (no alignment padding).
// Exported so project-format.ts can reuse the GPU readback logic without
// duplicating it. All downstream callers get un-padded pixel rows.

export async function textureToBytes(
    device:  GPUDevice,
    texture: GPUTexture
): Promise<Uint8Array> {
    const width   = texture.width;
    const height  = texture.height;
    const isF16   = texture.format === 'rgba16float';
    const srcBpp  = isF16 ? 8 : 4;
    const paddedPerRow = Math.ceil(width * srcBpp / 256) * 256;

    const readBuffer = device.createBuffer({
        label: 'Export Readback Buffer',
        size:  paddedPerRow * height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });

    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer(
        { texture },
        { buffer: readBuffer, bytesPerRow: paddedPerRow },
        [width, height]
    );
    device.queue.submit([encoder.finish()]);

    await readBuffer.mapAsync(GPUMapMode.READ);
    const mappedBuf = readBuffer.getMappedRange();
    const result    = new Uint8Array(width * height * 4);

    if (isF16) {
        // Decode float16 RGBA → uint8 RGBA
        const view = new DataView(mappedBuf);
        for (let y = 0; y < height; y++) {
            const rowOff = y * paddedPerRow, dstOff = y * width * 4;
            for (let x = 0; x < width; x++) {
                const src = rowOff + x * 8, dst = dstOff + x * 4;
                result[dst + 0] = Math.round(Math.min(1, Math.max(0, f16ToF32(view.getUint16(src + 0, true)))) * 255); // R
                result[dst + 1] = Math.round(Math.min(1, Math.max(0, f16ToF32(view.getUint16(src + 2, true)))) * 255); // G
                result[dst + 2] = Math.round(Math.min(1, Math.max(0, f16ToF32(view.getUint16(src + 4, true)))) * 255); // B
                result[dst + 3] = Math.round(Math.min(1, Math.max(0, f16ToF32(view.getUint16(src + 6, true)))) * 255); // A
            }
        }
    } else {
        // Strip alignment padding — copy only the valid pixel bytes per row
        const raw = new Uint8Array(mappedBuf);
        const unpaddedPerRow = width * 4;
        for (let y = 0; y < height; y++) {
            result.set(
                raw.subarray(y * paddedPerRow, y * paddedPerRow + unpaddedPerRow),
                y * unpaddedPerRow
            );
        }
    }

    readBuffer.unmap();
    readBuffer.destroy();
    return result;
}

function f16ToF32(h: number): number {
    const e = (h >> 10) & 0x1f, m = h & 0x3ff;
    let v: number;
    if (e === 0)       v = (m / 1024) * Math.pow(2, -14);
    else if (e === 31) v = m ? NaN : Infinity;
    else               v = (1 + m / 1024) * Math.pow(2, e - 15);
    return (h >> 15) ? -v : v;
}

// ── bytesToPng ─────────────────────────────────────────────────────────────────
// Encodes raw RGBA pixel bytes to a PNG Uint8Array via Canvas2D.
// Separated from textureToBytes so callers can do BGRA→RGBA swapping in between
// (needed for bgra8unorm textures on Windows/Chrome before PNG encoding).

export function bytesToPng(
    pixels: Uint8Array,
    width:  number,
    height: number
): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement('canvas');
        canvas.width  = width;
        canvas.height = height;
        const ctx     = canvas.getContext('2d')!;
        const img     = ctx.createImageData(width, height);
        img.data.set(pixels);
        ctx.putImageData(img, 0, 0);

        // toBlob is faster than toDataURL — no base64 encoding round-trip
        canvas.toBlob(blob => {
            if (!blob) { reject(new Error('canvas.toBlob returned null')); return; }
            blob.arrayBuffer()
                .then(buf => resolve(new Uint8Array(buf)))
                .catch(reject);
        }, 'image/png');
    });
}

// ── downloadTexture ────────────────────────────────────────────────────────────
// Public API kept identical to existing callers.
// Internally uses textureToBytes + bytesToPng for consistency with the export
// pipeline, and triggers download via URL.createObjectURL (faster than toDataURL).

export async function downloadTexture(
    device:   GPUDevice,
    texture:  GPUTexture,
    fileName: string = 'drawing.png',
    format?:  GPUTextureFormat
): Promise<void> {
    const pixels = await textureToBytes(device, texture);
    // On Windows/DX12 the default format is bgra8unorm — swap B and R so
    // bytesToPng (which feeds RGBA to Canvas2D putImageData) gets correct colors.
    if (format === 'bgra8unorm') {
        for (let i = 0; i < pixels.length; i += 4) {
            const b = pixels[i]; pixels[i] = pixels[i + 2]; pixels[i + 2] = b;
        }
    }
    const png = await bytesToPng(pixels, texture.width, texture.height);

    const blob = new Blob([png], { type: 'image/png' });
    const link = document.createElement('a');
    link.download = fileName;
    link.href     = URL.createObjectURL(blob);
    link.click();
    URL.revokeObjectURL(link.href);
}
