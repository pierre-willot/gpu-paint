import type { BrushBlendMode } from '../renderer/brush-descriptor';

// ── Command type ──────────────────────────────────────────────────────────────
// timestamp: ms since session start via history.now().
// Used by TimelapseRecorder for replay at correct relative speed.
// Old sessions without timestamp are patched to 0 in restoreUndoStack().

export type Command =
    | {
        type:           'stroke';
        label:          'Brush Stroke';
        layerIndex:     number;
        stamps:         Float32Array;
        blendMode:      BrushBlendMode;
        floatsPerStamp: number;
        timestamp:      number;
        /**
         * Snapshot of the CPU selection mask that was active when this stroke
         * was committed. null = no selection (paint everywhere).
         *
         * Strokes painted under the same selection share the SAME Uint8Array
         * reference — the pipeline uses identity comparison (===) during replay
         * to avoid redundant GPU uploads.
         */
        selectionMask:  Uint8Array | null;
      }
    | { type: 'add-layer';    label: 'Add Layer' | 'Initial Layer'; layerIndex: number; timestamp: number; }
    | { type: 'delete-layer'; label: 'Delete Layer';                layerIndex: number; timestamp: number; };

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HISTORY_COUNT   = 200;
const MAX_HISTORY_BYTES   = 128 * 1024 * 1024;
const CHECKPOINT_INTERVAL = 10;

function commandBytes(cmd: Command): number {
    return cmd.type === 'stroke' ? cmd.stamps.byteLength : 0;
}

// ── Options ───────────────────────────────────────────────────────────────────

export interface HistoryManagerOptions {
    onCheckpointNeeded?:     (stackLength: number) => void;
    onOldestCommandDropped?: () => void;
    onRedoInvalidated?:      (newStackLength: number) => void;
    onCommandAppended?:      (cmd: Command) => void;
    onCommandUndone?:        () => void;
    onCommandRedone?:        () => void;
}

// ── HistoryManager ────────────────────────────────────────────────────────────

export class HistoryManager {
    private undoStack:        Command[] = [];
    private redoStack:        Command[] = [];
    private totalBytes:       number    = 0;
    private sessionStartTime: number    = performance.now();

    constructor(
        private onNewCommand: (cmd: Command) => Promise<void>,
        private onReplay:     (log: Command[]) => Promise<void>,
        private options:      HistoryManagerOptions = {}
    ) {}

    /**
     * Returns milliseconds elapsed since this HistoryManager was created.
     * Used to stamp outgoing commands with a session-relative timestamp.
     */
    public now(): number {
        return performance.now() - this.sessionStartTime;
    }

    public async execute(command: Command): Promise<void> {
        this.undoStack.push(command);
        this.totalBytes += commandBytes(command);

        if (this.redoStack.length > 0) {
            this.redoStack.forEach(cmd => { this.totalBytes -= commandBytes(cmd); });
            this.redoStack = [];
            this.options.onRedoInvalidated?.(this.undoStack.length);
        }

        while (
            this.undoStack.length > 1 &&
            (this.undoStack.length > MAX_HISTORY_COUNT || this.totalBytes > MAX_HISTORY_BYTES)
        ) {
            const dropped = this.undoStack.shift()!;
            this.totalBytes -= commandBytes(dropped);
            this.options.onOldestCommandDropped?.();
        }

        this.options.onCommandAppended?.(command);

        if (this.undoStack.length % CHECKPOINT_INTERVAL === 0) {
            this.options.onCheckpointNeeded?.(this.undoStack.length);
        }

        await this.onNewCommand(command);
    }

    public async undo(): Promise<void> {
        if (!this.canUndo()) return;
        const cmd = this.undoStack.pop()!;
        this.totalBytes -= commandBytes(cmd);
        this.redoStack.push(cmd);
        this.options.onCommandUndone?.();
        await this.onReplay(this.undoStack);
    }

    public async redo(): Promise<void> {
        if (!this.canRedo()) return;
        const cmd = this.redoStack.pop()!;
        this.undoStack.push(cmd);
        this.totalBytes += commandBytes(cmd);
        this.options.onCommandRedone?.();
        await this.onReplay(this.undoStack);
    }

    /**
     * Rebuilds the undo stack from persisted data without firing any hooks.
     * Patches missing timestamp fields to 0 for backward compatibility.
     */
    public restoreUndoStack(commands: Command[]): void {
        this.undoStack  = commands.map(cmd =>
            'timestamp' in cmd ? cmd : { ...cmd, timestamp: 0 } as Command
        );
        this.redoStack  = [];
        this.totalBytes = commands.reduce((s, c) => s + commandBytes(c), 0);
    }

    public canUndo():  boolean    { return this.undoStack.length > 1;  }
    public canRedo():  boolean    { return this.redoStack.length > 0;  }
    public getHistory(): Command[] { return this.undoStack;             }
    public get memoryBytes(): number { return this.totalBytes;          }
}