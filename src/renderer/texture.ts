// renderer/texture.ts
export function createPersistentTexture(device: GPUDevice, width: number, height: number, format: GPUTextureFormat) {
  return device.createTexture({
    size: [width, height, 1],
    format: format,
    usage: 
      GPUTextureUsage.RENDER_ATTACHMENT | // Draw stamps to it
      GPUTextureUsage.COPY_SRC |           // Copy from it (for downloads/canvas)
      GPUTextureUsage.COPY_DST |           // Allow clearing/writing to it
      GPUTextureUsage.TEXTURE_BINDING      // CRITICAL: Allow the Composite Shader to read it
  });
}