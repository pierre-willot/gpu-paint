import { PaintApp }   from '../core/app';
import { SaveStatus } from '../core/event-bus';
import type { Tool }  from '../core/tool';

export class ToolbarUI {
    private undoBtn:    HTMLButtonElement | null;
    private redoBtn:    HTMLButtonElement | null;
    private saveStatus: HTMLElement | null;
    private brushDot:   HTMLElement | null;

    private savedAt:            number | null = null;
    private relativeIntervalId: number | null = null;

    private fileInput: HTMLInputElement;

    // Alt-key temporary eyedropper
    private altEyedropperActive = false;
    private altPreviousTool: Tool | null = null;

    /** Called when any tool button is clicked while that tool is already active. */
    public onToolSettingsOpen: (() => void) | null = null;

    constructor(private app: PaintApp) {
        this.undoBtn    = document.getElementById('undoBtn')     as HTMLButtonElement | null;
        this.redoBtn    = document.getElementById('redoBtn')     as HTMLButtonElement | null;
        this.saveStatus = document.getElementById('save-status');
        this.brushDot   = document.getElementById('brushDot');

        this.undoBtn?.addEventListener('click', () => this.app.history.undo());
        this.redoBtn?.addEventListener('click', () => this.app.history.redo());

        this.wireToolButtons();

        this.fileInput = document.createElement('input');
        this.fileInput.type   = 'file';
        this.fileInput.accept = '.gpaint';
        this.fileInput.style.display = 'none';
        document.body.appendChild(this.fileInput);

        this.fileInput.addEventListener('change', async () => {
            const file = this.fileInput.files?.[0];
            if (!file) return;
            this.fileInput.value = '';
            try {
                await this.app.openProject(await file.arrayBuffer());
            } catch (err) {
                alert(`Failed to open: ${err instanceof Error ? err.message : err}`);
            }
        });

        this.setupShortcuts();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public updateHistoryButtons(canUndo: boolean, canRedo: boolean): void {
        if (this.undoBtn) this.undoBtn.disabled = !canUndo;
        if (this.redoBtn) this.redoBtn.disabled = !canRedo;
    }

    public updateSaveStatus(status: SaveStatus): void {
        if (!this.saveStatus) return;
        if (this.relativeIntervalId !== null) { clearInterval(this.relativeIntervalId); this.relativeIntervalId = null; }

        switch (status.type) {
            case 'idle':    this.saveStatus.textContent = '';             this.saveStatus.style.color = '';            break;
            case 'saving':  this.saveStatus.textContent = '● Saving…';   this.saveStatus.style.color = 'var(--text-3)'; break;
            case 'saved':
                this.savedAt = status.at;
                this.renderSavedLabel();
                this.saveStatus.style.color = '#6bcb77';
                this.relativeIntervalId = window.setInterval(() => this.renderSavedLabel(), 30_000);
                break;
            case 'error':
                this.saveStatus.textContent = '✕ Save failed';
                this.saveStatus.style.color = '#ff6b6b';
                setTimeout(() => { if (this.saveStatus) this.saveStatus.textContent = ''; }, 5_000);
                break;
        }
    }

    public updateBrushDot(size: number): void {
        if (!this.brushDot) return;
        const d = Math.max(2, Math.round((size / 0.375) * 32));
        this.brushDot.style.width  = d + 'px';
        this.brushDot.style.height = d + 'px';
    }

    public triggerFileInput(): void { this.fileInput.click(); }

    // ── Private ───────────────────────────────────────────────────────────────

    private wireToolButtons(): void {
        const brushBtn      = document.getElementById('toolBrush');
        const eraserBtn     = document.getElementById('toolEraser');
        const smudgeBtn     = document.getElementById('toolSmudge');
        const eyedropperBtn = document.getElementById('toolEyedropper');
        const fillBtn       = document.getElementById('toolFill');
        const selectBtn     = document.getElementById('toolSelect');
        const transformBtn  = document.getElementById('toolTransform');

        const allBtns = [brushBtn, eraserBtn, smudgeBtn, eyedropperBtn, fillBtn, selectBtn, transformBtn];

        const setActive = (active: HTMLElement | null) => {
            allBtns.forEach(b => b?.classList.remove('active'));
            active?.classList.add('active');
        };

        const openSettingsIfActive = (toolName: string) => {
            if (this.app.activeToolName === toolName) this.onToolSettingsOpen?.();
        };

        brushBtn?.addEventListener('click', () => {
            if (this.app.activeToolName === 'BrushTool') this.onToolSettingsOpen?.();
            this.app.setTool(this.app.brushTool);
            setActive(brushBtn);
        });
        eraserBtn?.addEventListener('click', () => {
            openSettingsIfActive('EraserTool');
            this.app.setTool(this.app.eraserTool);
            setActive(eraserBtn);
        });
        smudgeBtn?.addEventListener('click', () => {
            openSettingsIfActive('SmudgeTool');
            this.app.setTool(this.app.smudgeTool);
            setActive(smudgeBtn);
        });
        eyedropperBtn?.addEventListener('click', () => {
            this.app.setTool(this.app.eyedropperTool);
            setActive(eyedropperBtn);
        });
        fillBtn?.addEventListener('click', () => {
            this.app.setTool(this.app.fillTool);
            setActive(fillBtn);
        });
        selectBtn?.addEventListener('click', () => {
            openSettingsIfActive('SelectionTool');
            this.app.setTool(this.app.selectionTool);
            setActive(selectBtn);
        });
        transformBtn?.addEventListener('click', () => {
            this.app.enterTransform();
        });

        // Sync when tool changes via keyboard shortcut
        this.app.bus.on('tool:change', ({ tool }) => {
            brushBtn?.classList.toggle('active',      tool === 'BrushTool');
            eraserBtn?.classList.toggle('active',     tool === 'EraserTool');
            smudgeBtn?.classList.toggle('active',     tool === 'SmudgeTool');
            eyedropperBtn?.classList.toggle('active', tool === 'EyedropperTool');
            fillBtn?.classList.toggle('active',       tool === 'FillTool');
            selectBtn?.classList.toggle('active',     tool === 'SelectionTool');
            transformBtn?.classList.toggle('active',  tool === 'TransformTool');
        });
    }

    private renderSavedLabel(): void {
        if (!this.saveStatus || this.savedAt === null) return;
        const minutes = Math.floor((Date.now() - this.savedAt) / 60_000);
        this.saveStatus.textContent = `✓ Saved ${minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : 'over 1h ago'}`;
    }

    private setupShortcuts(): void {
        window.addEventListener('keydown', async (e) => {
            const target = e.target as HTMLElement;
            if (target.isContentEditable || target.tagName === 'INPUT') return;

            const ctrl = e.ctrlKey || e.metaKey;
            const key  = e.key.toLowerCase();

            // Alt-key temporary eyedropper (first keydown only, not repeat)
            if (e.key === 'Alt' && !e.repeat && !ctrl) {
                e.preventDefault();
                if (!this.altEyedropperActive) {
                    this.altEyedropperActive = true;
                    this.altPreviousTool = this.app.activeTool;
                    this.app.setTool(this.app.eyedropperTool);
                }
                return;
            }

            // Delete key — clear selected pixels (or full layer)
            if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                await this.app.clearPixels();
                return;
            }

            // Undo / Redo
            if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); await this.app.history.undo(); }
            if ((ctrl && key === 'y') || (ctrl && e.shiftKey && key === 'z')) { e.preventDefault(); await this.app.history.redo(); }

            // Tools
            if (!ctrl && key === 'b') this.app.setTool(this.app.activeBrushTool);
            if (!ctrl && key === 'e') this.app.setTool(this.app.eraserTool);
            if (!ctrl && key === 'm') this.app.setTool(this.app.smudgeTool);
            if (!ctrl && key === 'i') this.app.setTool(this.app.eyedropperTool);
            if (!ctrl && key === 'g') this.app.setTool(this.app.fillTool);
            if (!ctrl && key === 'r') this.app.setTool(this.app.selectionTool);
            if (!ctrl && key === 't') { this.app.enterTransform(); }

            // Brush size
            if (!ctrl && key === 'q') {
                const s = this.app.pipeline.currentBrushSize;
                this.app.setBrushSize(Math.max(0.005, s - 0.005));
                this.syncSizeSlider();
            }
            if (!ctrl && key === 'w') {
                const s = this.app.pipeline.currentBrushSize;
                this.app.setBrushSize(Math.min(0.15, s + 0.005));
                this.syncSizeSlider();
            }

            // Selection shortcuts
            if (ctrl && key === 'a') { e.preventDefault(); this.app.selectAll(); }
            if (ctrl && key === 'd') { e.preventDefault(); this.app.deselect(); }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key === 'Alt' && this.altEyedropperActive) {
                this.altEyedropperActive = false;
                if (this.altPreviousTool) {
                    this.app.setTool(this.altPreviousTool);
                    this.altPreviousTool = null;
                }
            }
        });
    }

    private syncSizeSlider(): void {
        const slider = document.getElementById('sizeSlider') as HTMLInputElement | null;
        if (slider) slider.value = String(this.app.pipeline.currentBrushSize);
        this.updateBrushDot(this.app.pipeline.currentBrushSize);
    }
}
