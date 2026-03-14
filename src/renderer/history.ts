export type Command = 
  | { type: 'stroke'; layerIndex: number; stamps: Float32Array }
  | { type: 'add-layer'; layerIndex: number }
  | { type: 'delete-layer'; layerIndex: number; }; // Note: Real apps store deleted texture data here, but for now we'll handle state reconstruction.

export class UndoManager {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private maxHistory = 50;

  public push(command: Command) {
    this.undoStack.push(command);
    this.redoStack = []; 
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
  }

  public undo(): boolean {
    const cmd = this.undoStack.pop();
    if (cmd) {
      this.redoStack.push(cmd);
      return true;
    }
    return false;
  }

  public redo(): boolean {
    const cmd = this.redoStack.pop();
    if (cmd) {
      this.undoStack.push(cmd);
      return true;
    }
    return false;
  }

  public getHistory(): Command[] {
    return this.undoStack;
  }

  public canUndo() { return this.undoStack.length > 0; }
  public canRedo() { return this.redoStack.length > 0; }
}