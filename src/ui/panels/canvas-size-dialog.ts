// ── CanvasSizeDialog ──────────────────────────────────────────────────────────
// Modal dialog for New Canvas and Resize Canvas operations.
//
// New Canvas:  creates fresh layers at new dimensions, applies chosen background
// Resize:      recreates layers at new size, crops content outside new bounds
//
// Background options (new canvas only):
//   Paper       — warm off-white #F8F5EF, Procreate-style default
//   White       — pure white
//   Transparent — clear (alpha = 0)
//   Custom      — color picker
// + optional subtle paper noise texture

export type BackgroundType = 'paper' | 'white' | 'transparent' | 'color';

export interface CanvasSizeOptions {
    width:     number;       // logical pixels
    height:    number;
    bgType:    BackgroundType;
    bgColor:   string;       // hex, used when bgType === 'color'
    noise:     boolean;
}

export interface DialogCallbacks {
    onNewCanvas:   (opts: CanvasSizeOptions) => void;
    onResizeCanvas:(opts: CanvasSizeOptions) => void;
}

const PRESETS = [
    { label: 'Screen',   sub: '1000×1400', w: 1000,  h: 1400  },
    { label: 'Full HD',  sub: '1920×1080', w: 1920,  h: 1080  },
    { label: 'Square',   sub: '2000×2000', w: 2000,  h: 2000  },
    { label: 'A4 150',   sub: '1240×1754', w: 1240,  h: 1754  },
    { label: 'A4 300',   sub: '2480×3508', w: 2480,  h: 3508  },
    { label: 'Custom',   sub: '',          w: 0,     h: 0     },
] as const;

const CSS = `
.cdlg-overlay{position:fixed;inset:0;z-index:800;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(5px);animation:cdlgFadeIn 0.12s ease}
@keyframes cdlgFadeIn{from{opacity:0}to{opacity:1}}
.cdlg-box{width:460px;max-width:92vw;background:rgba(30,33,42,0.99);border:1px solid rgba(255,255,255,0.15);border-radius:16px;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,0.7);font-family:'DM Sans',sans-serif;}
.cdlg-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid rgba(255,255,255,0.08)}
.cdlg-title{font-size:14px;font-weight:600;color:#f4f7fd}
.cdlg-close{width:26px;height:26px;border-radius:7px;border:none;background:transparent;color:rgba(255,255,255,0.5);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:background 0.1s}
.cdlg-close:hover{background:rgba(255,255,255,0.08);color:#f4f7fd}
.cdlg-body{padding:16px 18px;display:flex;flex-direction:column;gap:14px}
.cdlg-section-label{font-size:9px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#7e8fa2;margin-bottom:6px}
.cdlg-presets{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
.cdlg-preset{padding:7px 4px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.18);cursor:pointer;text-align:center;transition:all 0.1s;color:#bcc8da}
.cdlg-preset:hover{border-color:rgba(255,255,255,0.22);color:#f4f7fd}
.cdlg-preset.active{background:rgba(0,0,0,0.35);border-color:rgba(255,255,255,0.38);color:#f4f7fd}
.cdlg-preset-name{font-size:11px;font-weight:500;display:block}
.cdlg-preset-sub{font-size:9px;font-family:'DM Mono',monospace;opacity:0.6;display:block;margin-top:1px}
.cdlg-dims{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.cdlg-field{display:flex;flex-direction:column;gap:4px}
.cdlg-field label{font-size:10px;color:#7e8fa2}
.cdlg-input{height:30px;background:rgba(0,0,0,0.28);border:1px solid rgba(255,255,255,0.12);border-radius:7px;font-family:'DM Mono',monospace;font-size:13px;color:#f4f7fd;padding:0 10px;outline:none;transition:border-color 0.1s}
.cdlg-input:focus{border-color:rgba(255,255,255,0.32)}
.cdlg-bg-btns{display:flex;gap:4px;margin-bottom:6px}
.cdlg-bg-btn{flex:1;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,0.1);background:rgba(0,0,0,0.18);cursor:pointer;font-size:11px;font-family:'DM Sans',sans-serif;color:#bcc8da;transition:all 0.1s}
.cdlg-bg-btn:hover{border-color:rgba(255,255,255,0.22);color:#f4f7fd}
.cdlg-bg-btn.active{background:rgba(0,0,0,0.35);border-color:rgba(255,255,255,0.38);color:#f4f7fd}
.cdlg-color-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.cdlg-color-swatch{width:28px;height:28px;border-radius:7px;border:1px solid rgba(255,255,255,0.15);cursor:pointer;flex-shrink:0}
.cdlg-color-label{font-size:11px;color:#bcc8da}
.cdlg-check-row{display:flex;align-items:center;gap:8px;cursor:pointer}
.cdlg-check-row input{width:13px;height:13px;cursor:pointer;accent-color:#6cbbff}
.cdlg-check-label{font-size:11px;color:#bcc8da}
.cdlg-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid rgba(255,255,255,0.08)}
.cdlg-btn{height:32px;padding:0 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:transparent;font-family:'DM Sans',sans-serif;font-size:12px;font-weight:500;color:#bcc8da;cursor:pointer;transition:all 0.1s}
.cdlg-btn:hover{border-color:rgba(255,255,255,0.28);color:#f4f7fd;background:rgba(255,255,255,0.05)}
.cdlg-btn.primary{background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.3);color:#f4f7fd}
.cdlg-btn.primary:hover{background:rgba(255,255,255,0.16)}
`;

export class CanvasSizeDialog {
    private overlay!:  HTMLElement;
    private titleEl!:  HTMLElement;
    private confirmEl!:HTMLButtonElement;
    private wInput!:   HTMLInputElement;
    private hInput!:   HTMLInputElement;
    private bgSection!: HTMLElement;
    private colorSwatch!: HTMLElement;
    private colorInput!: HTMLInputElement;
    private noiseCheck!: HTMLInputElement;

    private presetBtns: HTMLElement[] = [];
    private bgBtns:     HTMLElement[] = [];

    private mode:       'new' | 'resize' = 'new';
    private bgType:     BackgroundType   = 'paper';
    private bgColor     = '#F8F5EF';

    constructor(private callbacks: DialogCallbacks) {
        this.injectStyles();
        this.buildDOM();
    }

    public openNew(): void {
        this.mode = 'new';
        this.titleEl.textContent  = 'New Canvas';
        this.confirmEl.textContent = 'Create';
        this.bgSection.style.display = 'block';
        this.selectPreset(0); // default to Screen
        this.overlay.style.display = 'flex';
    }

    public openResize(currentW: number, currentH: number): void {
        this.mode = 'resize';
        this.titleEl.textContent   = 'Resize Canvas';
        this.confirmEl.textContent = 'Resize';
        this.bgSection.style.display = 'none'; // bg doesn't apply to resize
        this.wInput.value = String(currentW);
        this.hInput.value = String(currentH);
        // Deselect all presets for resize
        this.presetBtns.forEach(b => b.classList.remove('active'));
        this.overlay.style.display = 'flex';
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private injectStyles(): void {
        if (document.getElementById('cdlg-styles')) return;
        const style = document.createElement('style');
        style.id   = 'cdlg-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    private buildDOM(): void {
        this.overlay = document.createElement('div');
        this.overlay.className = 'cdlg-overlay';
        this.overlay.style.display = 'none';

        const box = document.createElement('div');
        box.className = 'cdlg-box';

        // Header
        const head = document.createElement('div');
        head.className = 'cdlg-head';
        this.titleEl = document.createElement('span');
        this.titleEl.className = 'cdlg-title';
        const closeBtn = document.createElement('button');
        closeBtn.className   = 'cdlg-close';
        closeBtn.textContent = '×';
        closeBtn.addEventListener('click', () => this.close());
        head.appendChild(this.titleEl);
        head.appendChild(closeBtn);

        // Body
        const body = document.createElement('div');
        body.className = 'cdlg-body';

        // Presets
        const presetSection = document.createElement('div');
        const psLabel = document.createElement('div');
        psLabel.className   = 'cdlg-section-label';
        psLabel.textContent = 'Preset';
        const presetGrid = document.createElement('div');
        presetGrid.className = 'cdlg-presets';

        PRESETS.forEach((p, i) => {
            const btn = document.createElement('button');
            btn.className = 'cdlg-preset';
            btn.innerHTML = `<span class="cdlg-preset-name">${p.label}</span><span class="cdlg-preset-sub">${p.sub}</span>`;
            btn.addEventListener('click', () => this.selectPreset(i));
            presetGrid.appendChild(btn);
            this.presetBtns.push(btn);
        });
        presetSection.appendChild(psLabel);
        presetSection.appendChild(presetGrid);

        // Dimensions
        const dimSection = document.createElement('div');
        const dimLabel   = document.createElement('div');
        dimLabel.className   = 'cdlg-section-label';
        dimLabel.textContent = 'Dimensions';
        const dims = document.createElement('div');
        dims.className = 'cdlg-dims';

        this.wInput = this.makeNumberInput('Width (px)', '1000');
        this.hInput = this.makeNumberInput('Height (px)', '1400');
        // Wrap each in a field div
        const wField = document.createElement('div'); wField.className = 'cdlg-field';
        const wLabel = document.createElement('label'); wLabel.textContent = 'Width (px)';
        wField.appendChild(wLabel); wField.appendChild(this.wInput);
        const hField = document.createElement('div'); hField.className = 'cdlg-field';
        const hLabel = document.createElement('label'); hLabel.textContent = 'Height (px)';
        hField.appendChild(hLabel); hField.appendChild(this.hInput);
        dims.appendChild(wField); dims.appendChild(hField);
        dimSection.appendChild(dimLabel); dimSection.appendChild(dims);

        // Background section
        this.bgSection = document.createElement('div');
        const bgLabel  = document.createElement('div');
        bgLabel.className   = 'cdlg-section-label';
        bgLabel.textContent = 'Background';

        const bgBtns = document.createElement('div');
        bgBtns.className = 'cdlg-bg-btns';
        for (const [type, label] of [['paper','Paper'],['white','White'],['transparent','Clear'],['color','Custom']] as [BackgroundType, string][]) {
            const btn = document.createElement('button');
            btn.className   = 'cdlg-bg-btn';
            btn.textContent = label;
            btn.addEventListener('click', () => this.selectBG(type));
            bgBtns.appendChild(btn);
            this.bgBtns.push(btn);
        }

        // Custom color row
        const colorRow = document.createElement('div');
        colorRow.className = 'cdlg-color-row';
        colorRow.id = 'cdlg-color-row';
        colorRow.style.display = 'none';
        this.colorSwatch = document.createElement('div');
        this.colorSwatch.className = 'cdlg-color-swatch';
        this.colorSwatch.style.background = this.bgColor;
        this.colorInput = document.createElement('input');
        this.colorInput.type  = 'color';
        this.colorInput.value = this.bgColor;
        this.colorInput.style.cssText = 'position:absolute;opacity:0;pointer-events:none;';
        this.colorInput.addEventListener('input', () => {
            this.bgColor = this.colorInput.value;
            this.colorSwatch.style.background = this.bgColor;
        });
        this.colorSwatch.addEventListener('click', () => this.colorInput.click());
        const colorLabel = document.createElement('span');
        colorLabel.className   = 'cdlg-color-label';
        colorLabel.textContent = 'Click swatch to choose color';
        colorRow.appendChild(this.colorSwatch);
        colorRow.appendChild(colorLabel);
        colorRow.appendChild(this.colorInput);

        // Noise checkbox
        const checkRow = document.createElement('label');
        checkRow.className = 'cdlg-check-row';
        this.noiseCheck = document.createElement('input');
        this.noiseCheck.type    = 'checkbox';
        this.noiseCheck.checked = true;
        const checkLabel = document.createElement('span');
        checkLabel.className   = 'cdlg-check-label';
        checkLabel.textContent = 'Paper texture noise';
        checkRow.appendChild(this.noiseCheck);
        checkRow.appendChild(checkLabel);

        this.bgSection.appendChild(bgLabel);
        this.bgSection.appendChild(bgBtns);
        this.bgSection.appendChild(colorRow);
        this.bgSection.appendChild(checkRow);

        body.appendChild(presetSection);
        body.appendChild(dimSection);
        body.appendChild(this.bgSection);

        // Footer
        const foot = document.createElement('div');
        foot.className = 'cdlg-foot';
        const cancelBtn = document.createElement('button');
        cancelBtn.className   = 'cdlg-btn';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this.close());
        this.confirmEl = document.createElement('button');
        this.confirmEl.className = 'cdlg-btn primary';
        this.confirmEl.textContent = 'Create';
        this.confirmEl.addEventListener('click', () => this.confirm());
        foot.appendChild(cancelBtn);
        foot.appendChild(this.confirmEl);

        // Close on overlay click
        this.overlay.addEventListener('mousedown', (e) => {
            if (e.target === this.overlay) this.close();
        });

        box.appendChild(head);
        box.appendChild(body);
        box.appendChild(foot);
        this.overlay.appendChild(box);
        document.body.appendChild(this.overlay);

        // Initial state
        this.selectBG('paper');
        this.selectPreset(0);
    }

    private makeNumberInput(_label: string, value: string): HTMLInputElement {
        const input = document.createElement('input');
        input.type      = 'number';
        input.className = 'cdlg-input';
        input.value     = value;
        input.min       = '100';
        input.max       = '8192';
        input.addEventListener('input', () => {
            // Deselect preset when user types custom value
            this.presetBtns.forEach(b => b.classList.remove('active'));
            this.presetBtns[this.presetBtns.length - 1].classList.add('active'); // 'Custom'
        });
        return input;
    }

    private selectPreset(index: number): void {
        this.presetBtns.forEach((b, i) => b.classList.toggle('active', i === index));
        const p = PRESETS[index];
        if (p.w > 0) {
            this.wInput.value = String(p.w);
            this.hInput.value = String(p.h);
        }
    }

    private selectBG(type: BackgroundType): void {
        this.bgType = type;
        this.bgBtns.forEach((b, i) => {
            const types: BackgroundType[] = ['paper', 'white', 'transparent', 'color'];
            b.classList.toggle('active', types[i] === type);
        });
        const colorRow = document.getElementById('cdlg-color-row');
        if (colorRow) colorRow.style.display = type === 'color' ? 'flex' : 'none';
    }

    private confirm(): void {
        const w = Math.max(100, Math.min(8192, parseInt(this.wInput.value) || 1000));
        const h = Math.max(100, Math.min(8192, parseInt(this.hInput.value) || 1400));

        const opts: CanvasSizeOptions = {
            width: w, height: h,
            bgType:  this.bgType,
            bgColor: this.bgType === 'color' ? this.bgColor : '#F8F5EF',
            noise:   this.noiseCheck.checked,
        };

        this.close();

        if (this.mode === 'new') this.callbacks.onNewCanvas(opts);
        else                     this.callbacks.onResizeCanvas(opts);
    }

    private close(): void {
        this.overlay.style.display = 'none';
    }
}

// ── Background texture generator ──────────────────────────────────────────────

export function generateBackground(
    w: number, h: number,
    type: BackgroundType,
    customColor: string,
    withNoise:   boolean
): Uint8Array | null {
    if (type === 'transparent') return null;

    let r = 255, g = 255, b = 255;
    if      (type === 'paper') { r = 248; g = 245; b = 239; }
    else if (type === 'color') {
        const c = parseHex(customColor);
        r = c.r; g = c.g; b = c.b;
    }

    const pixels   = new Uint8Array(w * h * 4);
    const noiseAmt = withNoise ? 10 : 0;

    for (let i = 0; i < w * h; i++) {
        const noise = withNoise ? (Math.random() - 0.5) * noiseAmt : 0;
        pixels[i*4]   = Math.max(0, Math.min(255, Math.round(r + noise)));
        pixels[i*4+1] = Math.max(0, Math.min(255, Math.round(g + noise)));
        pixels[i*4+2] = Math.max(0, Math.min(255, Math.round(b + noise)));
        pixels[i*4+3] = 255;
    }
    return pixels;
}

function parseHex(hex: string): { r: number; g: number; b: number } {
    const c = hex.replace('#', '');
    return {
        r: parseInt(c.substring(0, 2), 16),
        g: parseInt(c.substring(2, 4), 16),
        b: parseInt(c.substring(4, 6), 16),
    };
}
