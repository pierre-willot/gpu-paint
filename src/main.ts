import { initGPU }              from './renderer/webgpu';
import { PaintApp }             from './core/app';
import { LayerUI }              from './ui/layer-ui';
import { ToolbarUI }            from './ui/toolbar-ui';
import { ColorState }           from './core/color-state';
import { ColorPickerUI }        from './ui/color-picker/color-picker-ui';
import { PanelManager, makeDraggable, addResizeHandles } from './ui/panel-manager';
import { MenuManager }          from './ui/menu';
import { SessionStore }         from './core/session-store';
import { AutosaveManager }      from './core/autosave-manager';
import { RestoreBanner }        from './ui/restore-banner';
import { GestureRecognizer }    from './input/gesture-recognizer';
import { FocusMode }            from './ui/overlays/focus-mode';
import { PressureCurveUI }      from './ui/panels/pressure-curve-ui';
import { CanvasSizeDialog }     from './ui/panels/canvas-size-dialog';
import './style.css';

const CANVAS_LOGICAL = { width: 1000, height: 1400 };
const MAX_DPR        = 2;

function measureRefreshRate(): Promise<number> {
    return new Promise(resolve => {
        const samples: number[] = []; let last = 0;
        function tick(t: number) {
            if (last > 0 && t - last < 100) samples.push(t - last);
            last = t;
            if (samples.length < 10) { requestAnimationFrame(tick); return; }
            const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
            resolve(1000 / avg > 100 ? 120 : 1000 / avg > 75 ? 90 : 60);
        }
        requestAnimationFrame(tick);
    });
}

function subscribeUI(app: PaintApp, layerUI: LayerUI, toolbarUI: ToolbarUI): void {
    app.bus.on('layer:change',   ({ layers, activeIndex }) => layerUI.render(layers, activeIndex));
    app.bus.on('history:change', ({ canUndo, canRedo })    => toolbarUI.updateHistoryButtons(canUndo, canRedo));
    app.bus.on('save:status',    status                    => toolbarUI.updateSaveStatus(status));
    app.bus.on('brush:change',   ({ size })                => toolbarUI.updateBrushDot(size));
}

async function bootstrap() {
    try {
        const fps = await measureRefreshRate();
        const { device, context, format, canvas, supportsTimestamps } = await initGPU();

        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
        const w   = CANVAS_LOGICAL.width  * dpr;
        const h   = CANVAS_LOGICAL.height * dpr;
        canvas.width = w; canvas.height = h;

        const stack = document.getElementById('canvasStack');
        if (stack) { stack.style.width = CANVAS_LOGICAL.width + 'px'; stack.style.height = CANVAS_LOGICAL.height + 'px'; }

        console.info(`[GPU Paint] ${w}×${h}px · DPR=${dpr} · ${fps}Hz`);

        // ── App ───────────────────────────────────────────────────────────────
        const app = new PaintApp(
            canvas, device, context, format,
            { width: CANVAS_LOGICAL.width, height: CANVAS_LOGICAL.height },
            supportsTimestamps, fps
        );

        app.initBrushCursor();

        // ── Panels ────────────────────────────────────────────────────────────
        const panelIds = ['leftPanel', 'rightPanel', 'layerPanel', 'brushSettingsPanel', 'prefsPanel', 'exportPanel'];
        for (const id of panelIds) {
            const p = document.getElementById(id);
            if (p) { makeDraggable(p); addResizeHandles(p, { minW: 60, minH: 80 }); }
        }
        new PanelManager();

        // ── Color ─────────────────────────────────────────────────────────────
        const colorState = new ColorState(app.bus);
        new ColorPickerUI(colorState);

        colorState.subscribeLocal(() => {
            const { rgb } = colorState;
            app.setBrushColor(rgb.r / 255, rgb.g / 255, rgb.b / 255, 1.0);
        });
        app.bus.on('color:change', ({ rgb }) => colorState.setRgb(rgb.r, rgb.g, rgb.b));

        // ── Layer + toolbar UI ────────────────────────────────────────────────
        const layerUI   = new LayerUI(document.getElementById('layer-list'), document.getElementById('add-layer-btn'), app);
        const toolbarUI = new ToolbarUI(app);
        subscribeUI(app, layerUI, toolbarUI);

        // ── Brush size slider ─────────────────────────────────────────────────
        const sizeSlider = document.getElementById('sizeSlider') as HTMLInputElement | null;
        sizeSlider?.addEventListener('input', () => {
            const size = parseFloat(sizeSlider.value);
            app.setBrushSize(size);
            toolbarUI.updateBrushDot(size);
        });

        // ── Brush settings panel ──────────────────────────────────────────────
        wireBrushSettings(app);

        // ── B2 — Pressure curve UI ────────────────────────────────────────────
        const pressureContainer = document.getElementById('pressureCurveContainer');
        if (pressureContainer) {
            new PressureCurveUI(pressureContainer, lut => app.setPressureCurve(lut));
        }

        // ── B11 — Canvas size dialog ──────────────────────────────────────────
        const sizeDialog = new CanvasSizeDialog({
            onNewCanvas:    opts => app.newCanvas(opts).then(() => app.emitLayerChange()),
            onResizeCanvas: opts => app.resizeCanvas(opts).then(() => app.emitLayerChange()),
        });

        // ── Focus mode ────────────────────────────────────────────────────────
        const focusMode = new FocusMode();

        // ── Touch gestures ────────────────────────────────────────────────────
        new GestureRecognizer(canvas, app.nav, {
            onUndo:        () => app.history.undo(),
            onRedo:        () => app.history.redo(),
            onFocusToggle: () => focusMode.toggle()
        });

        // ── Autosave ──────────────────────────────────────────────────────────
        let autosave: AutosaveManager | null = null;
        try {
            const store = new SessionStore(); await store.open();
            autosave = new AutosaveManager(store, status => app.bus.emit('save:status', status));
            app.connectAutosave(autosave);
            if (await store.hasSession()) {
                const sessionData = await autosave.loadSessionData();
                if (sessionData?.meta) {
                    new RestoreBanner(
                        sessionData.meta.timestamp,
                        async () => { const d = await autosave!.loadSessionData(); if (d) await app.restoreSession(d); },
                        async () => { await autosave!.clearSession(); }
                    );
                }
            }
            await autosave.init(w, h);
        } catch (err) { console.warn('[Autosave] IndexedDB unavailable:', err); }

        // ── Menus (pass sizeDialog so File→New and Edit→Resize work) ──────────
        new MenuManager(app, autosave, () => toolbarUI.triggerFileInput(), sizeDialog);

        // ── App init ──────────────────────────────────────────────────────────
        await app.init();
        colorState.broadcastLocal();
        toolbarUI.updateBrushDot(app.pipeline.currentBrushSize);

        // ── Keyboard shortcuts ────────────────────────────────────────────────
        window.addEventListener('keydown', async (e) => {
            const target = e.target as HTMLElement;
            if (target.isContentEditable || target.tagName === 'INPUT') return;

            const ctrl = e.ctrlKey || e.metaKey;
            const key  = e.key.toLowerCase();

            // Save / open
            if (ctrl && key === 's' && !e.shiftKey) { e.preventDefault(); await autosave?.saveNow(); return; }
            if (ctrl && key === 's' &&  e.shiftKey) { e.preventDefault(); await app.saveProject();   return; }
            if (ctrl && key === 'o')                 { e.preventDefault(); toolbarUI.triggerFileInput(); return; }
            if (ctrl && key === 'n')                 { e.preventDefault(); sizeDialog.openNew();     return; }
            if (ctrl && e.altKey && key === 'c') {
                e.preventDefault();
                const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
                sizeDialog.openResize(Math.round(app.pipeline.canvasWidth / dpr), Math.round(app.pipeline.canvasHeight / dpr));
                return;
            }

            // Quick search
            if (ctrl && key === 'k') { e.preventDefault(); document.getElementById('quickSearchBtn')?.click(); return; }

            // View rotation
            if (!ctrl && key === 'r') { e.preventDefault(); app.nav.rotateBy(e.shiftKey ? -15 : 15); }

            // Zoom
            if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); app.nav.zoomIn();  }
            if (ctrl && key === '-')                   { e.preventDefault(); app.nav.zoomOut(); }
            if (ctrl && (key === '0' || e.code === 'Numpad0')) {
                e.preventDefault();
                const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
                app.nav.fitToScreen(app.pipeline.canvasWidth / dpr, app.pipeline.canvasHeight / dpr);
            }

            // Effects
            if (ctrl && key === 'u') { e.preventDefault(); document.getElementById('efx-hueSat')?.classList.toggle('open'); }
        });

        // ── Drag-and-drop .gpaint ─────────────────────────────────────────────
        document.body.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
        document.body.addEventListener('drop', async e => {
            e.preventDefault();
            const file = e.dataTransfer?.files[0];
            if (!file?.name.endsWith('.gpaint')) return;
            try { await app.openProject(await file.arrayBuffer()); }
            catch (err) { alert(`Failed to open: ${err instanceof Error ? err.message : err}`); }
        });

        // ── GPU device loss recovery ──────────────────────────────────────────
        window.addEventListener('webgpu-device-lost', async () => {
            console.warn('Attempting GPU recovery…');
            try {
                app.bus.clear();
                const fresh = await initGPU(canvas); fresh.canvas.width = w; fresh.canvas.height = h;
                await app.pipeline.reconstructFromHistory(app.history.getHistory());
                app.pipeline.markDirty();
                subscribeUI(app, layerUI, toolbarUI);
            } catch (e) {
                document.body.innerHTML = `<div style="color:red;padding:20px"><h2>GPU Recovery Failed</h2><p>${e}</p></div>`;
            }
        });

    } catch (error) {
        console.error('Initialization failed:', error);
        document.body.innerHTML = `<div style="color:red;padding:20px"><h2>Init Failed</h2><p>${error}</p></div>`;
    }
}

function wireBrushSettings(app: PaintApp): void {
    const bind = (sliderId: string, valId: string, suffix: string, fn: (v: number) => void) => {
        const s = document.getElementById(sliderId) as HTMLInputElement | null;
        const v = document.getElementById(valId)   as HTMLInputElement | null;
        s?.addEventListener('input', () => { const n = parseInt(s.value); if (v) v.value = n + suffix; fn(n / 100); });
    };
    bind('bs-opacity',  'bs-opacity-val',  '%', v => app.setBrushOpacity(v));
    bind('bs-flow',     'bs-flow-val',     '%', v => app.brushTool.setFlow(v));
    bind('bs-hardness', 'bs-hardness-val', '%', v => app.setBrushHardness(v));
    bind('bs-spacing',  'bs-spacing-val',  '%', v => app.brushTool.setSpacing(v / 100));
}

bootstrap();
