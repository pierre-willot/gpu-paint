// src/utils/export.ts

// ── textureToBytes ─────────────────────────────────────────────────────────────
// Reads a GPUTexture to a row-packed Uint8Array (no alignment padding).
// Exported so project-format.ts can reuse the GPU readback logic without
// duplicating it. All downstream callers get un-padded pixel rows.

export async function textureToBytes(
    device:  GPUDevice,
    texture: GPUTexture
): Promise<Uint8Array> {
    const width          = texture.width;
    const height         = texture.height;
    const bytesPerPixel  = 4;
    const unpaddedPerRow = width * bytesPerPixel;
    const paddedPerRow   = Math.ceil(unpaddedPerRow / 256) * 256;

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
    const raw    = new Uint8Array(readBuffer.getMappedRange());
    const result = new Uint8Array(width * height * bytesPerPixel);

    // Strip alignment padding — copy only the valid pixel bytes per row
    for (let y = 0; y < height; y++) {
        result.set(
            raw.subarray(y * paddedPerRow, y * paddedPerRow + unpaddedPerRow),
            y * unpaddedPerRow
        );
    }

    readBuffer.unmap();
    readBuffer.destroy();
    return result;
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
