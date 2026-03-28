import { LayerState, BlendMode } from "./layer-manager";
import { DirtyRect }              from "./brush-renderer";
import compositeShaderSource      from "./shaders/composite.wgsl?raw";

const BLEND_MODE_INDEX: Record<BlendMode, number> = {
    normal:   0,
    multiply: 1,
    screen:   2,
    overlay:  3
};

const MAX_LAYERS   = 32;
const OVERLAY_SLOT = MAX_LAYERS;       // slot MAX_LAYERS
const BG_SLOT      = MAX_LAYERS + 1;  // slot for white background fill
const TOTAL_SLOTS  = MAX_LAYERS + 2;  // layers + overlay + background

export class CompositeRenderer {
    private pipeline:        GPURenderPipeline;
    private bindGroupLayout: GPUBindGroupLayout;
    private sampler:         GPUSampler;

    private uniformBuffer: GPUBuffer;
    private uniformStride: number;
    private swapRB:        boolean;

    // 1×1 fully opaque white texture.
    // Used to "paint white" over the dirty region when compositing with a
    // scissor rect — loadOp:'clear' ignores the scissor and would wipe the
    // entire backing texture, so we use loadOp:'load' + a white quad draw
    // instead.
    private whiteTexture: GPUTexture;

    private bindGroupCache = new WeakMap<GPUTexture, GPUBindGroup>();

    constructor(
        private device: GPUDevice,
        format:         GPUTextureFormat,
        layerFormat:    GPUTextureFormat = format
    ) {
        this.swapRB = (layerFormat === 'rgba16float' && format === 'bgra8unorm');
        const alignment    = device.limits.minUniformBufferOffsetAlignment;
        this.uniformStride = Math.ceil(16 / alignment) * alignment;

        console.assert(
            this.uniformStride >= 16 && this.uniformStride % alignment === 0,
            `CompositeRenderer: bad uniformStride ${this.uniformStride} for alignment ${alignment}`
        );

        this.uniformBuffer = device.createBuffer({
            size:  this.uniformStride * TOTAL_SLOTS,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.sampler = device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear'
        });

        // ── White texture ─────────────────────────────────────────────────────
        // 1×1 texel, all channels 255. Blended at opacity=1/normal mode,
        // the composite pipeline outputs solid white regardless of destination
        // because: dst = src*1 + dst*(1-1) = src = white.
        // [255,255,255,255] is correct for both rgba8unorm and bgra8unorm
        // since all channels are at maximum.
        this.whiteTexture = device.createTexture({
            size:   [1, 1],
            format: format,
            usage:
                GPUTextureUsage.TEXTURE_BINDING    |
                GPUTextureUsage.RENDER_ATTACHMENT  |
                GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.whiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1]
        );

        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding:    0,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler:    { type: 'filtering' }
                },
                {
                    binding:    1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture:    { sampleType: 'float' }
                },
                {
                    binding:    2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer:     {
                        type:             'uniform',
                        hasDynamicOffset: true,
                        minBindingSize:   16
                    }
                }
            ]
        });

        const module = device.createShaderModule({ code: compositeShaderSource });

        this.pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.bindGroupLayout]
            }),
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
                    }
                }]
            },
            primitive: { topology: 'triangle-strip' }
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Composites all layers into targetView (the persistent backing texture).
     *
     * scissorRect behaviour — two distinct code paths:
     *
     *   scissorRect === null  (full composite — undo/redo, layer change, init)
     *     Clear pass uses loadOp:'clear' → entire backing texture reset to white.
     *     All layers drawn without scissor.
     *
     *   scissorRect !== null  (dirty rect composite — active stroke)
     *     Clear pass uses loadOp:'load' → backing texture preserved outside rect.
     *     A white quad is drawn WITHIN the scissor to reset just the dirty region.
     *     All layers drawn within the scissor.
     *
     * The second path is the core of the dirty rect optimisation. It works
     * correctly because loadOp:'clear' ignores the scissor rect in WebGPU —
     * it always clears the entire attachment. Using loadOp:'load' + a white
     * draw respects the scissor and leaves everything else untouched.
     */
    public render(
        targetView:     GPUTextureView,
        layers:         LayerState[],
        overlayTex:     GPUTexture,
        scissorRect:    DirtyRect | null,
        querySet?:      GPUQuerySet,
        texOverride?:   { layerIndex: number; texture: GPUTexture } | null
    ) {
        // ── Write all uniforms before encoding GPU work ───────────────────────
        const visibleLayers: Array<{ layer: LayerState; slot: number }> = [];

        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            if (!layer.visible) continue;
            this.writeUniformSlot(i, layer.opacity, layer.blendMode, this.swapRB);
            visibleLayers.push({ layer, slot: i });
        }

        this.writeUniformSlot(OVERLAY_SLOT, 1.0, 'normal', this.swapRB);
        // BG_SLOT: white texture — channel-agnostic, no swap needed
        this.writeUniformSlot(BG_SLOT, 1.0, 'normal', false);

        const encoder = this.device.createCommandEncoder();
        const usingScissor = scissorRect !== null;

        // ── Clear / background pass ───────────────────────────────────────────
        //
        // FULL composite path: loadOp:'clear' resets entire canvas to white.
        // No draw call needed — the clear itself is the white background.
        //
        // SCISSORED path: loadOp:'load' preserves the backing texture.
        // Draw the white texture clipped to the dirty rect to reset just that
        // region. This is the critical fix — loadOp:'clear' would wipe the
        // entire backing texture, destroying all previously composited content
        // outside the scissor rect.
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view:       targetView,
                    loadOp:     usingScissor ? 'load' : 'clear',
                    clearValue: { r: 1, g: 1, b: 1, a: 1 },
                    storeOp:    'store'
                }],
                timestampWrites: querySet ? {
                    querySet,
                    beginningOfPassWriteIndex: 0
                } : undefined
            });

            if (usingScissor) {
                // Reset the dirty region to white before layer blending
                pass.setScissorRect(
                    scissorRect!.x, scissorRect!.y,
                    scissorRect!.width, scissorRect!.height
                );
                pass.setPipeline(this.pipeline);
                pass.setBindGroup(0, this.getBindGroup(this.whiteTexture), [BG_SLOT * this.uniformStride]);
                pass.draw(4);
            }

            pass.end();
        }

        // ── Layer blend passes ────────────────────────────────────────────────
        for (const { layer, slot } of visibleLayers) {
            const tex  = (texOverride && slot === texOverride.layerIndex)
                ? texOverride.texture
                : layer.texture;
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view:    targetView,
                    loadOp:  'load',
                    storeOp: 'store'
                }]
            });
            if (usingScissor) pass.setScissorRect(
                scissorRect!.x, scissorRect!.y,
                scissorRect!.width, scissorRect!.height
            );
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.getBindGroup(tex), [slot * this.uniformStride]);
            pass.draw(4);
            pass.end();
        }

        // ── Overlay pass ──────────────────────────────────────────────────────
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view:    targetView,
                    loadOp:  'load',
                    storeOp: 'store'
                }],
                timestampWrites: querySet ? {
                    querySet,
                    endOfPassWriteIndex: 1
                } : undefined
            });
            if (usingScissor) pass.setScissorRect(
                scissorRect!.x, scissorRect!.y,
                scissorRect!.width, scissorRect!.height
            );
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.getBindGroup(overlayTex), [OVERLAY_SLOT * this.uniformStride]);
            pass.draw(4);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Blits the backing texture to the swap chain — always full canvas, no scissor.
     * The backing texture is always fully valid so no scissor is needed here.
     */
    public blit(srcTexture: GPUTexture, dstView: GPUTextureView) {
        this.writeUniformSlot(BG_SLOT, 1.0, 'normal');

        const encoder = this.device.createCommandEncoder();
        const pass    = encoder.beginRenderPass({
            colorAttachments: [{
                view:       dstView,
                loadOp:     'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp:    'store'
            }]
        });

        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.getBindGroup(srcTexture), [BG_SLOT * this.uniformStride]);
        pass.draw(4);
        pass.end();

        this.device.queue.submit([encoder.finish()]);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────────────

    private writeUniformSlot(
        slot:      number,
        opacity:   number,
        blendMode: BlendMode | 'normal',
        swapRB:    boolean = false
    ): void {
        const data = new ArrayBuffer(16);
        const dv   = new DataView(data);
        dv.setFloat32(0,  opacity,                                       true);
        dv.setUint32 (4,  BLEND_MODE_INDEX[blendMode as BlendMode] ?? 0, true);
        dv.setUint32 (8,  swapRB ? 1 : 0,                               true);
        dv.setFloat32(12, 0,                                             true);
        this.device.queue.writeBuffer(this.uniformBuffer, slot * this.uniformStride, data);
    }

    private getBindGroup(texture: GPUTexture): GPUBindGroup {
        if (!this.bindGroupCache.has(texture)) {
            this.bindGroupCache.set(texture, this.device.createBindGroup({
                layout:  this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: this.sampler         },
                    { binding: 1, resource: texture.createView() },
                    {
                        binding:  2,
                        resource: { buffer: this.uniformBuffer, offset: 0, size: 16 }
                    }
                ]
            }));
        }
        return this.bindGroupCache.get(texture)!;
    }
}