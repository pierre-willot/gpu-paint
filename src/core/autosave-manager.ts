import { SessionStore, SessionMeta, StoredCommandRecord, StoredCheckpointRecord } from './session-store';
import { Command }    from './history-manager';
import { SaveStatus } from './event-bus';

// ── Checkpoint shape (matches checkpoint-manager.ts exported interface) ───────
export interface PersistedCheckpoint {
    stackLength:      number;
    activeLayerIndex: number;
    snapshots: Array<{
        data:        Uint8Array;
        bytesPerRow: number;
        meta: {
            opacity:   number;
            blendMode: string;
            visible:   boolean;
            name:      string;
        };
    }>;
}

// ── AutosaveManager ───────────────────────────────────────────────────────────
//
// Owns the mapping between HistoryManager's undo stack and IndexedDB.
//
// Design principle: every undo-stack mutation produces exactly one IDB operation:
//   - New command    → appendCommand()          (one insert)
//   - Oldest dropped → deleteCommand(oldestSeq) (one delete)
//   - Redo cleared   → deleteCommandsAboveSeq() (range delete)
//   - Undo           → nothing (command stays valid, just inactive)
//   - Redo           → nothing (command restored from redo stack, seq reused)
//
// This means the IDB commands store always mirrors the current undo stack.
// Queries are bounded by history size (~200 commands × ~30 KB = ~6 MB typical).

export class AutosaveManager {
    // seqStack[i] = seq number for undoStack[i], always same length as undoStack
    private seqStack:      number[] = [];
    // redoSeqStack[i] = seq number for redoStack[i] — kept so redo invalidation
    // knows exactly which IDB records to delete
    private redoSeqStack:  number[] = [];
    private nextSeq:       number   = 0;

    // checkpointStackOffset: incremented each time oldest command is dropped.
    // Applied to loaded checkpoint stackLengths during restore so they map
    // correctly to the current (trimmed) command sequence.
    private checkpointStackOffset: number = 0;

    // Pending fire-and-forget IDB operations — awaited in saveNow() to guarantee
    // metadata is written after all command data is flushed.
    private pendingOps: Promise<void>[] = [];

    private intervalId:  number | null = null;
    private isSaving:    boolean        = false;

    private canvasWidth:  number = 0;
    private canvasHeight: number = 0;

    constructor(
        private store:    SessionStore,
        private onStatus: (s: SaveStatus) => void
    ) {}

    // ─────────────────────────────────────────────────────────────────────────
    // INIT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called once after GPU init. Writes initial session metadata so subsequent
     * page loads can detect a session before any commands are recorded.
     */
    async init(canvasWidth: number, canvasHeight: number): Promise<void> {
        this.canvasWidth  = canvasWidth;
        this.canvasHeight = canvasHeight;
        await this.flushMeta();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HISTORY HOOKS — called by HistoryManager options
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called after a new command is pushed to the undo stack.
     * Assigns a seq number, writes the record to IDB fire-and-forget.
     */
    onCommandAppended(cmd: Command): void {
        const seq = this.nextSeq++;
        this.seqStack.push(seq);

        const record = this.commandToRecord(seq, cmd);
        this.fireAndForget(
            this.store.appendCommand(record)
        );
    }

    /**
     * Called when the oldest command is dropped from the undo stack.
     * Removes the IDB record and increments the checkpoint offset so
     * loaded checkpoint stackLengths map correctly on restore.
     */
    onCommandDropped(): void {
        const seq = this.seqStack.shift();
        if (seq === undefined) return;

        this.checkpointStackOffset++;
        this.fireAndForget(
            this.store.deleteCommand(seq)
        );
    }

    /**
     * Called when a new command after undo invalidates the redo stack.
     * Deletes all redo commands from IDB and removes stale checkpoints.
     */
    onRedoInvalidated(): void {
        if (this.redoSeqStack.length === 0) return;

        // Delete all redo command records
        const cutoff = this.seqStack.length > 0
            ? this.seqStack[this.seqStack.length - 1]
            : -1;

        this.fireAndForget(
            this.store.deleteCommandsAboveSeq(cutoff)
        );

        // Delete checkpoints that were above the new stack top
        this.fireAndForget(
            this.store.deleteCheckpointsAboveStack(this.seqStack.length)
        );

        this.redoSeqStack = [];
    }

    /**
     * Called when undo moves a command from undoStack to redoStack.
     * Nothing in IDB changes — we just track the seq for future redo/invalidation.
     */
    onCommandUndone(): void {
        const seq = this.seqStack.pop();
        if (seq !== undefined) this.redoSeqStack.push(seq);
    }

    /**
     * Called when redo moves a command back from redoStack to undoStack.
     */
    onCommandRedone(): void {
        const seq = this.redoSeqStack.pop();
        if (seq !== undefined) this.seqStack.push(seq);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CHECKPOINT HOOK — called by CheckpointManager
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Persists a checkpoint to IDB. Called by CheckpointManager.onCheckpointSaved.
     * The compressed snapshot data is stored as detached ArrayBuffers.
     */
    async onCheckpointCreated(cp: PersistedCheckpoint): Promise<void> {
        const record: StoredCheckpointRecord = {
            stackLength:      cp.stackLength,
            activeLayerIndex: cp.activeLayerIndex,
            snapshots: cp.snapshots.map(s => ({
                // Slice to get an independent ArrayBuffer — the source Uint8Array
                // may share a buffer that gets unmapped after this call
                dataBuffer:  s.data.buffer.slice(s.data.byteOffset, s.data.byteOffset + s.data.byteLength),
                bytesPerRow: s.bytesPerRow,
                meta:        { ...s.meta }
            }))
        };
        await this.store.putCheckpoint(record);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERVAL + EXPLICIT SAVE
    // ─────────────────────────────────────────────────────────────────────────

    /** Starts the 30-second background metadata flush. */
    start(): void {
        if (this.intervalId !== null) return;
        this.intervalId = window.setInterval(() => {
            this.flushMeta().catch(err => console.warn('[Autosave] interval flush failed:', err));
        }, 30_000);
    }

    stop(): void {
        if (this.intervalId !== null) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    /**
     * Immediate save — Ctrl+S and save button.
     * Waits for all pending fire-and-forget writes, then flushes metadata.
     * Reports status via onStatus callback (wired to EventBus in app.ts).
     */
    async saveNow(): Promise<void> {
        if (this.isSaving) return;
        this.isSaving = true;
        this.onStatus({ type: 'saving' });

        try {
            // Flush all incremental writes before writing metadata
            await Promise.all(this.pendingOps);
            this.pendingOps = [];

            await this.flushMeta();
            this.onStatus({ type: 'saved', at: Date.now() });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.onStatus({ type: 'error', message });
            console.error('[Autosave] saveNow failed:', err);
        } finally {
            this.isSaving = false;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RESTORE HELPERS — called during session restore in main.ts
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Reconstructs the seq tracking state after restoring a session from IDB.
     * Must be called after the undo stack is rebuilt from loaded commands.
     */
    restoreState(seqStack: number[], nextSeq: number): void {
        this.seqStack      = [...seqStack];
        this.redoSeqStack  = [];
        this.nextSeq       = nextSeq;
        this.checkpointStackOffset = 0; // reset after restore
    }

    /**
     * Loads all stored commands and checkpoints from IDB for restore.
     * Returns null if no session exists.
     */
    async loadSessionData(): Promise<{
        meta:        SessionMeta;
        commands:    StoredCommandRecord[];
        checkpoints: StoredCheckpointRecord[];
    } | null> {
        const meta = await this.store.getSessionMeta();
        if (!meta || meta.maxSeq < meta.minSeq) return null;

        const [commands, checkpoints] = await Promise.all([
            this.store.loadCommandRange(meta.minSeq, meta.maxSeq),
            this.store.loadAllCheckpoints()
        ]);

        return { meta, commands, checkpoints };
    }

    async clearSession(): Promise<void> {
        await this.store.clearAll();
        this.seqStack      = [];
        this.redoSeqStack  = [];
        this.nextSeq       = 0;
        this.checkpointStackOffset = 0;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PRIVATE
    // ─────────────────────────────────────────────────────────────────────────

    private fireAndForget(p: Promise<void>): void {
        const wrapped = p.catch(err => console.warn('[Autosave] write failed:', err));
        this.pendingOps.push(wrapped);
        // Auto-remove when settled so the array doesn't grow unbounded
        wrapped.finally(() => {
            const idx = this.pendingOps.indexOf(wrapped);
            if (idx !== -1) this.pendingOps.splice(idx, 1);
        });
    }

    private async flushMeta(): Promise<void> {
        const meta: SessionMeta = {
            id:                    'meta',
            canvasWidth:           this.canvasWidth,
            canvasHeight:          this.canvasHeight,
            minSeq:                this.seqStack[0]                          ?? 0,
            maxSeq:                this.seqStack[this.seqStack.length - 1]   ?? -1,
            checkpointStackOffset: this.checkpointStackOffset,
            timestamp:             Date.now(),
            version:               1
        };
        await this.store.updateSessionMeta(meta);
    }

    private commandToRecord(seq: number, cmd: Command): StoredCommandRecord {
        const record: StoredCommandRecord = {
            seq,
            type:       cmd.type,
            label:      cmd.label,
            layerIndex: cmd.layerIndex
        };

        if (cmd.type === 'stroke') {
            record.blendMode      = cmd.blendMode;
            record.floatsPerStamp = cmd.floatsPerStamp;
            // Slice to detach from any shared buffer
            const s = cmd.stamps;
            record.stampsBuffer = s.buffer.slice(s.byteOffset, s.byteOffset + s.byteLength);
        }

        return record;
    }
}

// ── Serialization helpers (used during restore) ───────────────────────────────

/** Reconstructs a Command from a stored IDB record. */
export function recordToCommand(record: StoredCommandRecord): Command {
    if (record.type === 'stroke') {
        return {
            type:           'stroke',
            label:          'Brush Stroke',
            layerIndex:     record.layerIndex,
            blendMode:      record.blendMode as any,
            floatsPerStamp: record.floatsPerStamp ?? 8,
            stamps:         new Float32Array(record.stampsBuffer!)
        };
    } else if (record.type === 'add-layer') {
        return {
            type:       'add-layer',
            label:      record.label as 'Add Layer' | 'Initial Layer',
            layerIndex: record.layerIndex
        };
    } else {
        return {
            type:       'delete-layer',
            label:      'Delete Layer',
            layerIndex: record.layerIndex
        };
    }
}

/** Reconstructs a PersistedCheckpoint from a StoredCheckpointRecord. */
export function recordToCheckpoint(
    record: StoredCheckpointRecord,
    stackOffset: number
): PersistedCheckpoint {
    return {
        // Adjust stackLength by the cumulative oldest-drop offset so it maps
        // correctly to the current (trimmed) command sequence on restore
        stackLength:      record.stackLength - stackOffset,
        activeLayerIndex: record.activeLayerIndex,
        snapshots: record.snapshots.map(s => ({
            data:        new Uint8Array(s.dataBuffer),
            bytesPerRow: s.bytesPerRow,
            meta:        { ...s.meta }
        }))
    };
}
