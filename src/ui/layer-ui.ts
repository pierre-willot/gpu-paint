import type { PaintApp }   from '../core/app';
import type { LayerState } from '../renderer/layer-manager';

const EYE_OPEN   = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><ellipse cx="8" cy="8" rx="6" ry="4" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>`;
const EYE_CLOSED = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 2L14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M4.5 5.5C3.3 6.3 2.5 7.2 2 8C3.3 10.2 5.4 12 8 12C9 12 10 11.7 11 11.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M7 4.1C7.3 4 7.7 4 8 4C10.6 4 12.7 5.8 14 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;

const THUMB_COLORS = ['#4f9cff', '#ff6b6b', '#6bcb77', '#ffd93d', '#c77dff', '#f8961e'];

const BLEND_MAP: Record<string, string> = {
    normal:   'normal',
    multiply: 'multiply',
    screen:   'screen',
    overlay:  'overlay',
};

export class LayerUI {
    // DOM refs for the toolbar controls (outside the layer list)
    private opacitySlider  = document.getElementById('layerOpacity')    as HTMLInputElement | null;
    private opacityVal     = document.getElementById('layerOpacityVal') as HTMLInputElement | null;
    private blendSelect    = document.getElementById('layerBlend')       as HTMLSelectElement | null;
    private lockBtn        = document.getElementById('lyrLockBtn');
    private alphaLockBtn   = document.getElementById('lyrAlphaLockBtn');
    private visBtn         = document.getElementById('lyrVisBtn');
    private deleteBtn      = document.getElementById('lyrDeleteBtn');

    // Drag-drop state
    private dragFromIndex: number | null = null;
    private dragOverIndex: number | null = null;

    // Re-entrancy guard for opacity/blend callbacks
    private updatingToolbar = false;

    constructor(
        private container: HTMLElement | null,
        private addBtn:    HTMLElement | null,
        private app:       PaintApp
    ) {
        this.addBtn?.addEventListener('click', () => this.app.addLayer());
        this.wireToolbar();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    public render(layers: LayerState[], activeIndex: number): void {
        if (!this.container) return;
        this.container.innerHTML = '';

        [...layers].reverse().forEach((layer, uiPos) => {
            const actualIndex = layers.length - 1 - uiPos;
            const isActive    = actualIndex === activeIndex;

            const row = document.createElement('div');
            row.className   = `layer-row${isActive ? ' active' : ''}${!layer.visible ? ' hidden-layer' : ''}`;
            row.dataset.idx = String(actualIndex);

            // Drag handle (6 dots)
            const dragHandle = document.createElement('div');
            dragHandle.className = 'layer-drag-handle';
            for (let i = 0; i < 3; i++) {
                const s = document.createElement('span');
                dragHandle.appendChild(s);
            }
            this.wireDragHandle(dragHandle, actualIndex, layers.length);

            // Thumbnail
            const thumb = document.createElement('div');
            thumb.className = 'layer-thumb';
            const tc = document.createElement('canvas');
            tc.width = 40; tc.height = 30;
            const ctx = tc.getContext('2d')!;
            ctx.fillStyle = THUMB_COLORS[actualIndex % THUMB_COLORS.length] + 'cc';
            ctx.beginPath(); ctx.arc(12, 9, 6, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#ffffff44';
            ctx.beginPath(); ctx.arc(24, 19, 4, 0, Math.PI * 2); ctx.fill();
            thumb.appendChild(tc);

            // Info
            const info = document.createElement('div');
            info.className = 'layer-info';
            const nameEl = document.createElement('div');
            nameEl.className       = 'layer-name';
            nameEl.textContent     = layer.name;
            nameEl.contentEditable = 'true';
            nameEl.spellcheck      = false;
            nameEl.addEventListener('input', () =>
                this.app.pipeline.setLayerName(actualIndex, nameEl.textContent ?? '')
            );
            nameEl.addEventListener('mousedown', e => e.stopPropagation());
            nameEl.addEventListener('keydown',   e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

            const blendEl = document.createElement('div');
            blendEl.className   = 'layer-blend-mode';
            blendEl.textContent = this.blendLabel(layer.blendMode) + ' · ' + Math.round(layer.opacity * 100) + '%';

            info.appendChild(nameEl);
            info.appendChild(blendEl);

            // Visibility button (per-row)
            const visBtn = document.createElement('button');
            visBtn.className = 'btn-ghost lyr-btn';
            visBtn.style.cssText = 'width:26px;height:26px;border-radius:7px;';
            visBtn.innerHTML = layer.visible ? EYE_OPEN : EYE_CLOSED;
            visBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const v = !layer.visible;
                this.app.pipeline.setLayerVisible(actualIndex, v);
                this.app.emitLayerChange();
            });

            row.append(dragHandle, thumb, info, visBtn);

            row.addEventListener('mousedown', (e) => {
                const t = e.target as HTMLElement;
                if (t.closest('[contenteditable]') || t.closest('button')) return;
                this.app.setActiveLayer(actualIndex);
            });

            this.container!.appendChild(row);
        });

        // Sync toolbar to active layer
        this.syncToolbar(layers, activeIndex);
    }

    // ── Private — toolbar wiring ──────────────────────────────────────────────

    private wireToolbar(): void {
        this.opacitySlider?.addEventListener('input', () => {
            if (this.updatingToolbar) return;
            const v = parseInt(this.opacitySlider!.value) / 100;
            if (this.opacityVal) this.opacityVal.value = this.opacitySlider!.value + '%';
            this.app.pipeline.setLayerOpacity(this.app.pipeline.activeLayerIndex, v);
            this.app.emitLayerChange();
        });

        this.opacityVal?.addEventListener('blur', () => {
            if (this.updatingToolbar) return;
            const n = Math.round(Math.min(100, Math.max(0, parseFloat(this.opacityVal!.value) || 0)));
            if (this.opacitySlider) this.opacitySlider.value = String(n);
            this.app.pipeline.setLayerOpacity(this.app.pipeline.activeLayerIndex, n / 100);
            this.app.emitLayerChange();
        });

        this.blendSelect?.addEventListener('change', () => {
            if (this.updatingToolbar) return;
            const mode = this.blendSelect!.value as any;
            this.app.pipeline.setLayerBlendMode(this.app.pipeline.activeLayerIndex, mode);
            this.app.emitLayerChange();
        });

        this.lockBtn?.addEventListener('click', () => {
            const idx   = this.app.pipeline.activeLayerIndex;
            const layer = this.app.pipeline.layers[idx];
            if (!layer) return;
            const on = !layer.locked;
            this.app.pipeline.setLayerLock(idx, on);
            this.lockBtn!.classList.toggle('active', on);
        });

        this.alphaLockBtn?.addEventListener('click', () => {
            const idx   = this.app.pipeline.activeLayerIndex;
            const layer = this.app.pipeline.layers[idx];
            if (!layer) return;
            const on = !layer.alphaLock;
            this.app.pipeline.setLayerAlphaLock(idx, on);
            this.alphaLockBtn!.classList.toggle('active', on);
        });

        this.visBtn?.addEventListener('click', () => {
            const idx   = this.app.pipeline.activeLayerIndex;
            const layer = this.app.pipeline.layers[idx];
            if (!layer) return;
            const on = !layer.visible;
            this.app.pipeline.setLayerVisible(idx, on);
            this.app.emitLayerChange();
        });

        this.deleteBtn?.addEventListener('click', () => {
            this.app.deleteLayer(this.app.pipeline.activeLayerIndex);
        });
    }

    private syncToolbar(layers: LayerState[], activeIndex: number): void {
        const layer = layers[activeIndex];
        if (!layer) return;

        this.updatingToolbar = true;
        const pct = Math.round(layer.opacity * 100);
        if (this.opacitySlider) this.opacitySlider.value = String(pct);
        if (this.opacityVal)    this.opacityVal.value    = pct + '%';
        if (this.blendSelect)   this.blendSelect.value   = layer.blendMode;
        this.lockBtn?.classList.toggle('active',      layer.locked);
        this.alphaLockBtn?.classList.toggle('active', layer.alphaLock);
        if (this.visBtn) this.visBtn.innerHTML = layer.visible ? EYE_OPEN : EYE_CLOSED;
        this.visBtn?.classList.toggle('active', !layer.visible);
        if (this.deleteBtn) (this.deleteBtn as HTMLButtonElement).disabled = layers.length <= 1;
        this.updatingToolbar = false;
    }

    // ── Private — drag-drop ───────────────────────────────────────────────────

    private wireDragHandle(handle: HTMLElement, actualIndex: number, total: number): void {
        handle.addEventListener('pointerdown', (e) => {
            if (!this.container) return;
            e.preventDefault(); e.stopPropagation();
            handle.setPointerCapture(e.pointerId);

            this.dragFromIndex = actualIndex;
            this.dragOverIndex = actualIndex;

            const onMove = (ev: PointerEvent) => {
                if (!this.container) return;
                const rows = Array.from(this.container.querySelectorAll<HTMLElement>('[data-idx]'));
                const y    = ev.clientY;
                let   found = -1;
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i].getBoundingClientRect();
                    if (y >= r.top && y <= r.bottom) { found = i; break; }
                }
                if (found === -1) return;
                const targetActual = total - 1 - found;
                if (targetActual !== this.dragOverIndex) {
                    this.dragOverIndex = targetActual;
                    rows.forEach((r, i) => {
                        r.style.outline = i === found ? '1px solid rgba(255,255,255,0.35)' : '';
                    });
                }
            };

            const onUp = () => {
                handle.releasePointerCapture(e.pointerId);
                handle.removeEventListener('pointermove', onMove);
                handle.removeEventListener('pointerup',   onUp);
                if (this.container)
                    this.container.querySelectorAll<HTMLElement>('[data-idx]')
                        .forEach(r => { r.style.outline = ''; });
                if (this.dragFromIndex !== null && this.dragOverIndex !== null &&
                    this.dragFromIndex !== this.dragOverIndex) {
                    this.app.reorderLayer(this.dragFromIndex, this.dragOverIndex);
                }
                this.dragFromIndex = null;
                this.dragOverIndex = null;
            };

            handle.addEventListener('pointermove', onMove);
            handle.addEventListener('pointerup',   onUp);
        });
    }

    private blendLabel(mode: string): string {
        const m: Record<string, string> = {
            normal: 'Normal', multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay'
        };
        return m[mode] ?? 'Normal';
    }
}
