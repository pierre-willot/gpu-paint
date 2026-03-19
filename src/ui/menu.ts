import type { PaintApp }          from '../core/app';
import type { AutosaveManager }   from '../core/autosave-manager';
import type { CanvasSizeDialog }  from './panels/canvas-size-dialog';

const EFFECT_IDS = ['efx-hueSat', 'efx-colorBalance', 'efx-brightness', 'efx-curves', 'efx-blur', 'efx-noise', 'efx-sharpen'];

// ── Effect panel helpers ──────────────────────────────────────────────────────

function openEffect(id: string): void {
    EFFECT_IDS.forEach(eid => document.getElementById(eid)?.classList.toggle('open', eid === id));
}
function closeEffect(id: string): void { document.getElementById(id)?.classList.remove('open'); }

// ── Quick search data ─────────────────────────────────────────────────────────

const SEARCH_ITEMS = [
    { name: 'Brush',            sc: 'B'         },
    { name: 'Eraser',           sc: 'E'         },
    { name: 'Eyedropper',       sc: 'I'         },
    { name: 'Fill',             sc: 'G'         },
    { name: 'Selection',        sc: 'M'         },
    { name: 'Undo',             sc: '⌘Z'        },
    { name: 'Redo',             sc: '⇧⌘Z'       },
    { name: 'Save Session',     sc: '⌘S'        },
    { name: 'Save As .gpaint',  sc: '⇧⌘S'       },
    { name: 'Export PNG',       sc: '⇧⌘E'       },
    { name: 'New Canvas',       sc: '⌘N'        },
    { name: 'Resize Canvas',    sc: '⌥⌘C'       },
    { name: 'Select All',       sc: '⌘A'        },
    { name: 'Deselect',         sc: '⌘D'        },
    { name: 'Invert Selection', sc: '⇧⌘I'       },
    { name: 'Zoom In',          sc: '⌘+'        },
    { name: 'Zoom Out',         sc: '⌘−'        },
    { name: 'Fit to Screen',    sc: '⌘0'        },
    { name: 'Focus Mode',       sc: 'Tab'       },
    { name: 'Rotate CW',        sc: 'R'         },
    { name: 'Hue / Saturation', sc: '⌘U'        },
    { name: 'Gaussian Blur',    sc: ''          },
    { name: 'Straight Line',    sc: 'Shift+drag'},
    { name: 'Quick Search',     sc: '⌘K'        },
];

// ── MenuManager ───────────────────────────────────────────────────────────────

export class MenuManager {
    constructor(
        private app:           PaintApp,
        private autosave:      AutosaveManager | null,
        private openFileInput: () => void,
        private sizeDialog?:   CanvasSizeDialog
    ) {
        this.setupDropdowns();
        this.wireFileMenu();
        this.wireEditMenu();
        this.wireEffectsMenu();
        this.wireViewMenu();
        this.wireEffectPanels();   // D3 — live preview
        this.wireSelectionPopup(); // C2/C3
        this.wireExportPanel();
        this.wireSearch();
        this.wirePrefs();

        this.updateUndoRedo();
        this.app.bus.on('history:change', ({ canUndo, canRedo }) => {
            this.setDisabled('menu-undo', !canUndo);
            this.setDisabled('menu-redo', !canRedo);
        });
    }

    // ── Dropdowns ─────────────────────────────────────────────────────────────

    private setupDropdowns(): void {
        const pairs: [string, string][] = [
            ['btnFile','menuFile'],['btnEdit','menuEdit'],
            ['btnEffects','menuEffects'],['btnView','menuView'],['btnAbout','menuAbout'],
        ];
        for (const [btnId, menuId] of pairs) {
            const btn  = document.getElementById(btnId);
            const menu = document.getElementById(menuId);
            if (!btn || !menu) continue;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const isOpen = menu.classList.contains('open');
                this.closeAll();
                if (!isOpen) { menu.classList.add('open'); btn.classList.add('open'); }
            });
        }
        document.addEventListener('mousedown', (e) => {
            if (!(e.target as HTMLElement).closest('#menuGroup')) this.closeAll();
        });
    }

    private closeAll(): void {
        document.querySelectorAll('.dropdown').forEach(m => m.classList.remove('open'));
        document.querySelectorAll('.menu-btn').forEach(b => b.classList.remove('open'));
    }

    private on(id: string, fn: () => void): void {
        document.getElementById(id)?.addEventListener('click', () => { this.closeAll(); fn(); });
    }

    private setDisabled(id: string, v: boolean): void {
        document.getElementById(id)?.classList.toggle('disabled', v);
    }

    private updateUndoRedo(): void {
        this.setDisabled('menu-undo', !this.app.history.canUndo());
        this.setDisabled('menu-redo', !this.app.history.canRedo());
    }

    // ── File menu ─────────────────────────────────────────────────────────────

    private wireFileMenu(): void {
        this.on('menu-new',           () => this.sizeDialog?.openNew() ?? (confirm('New canvas?') && this.app.clearLayer()));
        this.on('menu-open',          () => this.openFileInput());
        this.on('menu-save',          () => this.autosave?.saveNow());
        this.on('menu-save-project',  () => this.app.saveProject());
        this.on('menu-export',        () => { this.closeAll(); document.getElementById('exportPanel')!.style.display = 'flex'; });
        this.on('menu-export-layers', () => this.app.exportLayersZip());
        this.on('menu-prefs',         () => this.togglePanel('prefsPanel'));
    }

    // ── Edit menu ─────────────────────────────────────────────────────────────

    private wireEditMenu(): void {
        this.on('menu-undo',        () => this.app.history.undo());
        this.on('menu-redo',        () => this.app.history.redo());
        this.on('menu-select-all',  () => this.app.pipeline.selectAll());
        this.on('menu-deselect',    () => this.app.pipeline.deselect());
        this.on('menu-invert-sel',  () => this.app.pipeline.invertSelection());
        this.on('menu-clear',       () => this.app.clearLayer());
        document.getElementById('menu-resize')?.addEventListener('click', () => {
            this.closeAll();
            const dpr  = Math.min(window.devicePixelRatio || 1, 2);
            this.sizeDialog?.openResize(
                Math.round(this.app.pipeline.canvasWidth  / dpr),
                Math.round(this.app.pipeline.canvasHeight / dpr)
            );
        });
    }

    // ── Effects menu ──────────────────────────────────────────────────────────

    private wireEffectsMenu(): void {
        this.on('menu-hue-sat',       () => openEffect('efx-hueSat'));
        this.on('menu-color-balance', () => openEffect('efx-colorBalance'));
        this.on('menu-brightness',    () => openEffect('efx-brightness'));
        this.on('menu-curves',        () => openEffect('efx-curves'));
        this.on('menu-blur',          () => openEffect('efx-blur'));
        this.on('menu-noise',         () => openEffect('efx-noise'));
        this.on('menu-sharpen',       () => openEffect('efx-sharpen'));
    }

    // ── View menu ─────────────────────────────────────────────────────────────

    private wireViewMenu(): void {
        const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
        this.on('menu-zoom-in',        () => this.app.nav.zoomIn());
        this.on('menu-zoom-out',       () => this.app.nav.zoomOut());
        this.on('menu-zoom-fit',       () => this.app.nav.fitToScreen(this.app.pipeline.canvasWidth / dpr(), this.app.pipeline.canvasHeight / dpr()));
        this.on('menu-rotate-cw',      () => this.app.nav.rotateBy(15));
        this.on('menu-rotate-ccw',     () => this.app.nav.rotateBy(-15));
        this.on('menu-reset-rotation', () => this.app.nav.setRotation(0));
        this.on('menu-focus',          () => document.getElementById('focusExitBtn')?.click());
    }

    // ── D3 — Effect panels with live preview ──────────────────────────────────
    //
    // Pattern for both real effects:
    //   1. Take GPU snapshot of active layer when panel opens (MutationObserver)
    //   2. On each slider change: restore snapshot → apply effect
    //   3. Apply button: keep current state, clear snapshot
    //   4. Cancel/close: restore snapshot

    private wireEffectPanels(): void {
        // Close buttons (all panels)
        for (const id of EFFECT_IDS) {
            document.getElementById(`${id}-close`)?.addEventListener('click', () => closeEffect(id));
        }

        // ── Hue / Saturation (REAL, live preview) ─────────────────────────────

        let hueSatSnapshot: Uint8Array | null = null;
        let hueSatOpen     = false;

        const hSlider = document.getElementById('efx-hue')   as HTMLInputElement | null;
        const sSlider = document.getElementById('efx-sat')   as HTMLInputElement | null;
        const lSlider = document.getElementById('efx-light') as HTMLInputElement | null;
        const hVal    = document.getElementById('efx-hue-val')   as HTMLInputElement | null;
        const sVal    = document.getElementById('efx-sat-val')   as HTMLInputElement | null;
        const lVal    = document.getElementById('efx-light-val') as HTMLInputElement | null;

        const resetHueSatSliders = () => {
            if (hSlider) hSlider.value = '0';
            if (sSlider) sSlider.value = '0';
            if (lSlider) lSlider.value = '0';
            if (hVal)    hVal.value    = '0';
            if (sVal)    sVal.value    = '0%';
            if (lVal)    lVal.value    = '0%';
        };

        const applyHueSat = async () => {
            const h = parseFloat(hSlider?.value ?? '0');
            const s = parseFloat(sSlider?.value ?? '0') / 100;
            const l = parseFloat(lSlider?.value ?? '0') / 100;
            if (hVal) hVal.value = String(Math.round(h));
            if (sVal) sVal.value = Math.round(s * 100) + '%';
            if (lVal) lVal.value = Math.round(l * 100) + '%';

            // Restore snapshot first, then apply fresh
            if (hueSatSnapshot) {
                this.app.pipeline.restoreActiveLayer(hueSatSnapshot);
            }
            await this.app.pipeline.applyHueSaturation(h, s, l);
        };

        const hueSatPanel = document.getElementById('efx-hueSat');
        const hueSatObs   = new MutationObserver(async () => {
            if (!hueSatPanel) return;
            const nowOpen = hueSatPanel.classList.contains('open');
            if (nowOpen && !hueSatOpen) {
                // Panel just opened — take snapshot and reset sliders
                hueSatSnapshot = await this.app.pipeline.snapshotActiveLayer();
                resetHueSatSliders();
            }
            if (!nowOpen && hueSatOpen && hueSatSnapshot) {
                // Panel closed without Apply — restore
                this.app.pipeline.restoreActiveLayer(hueSatSnapshot);
                hueSatSnapshot = null;
                resetHueSatSliders();
            }
            hueSatOpen = nowOpen;
        });
        if (hueSatPanel) hueSatObs.observe(hueSatPanel, { attributes: true, attributeFilter: ['class'] });

        hSlider?.addEventListener('input', applyHueSat);
        sSlider?.addEventListener('input', applyHueSat);
        lSlider?.addEventListener('input', applyHueSat);

        document.getElementById('efx-hueSat-apply')?.addEventListener('click', () => {
            hueSatSnapshot = null; // keep current state — discard snapshot
            closeEffect('efx-hueSat');
        });

        document.getElementById('efx-hueSat-reset')?.addEventListener('click', () => {
            if (hueSatSnapshot) this.app.pipeline.restoreActiveLayer(hueSatSnapshot);
            resetHueSatSliders();
        });

        // Override the close button to restore on cancel
        document.getElementById('efx-hueSat-close')?.addEventListener('click', () => {
            if (hueSatSnapshot) {
                this.app.pipeline.restoreActiveLayer(hueSatSnapshot);
                hueSatSnapshot = null;
                resetHueSatSliders();
            }
            closeEffect('efx-hueSat');
        });

        // ── Gaussian Blur (REAL, live preview) ────────────────────────────────

        let blurSnapshot: Uint8Array | null = null;
        let blurOpen     = false;
        let blurDebounce: ReturnType<typeof setTimeout> | null = null;

        const blurSlider = document.getElementById('efx-blur-radius') as HTMLInputElement | null;
        const blurVal    = document.getElementById('efx-blur-val')    as HTMLInputElement | null;

        const applyBlur = () => {
            const r = parseInt(blurSlider?.value ?? '0');
            if (blurVal) blurVal.value = r + 'px';

            if (blurDebounce) clearTimeout(blurDebounce);
            blurDebounce = setTimeout(async () => {
                if (blurSnapshot) this.app.pipeline.restoreActiveLayer(blurSnapshot);
                if (r > 0) await this.app.pipeline.applyGaussianBlur(r);
            }, 60); // 60ms debounce — blur is expensive
        };

        const blurPanel = document.getElementById('efx-blur');
        const blurObs   = new MutationObserver(async () => {
            if (!blurPanel) return;
            const nowOpen = blurPanel.classList.contains('open');
            if (nowOpen && !blurOpen) {
                blurSnapshot = await this.app.pipeline.snapshotActiveLayer();
                if (blurSlider) blurSlider.value = '0';
                if (blurVal)    blurVal.value     = '0px';
            }
            if (!nowOpen && blurOpen && blurSnapshot) {
                // Closed without Apply
                this.app.pipeline.restoreActiveLayer(blurSnapshot);
                blurSnapshot = null;
            }
            blurOpen = nowOpen;
        });
        if (blurPanel) blurObs.observe(blurPanel, { attributes: true, attributeFilter: ['class'] });

        blurSlider?.addEventListener('input', applyBlur);

        document.getElementById('efx-blur-apply')?.addEventListener('click', () => {
            blurSnapshot = null; closeEffect('efx-blur');
        });

        document.getElementById('efx-blur-reset')?.addEventListener('click', () => {
            if (blurSnapshot) this.app.pipeline.restoreActiveLayer(blurSnapshot);
            if (blurSlider) blurSlider.value = '0';
            if (blurVal)    blurVal.value    = '0px';
        });

        document.getElementById('efx-blur-close')?.addEventListener('click', () => {
            if (blurSnapshot) { this.app.pipeline.restoreActiveLayer(blurSnapshot); blurSnapshot = null; }
            if (blurSlider) blurSlider.value = '0';
            if (blurVal)    blurVal.value    = '0px';
            closeEffect('efx-blur');
        });

        // Placeholder panels — just wire close buttons
        for (const key of ['colorBalance', 'brightness', 'curves', 'noise', 'sharpen']) {
            document.getElementById(`efx-${key}-close`)?.addEventListener('click', () => closeEffect(`efx-${key}`));
        }
    }

    // ── C2/C3 — Selection popup ───────────────────────────────────────────────

    private wireSelectionPopup(): void {
        const popup  = document.getElementById('selectionPopup');
        const selTool = this.app.selectionTool;

        // Open/close popup when selection tool is activated
        this.app.bus.on('tool:change', ({ tool }) => {
            if (!popup) return;
            if (tool === 'SelectionTool') {
                popup.classList.add('open');
                // Position below the toolSelect button
                const btnRect = document.getElementById('toolSelect')?.getBoundingClientRect();
                if (btnRect) popup.style.left = btnRect.left + 'px';
            } else {
                popup.classList.remove('open');
            }
        });

        // Close popup on outside click (but not when clicking selection tool btn)
        document.addEventListener('mousedown', (e) => {
            const target = e.target as HTMLElement;
            if (popup?.classList.contains('open') &&
                !target.closest('#selectionPopup') &&
                !target.closest('#toolSelect')) {
                popup?.classList.remove('open');
            }
        });

        // Type buttons
        const typeMap: [string, 'rect' | 'lasso' | 'poly'][] = [
            ['selTypeRect', 'rect'], ['selTypeLasso', 'lasso'], ['selTypePoly', 'poly']
        ];
        for (const [id, type] of typeMap) {
            document.getElementById(id)?.addEventListener('click', () => {
                selTool.setType(type);
                // Visual active state
                typeMap.forEach(([tid]) => document.getElementById(tid)?.classList.remove('active'));
                document.getElementById(id)?.classList.add('active');
            });
        }

        // Mode buttons
        const modeMap: [string, 'replace' | 'add' | 'subtract' | 'intersect'][] = [
            ['selModeReplace', 'replace'], ['selModeAdd', 'add'],
            ['selModeSub', 'subtract'],    ['selModeInt', 'intersect'],
        ];
        for (const [id, mode] of modeMap) {
            document.getElementById(id)?.addEventListener('click', () => {
                selTool.setMode(mode);
                modeMap.forEach(([mid]) => document.getElementById(mid)?.classList.remove('active'));
                document.getElementById(id)?.classList.add('active');
            });
        }

        // Escape key — deselect and return to brush
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.app.selectionTool === (this.app as any).activeTool) {
                this.app.pipeline.deselect();
                this.app.setTool(this.app.brushTool);
            }
        });
    }

    // ── Export panel ──────────────────────────────────────────────────────────

    private wireExportPanel(): void {
        document.getElementById('export-png-btn')?.addEventListener('click', () => {
            this.app.pipeline.saveImage(); this.hidePanel('exportPanel');
        });
        document.getElementById('export-zip-btn')?.addEventListener('click', () => {
            this.app.exportLayersZip(); this.hidePanel('exportPanel');
        });
        document.getElementById('export-gpaint-btn')?.addEventListener('click', () => {
            this.app.saveProject(); this.hidePanel('exportPanel');
        });
    }

    // ── Quick search ──────────────────────────────────────────────────────────

    private wireSearch(): void {
        const overlay = document.getElementById('searchOverlay');
        const input   = document.getElementById('searchInput')  as HTMLInputElement | null;
        const results = document.getElementById('searchResults');

        document.getElementById('quickSearchBtn')?.addEventListener('click', () => this.openSearch());
        overlay?.addEventListener('mousedown', (e) => {
            if (e.target === overlay) overlay.classList.remove('open');
        });
        input?.addEventListener('input', () => this.filterSearch(input.value, results));
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); this.openSearch(); }
            if (e.key === 'Escape') overlay?.classList.remove('open');
        });
    }

    private openSearch(): void {
        const overlay = document.getElementById('searchOverlay');
        const input   = document.getElementById('searchInput') as HTMLInputElement | null;
        const results = document.getElementById('searchResults');
        overlay?.classList.add('open');
        setTimeout(() => input?.focus(), 80);
        this.filterSearch('', results);
    }

    private filterSearch(q: string, results: HTMLElement | null): void {
        if (!results) return;
        const items = q
            ? SEARCH_ITEMS.filter(i => i.name.toLowerCase().includes(q.toLowerCase()))
            : SEARCH_ITEMS.slice(0, 14);
        if (!items.length) { results.innerHTML = '<div class="search-empty">No results</div>'; return; }
        results.innerHTML = items.map(i =>
            `<div class="search-result-item"><span>${i.name}</span>${i.sc ? `<kbd class="search-result-kbd">${i.sc}</kbd>` : ''}</div>`
        ).join('');
    }

    // ── Prefs ─────────────────────────────────────────────────────────────────

    private wirePrefs(): void {
        document.addEventListener('mousedown', (e) => {
            const panel = document.getElementById('prefsPanel');
            if (!panel || panel.style.display === 'none') return;
            if (!(e.target as HTMLElement).closest('#prefsPanel') &&
                !(e.target as HTMLElement).closest('#menu-prefs')) {
                panel.style.display = 'none';
            }
        });
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private togglePanel(id: string): void {
        const p = document.getElementById(id);
        if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
    }

    private hidePanel(id: string): void {
        const p = document.getElementById(id);
        if (p) p.style.display = 'none';
    }
}
