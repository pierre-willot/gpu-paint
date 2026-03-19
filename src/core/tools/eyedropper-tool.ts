// src/core/tools/eyedropper-tool.ts
// Reads a pixel from the composited canvas and emits it as the new brush color.
//
// Uses GPU readback (copyTextureToBuffer → mapAsync) to get the exact pixel
// displayed on screen, including all layers composited together.
//
// The readback is a single 4-byte read — fast enough not to block painting.

import type { PaintPipeline } from '../../renderer/pipeline';
import type { EventBus }      from '../event-bus';
import type { Tool }          from '../tool';
import type { BrushBlendMode } from '../../renderer/brush-descriptor';

export class EyedropperTool implements Tool {
    public readonly blendMode: BrushBlendMode = 'normal';
    public get isActive(): boolean { return false; }

    constructor(private pipeline: PaintPipeline, private bus: EventBus) {}

    onPointerDown(
        x: number, y: number, _pressure: number,
        pipeline: PaintPipeline
    ): void {
        this.sample(x, y, pipeline);
    }

    onPointerMove(
        x: number, y: number, _pressure: number,
        pipeline: PaintPipeline
    ): void {
        // Continuous sampling while dragging with the eyedropper
        this.sample(x, y, pipeline);
    }

    async onPointerUp(
        _x: number, _y: number, _pressure: number,
        _pipeline: PaintPipeline
    ): Promise<Float32Array | null> {
        return null;
    }

    renderTick(_pipeline: PaintPipeline): Float32Array {
        return new Float32Array();
    }

    getPrediction(): Float32Array {
        return new Float32Array();
    }

    reset(_pipeline: PaintPipeline): void {}

    // ── Private ───────────────────────────────────────────────────────────────

    private sample(nx: number, ny: number, pipeline: PaintPipeline): void {
        pipeline.sampleColor(nx, ny).then(color => {
            if (!color) return;
            const [r, g, b] = color;
            this.bus.emit('color:change', {
                rgb: {
                    r: Math.round(r * 255),
                    g: Math.round(g * 255),
                    b: Math.round(b * 255)
                },
                hsv: rgbToHsv(r, g, b),
                hex: rgbToHex(r, g, b)
            });
        });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
        if      (mx === r) h = 60 * (((g - b) / d) % 6);
        else if (mx === g) h = 60 * ((b - r) / d + 2);
        else               h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h: Math.round(h), s: Math.round(mx > 0 ? (d / mx) * 100 : 0), v: Math.round(mx * 100) };
}

function rgbToHex(r: number, g: number, b: number): string {
    const h = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0').toUpperCase();
    return `#${h(r)}${h(g)}${h(b)}`;
}
