export type SelectionOperation = 'rect' | 'lasso' | 'selectAll' | 'deselect' | 'invertSelection';

export type Command =
    | {
        type:           'stroke';
        label:          'Brush Stroke';
        layerIndex:     number;
        beforePixels:   Uint8Array;   // packed RGBA full-layer snapshot before stroke
        afterPixels:    Uint8Array;   // packed RGBA full-layer snapshot after stroke
        timestamp:      number;
      }
    | { type: 'add-layer';    label: 'Add Layer' | 'Initial Layer'; layerIndex: number; timestamp: number; }
    | { type: 'delete-layer'; label: 'Delete Layer';                layerIndex: number; timestamp: number; }
    | {
        type:       'selection';
        label:      'Selection';
        operation:  SelectionOperation;  // kept for display/logging only
        beforeMask: Uint8Array | null;   // null = no selection; R8 mask data (w×h bytes)
        afterMask:  Uint8Array | null;
        maskWidth:  number;
        maskHeight: number;
        timestamp:  number;
      }
    | {
        type:         'cut';
        label:        'Cut';
        layerIndex:   number;
        beforePixels: Uint8Array;
        afterPixels:  Uint8Array;
        timestamp:    number;
      }
    | {
        type:      'paste';
        label:     'Paste';
        pixels:    Uint8Array;   // pasted layer RGBA (for redo/replay)
        timestamp: number;
      }
    | {
        type:         'smudge';
        label:        'Smudge Stroke';
        layerIndex:   number;
        beforePixels: Uint8Array;
        afterPixels:  Uint8Array;
        timestamp:    number;
      }
    | {
        type:         'transform';
        label:        'Transform';
        layerIndex:   number;
        beforePixels: Uint8Array;
        afterPixels:  Uint8Array;
        timestamp:    number;
      };

const MAX_HISTORY_COUNT = 200;
const MAX_HISTORY_BYTES = 256 * 1024 * 1024; // 256 MB — before+after pixels use more than stamps
const CHECKPOINT_INTERVAL = 10;

function commandBytes(cmd: Command): number {
    if (cmd.type === 'stroke')    return cmd.beforePixels.byteLength + cmd.afterPixels.byteLength;
    if (cmd.type === 'smudge')    return cmd.beforePixels.byteLength + cmd.afterPixels.byteLength;
    if (cmd.type === 'cut')       return cmd.beforePixels.byteLength + cmd.afterPixels.byteLength;
    if (cmd.type === 'transform') return cmd.beforePixels.byteLength + cmd.afterPixels.byteLength;
    if (cmd.type === 'paste')   return cmd.pixels.byteLength;
    if (cmd.type === 'selection') return (cmd.beforeMask?.byteLength ?? 0) + (cmd.afterMask?.byteLength ?? 0);
    return 0;
}

/** True for commands with direct before/after state — no full replay needed. */
function supportsDirectUndoRedo(cmd: Command): boolean {
    return cmd.type === 'stroke' || cmd.type === 'smudge' || cmd.type === 'cut' ||
           cmd.type === 'selection' || cmd.type === 'transform';
}

export interface HistoryManagerOptions {
    onCheckpointNeeded?:     (stackLength: number) => void;
    onOldestCommandDropped?: () => void;
    onRedoInvalidated?:      (newStackLength: number) => void;
    onCommandAppended?:      (cmd: Command) => void;
    onCommandUndone?:        () => void;
    onCommandRedone?:        () => void;
}

export class HistoryManager {
    private undoStack:        Command[] = [];
    private redoStack:        Command[] = [];
    private totalBytes:       number    = 0;
    private sessionStartTime: number    = performance.now();

    constructor(
        private onNewCommand:  (cmd: Command) => Promise<void>,
        private onReplay:      (log: Command[]) => Promise<void>,
        private onDirectUndo:  (cmd: Command) => Promise<void>,
        private onDirectRedo:  (cmd: Command) => Promise<void>,
        private options:       HistoryManagerOptions = {}
    ) {}

    /** ms since session start — stamp every outgoing command with this. */
    public now(): number {
        return performance.now() - this.sessionStartTime;
    }

    public async execute(command: Command): Promise<void> {
        this.undoStack.push(command);
        this.totalBytes += commandBytes(command);

        if (this.redoStack.length > 0) {
            this.redoStack.forEach(c => { this.totalBytes -= commandBytes(c); });
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
        if (supportsDirectUndoRedo(cmd)) {
            await this.onDirectUndo(cmd);
        } else {
            await this.onReplay(this.undoStack);
        }
    }

    public async redo(): Promise<void> {
        if (!this.canRedo()) return;
        const cmd = this.redoStack.pop()!;
        this.undoStack.push(cmd);
        this.totalBytes += commandBytes(cmd);
        this.options.onCommandRedone?.();
        if (supportsDirectUndoRedo(cmd)) {
            await this.onDirectRedo(cmd);
        } else {
            await this.onReplay(this.undoStack);
        }
    }

    /** Rebuilds the undo stack from persisted data without firing hooks. */
    public restoreUndoStack(commands: Command[]): void {
        this.undoStack  = commands.map(c => ('timestamp' in c ? c : { ...(c as object), timestamp: 0 }) as Command);
        this.redoStack  = [];
        this.totalBytes = commands.reduce((s, c) => s + commandBytes(c), 0);
    }

    public canUndo():  boolean     { return this.undoStack.length > 1; }
    public canRedo():  boolean     { return this.redoStack.length > 0; }
    public getHistory(): Command[] { return this.undoStack;            }
    public get memoryBytes(): number { return this.totalBytes;         }
}
