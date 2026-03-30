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
        const { device, context, format, canvas, supportsTimestamps, supportsBlendHalfFloat } = await initGPU();

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
            supportsTimestamps, fps, supportsBlendHalfFloat
        );
        app.initBrushCursor();

        // ── Panels ────────────────────────────────────────────────────────────
        for (const id of ['leftPanel','rightPanel','layerPanel','brushPanel','brushSettingsPanel','prefsPanel','exportPanel']) {
            const p = document.getElementById(id);
            if (p) { makeDraggable(p); addResizeHandles(p, { minW: 60, minH: 80 }); }
        }
        new PanelManager();

        // Pen/stylus: bypass OS gesture-classification delay on range sliders.
        // With touch-action:none the browser still delays the first pointermove for
        // native range inputs. Instead we capture immediately and drive the value
        // ourselves so the very first pen contact updates the slider.
        document.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            const inp = e.target as HTMLInputElement;
            if (!inp.matches('input[type="range"]')) return;
            e.preventDefault(); // prevent native range drag (we drive it manually)
            inp.setPointerCapture(e.pointerId);

            const updateFromEvent = (ev: PointerEvent) => {
                const rect = inp.getBoundingClientRect();
                const min  = parseFloat(inp.min)  || 0;
                const max  = parseFloat(inp.max)  || 1;
                const step = parseFloat(inp.step) || 0;
                let t = (ev.clientX - rect.left) / rect.width;
                t = Math.max(0, Math.min(1, t));
                let val = min + t * (max - min);
                if (step > 0) val = Math.round(val / step) * step;
                // clamp to precision of step
                const decimals = step > 0 ? Math.max(0, -Math.floor(Math.log10(step))) : 6;
                val = parseFloat(val.toFixed(decimals));
                if (inp.value !== String(val)) {
                    inp.value = String(val);
                    inp.dispatchEvent(new Event('input', { bubbles: true }));
                }
            };

            updateFromEvent(e); // immediate feedback on first contact

            const onMove = (ev: PointerEvent) => updateFromEvent(ev);
            const onUp   = () => {
                inp.removeEventListener('pointermove', onMove);
                inp.removeEventListener('pointerup',   onUp);
                inp.removeEventListener('pointercancel', onUp);
                inp.dispatchEvent(new Event('change', { bubbles: true }));
            };
            inp.addEventListener('pointermove', onMove);
            inp.addEventListener('pointerup',   onUp);
            inp.addEventListener('pointercancel', onUp);
        }, { capture: true, passive: false });

        // Pen/stylus scroll for panel scroll containers.
        //
        // Problem: touch-action:none on .float-panel (needed for panel drag) cascades
        // to ALL descendants, blocking native browser scroll on every child — including
        // scrollable containers (.bs-body, .layer-list, etc.).  The CSS touch-action:pan-y
        // on those containers has no effect because an ancestor's 'none' wins.
        //
        // Solution: capture the pointerdown on the scroll container, set pointer capture
        // so all subsequent pointermove events route here, then drive scrollTop manually.
        //
        // Critical: do NOT call e.preventDefault() here.  Calling it on a pen pointerdown
        // suppresses the browser's synthetic mousedown event (W3C spec), which would break
        // layer-row selection and brush-preset clicks that listen on mousedown/click.
        // The INTERACTIVE change in panel-manager.ts ensures makeDraggable never calls
        // e.preventDefault() for events originating inside scroll containers.
        document.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse') return;
            const target  = e.target as HTMLElement;
            const scroller = target.closest('.bs-body, .layer-list, .bp-list, .prefs-body') as HTMLElement | null;
            if (!scroller) return;
            // Interactive children handle themselves; don't steal their events.
            if (target.closest('button,input,select,textarea,[contenteditable],a,summary,.bp-item,.bp-filter-chip,.layer-drag-handle')) return;

            // Capture the pointer on the scroll container so pointermove goes here,
            // not to the panel drag handler.  No preventDefault — mousedown must still fire.
            scroller.setPointerCapture(e.pointerId);
            let prevY = e.clientY;

            const onMove = (ev: PointerEvent) => {
                scroller.scrollTop -= ev.clientY - prevY;
                prevY = ev.clientY;
            };
            const onUp = () => {
                scroller.removeEventListener('pointermove',   onMove);
                scroller.removeEventListener('pointerup',     onUp);
                scroller.removeEventListener('pointercancel', onUp);
            };
            scroller.addEventListener('pointermove',   onMove);
            scroller.addEventListener('pointerup',     onUp);
            scroller.addEventListener('pointercancel', onUp);
        }, { capture: true, passive: true });


        // ── Color ─────────────────────────────────────────────────────────────
        const colorState = new ColorState(app.bus);
        new ColorPickerUI(colorState);

        let eyedropperChanging = false;
        colorState.subscribeLocal(() => {
            const { rgb } = colorState;
            app.setBrushColor(rgb.r / 255, rgb.g / 255, rgb.b / 255, 1.0);
            // Color picker interaction → switch to paint mode (but not when eyedropper sets the color)
            if (!eyedropperChanging) app.usePaintMode();
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
        if (isEraser()) return;  // Eraser uses its own descriptor, not the preset store
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
            drawPreview(previewCanvas, app.activeBrushTool.getDescriptor());
        }, 60);
    };

    /** Push descriptor to worker and save to active preset. */
    const pushBrush = () => { app.brushTool.pushDescriptor(); notifyBrushChange(); schedulePreview(); };

    // ── Binding helpers ───────────────────────────────────────────────────────

    /** Draw an ImageBitmap thumbnail into a canvas element (call before bmp.close()). */
    const drawThumb = (id: string, bmp: ImageBitmap) => {
        const c = document.getElementById(id) as HTMLCanvasElement | null;
        if (!c) return;
        c.style.display = 'block';
        const ctx = c.getContext('2d');
        if (ctx) { ctx.clearRect(0, 0, 48, 48); ctx.drawImage(bmp, 0, 0, 48, 48); }
    };
    const clearThumb = (id: string) => {
        const c = document.getElementById(id) as HTMLCanvasElement | null;
        if (c) c.style.display = 'none';
    };

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

    // ── Dynamics popup ────────────────────────────────────────────────────────
    {
        const popup    = document.getElementById('dyn-popup')!;
        const titleEl  = document.getElementById('dyn-popup-title')!;
        const closeBtn = document.getElementById('dyn-popup-close')!;
        const noteEl   = document.getElementById('dyn-popup-note') as HTMLElement;

        const SOURCE_KEYS = ['pressure', 'tilt', 'velocity', 'random'] as const;
        type SourceKey = typeof SOURCE_KEYS[number];

        interface SourceConfig {
            getEnabled(): boolean;
            setEnabled(on: boolean): void;
            getMin(): number;
            setMin(v: number): void;
            getMax(): number;
            setMax(v: number): void;
        }
        interface ParamConfig { title: string; sources: Partial<Record<SourceKey, SourceConfig>>; }

        function getCurveEnabled(spec: { mode: string }): boolean { return spec.mode !== 'off'; }
        function setCurveMode(spec: { mode: string; min: number; max: number; [k: string]: unknown }, on: boolean) {
            return { ...spec, mode: on ? 'linear' : 'off' };
        }

        const PARAM_CONFIGS: Record<string, ParamConfig> = {
            size: {
                title: 'Size',
                sources: {
                    pressure: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().sizePressureCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.sizePressureCurve = setCurveMode(d.sizePressureCurve, on) as typeof d.sizePressureCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().sizePressureCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.sizePressureCurve = { ...d.sizePressureCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().sizePressureCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.sizePressureCurve = { ...d.sizePressureCurve, max: v }; pushBrush(); },
                    },
                    tilt: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().sizeTiltCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.sizeTiltCurve = setCurveMode(d.sizeTiltCurve, on) as typeof d.sizeTiltCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().sizeTiltCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.sizeTiltCurve = { ...d.sizeTiltCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().sizeTiltCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.sizeTiltCurve = { ...d.sizeTiltCurve, max: v }; pushBrush(); },
                    },
                    velocity: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().sizeSpeedCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.sizeSpeedCurve = setCurveMode(d.sizeSpeedCurve, on) as typeof d.sizeSpeedCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().sizeSpeedCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.sizeSpeedCurve = { ...d.sizeSpeedCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().sizeSpeedCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.sizeSpeedCurve = { ...d.sizeSpeedCurve, max: v }; pushBrush(); },
                    },
                    random: {
                        getEnabled: () => app.brushTool.getDescriptor().sizeJitter > 0,
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); if (!on) { d.sizeJitter = 0; } else if (d.sizeJitter === 0) { d.sizeJitter = 0.5; } pushBrush(); },
                        getMin: () => 0,
                        setMin: (_) => {},
                        getMax: () => app.brushTool.getDescriptor().sizeJitter,
                        setMax: (v) => { app.brushTool.getDescriptor().sizeJitter = v; pushBrush(); },
                    },
                },
            },
            opacity: {
                title: 'Opacity',
                sources: {
                    pressure: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().opacityPressureCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.opacityPressureCurve = setCurveMode(d.opacityPressureCurve, on) as typeof d.opacityPressureCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().opacityPressureCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.opacityPressureCurve = { ...d.opacityPressureCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().opacityPressureCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.opacityPressureCurve = { ...d.opacityPressureCurve, max: v }; pushBrush(); },
                    },
                    velocity: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().opacitySpeedCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.opacitySpeedCurve = setCurveMode(d.opacitySpeedCurve, on) as typeof d.opacitySpeedCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().opacitySpeedCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.opacitySpeedCurve = { ...d.opacitySpeedCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().opacitySpeedCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.opacitySpeedCurve = { ...d.opacitySpeedCurve, max: v }; pushBrush(); },
                    },
                    random: {
                        getEnabled: () => app.brushTool.getDescriptor().opacityJitter > 0,
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); if (!on) { d.opacityJitter = 0; } else if (d.opacityJitter === 0) { d.opacityJitter = 0.5; } pushBrush(); },
                        getMin: () => 0,
                        setMin: (_) => {},
                        getMax: () => app.brushTool.getDescriptor().opacityJitter,
                        setMax: (v) => { app.brushTool.getDescriptor().opacityJitter = v; pushBrush(); },
                    },
                },
            },
            flow: {
                title: 'Flow',
                sources: {
                    pressure: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().flowPressureCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.flowPressureCurve = setCurveMode(d.flowPressureCurve, on) as typeof d.flowPressureCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().flowPressureCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.flowPressureCurve = { ...d.flowPressureCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().flowPressureCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.flowPressureCurve = { ...d.flowPressureCurve, max: v }; pushBrush(); },
                    },
                },
            },
            roundness: {
                title: 'Roundness',
                sources: {
                    pressure: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().roundnessPressureCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.roundnessPressureCurve = setCurveMode(d.roundnessPressureCurve, on) as typeof d.roundnessPressureCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().roundnessPressureCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.roundnessPressureCurve = { ...d.roundnessPressureCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().roundnessPressureCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.roundnessPressureCurve = { ...d.roundnessPressureCurve, max: v }; pushBrush(); },
                    },
                    tilt: {
                        getEnabled: () => getCurveEnabled(app.brushTool.getDescriptor().roundnessTiltCurve),
                        setEnabled: (on) => { const d = app.brushTool.getDescriptor(); d.roundnessTiltCurve = setCurveMode(d.roundnessTiltCurve, on) as typeof d.roundnessTiltCurve; pushBrush(); },
                        getMin: () => app.brushTool.getDescriptor().roundnessTiltCurve.min,
                        setMin: (v) => { const d = app.brushTool.getDescriptor(); d.roundnessTiltCurve = { ...d.roundnessTiltCurve, min: v }; pushBrush(); },
                        getMax: () => app.brushTool.getDescriptor().roundnessTiltCurve.max,
                        setMax: (v) => { const d = app.brushTool.getDescriptor(); d.roundnessTiltCurve = { ...d.roundnessTiltCurve, max: v }; pushBrush(); },
                    },
                },
            },
        };

        function updateFill(src: SourceKey): void {
            const lo   = document.getElementById(`dyn-${src}-lo`)   as HTMLInputElement | null;
            const hi   = document.getElementById(`dyn-${src}-hi`)   as HTMLInputElement | null;
            const fill = document.querySelector(`#dyn-row-${src} .dual-fill`) as HTMLElement | null;
            if (!lo || !hi || !fill) return;
            const lv = parseInt(lo.value), hv = parseInt(hi.value);
            fill.style.left  = lv + '%';
            fill.style.width = Math.max(0, hv - lv) + '%';
            lo.style.zIndex  = lv > 90 ? '3' : '1';
        }

        function loadParam(key: string | null): void {
            const cfg = key ? PARAM_CONFIGS[key] : null;
            noteEl.style.display = cfg ? 'none' : '';
            for (const src of SOURCE_KEYS) {
                const row    = document.getElementById(`dyn-row-${src}`);
                const srcCfg = cfg?.sources[src];
                if (!row) continue;
                row.style.display = (cfg && srcCfg) ? '' : 'none';
                if (!srcCfg) continue;
                const chk   = document.getElementById(`dyn-${src}-chk`)  as HTMLInputElement | null;
                const minEl = document.getElementById(`dyn-${src}-min`)   as HTMLInputElement | null;
                const lo    = document.getElementById(`dyn-${src}-lo`)    as HTMLInputElement | null;
                const hi    = document.getElementById(`dyn-${src}-hi`)    as HTMLInputElement | null;
                const maxEl = document.getElementById(`dyn-${src}-max`)   as HTMLInputElement | null;
                if (chk)   chk.checked  = srcCfg.getEnabled();
                const minV = Math.round(srcCfg.getMin() * 100);
                const maxV = Math.round(srcCfg.getMax() * 100);
                if (lo)    lo.value     = String(minV);
                if (hi)    hi.value     = String(maxV);
                if (minEl) minEl.value  = minV + '%';
                if (maxEl) maxEl.value  = maxV + '%';
                updateFill(src);
            }
        }

        let openDynBtn: HTMLElement | null = null;
        let openParamKey: string | null    = null;

        function closeDynPopup(): void {
            popup.classList.remove('open');
            if (openDynBtn) openDynBtn.classList.remove('active');
            openDynBtn   = null;
            openParamKey = null;
        }

        function openDynPopup(key: string | null, btn: HTMLElement): void {
            if (openDynBtn === btn && popup.classList.contains('open')) { closeDynPopup(); return; }
            if (openDynBtn) openDynBtn.classList.remove('active');
            openDynBtn   = btn;
            openParamKey = key;
            const cfg    = key ? PARAM_CONFIGS[key] : null;
            titleEl.textContent = (cfg?.title ?? 'Dynamics') + ' — Dynamics';
            loadParam(key);
            popup.classList.add('open');
            btn.classList.add('active');
            const r  = btn.getBoundingClientRect();
            const pw = popup.offsetWidth  || 330;
            const ph = popup.offsetHeight || 200;
            let   lft = r.right + 6;
            if (lft + pw > window.innerWidth - 4) lft = r.left - pw - 6;
            popup.style.left = Math.max(4, lft) + 'px';
            popup.style.top  = Math.max(4, Math.min(r.top, window.innerHeight - ph - 4)) + 'px';
        }

        // Per-source event wiring
        for (const src of SOURCE_KEYS) {
            const chk   = document.getElementById(`dyn-${src}-chk`)  as HTMLInputElement | null;
            const minEl = document.getElementById(`dyn-${src}-min`)   as HTMLInputElement | null;
            const lo    = document.getElementById(`dyn-${src}-lo`)    as HTMLInputElement | null;
            const hi    = document.getElementById(`dyn-${src}-hi`)    as HTMLInputElement | null;
            const maxEl = document.getElementById(`dyn-${src}-max`)   as HTMLInputElement | null;

            chk?.addEventListener('change', () => {
                if (!openParamKey) return;
                const s = PARAM_CONFIGS[openParamKey]?.sources[src];
                if (!s) return;
                s.setEnabled(chk!.checked);
                loadParam(openParamKey);
            });
            lo?.addEventListener('input', () => {
                if (!openParamKey) return;
                const s = PARAM_CONFIGS[openParamKey]?.sources[src];
                if (!s) return;
                let lv = parseInt(lo!.value), hv = parseInt(hi?.value ?? '100');
                if (lv > hv) { lv = hv; lo!.value = String(lv); }
                if (minEl) minEl.value = lv + '%';
                s.setMin(lv / 100);
                updateFill(src);
            });
            hi?.addEventListener('input', () => {
                if (!openParamKey) return;
                const s = PARAM_CONFIGS[openParamKey]?.sources[src];
                if (!s) return;
                let hv = parseInt(hi!.value), lv = parseInt(lo?.value ?? '0');
                if (hv < lv) { hv = lv; hi!.value = String(hv); }
                if (maxEl) maxEl.value = hv + '%';
                s.setMax(hv / 100);
                updateFill(src);
            });
            minEl?.addEventListener('change', () => {
                if (!openParamKey) return;
                const s = PARAM_CONFIGS[openParamKey]?.sources[src];
                if (!s) return;
                const v = Math.max(0, Math.min(100, parseInt(minEl!.value) || 0));
                minEl!.value = v + '%';
                if (lo) lo.value = String(v);
                s.setMin(v / 100);
                updateFill(src);
            });
            maxEl?.addEventListener('change', () => {
                if (!openParamKey) return;
                const s = PARAM_CONFIGS[openParamKey]?.sources[src];
                if (!s) return;
                const v = Math.max(0, Math.min(100, parseInt(maxEl!.value) || 0));
                maxEl!.value = v + '%';
                if (hi) hi.value = String(v);
                s.setMax(v / 100);
                updateFill(src);
            });
        }

        closeBtn.addEventListener('click', closeDynPopup);
        document.addEventListener('mousedown', (e) => {
            if (!popup.classList.contains('open')) return;
            const t = e.target as Element;
            if (!popup.contains(t) && !t.closest?.('.curve-btn')) closeDynPopup();
        });

        // Wired param keys
        const BTN_MAP: Record<string, string> = {
            'bs-opacity-dyn-btn':   'opacity',
            'bs-flow-dyn-btn':      'flow',
            'bs-size-dyn-btn':      'size',
            'bs-roundness-dyn-btn': 'roundness',
        };

        document.querySelectorAll<HTMLButtonElement>('.curve-btn').forEach(btn => {
            btn.addEventListener('click', () => openDynPopup(BTN_MAP[btn.id] ?? null, btn));
        });
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
    // Wet-mix dynamics (shared — apply in both brush and smudge modes)
    bind('bs-smudge-charge',   'bs-smudge-charge-val',   '%', v => { app.brushTool.setCharge(v);   app.smudgeTool.setCharge(v);   });
    bind('bs-smudge-dilution', 'bs-smudge-dilution-val', '%', v => { app.brushTool.setDilution(v); app.smudgeTool.setDilution(v); });
    bind('bs-smudge-attack',   'bs-smudge-attack-val',   '%', v => { app.brushTool.setAttack(v);   app.smudgeTool.setAttack(v);   });
    bind('bs-smudge-grade',    'bs-smudge-grade-val',    '%', v => { app.brushTool.setGrade(v);    app.smudgeTool.setGrade(v);    });

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

    // ── Color Dynamics ────────────────────────────────────────────────────────

    bindRaw('bs-hue-jitter',    'bs-hue-jitter-val',    '°', 1, v => { app.brushTool.getDescriptor().hueJitter = v; pushBrush(); });
    bind(   'bs-sat-jitter',    'bs-sat-jitter-val',    '%',    v => { app.brushTool.getDescriptor().satJitter = v; pushBrush(); });
    bind(   'bs-val-jitter',    'bs-val-jitter-val',    '%',    v => { app.brushTool.getDescriptor().valJitter = v; pushBrush(); });
    bindRaw('bs-hue-jitter-ps', 'bs-hue-jitter-ps-val', '°', 1, v => { app.brushTool.getDescriptor().hueJitterPerStroke = v; pushBrush(); });
    bind(   'bs-sat-jitter-ps', 'bs-sat-jitter-ps-val', '%',    v => { app.brushTool.getDescriptor().satJitterPerStroke = v; pushBrush(); });
    bind(   'bs-val-jitter-ps', 'bs-val-jitter-ps-val', '%',    v => { app.brushTool.getDescriptor().valJitterPerStroke = v; pushBrush(); });

    // ── Stabilization (slider 0-100 → 0.0-0.20 normalized canvas units) ───────

    bind('bs-smoothing', 'bs-smoothing-val', '%', v => { app.brushTool.getDescriptor().smoothing = v; pushBrush(); });
    bindRaw('bs-pull-string', 'bs-pull-string-val', '%', 500, v => { app.brushTool.getDescriptor().pullStringLength = v; pushBrush(); });
    bindToggle('bs-catch-up', on => { app.brushTool.getDescriptor().catchUpEnabled = on; pushBrush(); });

    // ── Additional dynamics sliders ───────────────────────────────────────────
    bind('bs-size-min', 'bs-size-min-val', '%', v => { app.brushTool.getDescriptor().sizeMin = v; pushBrush(); });
    bind('bs-size-max', 'bs-size-max-val', '%', v => { app.brushTool.getDescriptor().sizeMax = v; pushBrush(); });
    bind('bs-opac-min', 'bs-opac-min-val', '%', v => { app.brushTool.getDescriptor().opacityMin = v; pushBrush(); });
    bind('bs-opac-max', 'bs-opac-max-val', '%', v => { app.brushTool.getDescriptor().opacityMax = v; pushBrush(); });
    bind('bs-roundness-min',   'bs-roundness-min-val', '%', v => { app.brushTool.getDescriptor().roundnessMin = v; pushBrush(); });
    bind('bs-tilt-influence',  'bs-tilt-influence-val', '%', v => { app.brushTool.getDescriptor().tiltAngleInfluence = v; pushBrush(); });
    bindToggle('bs-tilt-enabled', on => {
        app.brushTool.getDescriptor().tiltEnabled = on;
        app.setBrushTiltActive(on);
        pushBrush();
    });
    bindToggle('bs-tilt-shape', on => { app.brushTool.getDescriptor().tiltShape = on; pushBrush(); });

    // ── Glaze / Accumulation mode ─────────────────────────────────────────────
    const glazeModes = ['off', 'light', 'uniform', 'heavy', 'intense'] as const;
    const glazeBtnIds = ['bs-glaze-off', 'bs-glaze-light', 'bs-glaze-uniform', 'bs-glaze-heavy', 'bs-glaze-intense'];
    const setGlazeMode = (mode: typeof glazeModes[number]) => {
        app.brushTool.getDescriptor().glazeMode = mode;
        app.pipeline.brushRenderer.setGlazeMode(mode);
        glazeBtnIds.forEach((id, i) =>
            document.getElementById(id)?.classList.toggle('active', glazeModes[i] === mode)
        );
        pushBrush();
    };
    glazeBtnIds.forEach((id, i) =>
        document.getElementById(id)?.addEventListener('click', () => setGlazeMode(glazeModes[i]))
    );
    bind('bs-wet-pressure', 'bs-wet-pressure-val', '%', v => {
        const d = app.brushTool.getDescriptor();
        if (v < 0.01) {
            d.wetnessPressureCurve = { mode: 'off', min: 0, max: 1 };
        } else {
            d.wetnessPressureCurve = { mode: 'linear', min: 1 - v, max: 1 };
        }
        pushBrush();
    });

    // ── Wet Mixing ────────────────────────────────────────────────────────────

    bind('bs-wetness',    'bs-wetness-val',    '%', v => { app.brushTool.getDescriptor().wetness   = v; pushBrush(); });
    bind('bs-paint-load', 'bs-paint-load-val', '%', v => { app.brushTool.getDescriptor().paintLoad = v; pushBrush(); });
    bind('bs-wet-edge',   'bs-wet-edge-val',   '%', v => { app.brushTool.getDescriptor().wetEdge   = v; pushBrush(); });

    // ── Texture / Grain ───────────────────────────────────────────────────────

    const syncGrainConfig = () => {
        const d = app.brushTool.getDescriptor();
        app.pipeline.brushRenderer.setConfig({
            blendMode:       'normal',
            grainDepth:      d.grainDepth,
            grainScale:      d.grainScale,
            grainRotation:   d.grainRotation * Math.PI / 180,
            grainContrast:   d.grainContrast,
            grainBrightness: d.grainBrightness,
            grainBlendMode:  0,
            grainStatic:     d.grainStatic,
        });
    };

    const updateGrainPreview = () => {
        const canvas = document.getElementById('bs-grain-preview') as HTMLCanvasElement | null;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const d = app.brushTool.getDescriptor();
        const W = canvas.width, H = canvas.height;
        const srcSize = 256;
        const pixels = app.pipeline.brushRenderer.getGrainPixelData(d.grainIndex);
        if (!pixels) { ctx.clearRect(0, 0, W, H); return; }
        const imgData = ctx.createImageData(srcSize, srcSize);
        for (let i = 0; i < srcSize * srcSize; i++) {
            const raw = pixels[i * 4] / 255;
            const g = Math.max(0, Math.min(1, (raw - 0.5) * d.grainContrast + 0.5 + d.grainBrightness));
            const v = Math.round(g * 255);
            imgData.data[i * 4 + 0] = v;
            imgData.data[i * 4 + 1] = v;
            imgData.data[i * 4 + 2] = v;
            imgData.data[i * 4 + 3] = 255;
        }
        const offscreen = new OffscreenCanvas(srcSize, srcSize);
        offscreen.getContext('2d')!.putImageData(imgData, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const displayScale = Math.max(0.05, d.grainScale);
        ctx.drawImage(offscreen, 0, 0, W / displayScale, H / displayScale, 0, 0, W, H);
    };

    bind(   'bs-grain-depth',       'bs-grain-depth-val',      '%', v => { app.brushTool.getDescriptor().grainDepth        = v;               pushBrush(); syncGrainConfig(); updateGrainPreview(); });
    bindRaw('bs-grain-scale',       'bs-grain-scale-val',      '', 100, v => { app.brushTool.getDescriptor().grainScale    = Math.max(0.05, v); pushBrush(); syncGrainConfig(); updateGrainPreview(); });
    bindRaw('bs-grain-rotation',    'bs-grain-rotation-val',   '°',  1, v => { app.brushTool.getDescriptor().grainRotation = v;                 pushBrush(); syncGrainConfig(); updateGrainPreview(); });
    bindRaw('bs-grain-contrast',    'bs-grain-contrast-val',   '', 100, v => { app.brushTool.getDescriptor().grainContrast  = Math.max(0.1, v); pushBrush(); syncGrainConfig(); updateGrainPreview(); });
    bindRaw('bs-grain-brightness',  'bs-grain-brightness-val', '', 100, v => { app.brushTool.getDescriptor().grainBrightness = v;               pushBrush(); syncGrainConfig(); updateGrainPreview(); });
    bindToggle('bs-grain-static', on => { app.brushTool.getDescriptor().grainStatic = on; pushBrush(); syncGrainConfig(); updateGrainPreview(); });

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
                    updateGrainPreview();
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
                drawThumb('bs-tip-thumb', bmp);
                app.setBrushTipBitmap(bmp);
                bmp.close();
                app.pipeline.setTipTexture(tipTexture);
                const nameEl = document.getElementById('bs-tip-name');
                if (nameEl) nameEl.textContent = file.name.replace(/\.[^.]+$/, '');
                document.getElementById('bs-tip-clear-row')?.style.setProperty('display', '');
            } catch (e) { console.warn('Tip texture load failed:', e); }
        });
        document.getElementById('bs-tip-clear-btn')?.addEventListener('click', () => {
            tipTexture?.destroy(); tipTexture = null;
            app.pipeline.setTipTexture(null);
            app.setBrushTipBitmap(null);
            clearThumb('bs-tip-thumb');
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
                drawThumb('bs-grain-thumb', bmp);
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
            clearThumb('bs-grain-thumb');
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

    // ── Tab rail ──────────────────────────────────────────────────────────────
    const tabRail = document.getElementById('bsTabRail');

    const setTabVisible = (target: string, visible: boolean) => {
        const tab = tabRail?.querySelector<HTMLElement>(`.la-tab[data-target="${target}"]`);
        if (!tab) return;
        tab.style.display = visible ? '' : 'none';
        if (!visible && tab.classList.contains('active')) {
            tabRail?.querySelector<HTMLElement>('.la-tab[data-target="la-general"]')?.click();
        }
    };

    tabRail?.addEventListener('click', e => {
        const tab = (e.target as HTMLElement).closest('.la-tab') as HTMLElement | null;
        if (!tab) return;
        tabRail.querySelectorAll('.la-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('#brushSettingsPanel .la-section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset['target'];
        if (target) document.getElementById(target)?.classList.add('active');
    });

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
                show('bs-flow-row');
                setTabVisible('la-blend',       true);
                setTabVisible('la-grain',       true);
                setTabVisible('la-wetmix',      true);
                setTabVisible('la-shape',       true);
                setTabVisible('la-stroke-path', true);
            } else if (tool === 'EraserTool') {
                setText('bs-tool-title', 'Eraser');
                hide('bs-flow-row');
                setTabVisible('la-blend',       false);
                setTabVisible('la-grain',       false);
                setTabVisible('la-wetmix',      false);
                setTabVisible('la-shape',       true);
                setTabVisible('la-stroke-path', true);
            } else if (tool === 'SmudgeTool') {
                setText('bs-tool-title', 'Smudge');
                hide('bs-flow-row');
                setTabVisible('la-blend',       true);
                setTabVisible('la-grain',       false);
                setTabVisible('la-wetmix',      false);
                setTabVisible('la-shape',       true);
                setTabVisible('la-stroke-path', true);
            }
        }
    };

    // ── Sync functions ────────────────────────────────────────────────────────

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

        // Color Dynamics
        set('bs-hue-jitter',    Math.round(d.hueJitter));    setTxt('bs-hue-jitter-val',    Math.round(d.hueJitter) + '°');
        set('bs-sat-jitter',    pct(d.satJitter));            setTxt('bs-sat-jitter-val',    pct(d.satJitter) + '%');
        set('bs-val-jitter',    pct(d.valJitter));            setTxt('bs-val-jitter-val',    pct(d.valJitter) + '%');
        set('bs-hue-jitter-ps', Math.round(d.hueJitterPerStroke)); setTxt('bs-hue-jitter-ps-val', Math.round(d.hueJitterPerStroke) + '°');
        set('bs-sat-jitter-ps', pct(d.satJitterPerStroke));  setTxt('bs-sat-jitter-ps-val', pct(d.satJitterPerStroke) + '%');
        set('bs-val-jitter-ps', pct(d.valJitterPerStroke));  setTxt('bs-val-jitter-ps-val', pct(d.valJitterPerStroke) + '%');

        // Stabilization (0-0.20 → slider 0-100)
        set('bs-pull-string', Math.round(d.pullStringLength * 500)); setTxt('bs-pull-string-val', Math.round(d.pullStringLength * 500) + '%');
        setToggleEl('bs-catch-up', d.catchUpEnabled);

        // Additional dynamics
        set('bs-size-min',  pct(d.sizeMin));          setTxt('bs-size-min-val',  pct(d.sizeMin) + '%');
        set('bs-size-max',  pct(d.sizeMax === 0 ? 1 : d.sizeMax));  setTxt('bs-size-max-val',  pct(d.sizeMax === 0 ? 1 : d.sizeMax) + '%');
        set('bs-opac-min',  pct(d.opacityMin));        setTxt('bs-opac-min-val',  pct(d.opacityMin) + '%');
        set('bs-opac-max',  pct(d.opacityMax === 0 ? 1 : d.opacityMax)); setTxt('bs-opac-max-val',  pct(d.opacityMax === 0 ? 1 : d.opacityMax) + '%');
        set('bs-roundness-min',  pct(d.roundnessMin));  setTxt('bs-roundness-min-val',  pct(d.roundnessMin) + '%');
        set('bs-tilt-influence', pct(d.tiltAngleInfluence)); setTxt('bs-tilt-influence-val', pct(d.tiltAngleInfluence) + '%');
        setToggleEl('bs-tilt-enabled', d.tiltEnabled ?? false);
        app.setBrushTiltActive(d.tiltEnabled ?? false);
        setToggleEl('bs-tilt-shape', d.tiltShape);
        const wetPresStr = d.wetnessPressureCurve?.mode === 'off' ? 0 : Math.round((1 - (d.wetnessPressureCurve?.min ?? 0)) * 100);
        set('bs-wet-pressure', wetPresStr); setTxt('bs-wet-pressure-val', wetPresStr + '%');

        // Wet Mixing
        set('bs-wetness',    pct(d.wetness));             setTxt('bs-wetness-val',    pct(d.wetness) + '%');
        set('bs-paint-load', pct(d.paintLoad));           setTxt('bs-paint-load-val', pct(d.paintLoad) + '%');
        set('bs-wet-edge',   pct(d.wetEdge ?? 0));        setTxt('bs-wet-edge-val',   pct(d.wetEdge ?? 0) + '%');

        // Smudge dynamics (shared descriptor — always kept in sync, visible only in smudge mode)
        set('bs-smudge-charge',   pct(d.smudgeCharge));   setTxt('bs-smudge-charge-val',   pct(d.smudgeCharge) + '%');
        set('bs-smudge-dilution', pct(d.smudgeDilution)); setTxt('bs-smudge-dilution-val', pct(d.smudgeDilution) + '%');
        set('bs-smudge-attack',   pct(d.smudgeAttack));   setTxt('bs-smudge-attack-val',   pct(d.smudgeAttack) + '%');
        set('bs-smudge-grade',    pct(d.smudgeGrade));    setTxt('bs-smudge-grade-val',    pct(d.smudgeGrade) + '%');

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

        // Glaze mode
        const gm = d.glazeMode ?? 'off';
        app.pipeline.brushRenderer.setGlazeMode(gm);
        glazeBtnIds.forEach((id, i) =>
            document.getElementById(id)?.classList.toggle('active', glazeModes[i] === gm)
        );

        const hasPressureSize = (d.sizePressureCurve?.mode ?? 'off') !== 'off' || d.pressureSize > 0.01;
        app.setBrushSizePressureActive(hasPressureSize);
    };

    app.bus.on('tool:change', ({ tool }) => {
        syncLayout(tool);
        if (tool === 'SmudgeTool' || tool === 'BrushTool') syncToBrush();
        else if (tool === 'EraserTool') syncToEraser();
    });
}

bootstrap();
