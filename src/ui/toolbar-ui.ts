import { PaintApp }   from '../core/app';
import { SaveStatus } from '../core/event-bus';

export class ToolbarUI {
    private undoBtn:    HTMLButtonElement | null;
    private redoBtn:    HTMLButtonElement | null;
    private saveStatus: HTMLElement | null;
    private brushDot:   HTMLElement | null;

    private savedAt:            number | null = null;
    private relativeIntervalId: number | null = null;

    private fileInput: HTMLInputElement;

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
        const d = Math.max(2, Math.round((size / 0.15) * 32));
        this.brushDot.style.width  = d + 'px';
        this.brushDot.style.height = d + 'px';
    }

    public triggerFileInput(): void { this.fileInput.click(); }

    // ── Private ───────────────────────────────────────────────────────────────

    private wireToolButtons(): void {
        const brushBtn      = document.getElementById('toolBrush');
        const eraserBtn     = document.getElementById('toolEraser');
        const eyedropperBtn = document.getElementById('toolEyedropper');
        const fillBtn       = document.getElementById('toolFill');
        const selectBtn     = document.getElementById('toolSelect');

        const allBtns = [brushBtn, eraserBtn, eyedropperBtn, fillBtn, selectBtn];

        const setActive = (active: HTMLElement | null) => {
            allBtns.forEach(b => b?.classList.remove('active'));
            active?.classList.add('active');
        };

        brushBtn?.addEventListener('click', () => {
            this.app.setTool(this.app.brushTool);
            setActive(brushBtn);
        });
        eraserBtn?.addEventListener('click', () => {
            this.app.setTool(this.app.eraserTool);
            setActive(eraserBtn);
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
            this.app.setTool(this.app.selectionTool);
            setActive(selectBtn);
        });

        // Sync when tool changes via keyboard shortcut
        this.app.bus.on('tool:change', ({ tool }) => {
            brushBtn?.classList.toggle('active',      tool === 'BrushTool');
            eraserBtn?.classList.toggle('active',     tool === 'EraserTool');
            eyedropperBtn?.classList.toggle('active', tool === 'EyedropperTool');
            fillBtn?.classList.toggle('active',       tool === 'FillTool');
            selectBtn?.classList.toggle('active',     tool === 'SelectionTool');
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

            // Undo / Redo
            if (ctrl && key === 'z' && !e.shiftKey) { e.preventDefault(); await this.app.history.undo(); }
            if ((ctrl && key === 'y') || (ctrl && e.shiftKey && key === 'z')) { e.preventDefault(); await this.app.history.redo(); }

            // Tools
            if (!ctrl && key === 'b') this.app.setTool(this.app.brushTool);
            if (!ctrl && key === 'e') this.app.setTool(this.app.eraserTool);
            if (!ctrl && key === 'i') this.app.setTool(this.app.eyedropperTool);
            if (!ctrl && key === 'g') this.app.setTool(this.app.fillTool);
            if (!ctrl && key === 'm') this.app.setTool(this.app.selectionTool);

            // Brush size
            if (!ctrl && key === '[') {
                const s = this.app.pipeline.currentBrushSize;
                this.app.setBrushSize(Math.max(0.005, s - 0.005));
                this.syncSizeSlider();
            }
            if (!ctrl && key === ']') {
                const s = this.app.pipeline.currentBrushSize;
                this.app.setBrushSize(Math.min(0.15, s + 0.005));
                this.syncSizeSlider();
            }

            // Selection shortcuts
            if (ctrl && key === 'a') { e.preventDefault(); this.app.pipeline.selectAll(); }
            if (ctrl && key === 'd') { e.preventDefault(); this.app.pipeline.deselect(); }
        });
    }

    private syncSizeSlider(): void {
        const slider = document.getElementById('sizeSlider') as HTMLInputElement | null;
        if (slider) slider.value = String(this.app.pipeline.currentBrushSize);
        this.updateBrushDot(this.app.pipeline.currentBrushSize);
    }
}
