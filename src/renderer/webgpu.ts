export interface GPUInitResult {
    device:             GPUDevice;
    context:            GPUCanvasContext;
    format:             GPUTextureFormat;
    canvas:             HTMLCanvasElement;
    supportsTimestamps: boolean;
}

/**
 * Initialises WebGPU on the provided canvas (or finds #canvas if omitted).
 * Passing the canvas explicitly lets recovery code reuse an existing DOM element
 * without needing to query the DOM again.
 */
export async function initGPU(
    existingCanvas?: HTMLCanvasElement
): Promise<GPUInitResult> {
    const canvas = existingCanvas
        ?? (document.getElementById('canvas') as HTMLCanvasElement);

    if (!canvas) throw new Error('No canvas element found. Add <canvas id="canvas"> to your HTML.');

    const isWindows = (navigator as any).userAgentData
        ? (navigator as any).userAgentData.platform === 'Windows'
        : navigator.userAgent.includes('Windows');

    const adapter = await navigator.gpu.requestAdapter(
        isWindows ? undefined : { powerPreference: 'high-performance' }
    );

    if (!adapter) {
        throw new Error('No WebGPU adapter found. Your browser may not support WebGPU.');
    }

    const supportsTimestamps = adapter.features.has('timestamp-query');

    const device = await adapter.requestDevice({
        requiredFeatures: supportsTimestamps ? ['timestamp-query'] : []
    });

    device.lost.then((info) => {
        if (info.reason !== 'destroyed') {
            console.error(`WebGPU device lost: ${info.message}`);
            window.dispatchEvent(new CustomEvent('webgpu-device-lost', { detail: info }));
        }
    });

    const context = canvas.getContext('webgpu') as GPUCanvasContext;
    const format  = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
        device,
        format,
        usage:     GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
        alphaMode: 'premultiplied'
    });

    return { device, context, format, canvas, supportsTimestamps };
}
