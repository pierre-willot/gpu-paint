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
    // Normal-blend pipeline: GPU blend (one, one-minus-src-alpha) — Porter-Duff
    // over in linear space. No backdrop texture read needed.
    private pipelineNormal:    GPURenderPipeline;
    // Blend-mode pipeline: GPU blend (one, zero) — Porter-Duff done in shader.
    // Requires copying backingTexture → backdropTexture before each pass.
    private pipelineOverwrite: GPURenderPipeline;
    // Final blit: linear premultiplied → sRGB premultiplied for canvas display.
    private pipelineBlit:      GPURenderPipeline;

    private bindGroupLayout:     GPUBindGroupLayout;
    private blitBindGroupLayout: GPUBindGroupLayout;
    private sampler:             GPUSampler;

    private uniformBuffer: GPUBuffer;
    private uniformStride: number;
    private swapRB:        boolean;

    // 1×1 fully opaque white texture. Used for:
    //   (a) painting white over the dirty region in scissored composite passes
    //   (b) dummy backdrop binding for normal-blend layer passes
    private whiteTexture: GPUTexture;

    // Two-level cache: layerTex → backdropTex → GPUBindGroup.
    // Normal layers use whiteTexture as the backdrop key.
    private bindGroupCache     = new WeakMap<GPUTexture, WeakMap<GPUTexture, GPUBindGroup>>();
    private blitBindGroupCache = new WeakMap<GPUTexture, GPUBindGroup>();

    constructor(
        private device: GPUDevice,
        format:         GPUTextureFormat,
        layerFormat:    GPUTextureFormat = format
    ) {
        this.swapRB = (layerFormat === 'rgba16float' && format === 'bgra8unorm');
        const alignment    = device.limits.minUniformBufferOffsetAlignment;
        this.uniformStride = Math.ceil(16 / alignment) * alignment;

        this.uniformBuffer = device.createBuffer({
            size:  this.uniformStride * TOTAL_SLOTS,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

        // 1×1 white texture (channel-agnostic: all bytes 255).
        this.whiteTexture = device.createTexture({
            size:   [1, 1],
            format: format,
            usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST
        });
        device.queue.writeTexture(
            { texture: this.whiteTexture },
            new Uint8Array([255, 255, 255, 255]),
            { bytesPerRow: 4 },
            [1, 1]
        );

        // ── Bind group layouts ────────────────────────────────────────────────

        // Layer composite layout: sampler, layer tex, uniforms, backdrop tex.
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
                {
                    binding:    2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer:     { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 }
                },
                { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
            ]
        });

        // Blit layout: sampler + source texture only.
        this.blitBindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } }
            ]
        });

        const module         = device.createShaderModule({ code: compositeShaderSource });
        const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

        // ── Pipelines ─────────────────────────────────────────────────────────

        this.pipelineNormal = device.createRenderPipeline({
            layout:   pipelineLayout,
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: {
                module, entryPoint: 'fs_main',
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

        this.pipelineOverwrite = device.createRenderPipeline({
            layout:   pipelineLayout,
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: {
                module, entryPoint: 'fs_main',
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
                    }
                }]
            },
            primitive: { topology: 'triangle-strip' }
        });

        this.pipelineBlit = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: [this.blitBindGroupLayout] }),
            vertex:   { module, entryPoint: 'vs_main' },
            fragment: {
                module, entryPoint: 'fs_blit_srgb',
                targets: [{
                    format,
                    blend: {
                        color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                        alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
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
     * Composites all layers into backingTexture (via targetView).
     *
     * Accumulates LINEAR PREMULTIPLIED values — no sRGB encoding here.
     * sRGB encoding happens only in blitSrgb(), called by PaintPipeline.composite().
     *
     * backdropTexture: a same-size/format texture used as a staging copy of
     * backingTexture for non-normal blend mode layers. Allocated by PaintPipeline.
     *
     * scissorRect behaviour:
     *   null  → full composite: clear entire backing to white, draw all layers.
     *   non-null → dirty rect: preserve backing outside rect, white-fill the rect,
     *              draw all layers scissored to the rect.
     */
    public render(
        targetView:      GPUTextureView,
        backingTexture:  GPUTexture,
        backdropTexture: GPUTexture,
        layers:          LayerState[],
        overlayTex:      GPUTexture,
        scissorRect:     DirtyRect | null,
        querySet?:       GPUQuerySet,
        texOverride?:    { layerIndex: number; texture: GPUTexture } | null
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
        this.writeUniformSlot(BG_SLOT,      1.0, 'normal', false);

        const encoder      = this.device.createCommandEncoder();
        const usingScissor = scissorRect !== null;

        // ── Clear / background pass ───────────────────────────────────────────
        {
            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view:       targetView,
                    loadOp:     usingScissor ? 'load' : 'clear',
                    clearValue: { r: 1, g: 1, b: 1, a: 1 },
                    storeOp:    'store'
                }],
                timestampWrites: querySet ? { querySet, beginningOfPassWriteIndex: 0 } : undefined
            });

            if (usingScissor) {
                pass.setScissorRect(scissorRect!.x, scissorRect!.y, scissorRect!.width, scissorRect!.height);
                pass.setPipeline(this.pipelineNormal);
                pass.setBindGroup(0, this.getBindGroup(this.whiteTexture, this.whiteTexture), [BG_SLOT * this.uniformStride]);
                pass.draw(4);
            }
            pass.end();
        }

        // ── Layer blend passes ────────────────────────────────────────────────
        for (const { layer, slot } of visibleLayers) {
            const tex           = (texOverride && slot === texOverride.layerIndex) ? texOverride.texture : layer.texture;
            const needsBackdrop = layer.blendMode !== 'normal';

            if (needsBackdrop) {
                // Copy current backingTexture → backdropTexture BEFORE the render
                // pass. A render pass cannot read from its own render target.
                // Only copy the scissor subregion for efficiency during strokes.
                const origin: GPUOrigin3D = usingScissor
                    ? [scissorRect!.x, scissorRect!.y, 0]
                    : [0, 0, 0];
                const copySize: GPUExtent3D = usingScissor
                    ? [scissorRect!.width, scissorRect!.height, 1]
                    : [backingTexture.width, backingTexture.height, 1];
                encoder.copyTextureToTexture(
                    { texture: backingTexture,  origin },
                    { texture: backdropTexture, origin },
                    copySize
                );
            }

            const pass = encoder.beginRenderPass({
                colorAttachments: [{
                    view:    targetView,
                    loadOp:  'load',
                    storeOp: 'store'
                }]
            });
            if (usingScissor) {
                pass.setScissorRect(scissorRect!.x, scissorRect!.y, scissorRect!.width, scissorRect!.height);
            }

            if (needsBackdrop) {
                pass.setPipeline(this.pipelineOverwrite);
                pass.setBindGroup(0, this.getBindGroup(tex, backdropTexture), [slot * this.uniformStride]);
            } else {
                pass.setPipeline(this.pipelineNormal);
                pass.setBindGroup(0, this.getBindGroup(tex, this.whiteTexture), [slot * this.uniformStride]);
            }
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
                timestampWrites: querySet ? { querySet, endOfPassWriteIndex: 1 } : undefined
            });
            if (usingScissor) {
                pass.setScissorRect(scissorRect!.x, scissorRect!.y, scissorRect!.width, scissorRect!.height);
            }
            pass.setPipeline(this.pipelineNormal);
            pass.setBindGroup(0, this.getBindGroup(overlayTex, this.whiteTexture), [OVERLAY_SLOT * this.uniformStride]);
            pass.draw(4);
            pass.end();
        }

        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Blits linear-premultiplied backingTexture to dstView (canvas swap chain)
     * with sRGB encoding. Called by PaintPipeline.composite() instead of
     * copyTextureToTexture so that gamma encoding is applied correctly.
     */
    public blitSrgb(srcTexture: GPUTexture, dstView: GPUTextureView): void {
        const encoder = this.device.createCommandEncoder();
        const pass    = encoder.beginRenderPass({
            colorAttachments: [{
                view:       dstView,
                loadOp:     'clear',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
                storeOp:    'store'
            }]
        });
        pass.setPipeline(this.pipelineBlit);
        pass.setBindGroup(0, this.getBlitBindGroup(srcTexture));
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

    private getBindGroup(layerTex: GPUTexture, backdropTex: GPUTexture): GPUBindGroup {
        let inner = this.bindGroupCache.get(layerTex);
        if (!inner) {
            inner = new WeakMap();
            this.bindGroupCache.set(layerTex, inner);
        }
        if (!inner.has(backdropTex)) {
            inner.set(backdropTex, this.device.createBindGroup({
                layout:  this.bindGroupLayout,
                entries: [
                    { binding: 0, resource: this.sampler              },
                    { binding: 1, resource: layerTex.createView()     },
                    { binding: 2, resource: { buffer: this.uniformBuffer, offset: 0, size: 16 } },
                    { binding: 3, resource: backdropTex.createView()  }
                ]
            }));
        }
        return inner.get(backdropTex)!;
    }

    private getBlitBindGroup(srcTexture: GPUTexture): GPUBindGroup {
        if (!this.blitBindGroupCache.has(srcTexture)) {
            this.blitBindGroupCache.set(srcTexture, this.device.createBindGroup({
                layout:  this.blitBindGroupLayout,
                entries: [
                    { binding: 0, resource: this.sampler            },
                    { binding: 1, resource: srcTexture.createView() }
                ]
            }));
        }
        return this.blitBindGroupCache.get(srcTexture)!;
    }
}
