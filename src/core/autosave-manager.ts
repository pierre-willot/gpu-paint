import type { SessionStore, SessionMeta, StoredCommandRecord, StoredCheckpointRecord } from './session-store';
import type { Command }     from './history-manager';
import type { Checkpoint }  from '../renderer/checkpoint-manager';
import type { SaveStatus }  from './event-bus';

// ── Serialisation helpers exported for app.ts restoreSession ─────────────────

export function recordToCommand(r: StoredCommandRecord): Command {
    if (r.type === 'stroke') {
        return {
            type:           'stroke',
            label:          'Brush Stroke',
            layerIndex:     r.layerIndex ?? 0,
            stamps:         r.stampsBuffer ? new Float32Array(r.stampsBuffer) : new Float32Array(),
            blendMode:      (r.blendMode ?? 'normal') as any,
            floatsPerStamp: r.floatsPerStamp ?? 12,
            timestamp:      0,
        };
    }
    if (r.type === 'add-layer') {
        return { type: 'add-layer', label: (r.label as any) ?? 'Add Layer', layerIndex: r.layerIndex ?? 0, timestamp: 0 };
    }
    if (r.type === 'cut') {
        return {
            type:       'cut',
            label:      'Cut',
            layerIndex: r.layerIndex ?? 0,
            pixels:     r.pixelsBuffer ? new Uint8Array(r.pixelsBuffer) : new Uint8Array(),
            timestamp:  0,
        };
    }
    if (r.type === 'paste') {
        return {
            type:      'paste',
            label:     'Paste',
            pixels:    r.pixelsBuffer ? new Uint8Array(r.pixelsBuffer) : new Uint8Array(),
            timestamp: 0,
        };
    }
    return { type: 'delete-layer', label: 'Delete Layer', layerIndex: r.layerIndex ?? 0, timestamp: 0 };
}

export function recordToCheckpoint(r: StoredCheckpointRecord, stackOffset: number): Checkpoint {
    return {
        stackLength:      r.stackLength + stackOffset,
        activeLayerIndex: r.activeLayerIndex,
        layers:           r.snapshots.map(s => ({
            name:      s.meta.name,
            opacity:   s.meta.opacity,
            blendMode: s.meta.blendMode,
            visible:   s.meta.visible,
            pixels:    new Uint8Array(s.dataBuffer),
        })),
    };
}

// ── AutosaveManager ───────────────────────────────────────────────────────────
//
// Tracks the undo/redo seq stack and mirrors it into IndexedDB incrementally.
// One IDB write per command append — all other ops (undo/redo/drop) update
// only the SessionMeta record.

export class AutosaveManager {
    private minSeq    = 0;
    private maxSeq    = -1;          // -1 = no commands yet
    private nextSeq   = 0;
    private checkpointStackOffset = 0;

    private canvasW   = 0;
    private canvasH   = 0;

    private saveTimer: ReturnType<typeof setInterval> | null = null;
    private readonly SAVE_INTERVAL_MS = 30_000;

    constructor(
        private store:    SessionStore,
        private onStatus: (s: SaveStatus) => void
    ) {}

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    public start(): void {
        if (this.saveTimer) return;
        this.saveTimer = setInterval(() => this.saveNow(), this.SAVE_INTERVAL_MS);
    }

    public async init(canvasW: number, canvasH: number): Promise<void> {
        this.canvasW = canvasW;
        this.canvasH = canvasH;
        await this.writeMeta();
    }

    public async clearSession(): Promise<void> {
        await this.store.clearAll();
        this.minSeq    = 0;
        this.maxSeq    = -1;
        this.nextSeq   = 0;
        this.checkpointStackOffset = 0;
    }

    public restoreState(seqStack: number[], nextSeq: number): void {
        if (seqStack.length > 0) {
            this.minSeq  = seqStack[0];
            this.maxSeq  = seqStack[seqStack.length - 1];
        }
        this.nextSeq = nextSeq;
    }

    // ── Command hooks — called from HistoryManager options ────────────────────

    public onCommandAppended(cmd: Command): void {
        const seq = this.nextSeq++;
        this.maxSeq = seq;
        if (this.minSeq < 0 || seq === 0) this.minSeq = seq;

        const record = this.commandToRecord(seq, cmd);
        this.store.appendCommand(record).catch(err =>
            console.warn('[Autosave] appendCommand failed:', err)
        );
    }

    public onCommandUndone(): void {
        if (this.maxSeq > this.minSeq) this.maxSeq--;
        // Fire-and-forget meta update
        this.writeMeta().catch(console.warn);
    }

    public onCommandRedone(): void {
        this.maxSeq++;
        this.writeMeta().catch(console.warn);
    }

    public onCommandDropped(): void {
        this.minSeq++;
        this.checkpointStackOffset++;
        this.writeMeta().catch(console.warn);
    }

    public onRedoInvalidated(): void {
        // Delete all commands with seq > current maxSeq
        if (this.maxSeq >= 0) {
            this.store.deleteCommandsAboveSeq(this.maxSeq).catch(console.warn);
            this.store.deleteCheckpointsAboveStack(this.maxSeq).catch(console.warn);
        }
        this.writeMeta().catch(console.warn);
    }

    // ── Checkpoint ────────────────────────────────────────────────────────────

    public async onCheckpointCreated(cp: Checkpoint): Promise<void> {
        const record: StoredCheckpointRecord = {
            stackLength:      cp.stackLength - this.checkpointStackOffset,
            activeLayerIndex: cp.activeLayerIndex,
            snapshots:        (cp.layers as any[]).map((l: any) => ({
                dataBuffer:  (l.pixels as Uint8Array).buffer.slice(
                    (l.pixels as Uint8Array).byteOffset,
                    (l.pixels as Uint8Array).byteOffset + (l.pixels as Uint8Array).byteLength
                ),
                bytesPerRow: l.pixels?.length ?? 0,
                meta: {
                    opacity:   l.opacity,
                    blendMode: l.blendMode,
                    visible:   l.visible,
                    name:      l.name,
                },
            })),
        };
        await this.store.putCheckpoint(record).catch(console.warn);
    }

    // ── Explicit save ─────────────────────────────────────────────────────────

    public async saveNow(): Promise<void> {
        this.onStatus({ type: 'saving' });
        try {
            await this.writeMeta();
            this.onStatus({ type: 'saved', at: Date.now() });
        } catch (err) {
            console.error('[Autosave] saveNow failed:', err);
            this.onStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        }
    }

    // ── Load ──────────────────────────────────────────────────────────────────

    public async loadSessionData(): Promise<{
        meta:        { timestamp: number; checkpointStackOffset: number };
        commands:    StoredCommandRecord[];
        checkpoints: StoredCheckpointRecord[];
    } | null> {
        try {
            const meta = await this.store.getSessionMeta();
            if (!meta) return null;
            const commands    = await this.store.loadCommandRange(meta.minSeq, meta.maxSeq);
            const checkpoints = await this.store.loadAllCheckpoints();
            return {
                meta: {
                    timestamp:             meta.timestamp,
                    checkpointStackOffset: meta.checkpointStackOffset,
                },
                commands,
                checkpoints,
            };
        } catch (err) {
            console.warn('[Autosave] loadSessionData failed:', err);
            return null;
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private async writeMeta(): Promise<void> {
        const meta: SessionMeta = {
            id:                    'meta',
            canvasWidth:           this.canvasW,
            canvasHeight:          this.canvasH,
            minSeq:                this.minSeq,
            maxSeq:                this.maxSeq,
            checkpointStackOffset: this.checkpointStackOffset,
            timestamp:             Date.now(),
            version:               1,
        };
        await this.store.updateSessionMeta(meta);
    }

    private commandToRecord(seq: number, cmd: Command): StoredCommandRecord {
        const base: StoredCommandRecord = {
            seq,
            type:  cmd.type,
            label: cmd.label,
        };
        if ('layerIndex' in cmd) base.layerIndex = cmd.layerIndex;

        if (cmd.type === 'stroke') {
            base.blendMode      = cmd.blendMode;
            base.floatsPerStamp = cmd.floatsPerStamp;
            base.stampsBuffer   = cmd.stamps.slice().buffer as ArrayBuffer;
        } else if (cmd.type === 'cut' || cmd.type === 'paste') {
            base.pixelsBuffer   = cmd.pixels.slice().buffer as ArrayBuffer;
        }
        return base;
    }
}