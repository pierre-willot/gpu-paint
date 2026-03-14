// renderer/webgpu.ts
export async function initGPU() {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter!.requestDevice();
  const context = canvas.getContext("webgpu") as GPUCanvasContext;
  const format = navigator.gpu.getPreferredCanvasFormat();

  context.configure({
    device,
    format,
    // ADD COPY_DST so we can blit our persistent texture to the canvas
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST 
  });

  return { device, context, format, canvas };
}