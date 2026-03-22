import brushShaderSource from '../brush/brush.wgsl?raw';
import type { BrushBlendMode } from './brush-descriptor';

export type { BrushBlendMode };

// ── Stamp layout — 16 floats = 64 bytes ───────────────────────────────────────
// [x, y, pressure, size, r, g, b, a, tiltX, tiltY, opacity, stampAngle,
//  roundness, grainDepthScale, _pad0, _pad1]
export const FLOATS_PER_STAMP = 16;
export const BYTES_PER_STAMP  = FLOATS_PER_STAMP * 4; // 64

export interface BrushPipelineConfig {
    blendMode:       BrushBlendMode;
    hardness?:       number;
    grainDepth?:     number;
    grainScale?:     number;
    grainRotation?:  number;  // radians
    grainContrast?:  number;
    grainBrightness?: number;
    grainBlendMode?: number;  // 0=multiply 1=screen 2=overlay 3=normal
    grainStatic?:    boolean;
}

const BLEND_CONFIGS: Record<BrushBlendMode, GPUBlendState> = {
    normal: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one',       dstFactor: 'one-minus-src-alpha', operation: 'add' }
    },
    erase: {
        color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha', operation: 'add' }
    }
};

export class PipelineCache {
    private cache  = new Map<BrushBlendMode, GPURenderPipeline>();
    private module: GPUShaderModule;

    // Explicit bind group layout so BrushRenderer can create bind groups
    // independently of the pipeline.
    public bindGroupLayout: GPUBindGroupLayout;

    constructor(private device: GPUDevice, private format: GPUTextureFormat) {
        this.module = device.createShaderModule({ code: brushShaderSource });

        // Bind group 0 layout:
        //   binding 0 — uniform buffer (48 bytes: resolution, hardness, grain params)
        //   binding 1 — mask texture   (R8Unorm selection mask)
        //   binding 2 — mask sampler   (nearest-neighbour)
        //   binding 3 — grain texture  (rgba8unorm, repeat)
        //   binding 4 — grain sampler  (linear, repeat)
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                {
                    binding:    0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer:     { type: 'uniform' }
                },
                {
                    binding:    1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture:    { sampleType: 'float', viewDimension: '2d', multisampled: false }
                },
                {
                    binding:    2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler:    { type: 'non-filtering' }
                },
                {
                    binding:    3,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture:    { sampleType: 'float', viewDimension: '2d', multisampled: false }
                },
                {
                    binding:    4,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler:    { type: 'filtering' }
                },
                {
                    binding:    5,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture:    { sampleType: 'float', viewDimension: '2d', multisampled: false }
                },
                {
                    binding:    6,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler:    { type: 'filtering' }
                },
                {
                    binding:    7,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture:    { sampleType: 'float', viewDimension: '2d', multisampled: false }
                },
                {
                    binding:    8,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler:    { type: 'filtering' }
                }
            ]
        });

        for (const mode of Object.keys(BLEND_CONFIGS) as BrushBlendMode[]) {
            this.getOrCreate(mode);
        }
    }

    public getOrCreate(blendMode: BrushBlendMode): GPURenderPipeline {
        if (!this.cache.has(blendMode)) this.cache.set(blendMode, this.build(blendMode));
        return this.cache.get(blendMode)!;
    }

    private build(blendMode: BrushBlendMode): GPURenderPipeline {
        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.bindGroupLayout]
        });

        return this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
                module: this.module, entryPoint: 'vs_main',
                buffers: [{
                    arrayStride: BYTES_PER_STAMP,
                    stepMode:    'instance',
                    attributes: [
                        { shaderLocation: 0, offset:  0, format: 'float32x2' }, // pos
                        { shaderLocation: 1, offset:  8, format: 'float32'   }, // pressure
                        { shaderLocation: 2, offset: 12, format: 'float32'   }, // size
                        { shaderLocation: 3, offset: 16, format: 'float32x4' }, // rgba
                        { shaderLocation: 4, offset: 32, format: 'float32x2' }, // tiltX, tiltY
                        { shaderLocation: 5, offset: 40, format: 'float32'   }, // opacity
                        { shaderLocation: 6, offset: 44, format: 'float32'   }, // stampAngle
                        { shaderLocation: 7, offset: 48, format: 'float32'   }, // roundness
                        { shaderLocation: 8, offset: 52, format: 'float32'   }, // grainDepthScale
                    ]
                }]
            },
            fragment: {
                module: this.module, entryPoint: 'fs_main',
                targets: [{ format: this.format, blend: BLEND_CONFIGS[blendMode] }]
            },
            primitive: { topology: 'triangle-strip' }
        });
    }
}
