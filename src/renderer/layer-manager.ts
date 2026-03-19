export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay';

export interface LayerState {
    texture:   GPUTexture;
    opacity:   number;      // 0.0–1.0
    blendMode: BlendMode;
    visible:   boolean;
    name:      string;
    locked:    boolean;     // prevents painting on this layer
    alphaLock: boolean;     // paint only into existing alpha areas (GPU side in Tier C)
}

export class LayerManager {
    public layers:           LayerState[] = [];
    public activeLayerIndex: number       = 0;
    private layerCount                    = 0;

    constructor(
        private device: GPUDevice,
        private format: GPUTextureFormat,
        public  width:  number,
        public  height: number
    ) {}

    // ── Layer lifecycle ───────────────────────────────────────────────────────

    public addLayer(): LayerState {
        const texture = this.device.createTexture({
            size:   [this.width, this.height],
            format: this.format,
            usage:
                GPUTextureUsage.RENDER_ATTACHMENT |
                GPUTextureUsage.TEXTURE_BINDING   |
                GPUTextureUsage.COPY_SRC          |
                GPUTextureUsage.COPY_DST
        });
        this.clearTexture(texture);
        this.layerCount++;

        const state: LayerState = {
            texture,
            opacity:   1.0,
            blendMode: 'normal',
            visible:   true,
            name:      `Layer ${this.layerCount}`,
            locked:    false,
            alphaLock: false,
        };
        this.layers.push(state);
        this.activeLayerIndex = this.layers.length - 1;
        return state;
    }

    public getActiveLayer(): LayerState | null {
        return this.layers[this.activeLayerIndex] ?? null;
    }

    public clearLayer(index: number): void {
        const layer = this.layers[index];
        if (layer) this.clearTexture(layer.texture);
    }

    public removeLayer(index: number): void {
        if (this.layers.length <= 1) return;
        this.layers[index]?.texture.destroy();
        this.layers.splice(index, 1);
        this.activeLayerIndex = Math.min(this.activeLayerIndex, this.layers.length - 1);
    }

    /**
     * Moves a layer from one index to another.
     * Keeps activeLayerIndex pointing at the same layer after the move.
     */
    public reorderLayer(fromIndex: number, toIndex: number): void {
        if (fromIndex === toIndex) return;
        const n = this.layers.length;
        if (fromIndex < 0 || fromIndex >= n || toIndex < 0 || toIndex >= n) return;

        const [layer] = this.layers.splice(fromIndex, 1);
        this.layers.splice(toIndex, 0, layer);

        // Keep active index pointing at the same layer
        const ai = this.activeLayerIndex;
        if      (ai === fromIndex)                      this.activeLayerIndex = toIndex;
        else if (fromIndex < toIndex && ai > fromIndex && ai <= toIndex) this.activeLayerIndex--;
        else if (fromIndex > toIndex && ai < fromIndex && ai >= toIndex) this.activeLayerIndex++;
    }

    public destroyAll(): void {
        this.layers.forEach(l => l.texture.destroy());
        this.layers           = [];
        this.activeLayerIndex = 0;
    }

    // ── State setters — all range-guarded ─────────────────────────────────────

    public setOpacity(index: number, opacity: number): LayerState | null {
        const l = this.layers[index]; if (!l) return null;
        l.opacity = Math.max(0, Math.min(1, opacity)); return l;
    }

    public setBlendMode(index: number, mode: BlendMode): LayerState | null {
        const l = this.layers[index]; if (!l) return null;
        l.blendMode = mode; return l;
    }

    public setVisible(index: number, visible: boolean): LayerState | null {
        const l = this.layers[index]; if (!l) return null;
        l.visible = visible; return l;
    }

    public setName(index: number, name: string): LayerState | null {
        const l = this.layers[index]; if (!l) return null;
        l.name = name.trim() || l.name; return l;
    }

    public setLocked(index: number, locked: boolean): LayerState | null {
        const l = this.layers[index]; if (!l) return null;
        l.locked = locked; return l;
    }

    public setAlphaLock(index: number, alphaLock: boolean): LayerState | null {
        const l = this.layers[index]; if (!l) return null;
        l.alphaLock = alphaLock; return l;
    }

    // ── Texture utilities ─────────────────────────────────────────────────────

    public clearTexture(
        texture: GPUTexture,
        color: GPUColorDict = { r: 0, g: 0, b: 0, a: 0 }
    ): void {
        const encoder = this.device.createCommandEncoder();
        const pass    = encoder.beginRenderPass({
            colorAttachments: [{
                view: texture.createView(), loadOp: 'clear', clearValue: color, storeOp: 'store'
            }]
        });
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }
}
