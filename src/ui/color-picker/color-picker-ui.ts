import { ColorState } from '../../core/color-state';

// ── ColorPickerUI ─────────────────────────────────────────────────────────────
// Drives the RGB + HSV slider system in the right panel.
// No canvas overlay, no GPU wheel renderer — pure slider math.
//
// Responsibilities:
//   - Sync sliders and text inputs from ColorState changes
//   - Update CSS gradient track variables
//   - Bidirectional: RGB sliders → setRgb(), HSV sliders → setHsv()
//   - Tab switching: RGB/HSV pane visibility
//   - Expand mode: when the panel is tall enough, show both panes simultaneously

const EXPAND_THRESHOLD = 370; // px — panel height above which both panes are shown

export class ColorPickerUI {
    private root = document.documentElement;
    private updating = false; // re-entrancy guard

    // Sliders
    private rS = document.getElementById('redSlider')   as HTMLInputElement | null;
    private gS = document.getElementById('greenSlider') as HTMLInputElement | null;
    private bS = document.getElementById('blueSlider')  as HTMLInputElement | null;
    private hS = document.getElementById('hue-slider')  as HTMLInputElement | null;
    private sS = document.getElementById('sat-slider')  as HTMLInputElement | null;
    private vS = document.getElementById('val-slider')  as HTMLInputElement | null;

    // Text inputs
    private rV = document.getElementById('redVal')   as HTMLInputElement | null;
    private gV = document.getElementById('greenVal') as HTMLInputElement | null;
    private bV = document.getElementById('blueVal')  as HTMLInputElement | null;
    private hV = document.getElementById('hue-val')  as HTMLInputElement | null;
    private sV = document.getElementById('sat-val')  as HTMLInputElement | null;
    private vV = document.getElementById('val-val')  as HTMLInputElement | null;

    // Other elements
    private swatch     = document.getElementById('active-color-preview');
    private rgbPane    = document.getElementById('rgbPane');
    private hsvPane    = document.getElementById('hsvPane');
    private tabRow     = document.getElementById('colorTabRow');
    private colorSep   = document.getElementById('colorSep');
    private tabRgb     = document.getElementById('tabRgb');
    private tabHsv     = document.getElementById('tabHsv');
    private rightPanel = document.getElementById('rightPanel');

    private colorTab: 'rgb' | 'hsv' = 'rgb';

    constructor(private state: ColorState) {
        this.setupSliderListeners();
        this.setupTabListeners();
        this.setupTextInputListeners();
        this.setupExpandObserver();
        this.setupSwatchDrag();      // B10

        // Initial sync
        state.subscribeLocal(() => this.syncFromState());
        this.syncFromState();
    }

    // ── Private: sync FROM state → UI ────────────────────────────────────────

    private syncFromState() {
        if (this.updating) return;
        this.updating = true;

        const { rgb, hsv } = this.state;

        // Slider values
        if (this.rS) this.rS.value = String(rgb.r);
        if (this.gS) this.gS.value = String(rgb.g);
        if (this.bS) this.bS.value = String(rgb.b);
        if (this.hS) this.hS.value = String(Math.round(hsv.h));
        if (this.sS) this.sS.value = String(Math.round(hsv.s));
        if (this.vS) this.vS.value = String(Math.round(hsv.v));

        // Text inputs
        if (this.rV) this.rV.value = String(rgb.r);
        if (this.gV) this.gV.value = String(rgb.g);
        if (this.bV) this.bV.value = String(rgb.b);
        if (this.hV) this.hV.value = Math.round(hsv.h) + '°';
        if (this.sV) this.sV.value = Math.round(hsv.s) + '%';
        if (this.vV) this.vV.value = Math.round(hsv.v) + '%';

        // Swatch
        if (this.swatch) {
            this.swatch.style.background = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
        }

        // CSS gradient variables
        this.updateGradients(rgb.r, rgb.g, rgb.b, hsv.h, hsv.s, hsv.v);

        this.updating = false;
    }

    private updateGradients(r: number, g: number, b: number, h: number, s: number, v: number) {
        this.root.style.setProperty('--red-start',   `rgb(0,${g},${b})`);
        this.root.style.setProperty('--red-end',     `rgb(255,${g},${b})`);
        this.root.style.setProperty('--green-start', `rgb(${r},0,${b})`);
        this.root.style.setProperty('--green-end',   `rgb(${r},255,${b})`);
        this.root.style.setProperty('--blue-start',  `rgb(${r},${g},0)`);
        this.root.style.setProperty('--blue-end',    `rgb(${r},${g},255)`);

        // Sat: grey → full hue at current value
        const grey   = Math.round(v * 255 / 100);
        const fh     = this.hsvToRgb(h, 100, v);
        this.root.style.setProperty('--sat-start', `rgb(${grey},${grey},${grey})`);
        this.root.style.setProperty('--sat-end',   `rgb(${fh.r},${fh.g},${fh.b})`);

        // Val: black → full hue at current saturation
        const fv = this.hsvToRgb(h, s, 100);
        this.root.style.setProperty('--val-start', '#000');
        this.root.style.setProperty('--val-end',   `rgb(${fv.r},${fv.g},${fv.b})`);
    }

    // ── Private: setup listeners ──────────────────────────────────────────────

    private setupSliderListeners() {
        const fromRgb = () => {
            if (this.updating) return;
            this.state.setRgb(+(this.rS?.value ?? 0), +(this.gS?.value ?? 0), +(this.bS?.value ?? 0));
        };
        const fromHsv = () => {
            if (this.updating) return;
            this.state.setHsv(+(this.hS?.value ?? 0), +(this.sS?.value ?? 0), +(this.vS?.value ?? 0));
        };

        this.rS?.addEventListener('input', fromRgb);
        this.gS?.addEventListener('input', fromRgb);
        this.bS?.addEventListener('input', fromRgb);
        this.hS?.addEventListener('input', fromHsv);
        this.sS?.addEventListener('input', fromHsv);
        this.vS?.addEventListener('input', fromHsv);
    }

    private setupTextInputListeners() {
        const bindText = (
            inputEl: HTMLInputElement | null,
            sliderEl: HTMLInputElement | null,
            min: number, max: number,
            suffix: string,
            onCommit: () => void
        ) => {
            if (!inputEl) return;
            inputEl.addEventListener('focus',   ()  => inputEl.select());
            inputEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); inputEl.blur(); }
            });
            inputEl.addEventListener('blur', () => {
                const raw = inputEl.value.replace(/[°%]/g, '').trim();
                const n   = Math.round(Math.min(max, Math.max(min, parseFloat(raw) || 0)));
                if (sliderEl) sliderEl.value = String(n);
                onCommit();
            });
        };

        const fromRgb = () => this.state.setRgb(+(this.rS?.value ?? 0), +(this.gS?.value ?? 0), +(this.bS?.value ?? 0));
        const fromHsv = () => this.state.setHsv(+(this.hS?.value ?? 0), +(this.sS?.value ?? 0), +(this.vS?.value ?? 0));

        bindText(this.rV, this.rS, 0, 255, '',   fromRgb);
        bindText(this.gV, this.gS, 0, 255, '',   fromRgb);
        bindText(this.bV, this.bS, 0, 255, '',   fromRgb);
        bindText(this.hV, this.hS, 0, 360, '°',  fromHsv);
        bindText(this.sV, this.sS, 0, 100, '%',  fromHsv);
        bindText(this.vV, this.vS, 0, 100, '%',  fromHsv);
    }

    private setupTabListeners() {
        this.tabRgb?.addEventListener('click', () => this.setColorTab('rgb'));
        this.tabHsv?.addEventListener('click', () => this.setColorTab('hsv'));
    }

    private setColorTab(tab: 'rgb' | 'hsv') {
        this.colorTab = tab;
        this.tabRgb?.classList.toggle('active', tab === 'rgb');
        this.tabHsv?.classList.toggle('active', tab === 'hsv');
        this.applyColorMode();
    }

    // Expand mode: when panel is tall enough show both panes at once
    // ── B10 — swatch drag: horizontal = hue, vertical = value ─────────────────
    private setupSwatchDrag(): void {
        if (!this.swatch) return;
        let dragging = false, startX = 0, startY = 0, startH = 0, startV = 0;
        this.swatch.addEventListener("mousedown", (e: Event) => {
            const me = e as MouseEvent;
            dragging = true; startX = me.clientX; startY = me.clientY;
            startH = this.state.hsv.h; startV = this.state.hsv.v;
            me.preventDefault(); me.stopPropagation();
            document.body.style.cursor = "crosshair";
        });
        document.addEventListener("mousemove", (e: MouseEvent) => {
            if (!dragging) return;
            const newH = ((startH + (e.clientX - startX) * 1.5) % 360 + 360) % 360;
            const newV = Math.max(0, Math.min(100, startV - (e.clientY - startY) * 0.5));
            this.state.setHsv(Math.round(newH), this.state.hsv.s, Math.round(newV));
        });
        document.addEventListener("mouseup", () => {
            if (dragging) { dragging = false; document.body.style.cursor = ""; }
        });
    }

    private setupExpandObserver() {
        if (!this.rightPanel) return;
        new ResizeObserver(() => this.applyColorMode()).observe(this.rightPanel);
    }

    private applyColorMode() {
        const expanded = (this.rightPanel?.offsetHeight ?? 0) >= EXPAND_THRESHOLD;
        if (this.tabRow)   this.tabRow.style.display   = expanded ? 'none' : 'flex';
        if (this.colorSep) this.colorSep.style.display = expanded ? 'block' : 'none';
        if (this.rgbPane) {
            this.rgbPane.style.display = expanded ? 'flex' : (this.colorTab === 'rgb' ? 'flex' : 'none');
        }
        if (this.hsvPane) {
            this.hsvPane.style.display = expanded ? 'flex' : (this.colorTab === 'hsv' ? 'flex' : 'none');
        }
    }

    // ── Private: color math ───────────────────────────────────────────────────

    private hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
        const sN = s / 100, vN = v / 100;
        const k  = (n: number) => (n + h / 60) % 6;
        const f  = (n: number) => vN * (1 - sN * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
        return { r: Math.round(255 * f(5)), g: Math.round(255 * f(3)), b: Math.round(255 * f(1)) };
    }
}
