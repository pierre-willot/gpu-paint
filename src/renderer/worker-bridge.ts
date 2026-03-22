import type { BrushDescriptor } from './brush-descriptor';
import { buildDynamicsLUTs }   from './dynamics-lut';

export class WorkerBridge {
    private worker:        Worker;
    private pendingStamps: Float32Array[] = [];
    private _latestPrediction = new Float32Array();
    private _isDrawing    = false;
    private finalResolver: ((stamps: Float32Array) => void) | null = null;

    private _smoothingStrength = 0;

    get smoothingStrength(): number { return this._smoothingStrength; }
    set smoothingStrength(v: number) {
        this._smoothingStrength = v;
        this.worker.postMessage({ type: 'set_smoothing', strength: v });
    }

    get isDrawing(): boolean { return this._isDrawing; }

    constructor() {
        this.worker = new Worker(
            new URL('./stroke-worker.ts', import.meta.url),
            { type: 'module' }
        );

        this.worker.onmessage = (e: MessageEvent) => {
            const msg = e.data;
            switch (msg.type) {
                case 'stamps':
                    if ((msg.data as Float32Array).length > 0)
                        this.pendingStamps.push(msg.data as Float32Array);
                    break;
                case 'prediction':
                    this._latestPrediction = msg.data as Float32Array;
                    break;
                case 'final': {
                    this._isDrawing = false;
                    if (this.finalResolver) {
                        const finalBatch = msg.data as Float32Array;
                        const pending    = this.drainPending();
                        let merged: Float32Array;
                        if      (pending.length    === 0) merged = finalBatch;
                        else if (finalBatch.length === 0) merged = pending;
                        else {
                            merged = new Float32Array(pending.length + finalBatch.length);
                            merged.set(pending, 0);
                            merged.set(finalBatch, pending.length);
                        }
                        this.finalResolver(merged);
                        this.finalResolver = null;
                    }
                    break;
                }
            }
        };

        this.worker.onerror = (err) => {
            console.error('[WorkerBridge] Worker error:', err);
            this.finalResolver?.(new Float32Array());
            this.finalResolver = null;
            this._isDrawing    = false;
        };
    }

    // ── Descriptor API ────────────────────────────────────────────────────────

    /**
     * Sends the full BrushDescriptor to the worker.
     * Call whenever any brush property changes — the worker uses it for all
     * subsequent stamps. Descriptor is structured-cloned by postMessage.
     */
    setDescriptor(descriptor: BrushDescriptor): void {
        this.worker.postMessage({ type: 'set_descriptor', descriptor });
        // Auto-build and transfer dynamics LUTs so the worker has them in sync.
        this.sendDynamicsLUTs(descriptor);
    }

    private sendDynamicsLUTs(d: BrushDescriptor): void {
        const packed = buildDynamicsLUTs(d);
        this.worker.postMessage({ type: 'set_dynamics_luts', packed }, [packed.buffer]);
    }

    setPressureLUT(lut: Float32Array): void {
        this.worker.postMessage({ type: 'set_pressure_lut', lut }, [lut.buffer]);
    }

    // ── Stroke API ────────────────────────────────────────────────────────────
    // beginStroke no longer takes size/color — those come from the descriptor.

    beginStroke(x: number, y: number, pressure: number, tiltX = 0, tiltY = 0): void {
        this._isDrawing        = true;
        this.pendingStamps     = [];
        this._latestPrediction = new Float32Array();
        this.worker.postMessage({ type: 'begin', x, y, pressure, tiltX, tiltY });
    }

    addPoint(x: number, y: number, pressure: number, tiltX = 0, tiltY = 0): void {
        this.worker.postMessage({ type: 'move', x, y, pressure, tiltX, tiltY });
    }

    flush(): Float32Array { return this.drainPending(); }

    endStrokeAndFlush(): Promise<Float32Array> {
        return new Promise((resolve) => {
            if (this.finalResolver) {
                console.warn('[WorkerBridge] endStrokeAndFlush called while already finalizing');
                resolve(new Float32Array());
                return;
            }
            this.finalResolver = resolve;
            this.worker.postMessage({ type: 'flush_final' });
        });
    }

    getPredictedStamps(): Float32Array {
        this.worker.postMessage({ type: 'predict' });
        return this._latestPrediction;
    }

    reset(): void {
        this._isDrawing    = false;
        this.pendingStamps = [];
        this.finalResolver?.(new Float32Array());
        this.finalResolver = null;
        this.worker.postMessage({ type: 'reset' });
    }

    destroy(): void {
        this.finalResolver?.(new Float32Array());
        this.finalResolver = null;
        this.worker.terminate();
    }

    private drainPending(): Float32Array {
        if (this.pendingStamps.length === 0) return new Float32Array();
        if (this.pendingStamps.length === 1) {
            const s = this.pendingStamps[0]; this.pendingStamps = []; return s;
        }
        const total  = this.pendingStamps.reduce((s, a) => s + a.length, 0);
        const merged = new Float32Array(total);
        let   offset = 0;
        for (const chunk of this.pendingStamps) { merged.set(chunk, offset); offset += chunk.length; }
        this.pendingStamps = [];
        return merged;
    }
}
