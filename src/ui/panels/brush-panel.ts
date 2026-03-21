import type { PaintApp }      from '../../core/app';
import type { BrushDescriptor } from '../../renderer/brush-descriptor';
import { defaultEraserDescriptor } from '../../renderer/brush-descriptor';
import { BrushPresets, type BrushPreset } from '../../core/brush-presets';

// ── Built-in eraser presets ────────────────────────────────────────────────────
const ERASER_PRESETS: { name: string; desc: Partial<BrushDescriptor> }[] = [
    { name: 'Hard',     desc: { hardness: 1.0, opacity: 1.0, size: 0.05,  spacing: 0.10 } },
    { name: 'Soft',     desc: { hardness: 0.0, opacity: 1.0, size: 0.07,  spacing: 0.08 } },
    { name: 'Airbrush', desc: { hardness: 0.0, opacity: 0.35, size: 0.09, spacing: 0.05 } },
];

// ── Built-in smudge presets ────────────────────────────────────────────────────
const SMUDGE_PRESETS: { name: string; desc: Partial<BrushDescriptor> }[] = [
    { name: 'Light',  desc: { smudge: 0.30, hardness: 0.6, opacity: 1.0, spacing: 0.12 } },
    { name: 'Medium', desc: { smudge: 0.70, hardness: 0.5, opacity: 1.0, spacing: 0.10 } },
    { name: 'Heavy',  desc: { smudge: 0.95, hardness: 0.4, opacity: 1.0, spacing: 0.10 } },
    { name: 'Dry',    desc: { smudge: 0.80, hardness: 1.0, opacity: 1.0, spacing: 0.08 } },
];

// ── Stroke preview on a 2D canvas ─────────────────────────────────────────────

export function drawPreview(canvas: HTMLCanvasElement, desc: BrushDescriptor): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width: w, height: h } = canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1d24';
    ctx.fillRect(0, 0, w, h);

    // Max radius at peak pressure — desc.size is a fraction of canvas logical width
    const maxR      = Math.max(2, Math.min(h * 0.42, desc.size * 280));
    const spacingPx = Math.max(1.5, maxR * Math.max(0.06, desc.spacing * 0.85));
    const steps     = Math.ceil(w / spacingPx);

    const hasPressureSize  = desc.pressureSize > 0.01;
    const hasPressureOpac  = desc.pressureOpacity > 0.01;

    for (let i = 0; i <= steps; i++) {
        const t        = i / steps;
        // Procreate-style ramp: 0 → peak → 0 via sine
        const pressure = (hasPressureSize || hasPressureOpac) ? Math.sin(t * Math.PI) : 1.0;

        const sizeMult    = hasPressureSize ? 1 - desc.pressureSize * (1 - pressure) : 1.0;
        const opacityMult = hasPressureOpac ? 1 - desc.pressureOpacity * (1 - pressure) : 1.0;

        const r     = Math.max(1, maxR * sizeMult);
        const alpha = Math.min(1, desc.opacity * opacityMult * 0.9 + 0.05);
        const x     = t * w;
        const y     = h / 2 + Math.sin(t * Math.PI) * h * 0.2;

        const innerR = r * Math.max(0, desc.hardness - 0.05) * 0.75;
        const grad   = ctx.createRadialGradient(x, y, innerR, x, y, r);
        grad.addColorStop(0, `rgba(255,255,255,${alpha.toFixed(2)})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ── BrushPanel ────────────────────────────────────────────────────────────────

export class BrushPanel {
    private el:              HTMLElement;
    private listEl:          HTMLElement;
    private selectedId:      string | null = null;
    private selectedEraser:  number = 0;
    private selectedSmudge:  number = 0;
    private fileInput:       HTMLInputElement;
    private activeCategory:  string = 'All';

    /** Called after a brush preset is loaded — use to sync GPU state (grain config, etc.). */
    public onPresetLoaded: ((desc: BrushDescriptor) => void) | null = null;

    constructor(
        private presets: BrushPresets,
        private app:     PaintApp,
    ) {
        this.el     = document.getElementById('brushPanel')!;
        this.listEl = document.getElementById('bp-list')!;

        this.fileInput         = document.createElement('input');
        this.fileInput.type    = 'file';
        this.fileInput.accept  = '.json';
        this.fileInput.style.display = 'none';
        document.body.appendChild(this.fileInput);

        this.wireButtons();
        this.renderFilterBar();
        this.render();
        this.renderEraserPresets();
        this.renderSmudgePresets();
        this.wireSelectionSection();

        // Select + apply the first built-in by default
        const first = presets.getAll()[0];
        if (first) this.selectPreset(first.id, false);
    }

    // ── Public ────────────────────────────────────────────────────────────────

    public getSelectedPresetId(): string | null { return this.selectedId; }

    /** Redraws the preview canvas for the given preset id without a full re-render. */
    public refreshPreview(id: string, desc: BrushDescriptor): void {
        const item = this.listEl.querySelector(`[data-id="${id}"]`) as HTMLElement | null;
        if (!item) return;
        const cv = item.querySelector('.bp-preview') as HTMLCanvasElement | null;
        if (cv) drawPreview(cv, desc);
    }

    public toggle(): void {
        this.el.style.display = this.isOpen() ? 'none' : 'flex';
    }

    public show(): void { this.el.style.display = 'flex'; }
    public hide(): void { this.el.style.display = 'none'; }

    public isOpen(): boolean { return this.el.style.display !== 'none'; }

    /** Show the section appropriate for the given tool, update title. */
    public showSection(toolName: string): void {
        const title    = document.getElementById('bp-title');
        const toolbar  = document.getElementById('bp-brush-toolbar');
        const brushSec = document.getElementById('tg-brush-section');
        const eraserSec= document.getElementById('tg-eraser-section');
        const smudgeSec= document.getElementById('tg-smudge-section');
        const selSec   = document.getElementById('tg-selection-section');

        const hide = (el: HTMLElement | null) => { if (el) el.style.display = 'none'; };
        const show = (el: HTMLElement | null, d = '') => { if (el) el.style.display = d; };

        hide(brushSec); hide(eraserSec); hide(smudgeSec); hide(selSec);
        hide(toolbar);

        switch (toolName) {
            case 'BrushTool':
                if (title) title.textContent = 'Brushes';
                show(brushSec); show(toolbar);
                break;
            case 'EraserTool':
                if (title) title.textContent = 'Eraser';
                show(eraserSec);
                break;
            case 'SmudgeTool':
                if (title) title.textContent = 'Smudge';
                show(smudgeSec);
                break;
            case 'SelectionTool':
                if (title) title.textContent = 'Selection';
                show(selSec);
                break;
            default:
                // For fill, eyedropper, etc. — just show brush section
                if (title) title.textContent = 'Brushes';
                show(brushSec); show(toolbar);
        }
    }

    // ── Filter bar ────────────────────────────────────────────────────────────

    private renderFilterBar(): void {
        const brushSec = document.getElementById('tg-brush-section');
        if (!brushSec) return;

        const bar = document.createElement('div');
        bar.className = 'bp-filter-bar';
        bar.id        = 'bp-filter-bar';

        const categories = ['All', 'Basic', 'Painting', 'Texture', 'Special', 'Custom'];
        for (const cat of categories) {
            const chip = document.createElement('button');
            chip.className   = 'bp-filter-chip' + (cat === this.activeCategory ? ' active' : '');
            chip.textContent = cat;
            chip.dataset['cat'] = cat;
            chip.addEventListener('click', () => {
                this.activeCategory = cat;
                bar.querySelectorAll('.bp-filter-chip').forEach(c =>
                    c.classList.toggle('active', (c as HTMLElement).dataset['cat'] === cat)
                );
                this.render();
            });
            bar.appendChild(chip);
        }

        // Insert before bp-list
        brushSec.insertBefore(bar, this.listEl);
    }

    // ── Render ────────────────────────────────────────────────────────────────

    private render(): void {
        this.listEl.innerHTML = '';
        const all = this.presets.getAll();
        const filtered = this.activeCategory === 'All'
            ? all
            : all.filter(p => p.category === this.activeCategory);
        for (const preset of filtered) {
            this.listEl.appendChild(this.makeItem(preset));
        }
    }

    private makeItem(preset: BrushPreset): HTMLElement {
        const item        = document.createElement('div');
        item.className    = 'bp-item' + (preset.id === this.selectedId ? ' active' : '');
        item.dataset['id'] = preset.id;

        const canvas     = document.createElement('canvas');
        canvas.className = 'bp-preview';
        canvas.width     = 148;
        canvas.height    = 32;
        drawPreview(canvas, preset.desc);

        const name     = document.createElement('span');
        name.className = 'bp-name';
        name.textContent = preset.name;

        const actions     = document.createElement('div');
        actions.className = 'bp-item-actions';

        if (!preset.builtIn) {
            const overwriteBtn       = document.createElement('button');
            overwriteBtn.className   = 'btn-ghost bp-act-btn';
            overwriteBtn.title       = 'Overwrite with current brush';
            overwriteBtn.textContent = '↺';
            overwriteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm(`Overwrite "${preset.name}" with current brush settings?`)) return;
                this.presets.updateCustom(preset.id, this.app.brushTool.getDescriptor());
                this.render();
            });
            actions.appendChild(overwriteBtn);

            const delBtn       = document.createElement('button');
            delBtn.className   = 'btn-ghost bp-act-btn bp-del-btn';
            delBtn.title       = 'Delete preset';
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!confirm(`Delete "${preset.name}"?`)) return;
                this.presets.delete(preset.id);
                if (this.selectedId === preset.id) this.selectedId = null;
                this.render();
            });
            actions.appendChild(delBtn);
        }

        item.appendChild(canvas);
        item.appendChild(name);
        item.appendChild(actions);
        item.addEventListener('click', () => this.selectPreset(preset.id, true));
        return item;
    }

    private selectPreset(id: string, apply: boolean): void {
        this.selectedId = id;
        this.listEl.querySelectorAll('.bp-item').forEach(el =>
            el.classList.toggle('active', (el as HTMLElement).dataset['id'] === id)
        );
        if (!apply) return;
        const preset = this.presets.getById(id);
        if (!preset) return;

        // Preserve user's current paint color
        const color = this.app.brushTool.getCurrentColor();
        this.app.brushTool.loadDescriptor(preset.desc);
        this.app.brushTool.setColor(...color);
        this.app.setBrushSize(preset.desc.size);
        this.app.setBrushHardness(preset.desc.hardness);
        this.syncSettingsUI(preset.desc);
        this.onPresetLoaded?.(preset.desc);
    }

    // Sync all brush-settings sliders to match the loaded preset
    private syncSettingsUI(d: BrushDescriptor): void {
        const set    = (id: string, v: number) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = String(v); };
        const setTxt = (id: string, t: string) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = t; };
        const tog    = (id: string, on: boolean) => { document.getElementById(id)?.classList.toggle('on', on); };
        const pct    = (v: number) => Math.round(v * 100);

        set('sizeSlider',    d.size);
        set('bs-opacity',    pct(d.opacity));           setTxt('bs-opacity-val',    pct(d.opacity) + '%');
        set('bs-flow',       pct(d.flow));              setTxt('bs-flow-val',       pct(d.flow) + '%');
        set('bs-hardness',   pct(d.hardness));          setTxt('bs-hardness-val',   pct(d.hardness) + '%');
        set('bs-spacing',    Math.round(d.spacing*100)); setTxt('bs-spacing-val',   Math.round(d.spacing*100) + '%');
        set('bs-pres-size',  pct(d.pressureSize));      setTxt('bs-pres-size-val',  pct(d.pressureSize) + '%');
        set('bs-pres-opac',  pct(d.pressureOpacity));   setTxt('bs-pres-opac-val',  pct(d.pressureOpacity) + '%');
        set('bs-size-jitter',pct(d.sizeJitter));        setTxt('bs-size-jitter-val',pct(d.sizeJitter) + '%');
        set('bs-opac-jitter',pct(d.opacityJitter));     setTxt('bs-opac-jitter-val',pct(d.opacityJitter) + '%');
        set('bs-mix',        pct(d.smudge));            setTxt('bs-mix-val',        pct(d.smudge) + '%');

        // Shape
        set('bs-roundness', pct(d.roundness));          setTxt('bs-roundness-val', pct(d.roundness) + '%');
        set('bs-angle',     Math.round(d.angle));       setTxt('bs-angle-val',     Math.round(d.angle) + '°');
        tog('bs-follow-stroke', d.followStroke);

        // Dynamics
        const flowPresStr = d.flowPressureCurve?.mode === 'off' ? 0 : Math.round((1 - (d.flowPressureCurve?.min ?? 0)) * 100);
        set('bs-pres-flow', flowPresStr); setTxt('bs-pres-flow-val', flowPresStr + '%');

        // Scatter
        set('bs-angle-jitter', Math.round(d.angleJitter));      setTxt('bs-angle-jitter-val', Math.round(d.angleJitter) + '°');
        set('bs-scatter-x',    Math.round(d.scatterX * 1000));  setTxt('bs-scatter-x-val',    Math.round(d.scatterX * 1000) + '%');
        set('bs-scatter-y',    Math.round(d.scatterY * 1000));  setTxt('bs-scatter-y-val',    Math.round(d.scatterY * 1000) + '%');
        set('bs-stamp-count',  d.stampCount);                   setTxt('bs-stamp-count-val',  String(d.stampCount));

        // Color Dynamics
        set('bs-hue-jitter',    Math.round(d.hueJitter));       setTxt('bs-hue-jitter-val',    Math.round(d.hueJitter) + '°');
        set('bs-sat-jitter',    pct(d.satJitter));              setTxt('bs-sat-jitter-val',    pct(d.satJitter) + '%');
        set('bs-val-jitter',    pct(d.valJitter));              setTxt('bs-val-jitter-val',    pct(d.valJitter) + '%');
        set('bs-fg-bg-mix',     pct(d.colorFgBgMix));          setTxt('bs-fg-bg-mix-val',     pct(d.colorFgBgMix) + '%');
        set('bs-hue-jitter-ps', Math.round(d.hueJitterPerStroke)); setTxt('bs-hue-jitter-ps-val', Math.round(d.hueJitterPerStroke) + '°');
        set('bs-sat-jitter-ps', pct(d.satJitterPerStroke));    setTxt('bs-sat-jitter-ps-val', pct(d.satJitterPerStroke) + '%');
        set('bs-val-jitter-ps', pct(d.valJitterPerStroke));    setTxt('bs-val-jitter-ps-val', pct(d.valJitterPerStroke) + '%');

        // Tapering
        set('bs-taper-start', Math.round(d.taperStart * 500)); setTxt('bs-taper-start-val', Math.round(d.taperStart * 500) + '%');
        set('bs-taper-end',   Math.round(d.taperEnd   * 500)); setTxt('bs-taper-end-val',   Math.round(d.taperEnd   * 500) + '%');
        tog('bs-taper-size', d.taperSizeLink);
        tog('bs-taper-opac', d.taperOpacityLink);

        // Stabilization
        set('bs-pull-string', Math.round(d.pullStringLength * 500)); setTxt('bs-pull-string-val', Math.round(d.pullStringLength * 500) + '%');
        tog('bs-catch-up', d.catchUpEnabled);

        // Wet Mixing
        set('bs-wetness',    pct(d.wetness));           setTxt('bs-wetness-val',    pct(d.wetness) + '%');
        set('bs-paint-load', pct(d.paintLoad));         setTxt('bs-paint-load-val', pct(d.paintLoad) + '%');

        // Texture / Grain
        set('bs-grain-depth',      pct(d.grainDepth));                    setTxt('bs-grain-depth-val',      pct(d.grainDepth) + '%');
        set('bs-grain-scale',      Math.round(d.grainScale * 100));        setTxt('bs-grain-scale-val',      d.grainScale.toFixed(2));
        set('bs-grain-rotation',   Math.round(d.grainRotation));           setTxt('bs-grain-rotation-val',   Math.round(d.grainRotation) + '°');
        set('bs-grain-contrast',   Math.round(d.grainContrast * 100));     setTxt('bs-grain-contrast-val',   d.grainContrast.toFixed(2));
        set('bs-grain-brightness', Math.round(d.grainBrightness * 100));   setTxt('bs-grain-brightness-val', d.grainBrightness.toFixed(2));
        tog('bs-grain-static', d.grainStatic);
        const blendIdx = ({ multiply: 0, screen: 1, overlay: 2, normal: 3 } as Record<string, number>)[d.grainBlendMode] ?? 0;
        ['bs-grain-multiply','bs-grain-screen','bs-grain-overlay','bs-grain-normal'].forEach(
            (id, i) => document.getElementById(id)?.classList.toggle('active', i === blendIdx)
        );
    }

    // ── Eraser presets ────────────────────────────────────────────────────────

    private renderEraserPresets(): void {
        const list = document.getElementById('tg-eraser-list');
        if (!list) return;
        list.innerHTML = '';
        ERASER_PRESETS.forEach((preset, i) => {
            const base = { ...defaultEraserDescriptor(), ...preset.desc };
            const item = document.createElement('div');
            item.className = 'bp-item' + (i === this.selectedEraser ? ' active' : '');

            const canvas = document.createElement('canvas');
            canvas.className = 'bp-preview';
            canvas.width = 148; canvas.height = 32;
            drawPreview(canvas, base as any);

            const name = document.createElement('span');
            name.className = 'bp-name';
            name.textContent = preset.name;

            item.appendChild(canvas);
            item.appendChild(name);
            item.addEventListener('click', () => {
                this.selectedEraser = i;
                list.querySelectorAll('.bp-item').forEach((el, j) =>
                    el.classList.toggle('active', j === i)
                );
                this.app.eraserTool.setHardness(base.hardness ?? 1);
                this.app.eraserTool.setOpacity(base.opacity ?? 1);
                this.app.eraserTool.setSpacing(base.spacing ?? 0.1);
                this.app.setBrushSize(base.size ?? 0.05);
                this.syncSettingsUI(base as any);
            });
            list.appendChild(item);
        });
    }

    // ── Smudge presets ────────────────────────────────────────────────────────

    private renderSmudgePresets(): void {
        const list = document.getElementById('tg-smudge-list');
        if (!list) return;
        list.innerHTML = '';
        SMUDGE_PRESETS.forEach((preset, i) => {
            const base = { ...defaultEraserDescriptor(), blendMode: 'normal', ...preset.desc };
            const item = document.createElement('div');
            item.className = 'bp-item' + (i === this.selectedSmudge ? ' active' : '');

            const canvas = document.createElement('canvas');
            canvas.className = 'bp-preview';
            canvas.width = 148; canvas.height = 32;
            drawPreview(canvas, base as any);

            const name = document.createElement('span');
            name.className = 'bp-name';
            name.textContent = preset.name;

            item.appendChild(canvas);
            item.appendChild(name);
            item.addEventListener('click', () => {
                this.selectedSmudge = i;
                list.querySelectorAll('.bp-item').forEach((el, j) =>
                    el.classList.toggle('active', j === i)
                );
                this.app.smudgeTool.setHardness(base.hardness ?? 0.5);
                this.app.smudgeTool.setOpacity(base.opacity ?? 1);
                this.app.smudgeTool.setSpacing(base.spacing ?? 0.1);
                this.app.smudgeTool.setStrength(base.smudge ?? 0.7);
                this.app.setBrushSize(base.size ?? 0.05);
                this.syncSettingsUI(base as any);
            });
            list.appendChild(item);
        });
    }

    // ── Selection type section ────────────────────────────────────────────────

    private wireSelectionSection(): void {
        // These buttons set the selection TYPE (variation); wired here so the
        // Tool Group panel is self-contained. They also sync the floating popup.
        const map: [string, 'rect' | 'lasso' | 'poly'][] = [
            ['tg-selTypeRect', 'rect'], ['tg-selTypeLasso', 'lasso'], ['tg-selTypePoly', 'poly'],
        ];
        for (const [id, type] of map) {
            document.getElementById(id)?.addEventListener('click', () => {
                this.app.selectionTool.setType(type);
                // Sync active state across all selection-type button sets
                map.forEach(([tid, t]) => document.getElementById(tid)?.classList.toggle('active', t === type));
                // Sync floating popup
                const popMap: [string, string][] = [['selTypeRect','rect'],['selTypeLasso','lasso'],['selTypePoly','poly']];
                popMap.forEach(([tid, t]) => document.getElementById(tid)?.classList.toggle('active', t === type));
            });
        }
    }

    // ── Button wiring ─────────────────────────────────────────────────────────

    private wireButtons(): void {
        document.getElementById('bp-save-btn')?.addEventListener('click', () => {
            const name = prompt('Preset name:', 'Custom Brush');
            if (!name) return;
            const preset = this.presets.addCustom(name, this.app.brushTool.getDescriptor());
            this.render();
            this.selectPreset(preset.id, false);
        });

        document.getElementById('bp-import-btn')?.addEventListener('click', () => this.fileInput.click());

        this.fileInput.addEventListener('change', () => {
            const file = this.fileInput.files?.[0];
            if (!file) return;
            this.fileInput.value = '';
            const reader = new FileReader();
            reader.onload = () => {
                const preset = this.presets.importFromJSON(reader.result as string);
                if (!preset) { alert('Failed to import brush preset.'); return; }
                this.render();
                this.selectPreset(preset.id, true);
            };
            reader.readAsText(file);
        });

        document.getElementById('bp-export-btn')?.addEventListener('click', () => {
            if (!this.selectedId) { alert('Select a preset first.'); return; }
            const json = this.presets.exportPreset(this.selectedId);
            if (!json) return;
            const name = this.presets.getById(this.selectedId)?.name ?? 'brush';
            this.download(json, name.replace(/[^a-z0-9_-]/gi, '_') + '.json');
        });

        document.getElementById('bp-export-all-btn')?.addEventListener('click', () => {
            this.download(this.presets.exportAll(), 'brushes.json');
        });

        document.getElementById('bp-restore-btn')?.addEventListener('click', () => {
            if (!confirm('Restore built-in presets? Custom presets are kept.')) return;
            this.presets.restoreDefaults();
            this.render();
        });
    }

    private download(text: string, filename: string): void {
        const a  = document.createElement('a');
        a.href   = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }
}
