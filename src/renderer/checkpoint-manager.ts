import { LayerManager, LayerState, BlendMode } from './layer-manager';

export const MAX_CHECKPOINTS = 20;

// ── Exported interfaces ───────────────────────────────────────────────────────

export interface LayerMeta {
    opacity:   number;
    blendMode: string;
    visible:   boolean;
    name:      string;
}

export interface LayerSnapshot {
    data:        Uint8Array;
    bytesPerRow: number;
    meta:        LayerMeta;
}

export interface Checkpoint {
    stackLength:      number;
    snapshots:        LayerSnapshot[];
    activeLayerIndex: number;
}

// ── Compression helpers ───────────────────────────────────────────────────────

async function compress(data: Uint8Array): Promise<Uint8Array> {
    if (typeof CompressionStream === 'undefined') return data;
    const cs = new CompressionStream('deflate-raw');
    const w  = cs.writable.getWriter();
    w.write(data); w.close();
    return collectStream(cs.readable);
}

async function decompress(data: Uint8Array): Promise<Uint8Array> {
    if (typeof DecompressionStream === 'undefined') return data;
    const ds = new DecompressionStream('deflate-raw');
    const w  = ds.writable.getWriter();
    w.write(data); w.close();
    return collectStream(ds.readable);
}

async function collectStream(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const reader = readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total  = chunks.reduce((s, c) => s + c.byteLength, 0);
    const result = new Uint8Array(total);
    let offset   = 0;
    for (const c of chunks) { result.set(c, offset); offset += c.byteLength; }
    return result;
}

// ── CheckpointManager ─────────────────────────────────────────────────────────

export class CheckpointManager {
    private checkpoints: Checkpoint[] = [];

    /**
     * Called after a checkpoint is stored in memory.
     * AutosaveManager wires this to persist the checkpoint to IndexedDB.
     */
    public onCheckpointSaved?: (cp: Checkpoint) => Promise<void>;

    async save(
        stackLength:      number,
        layers:           LayerState[],
        device:           GPUDevice,
        width:            number,
        height:           number,
        activeLayerIndex: number
    ): Promise<void> {
        if (this.checkpoints.some(c => c.stackLength === stackLength)) return;

        try {
            const snapshots: LayerSnapshot[] = [];

            for (const layer of layers) {
                const { compressed, bytesPerRow } =
                    await this.readTexture(device, layer.texture, width, height);
                snapshots.push({
                    data: compressed, bytesPerRow,
                    meta: {
                        opacity:   layer.opacity,
                        blendMode: layer.blendMode,
                        visible:   layer.visible,
                        name:      layer.name
                    }
                });
            }

            const checkpoint: Checkpoint = { stackLength, snapshots, activeLayerIndex };
            this.checkpoints.push(checkpoint);
            this.checkpoints.sort((a, b) => a.stackLength - b.stackLength);
            while (this.checkpoints.length > MAX_CHECKPOINTS) this.checkpoints.shift();

            if (this.onCheckpointSaved) {
                this.onCheckpointSaved(checkpoint).catch(err =>
                    console.warn('[CheckpointManager] persist failed:', err)
                );
            }

        } catch (err) {
            console.warn('[CheckpointManager] save failed:', err);
        }
    }

    findNearest(targetLength: number): Checkpoint | null {
        let best: Checkpoint | null = null;
        for (const cp of this.checkpoints) {
            if (cp.stackLength <= targetLength) best = cp;
            else break;
        }
        return best;
    }

    async restore(
        checkpoint:   Checkpoint,
        layerManager: LayerManager,
        device:       GPUDevice,
        width:        number,
        height:       number
    ): Promise<void> {
        layerManager.destroyAll();

        for (const snapshot of checkpoint.snapshots) {
            const layerState = layerManager.addLayer();
            await this.writeTexture(device, snapshot, layerState.texture, width, height);
            layerState.opacity   = snapshot.meta.opacity;
            layerState.blendMode = snapshot.meta.blendMode as BlendMode;
            layerState.visible   = snapshot.meta.visible;
            layerState.name      = snapshot.meta.name;
        }

        layerManager.activeLayerIndex = Math.min(
            checkpoint.activeLayerIndex,
            layerManager.layers.length - 1
        );
    }

    /**
     * Replaces all in-memory checkpoints with persisted data from IDB.
     * Called during session restore before reconstructFromHistory.
     */
    loadFromPersisted(checkpoints: Checkpoint[]): void {
        this.checkpoints = [...checkpoints].sort((a, b) => a.stackLength - b.stackLength);
    }

    shiftDown(): void {
        this.checkpoints = this.checkpoints
            .map(cp => ({ ...cp, stackLength: cp.stackLength - 1 }))
            .filter(cp => cp.stackLength > 0);
    }

    pruneAbove(targetLength: number): void {
        this.checkpoints = this.checkpoints.filter(cp => cp.stackLength <= targetLength);
    }

    clear(): void { this.checkpoints = []; }

    // ── Private GPU I/O ───────────────────────────────────────────────────────

    private async readTexture(
        device: GPUDevice, texture: GPUTexture, width: number, height: number
    ): Promise<{ compressed: Uint8Array; bytesPerRow: number }> {
        const bpp         = texture.format === 'rgba16float' ? 8 : 4;
        const bytesPerRow = Math.ceil(width * bpp / 256) * 256;
        const readBuffer  = device.createBuffer({
            size:  bytesPerRow * height,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture }, { buffer: readBuffer, bytesPerRow }, [width, height]);
        device.queue.submit([enc.finish()]);

        await readBuffer.mapAsync(GPUMapMode.READ);
        const data = new Uint8Array(new Uint8Array(readBuffer.getMappedRange()));
        readBuffer.unmap();
        readBuffer.destroy();

        return { compressed: await compress(data), bytesPerRow };
    }

    private async writeTexture(
        device: GPUDevice, snapshot: LayerSnapshot,
        texture: GPUTexture, width: number, height: number
    ): Promise<void> {
        const pixels  = await decompress(snapshot.data);
        const staging = device.createBuffer({
            size:  pixels.byteLength,
            usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        device.queue.writeBuffer(staging, 0, pixels);

        const enc = device.createCommandEncoder();
        enc.copyBufferToTexture(
            { buffer: staging, bytesPerRow: snapshot.bytesPerRow },
            { texture }, [width, height]
        );
        device.queue.submit([enc.finish()]);
        staging.destroy();
    }
}
