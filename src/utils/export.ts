// src/utils/export.ts

/**
 * Downloads a GPUTexture as a PNG file.
 */
export async function downloadTexture(device: GPUDevice, texture: GPUTexture, fileName: string = "drawing.png") {
  const width = texture.width;
  const height = texture.height;

  // 1. Calculate bytes per row (Must be a multiple of 256)
  const bytesPerPixel = 4;
  const unpaddedBytesPerRow = width * bytesPerPixel;
  const align = 256;
  const paddedBytesPerRow = Math.ceil(unpaddedBytesPerRow / align) * align;

  // 2. Create a buffer to read the GPU data
  const readBuffer = device.createBuffer({
    label: "Export Readback Buffer",
    size: paddedBytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // 3. Encode the copy command
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: texture },
    { buffer: readBuffer, bytesPerRow: paddedBytesPerRow },
    [width, height]
  );
  device.queue.submit([encoder.finish()]);

  // 4. Map the buffer to CPU memory
  await readBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = readBuffer.getMappedRange();
  const rawData = new Uint8Array(arrayBuffer);

  // 5. Use Canvas2D to encode the PNG (removes the padding)
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);

  for (let y = 0; y < height; y++) {
    const srcOffset = y * paddedBytesPerRow;
    const destOffset = y * width * bytesPerPixel;
    imageData.data.set(
      rawData.subarray(srcOffset, srcOffset + unpaddedBytesPerRow),
      destOffset
    );
  }
  
  ctx.putImageData(imageData, 0, 0);

  // 6. Trigger Download
  const link = document.createElement('a');
  link.download = fileName;
  link.href = canvas.toDataURL('image/png');
  link.click();

  // 7. Cleanup
  readBuffer.unmap();
  readBuffer.destroy();
}