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
import { CanvasSizeDialog }      from './ui/panels/canvas-size-dialog';
import { BrushPresets }         from './core/brush-presets';
import { BrushPanel, drawPreview } from './ui/panels/brush-panel';
import { CurveEditor }          from './ui/panels/curve-editor';
import './style.css';

const CANVAS_LOGICAL = { width: 1000, height: 1400 };
const MAX_DPR        = 2;

function measureRefreshRate(): Promise<number> {
    return new Promise(resolve => {
        const s: number[] = []; let last = 0;
        function tick(t: number) {
            if (last > 0 && t - last < 100) s.push(t - last);
            last = t;
            if (s.length < 10) { requestAnimationFrame(tick); return; }
            const avg = s.reduce((a, b) => a + b) / s.length;
            resolve(avg < 10 ? 120 : avg < 13 ? 90 : 60);
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
        const app = new PaintApp(canvas, device, context, format,
            { width: CANVAS_LOGICAL.width, height: CANVAS_LOGICAL.height },
            supportsTimestamps, fps
        );
        app.initBrushCursor();

        // ── Panels ────────────────────────────────────────────────────────────
        for (const id of ['leftPanel','rightPanel','layerPanel','brushPanel','brushSettingsPanel','prefsPanel','exportPanel']) {
            const p = document.getElementById(id);
            if (p) { makeDraggable(p); addResizeHandles(p, { minW: 60, minH: 80 }); }
        }
        new PanelManager();

        // ── Color ─────────────────────────────────────────────────────────────
        const colorState = new ColorState(app.bus);
        new ColorPickerUI(colorState);

        let eyedropperChanging = false;
        colorState.subscribeLocal(() => {
            const { rgb } = colorState;
            app.setBrushColor(rgb.r / 255, rgb.g / 255, rgb.b / 255, 1.0);
            // Color picker interaction → switch to brush (but not when eyedropper sets the color)
            if (!eyedropperChanging) app.setTool(app.brushTool);
        });
        app.bus.on('color:change', ({ rgb }) => {
            eyedropperChanging = true;
            colorState.setRgb(rgb.r, rgb.g, rgb.b);
            eyedropperChanging = false;
        });

        // ── Layer + toolbar UI ────────────────────────────────────────────────
        const layerUI   = new LayerUI(document.getElementById('layer-list'), document.getElementById('add-layer-btn'), app);
        const toolbarUI = new ToolbarUI(app);
        subscribeUI(app, layerUI, toolbarUI);

        // ── Tool Group panel (brush presets + per-tool variations) ───────────
        const brushPresets   = new BrushPresets();
        const toolGroupPanel = new BrushPanel(brushPresets, app);

        // Clicking an already-active tool button → toggle Tool Group panel
        toolbarUI.onToolSettingsOpen = () => toolGroupPanel.toggle();

        // When a preset is loaded, sync GPU grain config
        toolGroupPanel.onPresetLoaded = (desc) => {
            const blendMap: Record<string, number> = { multiply: 0, screen: 1, overlay: 2, normal: 3 };
            app.pipeline.brushRenderer.setConfig({
                blendMode:       'normal',
                grainDepth:      desc.grainDepth,
                grainScale:      desc.grainScale,
                grainRotation:   desc.grainRotation * Math.PI / 180,
                grainContrast:   desc.grainContrast,
                grainBrightness: desc.grainBrightness,
                grainBlendMode:  blendMap[desc.grainBlendMode] ?? 0,
                grainStatic:     desc.grainStatic,
            });
            // Sync grain library index
            if (desc.grainIndex >= 0) {
                app.pipeline.brushRenderer.setGrainIndex(desc.grainIndex);
            }
        };

        // Update Tool Group content when the active tool changes
        app.bus.on('tool:change', ({ tool }) => {
            toolGroupPanel.showSection(tool);
        });

        // ── Size slider ───────────────────────────────────────────────────────
        const sizeSlider = document.getElementById('sizeSlider') as HTMLInputElement | null;
        sizeSlider?.addEventListener('input', () => {
            const size = parseFloat(sizeSlider.value);
            app.setBrushSize(size);
            toolbarUI.updateBrushDot(size);
        });

        // ── Brush settings panel ──────────────────────────────────────────────
        wireBrushSettings(app, toolGroupPanel, brushPresets);
        document.getElementById('bsCloseBtn')?.addEventListener('click', () => {
            const panel = document.getElementById('brushSettingsPanel');
            if (panel) panel.style.display = 'none';
        });

        // ── Pressure curve (B2) ───────────────────────────────────────────────
        const pressureContainer = document.getElementById('pressureCurveContainer');
        if (pressureContainer) new PressureCurveUI(pressureContainer, lut => app.setPressureCurve(lut));

        // ── Canvas size dialog (B11) ──────────────────────────────────────────
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
            onFocusToggle: () => focusMode.toggle(),
        });

        // ── Autosave ──────────────────────────────────────────────────────────
        let autosave: AutosaveManager | null = null;
        try {
            const store = new SessionStore();
            await store.open();
            autosave = new AutosaveManager(store, status => app.bus.emit('save:status', status));
            app.connectAutosave(autosave);
            if (await store.hasSession()) {
                const sd = await autosave.loadSessionData();
                if (sd?.meta) {
                    new RestoreBanner(
                        sd.meta.timestamp,
                        async () => { const d = await autosave!.loadSessionData(); if (d) await app.restoreSession(d); },
                        async () => { await autosave!.clearSession(); }
                    );
                }
            }
            await autosave.init(w, h);
        } catch (err) { console.warn('[Autosave] Disabled:', err); }

        // ── Image import file input (shared by Ctrl+I shortcut and menu) ────────
        const imgInput = document.createElement('input');
        imgInput.type   = 'file';
        imgInput.accept = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';
        imgInput.style.display = 'none';
        document.body.appendChild(imgInput);
        imgInput.addEventListener('change', async () => {
            if (imgInput.files?.[0]) {
                try   { await app.importImage(imgInput.files[0]); }
                catch (err) { alert(`Failed to import image: ${err instanceof Error ? err.message : err}`); }
                imgInput.value = '';
            }
        });

        // ── Menus ─────────────────────────────────────────────────────────────
        new MenuManager(app, autosave, () => toolbarUI.triggerFileInput(), sizeDialog);
        document.getElementById('menu-import')?.addEventListener('click', () => imgInput.click());

        // ── App init ──────────────────────────────────────────────────────────
        await app.init();
        colorState.broadcastLocal();
        toolbarUI.updateBrushDot(app.pipeline.currentBrushSize);

        // ── Keyboard shortcuts ────────────────────────────────────────────────

        window.addEventListener('keydown', async (e) => {
            const target = e.target as HTMLElement;
            if (target.isContentEditable || target.tagName === 'INPUT') return;
            const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();

            // Transform mode shortcuts
            if (app.pipeline.transformActive) {
                if (e.key === 'Enter')  { e.preventDefault(); await app.commitTransform(); return; }
                if (e.key === 'Escape') { e.preventDefault(); app.cancelTransform();       return; }
            }

            if (ctrl && key === 'c' && !e.shiftKey) { e.preventDefault(); await app.copy();  return; }
            if (ctrl && key === 'x')                { e.preventDefault(); await app.cut();   return; }
            if (ctrl && key === 'v')                { e.preventDefault(); await app.paste(); return; }

            if (ctrl && key === 's' && !e.shiftKey) { e.preventDefault(); await autosave?.saveNow(); return; }
            if (ctrl && key === 's' &&  e.shiftKey) { e.preventDefault(); await app.saveProject(); return; }
            if (ctrl && key === 'o')                 { e.preventDefault(); toolbarUI.triggerFileInput(); return; }
            if (ctrl && key === 'n')                 { e.preventDefault(); sizeDialog.openNew(); return; }
            if (ctrl && e.altKey && key === 'c')     { e.preventDefault();
                const dpr = Math.min(window.devicePixelRatio||1, MAX_DPR);
                sizeDialog.openResize(Math.round(app.pipeline.canvasWidth/dpr), Math.round(app.pipeline.canvasHeight/dpr)); return; }
            if (ctrl && key === 'k') { e.preventDefault(); document.getElementById('quickSearchBtn')?.click(); return; }
            if (ctrl && key === 'u') { e.preventDefault(); document.getElementById('efx-hueSat')?.classList.toggle('open'); return; }
            if (ctrl && key === 'i') { e.preventDefault(); imgInput.click(); return; }

            if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); app.nav.zoomIn(); }
            if (ctrl && key === '-')                   { e.preventDefault(); app.nav.zoomOut(); }
            if (ctrl && (key === '0' || e.code === 'Numpad0')) {
                e.preventDefault();
                const dpr = Math.min(window.devicePixelRatio||1, MAX_DPR);
                app.nav.fitToScreen(app.pipeline.canvasWidth/dpr, app.pipeline.canvasHeight/dpr);
            }
        });

        // ── Drag-and-drop (.gpaint or image files) ────────────────────────────
        document.body.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; });
        document.body.addEventListener('drop', async e => {
            e.preventDefault();
            const file = e.dataTransfer?.files[0];
            if (!file) return;
            if (file.name.endsWith('.gpaint')) {
                try   { await app.openProject(await file.arrayBuffer()); }
                catch (err) { alert(`Failed to open: ${err instanceof Error ? err.message : err}`); }
            } else if (file.type.startsWith('image/')) {
                try   { await app.importImage(file); }
                catch (err) { alert(`Failed to import image: ${err instanceof Error ? err.message : err}`); }
            }
        });

        // ── GPU device loss recovery ──────────────────────────────────────────
        window.addEventListener('webgpu-device-lost', async () => {
            console.warn('Attempting GPU recovery…');
            try {
                app.bus.clear();
                const fresh = await initGPU(canvas);
                fresh.canvas.width = w; fresh.canvas.height = h;
                await app.pipeline.reconstructFromHistory(app.history.getHistory());
                app.pipeline.markDirty();
                subscribeUI(app, layerUI, toolbarUI);
            } catch (e) {
                document.body.innerHTML = `<div style="color:red;padding:20px"><h2>GPU Recovery Failed</h2><p>${e}</p></div>`;
            }
        });

    } catch (error) {
        console.error('Init failed:', error);
        document.body.innerHTML = `<div style="color:red;padding:20px"><h2>Init Failed</h2><p>${error}</p></div>`;
    }
}

function wireBrushSettings(app: PaintApp, brushPanel: BrushPanel, brushPresetsRef: BrushPresets): void {
    const isSmudge = () => app.activeToolName === 'SmudgeTool';
    const isEraser = () => app.activeToolName === 'EraserTool';
    const pct = (v: number) => Math.round(v * 100);

    /** Save current brush descriptor back to the active preset and refresh its preview. */
    const notifyBrushChange = () => {
        if (isSmudge() || isEraser()) return;
        const id = brushPanel.getSelectedPresetId();
        if (!id) return;
        const desc = app.brushTool.getDescriptor();
        brushPresetsRef.update(id, desc);
        brushPanel.refreshPreview(id, desc);
    };

    // ── Live stroke preview ────────────────────────────────────────────────────
    const previewCanvas = document.getElementById('bs-stroke-preview') as HTMLCanvasElement | null;
    let previewTimer: ReturnType<typeof setTimeout> | null = null;
    const schedulePreview = () => {
        if (!previewCanvas) return;
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            drawPreview(previewCanvas, app.brushTool.getDescriptor());
        }, 60);
    };

    /** Push descriptor to worker and save to active preset. */
    const pushBrush = () => { app.brushTool.pushDescriptor(); notifyBrushChange(); schedulePreview(); };

    // ── Binding helpers ───────────────────────────────────────────────────────

    // Standard 0-100 slider → 0.0-1.0 value
    const bind = (sid: string, vid: string, suffix: string, fn: (v: number) => void) => {
        const s = document.getElementById(sid) as HTMLInputElement | null;
        const v = document.getElementById(vid) as HTMLInputElement | null;
        s?.addEventListener('input', () => { const n = parseInt(s.value); if (v) v.value = n + suffix; fn(n / 100); });
    };

    // Slider with custom divisor (e.g. degrees, raw counts, scaled ranges)
    const bindRaw = (sid: string, vid: string, suffix: string, divisor: number, fn: (v: number) => void) => {
        const s = document.getElementById(sid) as HTMLInputElement | null;
        const v = document.getElementById(vid) as HTMLInputElement | null;
        s?.addEventListener('input', () => { const n = parseInt(s.value); if (v) v.value = n + suffix; fn(n / divisor); });
    };

    // Toggle switch (div.toggle-switch with .on class)
    const bindToggle = (id: string, fn: (on: boolean) => void) => {
        document.getElementById(id)?.addEventListener('click', e => {
            const el = e.currentTarget as HTMLElement;
            el.classList.toggle('on');
            fn(el.classList.contains('on'));
        });
    };

    // ── Pressure curve editors ────────────────────────────────────────────────

    let sizeCurveEditor:             CurveEditor | null = null;
    let sizeTiltCurveEditor:         CurveEditor | null = null;
    let sizeSpeedCurveEditor:        CurveEditor | null = null;
    let opacityCurveEditor:          CurveEditor | null = null;
    let opacitySpeedCurveEditor:     CurveEditor | null = null;
    let flowCurveEditor:             CurveEditor | null = null;
    let roundnessTiltCurveEditor:    CurveEditor | null = null;
    let roundnessPressureCurveEditor: CurveEditor | null = null;
    let scatterPressureCurveEditor:  CurveEditor | null = null;
    let grainDepthCurveEditor:       CurveEditor | null = null;
    let colorMixCurveEditor:         CurveEditor | null = null;

    const sizeCurveContainer              = document.getElementById('bs-size-curve-container');
    const sizeTiltCurveContainer          = document.getElementById('bs-size-tilt-curve-container');
    const sizeSpeedCurveContainer         = document.getElementById('bs-size-speed-curve-container');
    const opacityCurveContainer           = document.getElementById('bs-opacity-curve-container');
    const opacitySpeedCurveContainer      = document.getElementById('bs-opacity-speed-curve-container');
    const flowCurveContainer              = document.getElementById('bs-flow-curve-container');
    const roundnessTiltCurveContainer     = document.getElementById('bs-roundness-tilt-curve-container');
    const roundnessPressureCurveContainer = document.getElementById('bs-roundness-pressure-curve-container');
    const scatterPressureCurveContainer   = document.getElementById('bs-scatter-pressure-curve-container');
    const grainDepthCurveContainer        = document.getElementById('bs-grain-depth-curve-container');
    const colorMixCurveContainer          = document.getElementById('bs-color-mix-curve-container');

    const makeEditor = (label: string, onChange: (s: any) => void) =>
        new CurveEditor({ width: 120, height: 70, label, onChange });

    if (sizeCurveContainer) {
        sizeCurveEditor = makeEditor('Pressure → Size', (spec) => { app.brushTool.getDescriptor().sizePressureCurve = spec; pushBrush(); });
        sizeCurveContainer.appendChild(sizeCurveEditor.el);
    }
    if (sizeTiltCurveContainer) {
        sizeTiltCurveEditor = makeEditor('Tilt → Size', (spec) => { app.brushTool.getDescriptor().sizeTiltCurve = spec; pushBrush(); });
        sizeTiltCurveContainer.appendChild(sizeTiltCurveEditor.el);
    }
    if (sizeSpeedCurveContainer) {
        sizeSpeedCurveEditor = makeEditor('Speed → Size', (spec) => { app.brushTool.getDescriptor().sizeSpeedCurve = spec; pushBrush(); });
        sizeSpeedCurveContainer.appendChild(sizeSpeedCurveEditor.el);
    }
    if (opacityCurveContainer) {
        opacityCurveEditor = makeEditor('Pressure → Opacity', (spec) => { app.brushTool.getDescriptor().opacityPressureCurve = spec; pushBrush(); });
        opacityCurveContainer.appendChild(opacityCurveEditor.el);
    }
    if (opacitySpeedCurveContainer) {
        opacitySpeedCurveEditor = makeEditor('Speed → Opacity', (spec) => { app.brushTool.getDescriptor().opacitySpeedCurve = spec; pushBrush(); });
        opacitySpeedCurveContainer.appendChild(opacitySpeedCurveEditor.el);
    }
    if (flowCurveContainer) {
        flowCurveEditor = makeEditor('Pressure → Flow', (spec) => { app.brushTool.getDescriptor().flowPressureCurve = spec; pushBrush(); });
        flowCurveContainer.appendChild(flowCurveEditor.el);
    }
    if (roundnessTiltCurveContainer) {
        roundnessTiltCurveEditor = makeEditor('Tilt → Roundness', (spec) => { app.brushTool.getDescriptor().roundnessTiltCurve = spec; pushBrush(); });
        roundnessTiltCurveContainer.appendChild(roundnessTiltCurveEditor.el);
    }
    if (roundnessPressureCurveContainer) {
        roundnessPressureCurveEditor = makeEditor('Pressure → Roundness', (spec) => { app.brushTool.getDescriptor().roundnessPressureCurve = spec; pushBrush(); });
        roundnessPressureCurveContainer.appendChild(roundnessPressureCurveEditor.el);
    }
    if (scatterPressureCurveContainer) {
        scatterPressureCurveEditor = makeEditor('Pressure → Scatter', (spec) => { app.brushTool.getDescriptor().scatterPressureCurve = spec; pushBrush(); });
        scatterPressureCurveContainer.appendChild(scatterPressureCurveEditor.el);
    }
    if (grainDepthCurveContainer) {
        grainDepthCurveEditor = makeEditor('Pressure → Grain', (spec) => { app.brushTool.getDescriptor().grainDepthCurve = spec; pushBrush(); });
        grainDepthCurveContainer.appendChild(grainDepthCurveEditor.el);
    }
    if (colorMixCurveContainer) {
        colorMixCurveEditor = makeEditor('Pressure → Color Mix', (spec) => { app.brushTool.getDescriptor().colorMixPressureCurve = spec; pushBrush(); });
        colorMixCurveContainer.appendChild(colorMixCurveEditor.el);
    }

    // ── Existing controls ─────────────────────────────────────────────────────

    bind('bs-opacity',  'bs-opacity-val',  '%', v => {
        if (isSmudge()) app.smudgeTool.setOpacity(v);
        else if (isEraser()) app.eraserTool.setOpacity(v);
        else { app.setBrushOpacity(v); notifyBrushChange(); }
    });
    bind('bs-flow',     'bs-flow-val',     '%', v => { if (!isSmudge() && !isEraser()) { app.brushTool.setFlow(v); notifyBrushChange(); } });
    bind('bs-hardness', 'bs-hardness-val', '%', v => {
        if (isSmudge()) app.smudgeTool.setHardness(v);
        else if (isEraser()) app.eraserTool.setHardness(v);
        else { app.setBrushHardness(v); notifyBrushChange(); }
    });
    // Spacing uses 0.5-step float slider: parse as float, divide by 100
    {
        const s = document.getElementById('bs-spacing')  as HTMLInputElement | null;
        const vEl = document.getElementById('bs-spacing-val') as HTMLInputElement | null;
        s?.addEventListener('input', () => {
            const n = parseFloat(s.value);
            if (vEl) vEl.value = n.toFixed(n % 1 === 0 ? 0 : 1) + '%';
            const v = n / 100;
            if (isSmudge()) app.smudgeTool.setSpacing(v);
            else if (isEraser()) app.eraserTool.setSpacing(v);
            else { app.brushTool.setSpacing(v); notifyBrushChange(); }
        });
    }
    bind('bs-mix',      'bs-mix-val',      '%', v => {
        if (isSmudge()) app.smudgeTool.setStrength(v); else { app.brushTool.setMix(v); notifyBrushChange(); }
    });
    bind('bs-pres-size',   'bs-pres-size-val',   '%', v => { app.brushTool.getDescriptor().pressureSize    = v; pushBrush(); });
    bind('bs-pres-opac',   'bs-pres-opac-val',   '%', v => { app.brushTool.getDescriptor().pressureOpacity = v; pushBrush(); });
    bind('bs-size-jitter', 'bs-size-jitter-val', '%', v => { app.brushTool.getDescriptor().sizeJitter      = v; pushBrush(); });
    bind('bs-opac-jitter', 'bs-opac-jitter-val', '%', v => { app.brushTool.getDescriptor().opacityJitter   = v; pushBrush(); });

    // ── Shape ─────────────────────────────────────────────────────────────────

    bind('bs-roundness', 'bs-roundness-val', '%', v => { app.brushTool.getDescriptor().roundness = v; pushBrush(); });
    bindRaw('bs-angle',  'bs-angle-val', '°', 1, v => { app.brushTool.getDescriptor().angle = v; pushBrush(); });
    bindToggle('bs-follow-stroke', on => { app.brushTool.getDescriptor().followStroke = on; pushBrush(); });

    // ── Dynamics ──────────────────────────────────────────────────────────────

    bind('bs-pres-flow', 'bs-pres-flow-val', '%', v => {
        const d = app.brushTool.getDescriptor();
        if (v < 0.01) {
            d.flowPressureCurve = { mode: 'off', min: 0, max: 1 };
        } else {
            d.flowPressureCurve = { mode: 'linear', min: 1 - v, max: 1 };
        }
        pushBrush();
    });

    // ── Scatter ───────────────────────────────────────────────────────────────

    bindRaw('bs-angle-jitter', 'bs-angle-jitter-val', '°', 1, v => { app.brushTool.getDescriptor().angleJitter = v; pushBrush(); });
    // Scatter X/Y: slider 0-100 → value 0.0-0.1 (10% of canvas width max)
    bindRaw('bs-scatter-x', 'bs-scatter-x-val', '%', 1000, v => { app.brushTool.getDescriptor().scatterX = v; pushBrush(); });
    bindRaw('bs-scatter-y', 'bs-scatter-y-val', '%', 1000, v => { app.brushTool.getDescriptor().scatterY = v; pushBrush(); });
    bindRaw('bs-stamp-count', 'bs-stamp-count-val', '', 1, v => { app.brushTool.getDescriptor().stampCount = Math.max(1, Math.round(v)); pushBrush(); });

    // ── Color Dynamics ────────────────────────────────────────────────────────

    bindRaw('bs-hue-jitter',    'bs-hue-jitter-val',    '°', 1, v => { app.brushTool.getDescriptor().hueJitter = v; pushBrush(); });
    bind(   'bs-sat-jitter',    'bs-sat-jitter-val',    '%',    v => { app.brushTool.getDescriptor().satJitter = v; pushBrush(); });
    bind(   'bs-val-jitter',    'bs-val-jitter-val',    '%',    v => { app.brushTool.getDescriptor().valJitter = v; pushBrush(); });
    bind(   'bs-fg-bg-mix',     'bs-fg-bg-mix-val',     '%',    v => { app.brushTool.getDescriptor().colorFgBgMix = v; pushBrush(); });
    bindRaw('bs-hue-jitter-ps', 'bs-hue-jitter-ps-val', '°', 1, v => { app.brushTool.getDescriptor().hueJitterPerStroke = v; pushBrush(); });
    bind(   'bs-sat-jitter-ps', 'bs-sat-jitter-ps-val', '%',    v => { app.brushTool.getDescriptor().satJitterPerStroke = v; pushBrush(); });
    bind(   'bs-val-jitter-ps', 'bs-val-jitter-ps-val', '%',    v => { app.brushTool.getDescriptor().valJitterPerStroke = v; pushBrush(); });

    // ── Tapering (slider 0-100 → 0.0-0.20 in normalized canvas units) ─────────

    bindRaw('bs-taper-start', 'bs-taper-start-val', '%', 500, v => { app.brushTool.getDescriptor().taperStart = v; pushBrush(); });
    bindRaw('bs-taper-end',   'bs-taper-end-val',   '%', 500, v => { app.brushTool.getDescriptor().taperEnd   = v; pushBrush(); });
    bindToggle('bs-taper-size', on => { app.brushTool.getDescriptor().taperSizeLink    = on; pushBrush(); });
    bindToggle('bs-taper-opac', on => { app.brushTool.getDescriptor().taperOpacityLink = on; pushBrush(); });

    // ── Stabilization (slider 0-100 → 0.0-0.20 normalized canvas units) ───────

    bind('bs-smoothing', 'bs-smoothing-val', '%', v => { app.brushTool.getDescriptor().smoothing = v; pushBrush(); });
    bindRaw('bs-pull-string', 'bs-pull-string-val', '%', 500, v => { app.brushTool.getDescriptor().pullStringLength = v; pushBrush(); });
    bindToggle('bs-catch-up', on => { app.brushTool.getDescriptor().catchUpEnabled = on; pushBrush(); });
    bindToggle('bs-jitter-seed-lock', on => { app.brushTool.getDescriptor().jitterSeedLock = on; pushBrush(); });

    // ── Additional dynamics sliders ───────────────────────────────────────────
    bind('bs-size-min', 'bs-size-min-val', '%', v => { app.brushTool.getDescriptor().sizeMin = v; pushBrush(); });
    bind('bs-size-max', 'bs-size-max-val', '%', v => { app.brushTool.getDescriptor().sizeMax = v; pushBrush(); });
    bind('bs-opac-min', 'bs-opac-min-val', '%', v => { app.brushTool.getDescriptor().opacityMin = v; pushBrush(); });
    bind('bs-opac-max', 'bs-opac-max-val', '%', v => { app.brushTool.getDescriptor().opacityMax = v; pushBrush(); });
    bindRaw('bs-stamp-count-jitter', 'bs-stamp-count-jitter-val', '', 1, v => { app.brushTool.getDescriptor().stampCountJitter = Math.max(0, Math.round(v)); pushBrush(); });
    bind('bs-roundness-min',   'bs-roundness-min-val', '%', v => { app.brushTool.getDescriptor().roundnessMin = v; pushBrush(); });
    bind('bs-tilt-influence',  'bs-tilt-influence-val', '%', v => { app.brushTool.getDescriptor().tiltAngleInfluence = v; pushBrush(); });
    bindToggle('bs-tilt-shape', on => { app.brushTool.getDescriptor().tiltShape = on; pushBrush(); });
    bind('bs-wet-pressure', 'bs-wet-pressure-val', '%', v => {
        const d = app.brushTool.getDescriptor();
        if (v < 0.01) {
            d.wetnessPressureCurve = { mode: 'off', min: 0, max: 1 };
        } else {
            d.wetnessPressureCurve = { mode: 'linear', min: 1 - v, max: 1 };
        }
        pushBrush();
    });

    // ── Bristle ───────────────────────────────────────────────────────────────
    {
        const sl  = document.getElementById('bs-bristle-count')  as HTMLInputElement | null;
        const txt = document.getElementById('bs-bristle-count-val') as HTMLInputElement | null;
        sl?.addEventListener('input', () => {
            const n = parseInt(sl.value);
            if (txt) txt.value = String(n);
            app.brushTool.getDescriptor().bristleCount = n;
            pushBrush();
        });
    }
    {
        const sl  = document.getElementById('bs-bristle-length')  as HTMLInputElement | null;
        const txt = document.getElementById('bs-bristle-length-val') as HTMLInputElement | null;
        sl?.addEventListener('input', () => {
            const v = parseFloat(sl.value) / 100;
            if (txt) txt.value = v.toFixed(2);
            app.brushTool.getDescriptor().bristleLength = v;
            pushBrush();
        });
    }

    // ── Wet Mixing ────────────────────────────────────────────────────────────

    bind('bs-wetness',    'bs-wetness-val',    '%', v => { app.brushTool.getDescriptor().wetness   = v; pushBrush(); });
    bind('bs-paint-load', 'bs-paint-load-val', '%', v => { app.brushTool.getDescriptor().paintLoad = v; pushBrush(); });
    bind('bs-wet-edge',   'bs-wet-edge-val',   '%', v => { app.brushTool.getDescriptor().wetEdge   = v; pushBrush(); });

    // ── Texture / Grain ───────────────────────────────────────────────────────

    const GRAIN_BLEND_MODES: Array<'multiply'|'screen'|'overlay'|'normal'> = ['multiply','screen','overlay','normal'];
    const GRAIN_BLEND_IDS = ['bs-grain-multiply','bs-grain-screen','bs-grain-overlay','bs-grain-normal'];

    const syncGrainConfig = () => {
        const d = app.brushTool.getDescriptor();
        const blendMap: Record<string,number> = { multiply:0, screen:1, overlay:2, normal:3 };
        app.pipeline.brushRenderer.setConfig({
            blendMode:       'normal',
            grainDepth:      d.grainDepth,
            grainScale:      d.grainScale,
            grainRotation:   d.grainRotation * Math.PI / 180,
            grainContrast:   d.grainContrast,
            grainBrightness: d.grainBrightness,
            grainBlendMode:  blendMap[d.grainBlendMode] ?? 0,
            grainStatic:     d.grainStatic,
        });
    };

    bind(   'bs-grain-depth',       'bs-grain-depth-val',      '%', v => { app.brushTool.getDescriptor().grainDepth        = v;               pushBrush(); syncGrainConfig(); });
    bindRaw('bs-grain-scale',       'bs-grain-scale-val',      '', 100, v => { app.brushTool.getDescriptor().grainScale    = Math.max(0.05, v); pushBrush(); syncGrainConfig(); });
    bindRaw('bs-grain-rotation',    'bs-grain-rotation-val',   '°',  1, v => { app.brushTool.getDescriptor().grainRotation = v;                 pushBrush(); syncGrainConfig(); });
    bindRaw('bs-grain-contrast',    'bs-grain-contrast-val',   '', 100, v => { app.brushTool.getDescriptor().grainContrast  = Math.max(0.1, v); pushBrush(); syncGrainConfig(); });
    bindRaw('bs-grain-brightness',  'bs-grain-brightness-val', '', 100, v => { app.brushTool.getDescriptor().grainBrightness = v;               pushBrush(); syncGrainConfig(); });
    bindToggle('bs-grain-static', on => { app.brushTool.getDescriptor().grainStatic = on; pushBrush(); syncGrainConfig(); });

    GRAIN_BLEND_IDS.forEach((id, i) => {
        document.getElementById(id)?.addEventListener('click', () => {
            GRAIN_BLEND_IDS.forEach((bid, j) =>
                document.getElementById(bid)?.classList.toggle('active', i === j)
            );
            app.brushTool.getDescriptor().grainBlendMode = GRAIN_BLEND_MODES[i];
            pushBrush();
            syncGrainConfig();
        });
    });

    // ── Grain library thumbnails ──────────────────────────────────────────────
    {
        const GRAIN_NAMES = ['Noise','Paper','Rough','Cross','Stipple','Water','Charcoal','Linen'];
        const libraryEl   = document.getElementById('bs-grain-library');
        let activeGrainIdx = -1;

        if (libraryEl) {
            GRAIN_NAMES.forEach((name, i) => {
                const btn = document.createElement('button');
                btn.className   = 'btn-ghost';
                btn.title       = name;
                btn.dataset.idx = String(i);
                btn.style.cssText = 'padding:2px;height:36px;width:100%;font-size:8px;flex-direction:column;gap:2px;border-radius:4px;border:1px solid rgba(255,255,255,0.08);';
                btn.innerHTML = `<span style="font-size:8px;line-height:1;opacity:.6">${name}</span>`;
                btn.addEventListener('click', () => {
                    activeGrainIdx = (activeGrainIdx === i) ? -1 : i;
                    Array.from(libraryEl.children).forEach((el, j) =>
                        (el as HTMLElement).classList.toggle('active', j === activeGrainIdx)
                    );
                    if (activeGrainIdx >= 0) {
                        app.pipeline.brushRenderer.setGrainIndex(activeGrainIdx);
                        app.brushTool.getDescriptor().grainIndex = activeGrainIdx;
                    } else {
                        app.pipeline.brushRenderer.setGrainIndex(-1);
                        app.brushTool.getDescriptor().grainIndex = -1;
                    }
                    pushBrush();
                });
                libraryEl.appendChild(btn);
            });
        }
    }

    // ── Tip texture upload ────────────────────────────────────────────────────
    {
        const tipInput = document.createElement('input');
        tipInput.type = 'file'; tipInput.accept = 'image/png,image/jpeg,image/webp,image/bmp';
        tipInput.style.display = 'none'; document.body.appendChild(tipInput);
        let tipTexture: GPUTexture | null = null;

        document.getElementById('bs-tip-load-btn')?.addEventListener('click', () => tipInput.click());
        tipInput.addEventListener('change', async () => {
            const file = tipInput.files?.[0]; tipInput.value = '';
            if (!file) return;
            try {
                const bmp = await createImageBitmap(file, { resizeWidth: 256, resizeHeight: 256 });
                tipTexture?.destroy();
                tipTexture = app.pipeline.device.createTexture({
                    size: [256, 256], format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                });
                app.pipeline.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tipTexture }, [256, 256]);
                bmp.close();
                app.pipeline.brushRenderer.setTipTexture(tipTexture);
                const nameEl = document.getElementById('bs-tip-name');
                if (nameEl) nameEl.textContent = file.name.replace(/\.[^.]+$/, '');
                document.getElementById('bs-tip-clear-row')?.style.setProperty('display', '');
            } catch (e) { console.warn('Tip texture load failed:', e); }
        });
        document.getElementById('bs-tip-clear-btn')?.addEventListener('click', () => {
            tipTexture?.destroy(); tipTexture = null;
            app.pipeline.brushRenderer.setTipTexture(null);
            const nameEl = document.getElementById('bs-tip-name');
            if (nameEl) nameEl.textContent = 'Procedural (none)';
            document.getElementById('bs-tip-clear-row')?.style.setProperty('display', 'none');
        });
    }

    // ── Grain texture upload ───────────────────────────────────────────────────
    {
        const grainInput = document.createElement('input');
        grainInput.type = 'file'; grainInput.accept = 'image/png,image/jpeg,image/webp,image/bmp';
        grainInput.style.display = 'none'; document.body.appendChild(grainInput);
        let customGrainTexture: GPUTexture | null = null;

        document.getElementById('bs-grain-tex-load-btn')?.addEventListener('click', () => grainInput.click());
        grainInput.addEventListener('change', async () => {
            const file = grainInput.files?.[0]; grainInput.value = '';
            if (!file) return;
            try {
                const bmp = await createImageBitmap(file, { resizeWidth: 256, resizeHeight: 256 });
                customGrainTexture?.destroy();
                customGrainTexture = app.pipeline.device.createTexture({
                    size: [256, 256], format: 'rgba8unorm',
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
                });
                app.pipeline.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: customGrainTexture }, [256, 256]);
                bmp.close();
                app.pipeline.brushRenderer.setGrainTexture(customGrainTexture);
                const nameEl = document.getElementById('bs-grain-tex-name');
                if (nameEl) nameEl.textContent = file.name.replace(/\.[^.]+$/, '');
                document.getElementById('bs-grain-tex-clear-row')?.style.setProperty('display', '');
            } catch (e) { console.warn('Grain texture load failed:', e); }
        });
        document.getElementById('bs-grain-tex-clear-btn')?.addEventListener('click', () => {
            customGrainTexture?.destroy(); customGrainTexture = null;
            app.pipeline.brushRenderer.setGrainTexture(null);
            const nameEl = document.getElementById('bs-grain-tex-name');
            if (nameEl) nameEl.textContent = 'Procedural noise';
            document.getElementById('bs-grain-tex-clear-row')?.style.setProperty('display', 'none');
        });
    }

    // ── Layout helpers ────────────────────────────────────────────────────────

    const set     = (id: string, v: number) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = String(v); };
    const setTxt  = (id: string, t: string) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = t; };
    const show    = (id: string) => { const el = document.getElementById(id); if (el) el.style.display = ''; };
    const hide    = (id: string) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
    const setText = (id: string, t: string) => { const el = document.getElementById(id); if (el) el.textContent = t; };
    const setToggleEl = (id: string, on: boolean) => { document.getElementById(id)?.classList.toggle('on', on); };

    const syncLayout = (tool: string) => {
        if (tool === 'SelectionTool' || tool === 'FillTool' || tool === 'EyedropperTool') {
            hide('bs-painting-section');
            if (tool === 'SelectionTool') show('bs-selection-section');
            else hide('bs-selection-section');
            setText('bs-tool-title', tool === 'SelectionTool' ? 'Selection' : tool === 'FillTool' ? 'Fill' : 'Eyedropper');
        } else {
            show('bs-painting-section');
            hide('bs-selection-section');
            if (tool === 'BrushTool') {
                setText('bs-tool-title', 'Brush');
                show('bs-flow-row'); show('bs-mix-row');
                show('bs-pressure-section'); show('bs-scatter-section');
                show('bs-brush-adv');
                setText('bs-mix-label', 'Mix');
            } else if (tool === 'EraserTool') {
                setText('bs-tool-title', 'Eraser');
                hide('bs-flow-row'); hide('bs-mix-row');
                hide('bs-pressure-section'); hide('bs-scatter-section');
                hide('bs-brush-adv');
            } else if (tool === 'SmudgeTool') {
                setText('bs-tool-title', 'Smudge');
                hide('bs-flow-row'); show('bs-mix-row');
                hide('bs-pressure-section'); hide('bs-scatter-section');
                hide('bs-brush-adv');
                setText('bs-mix-label', 'Strength');
            }
        }
    };

    // ── Sync functions ────────────────────────────────────────────────────────

    const syncToSmudge = () => {
        const d = app.smudgeTool.getDescriptor();
        set('bs-opacity',  pct(d.opacity));              setTxt('bs-opacity-val',  pct(d.opacity) + '%');
        set('bs-hardness', pct(d.hardness));             setTxt('bs-hardness-val', pct(d.hardness) + '%');
        { const sv = Math.round(d.spacing * 200) / 2; set('bs-spacing', sv); setTxt('bs-spacing-val', (sv % 1 === 0 ? sv.toFixed(0) : sv.toFixed(1)) + '%'); }
        set('bs-mix',      pct(d.smudge));               setTxt('bs-mix-val',      pct(d.smudge) + '%');
        set('bs-roundness', pct(d.roundness));            setTxt('bs-roundness-val', pct(d.roundness) + '%');
    };
    const syncToEraser = () => {
        const d = app.eraserTool.getDescriptor();
        set('bs-opacity',  pct(d.opacity));              setTxt('bs-opacity-val',  pct(d.opacity) + '%');
        set('bs-hardness', pct(d.hardness));             setTxt('bs-hardness-val', pct(d.hardness) + '%');
        { const sv = Math.round(d.spacing * 200) / 2; set('bs-spacing', sv); setTxt('bs-spacing-val', (sv % 1 === 0 ? sv.toFixed(0) : sv.toFixed(1)) + '%'); }
        set('bs-roundness', pct(d.roundness));            setTxt('bs-roundness-val', pct(d.roundness) + '%');
    };
    const syncToBrush = () => {
        const d = app.brushTool.getDescriptor();
        set('bs-opacity',  pct(d.opacity));              setTxt('bs-opacity-val',  pct(d.opacity) + '%');
        set('bs-hardness', pct(d.hardness));             setTxt('bs-hardness-val', pct(d.hardness) + '%');
        { const sv = Math.round(d.spacing * 200) / 2; set('bs-spacing', sv); setTxt('bs-spacing-val', (sv % 1 === 0 ? sv.toFixed(0) : sv.toFixed(1)) + '%'); }
        set('bs-mix',      pct(d.smudge));               setTxt('bs-mix-val',      pct(d.smudge) + '%');
        set('bs-flow',     pct(d.flow));                 setTxt('bs-flow-val',     pct(d.flow) + '%');

        // Shape
        set('bs-smoothing', pct(d.smoothing ?? 0));       setTxt('bs-smoothing-val', pct(d.smoothing ?? 0) + '%');
        set('bs-roundness', pct(d.roundness));            setTxt('bs-roundness-val', pct(d.roundness) + '%');
        set('bs-angle',     Math.round(d.angle));         setTxt('bs-angle-val',     Math.round(d.angle) + '°');
        setToggleEl('bs-follow-stroke', d.followStroke);

        // Dynamics
        const flowPresStr = d.flowPressureCurve.mode === 'off' ? 0 : Math.round((1 - (d.flowPressureCurve.min ?? 0)) * 100);
        set('bs-pres-flow', flowPresStr); setTxt('bs-pres-flow-val', flowPresStr + '%');

        // Curve editors
        sizeCurveEditor?.setSpec(d.sizePressureCurve);
        sizeTiltCurveEditor?.setSpec(d.sizeTiltCurve);
        sizeSpeedCurveEditor?.setSpec(d.sizeSpeedCurve);
        opacityCurveEditor?.setSpec(d.opacityPressureCurve);
        opacitySpeedCurveEditor?.setSpec(d.opacitySpeedCurve);
        flowCurveEditor?.setSpec(d.flowPressureCurve);
        roundnessTiltCurveEditor?.setSpec(d.roundnessTiltCurve);
        roundnessPressureCurveEditor?.setSpec(d.roundnessPressureCurve);
        scatterPressureCurveEditor?.setSpec(d.scatterPressureCurve);
        grainDepthCurveEditor?.setSpec(d.grainDepthCurve);
        colorMixCurveEditor?.setSpec(d.colorMixPressureCurve);

        // Scatter
        set('bs-angle-jitter', Math.round(d.angleJitter));  setTxt('bs-angle-jitter-val', Math.round(d.angleJitter) + '°');
        set('bs-scatter-x',    Math.round(d.scatterX * 1000)); setTxt('bs-scatter-x-val', Math.round(d.scatterX * 1000) + '%');
        set('bs-scatter-y',    Math.round(d.scatterY * 1000)); setTxt('bs-scatter-y-val', Math.round(d.scatterY * 1000) + '%');
        set('bs-stamp-count',  d.stampCount);               setTxt('bs-stamp-count-val', String(d.stampCount));

        // Color Dynamics
        set('bs-hue-jitter',    Math.round(d.hueJitter));    setTxt('bs-hue-jitter-val',    Math.round(d.hueJitter) + '°');
        set('bs-sat-jitter',    pct(d.satJitter));            setTxt('bs-sat-jitter-val',    pct(d.satJitter) + '%');
        set('bs-val-jitter',    pct(d.valJitter));            setTxt('bs-val-jitter-val',    pct(d.valJitter) + '%');
        set('bs-fg-bg-mix',     pct(d.colorFgBgMix));        setTxt('bs-fg-bg-mix-val',     pct(d.colorFgBgMix) + '%');
        set('bs-hue-jitter-ps', Math.round(d.hueJitterPerStroke)); setTxt('bs-hue-jitter-ps-val', Math.round(d.hueJitterPerStroke) + '°');
        set('bs-sat-jitter-ps', pct(d.satJitterPerStroke));  setTxt('bs-sat-jitter-ps-val', pct(d.satJitterPerStroke) + '%');
        set('bs-val-jitter-ps', pct(d.valJitterPerStroke));  setTxt('bs-val-jitter-ps-val', pct(d.valJitterPerStroke) + '%');

        // Tapering (0-0.20 → slider 0-100, multiply by 500)
        set('bs-taper-start', Math.round(d.taperStart * 500)); setTxt('bs-taper-start-val', Math.round(d.taperStart * 500) + '%');
        set('bs-taper-end',   Math.round(d.taperEnd   * 500)); setTxt('bs-taper-end-val',   Math.round(d.taperEnd   * 500) + '%');
        setToggleEl('bs-taper-size', d.taperSizeLink);
        setToggleEl('bs-taper-opac', d.taperOpacityLink);

        // Stabilization (0-0.20 → slider 0-100)
        set('bs-pull-string', Math.round(d.pullStringLength * 500)); setTxt('bs-pull-string-val', Math.round(d.pullStringLength * 500) + '%');
        setToggleEl('bs-catch-up', d.catchUpEnabled);
        setToggleEl('bs-jitter-seed-lock', d.jitterSeedLock ?? false);

        // Additional dynamics
        set('bs-size-min',  pct(d.sizeMin));          setTxt('bs-size-min-val',  pct(d.sizeMin) + '%');
        set('bs-size-max',  pct(d.sizeMax === 0 ? 1 : d.sizeMax));  setTxt('bs-size-max-val',  pct(d.sizeMax === 0 ? 1 : d.sizeMax) + '%');
        set('bs-opac-min',  pct(d.opacityMin));        setTxt('bs-opac-min-val',  pct(d.opacityMin) + '%');
        set('bs-opac-max',  pct(d.opacityMax === 0 ? 1 : d.opacityMax)); setTxt('bs-opac-max-val',  pct(d.opacityMax === 0 ? 1 : d.opacityMax) + '%');
        set('bs-stamp-count-jitter', d.stampCountJitter);  setTxt('bs-stamp-count-jitter-val', String(d.stampCountJitter));
        set('bs-roundness-min',  pct(d.roundnessMin));  setTxt('bs-roundness-min-val',  pct(d.roundnessMin) + '%');
        set('bs-tilt-influence', pct(d.tiltAngleInfluence)); setTxt('bs-tilt-influence-val', pct(d.tiltAngleInfluence) + '%');
        setToggleEl('bs-tilt-shape', d.tiltShape);
        const wetPresStr = d.wetnessPressureCurve?.mode === 'off' ? 0 : Math.round((1 - (d.wetnessPressureCurve?.min ?? 0)) * 100);
        set('bs-wet-pressure', wetPresStr); setTxt('bs-wet-pressure-val', wetPresStr + '%');

        // Dynamics (pressure)
        set('bs-pres-size', pct(d.pressureSize)); setTxt('bs-pres-size-val', pct(d.pressureSize) + '%');
        set('bs-pres-opac', pct(d.pressureOpacity)); setTxt('bs-pres-opac-val', pct(d.pressureOpacity) + '%');
        set('bs-size-jitter', pct(d.sizeJitter)); setTxt('bs-size-jitter-val', pct(d.sizeJitter) + '%');
        set('bs-opac-jitter', pct(d.opacityJitter)); setTxt('bs-opac-jitter-val', pct(d.opacityJitter) + '%');

        // Bristle
        set('bs-bristle-count',  d.bristleCount ?? 0);               setTxt('bs-bristle-count-val', String(d.bristleCount ?? 0));
        set('bs-bristle-length', Math.round((d.bristleLength ?? 0.8) * 100));
        setTxt('bs-bristle-length-val', (d.bristleLength ?? 0.8).toFixed(2));

        // Wet Mixing
        set('bs-wetness',    pct(d.wetness));             setTxt('bs-wetness-val',    pct(d.wetness) + '%');
        set('bs-paint-load', pct(d.paintLoad));           setTxt('bs-paint-load-val', pct(d.paintLoad) + '%');
        set('bs-wet-edge',   pct(d.wetEdge ?? 0));        setTxt('bs-wet-edge-val',   pct(d.wetEdge ?? 0) + '%');

        // Texture / Grain
        set('bs-grain-depth',      pct(d.grainDepth));                    setTxt('bs-grain-depth-val',      pct(d.grainDepth) + '%');
        set('bs-grain-scale',      Math.round(d.grainScale * 100));        setTxt('bs-grain-scale-val',      (d.grainScale).toFixed(2));
        set('bs-grain-rotation',   Math.round(d.grainRotation));           setTxt('bs-grain-rotation-val',   Math.round(d.grainRotation) + '°');
        set('bs-grain-contrast',   Math.round(d.grainContrast * 100));     setTxt('bs-grain-contrast-val',   d.grainContrast.toFixed(2));
        set('bs-grain-brightness', Math.round(d.grainBrightness * 100));   setTxt('bs-grain-brightness-val', d.grainBrightness.toFixed(2));
        setToggleEl('bs-grain-static', d.grainStatic);
        const blendIdx = { multiply:0, screen:1, overlay:2, normal:3 }[d.grainBlendMode] ?? 0;
        ['bs-grain-multiply','bs-grain-screen','bs-grain-overlay','bs-grain-normal'].forEach(
            (id, i) => document.getElementById(id)?.classList.toggle('active', i === blendIdx)
        );
        syncGrainConfig();
        schedulePreview();
    };

    app.bus.on('tool:change', ({ tool }) => {
        syncLayout(tool);
        if (tool === 'SmudgeTool') syncToSmudge();
        else if (tool === 'EraserTool') syncToEraser();
        else if (tool === 'BrushTool') syncToBrush();
    });
}

bootstrap();
