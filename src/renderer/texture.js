// renderer/texture.ts
export function createPersistentTexture(device, width, height, format) {
    return device.createTexture({
        size: [width, height, 1],
        format: format,
        // RENDER_ATTACHMENT = we draw brush stamps to it
        // COPY_SRC = we copy it to the HTML canvas to show the user
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
    });
}
//# sourceMappingURL=texture.js.map