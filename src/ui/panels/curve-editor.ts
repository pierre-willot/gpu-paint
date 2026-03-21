import type { CurveSpec } from '../../renderer/brush-descriptor';

// ── CurveEditor ───────────────────────────────────────────────────────────────
// A small inline bezier curve editor for pressure/speed → value mappings.
// The bezier is CSS cubic-bezier style: P0=(0,0) and P3=(1,1) fixed,
// P1=(p1x,p1y) and P2=(p2x,p2y) are user-draggable.

export interface CurveEditorOptions {
    width?:    number;   // default 120
    height?:   number;   // default 80
    label?:    string;   // shown above
    onChange:  (spec: CurveSpec) => void;
}

const DEFAULT_P1X = 0.42, DEFAULT_P1Y = 0.0;
const DEFAULT_P2X = 0.58, DEFAULT_P2Y = 1.0;

export class CurveEditor {
    public readonly el: HTMLElement;
    private canvas:    HTMLCanvasElement;
    private ctx:       CanvasRenderingContext2D;
    private spec:      CurveSpec;
    private onChange:  (spec: CurveSpec) => void;

    private w: number;
    private h: number;

    // Drag state
    private dragging: 1 | 2 | null = null;
    private dragOffX = 0;
    private dragOffY = 0;

    constructor(opts: CurveEditorOptions) {
        this.w       = opts.width  ?? 120;
        this.h       = opts.height ?? 80;
        this.onChange = opts.onChange;

        this.spec = { mode: 'off', p1x: DEFAULT_P1X, p1y: DEFAULT_P1Y, p2x: DEFAULT_P2X, p2y: DEFAULT_P2Y, min: 0, max: 1 };

        // ── Build DOM ─────────────────────────────────────────────────────────
        this.el = document.createElement('div');
        this.el.style.cssText = 'display:flex;flex-direction:column;gap:2px;';

        // Label row
        if (opts.label) {
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:1px;';
            lbl.textContent   = opts.label;
            this.el.appendChild(lbl);
        }

        // Canvas
        this.canvas             = document.createElement('canvas');
        this.canvas.width       = this.w;
        this.canvas.height      = this.h;
        this.canvas.style.cssText = `width:${this.w}px;height:${this.h}px;border-radius:5px;cursor:pointer;display:block;`;
        this.ctx = this.canvas.getContext('2d')!;
        this.el.appendChild(this.canvas);

        // Range row (min/max output clamp inputs)
        const rangeRow = document.createElement('div');
        rangeRow.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;';
        const makeRangeInput = (label: string, val: number, title: string) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;align-items:center;gap:2px;flex:1;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'font-size:9px;color:var(--text-3);white-space:nowrap;';
            lbl.textContent = label;
            const inp = document.createElement('input');
            inp.type = 'number'; inp.min = '0'; inp.max = '1'; inp.step = '0.01';
            inp.value = String(val); inp.title = title;
            inp.style.cssText = 'width:100%;font-size:9px;background:var(--track-bg);color:var(--text-1);border:1px solid var(--border);border-radius:3px;padding:1px 3px;';
            wrap.appendChild(lbl); wrap.appendChild(inp);
            return { wrap, inp };
        };
        const minRng = makeRangeInput('Min', this.spec.min ?? 0, 'Minimum output value (0–1)');
        const maxRng = makeRangeInput('Max', this.spec.max ?? 1, 'Maximum output value (0–1)');
        rangeRow.appendChild(minRng.wrap); rangeRow.appendChild(maxRng.wrap);
        this.el.appendChild(rangeRow);

        minRng.inp.addEventListener('change', () => {
            const v = Math.max(0, Math.min(1, parseFloat(minRng.inp.value) || 0));
            minRng.inp.value = String(v);
            this.spec = { ...this.spec, min: v };
            this.onChange({ ...this.spec });
        });
        maxRng.inp.addEventListener('change', () => {
            const v = Math.max(0, Math.min(1, parseFloat(maxRng.inp.value) || 1));
            maxRng.inp.value = String(v);
            this.spec = { ...this.spec, max: v };
            this.onChange({ ...this.spec });
        });
        (this as any)._minRngInp = minRng.inp;
        (this as any)._maxRngInp = maxRng.inp;

        // Mode label row
        const modeRow = document.createElement('div');
        modeRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';

        const modeLbl = document.createElement('span');
        modeLbl.id            = 'mode-lbl-' + Math.random().toString(36).slice(2);
        modeLbl.style.cssText = 'font-size:9px;color:var(--text-3);';
        modeLbl.textContent   = 'off';
        modeRow.appendChild(modeLbl);
        this.el.appendChild(modeRow);

        // Store mode label ref
        (this as any)._modeLbl = modeLbl;

        this.draw();
        this.setupInteraction();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public setSpec(spec: CurveSpec): void {
        this.spec = { ...spec };
        if (!this.spec.p1x) this.spec.p1x = DEFAULT_P1X;
        if (!this.spec.p1y) this.spec.p1y = DEFAULT_P1Y;
        if (!this.spec.p2x) this.spec.p2x = DEFAULT_P2X;
        if (!this.spec.p2y) this.spec.p2y = DEFAULT_P2Y;
        const minInp = (this as any)._minRngInp as HTMLInputElement | undefined;
        const maxInp = (this as any)._maxRngInp as HTMLInputElement | undefined;
        if (minInp) minInp.value = String(this.spec.min ?? 0);
        if (maxInp) maxInp.value = String(this.spec.max ?? 1);
        this.updateModeLbl();
        this.draw();
    }

    public getSpec(): CurveSpec {
        return { ...this.spec };
    }

    // ── Drawing ───────────────────────────────────────────────────────────────

    private draw(): void {
        const ctx = this.ctx, w = this.w, h = this.h;
        const pad = 6; // inner padding in pixels

        // Background
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(18,20,26,0.92)';
        const r = 5;
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, r);
        ctx.fill();

        // Grid
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth   = 1;
        for (let i = 1; i < 4; i++) {
            const x = pad + ((w - pad*2) * i / 4);
            const y = pad + ((h - pad*2) * i / 4);
            ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, h - pad); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
        }

        // Diagonal reference line
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, pad); ctx.stroke();

        const off = this.spec.mode === 'off';

        // Convert normalized 0..1 coords to pixel coords
        const toX = (nx: number) => pad + nx * (w - pad*2);
        const toY = (ny: number) => (h - pad) - ny * (h - pad*2);

        if (this.spec.mode === 'linear') {
            ctx.strokeStyle = off ? 'rgba(180,210,255,0.25)' : 'rgba(180,210,255,0.9)';
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.moveTo(toX(0), toY(0)); ctx.lineTo(toX(1), toY(1));
            ctx.stroke();
        } else {
            // Bezier (or off — show dimmed bezier so the shape is always visible)
            const p1x = this.spec.p1x ?? DEFAULT_P1X;
            const p1y = this.spec.p1y ?? DEFAULT_P1Y;
            const p2x = this.spec.p2x ?? DEFAULT_P2X;
            const p2y = this.spec.p2y ?? DEFAULT_P2Y;

            // Control point lines
            ctx.strokeStyle = off ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.2)';
            ctx.lineWidth   = 1;
            ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.moveTo(toX(0), toY(0)); ctx.lineTo(toX(p1x), toY(p1y)); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(toX(1), toY(1)); ctx.lineTo(toX(p2x), toY(p2y)); ctx.stroke();
            ctx.setLineDash([]);

            // Curve
            ctx.strokeStyle = off ? 'rgba(180,210,255,0.22)' : 'rgba(180,210,255,0.95)';
            ctx.lineWidth   = 1.5;
            ctx.beginPath();
            ctx.moveTo(toX(0), toY(0));
            ctx.bezierCurveTo(toX(p1x), toY(p1y), toX(p2x), toY(p2y), toX(1), toY(1));
            ctx.stroke();

            // Control point handles (only when active)
            if (!off) {
                const drawHandle = (nx: number, ny: number, hovered: boolean) => {
                    ctx.beginPath();
                    ctx.arc(toX(nx), toY(ny), hovered ? 5 : 4, 0, Math.PI * 2);
                    ctx.fillStyle   = hovered ? 'rgba(120,180,255,1)' : 'rgba(180,210,255,0.9)';
                    ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                    ctx.lineWidth   = 1;
                    ctx.stroke();
                };
                drawHandle(p1x, p1y, this.dragging === 1);
                drawHandle(p2x, p2y, this.dragging === 2);
            }
        }

        // "off" overlay text
        if (off) {
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.font      = `${Math.round(h * 0.18)}px DM Sans, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('click to enable', w / 2, h / 2);
        }
    }

    // ── Interaction ───────────────────────────────────────────────────────────

    private setupInteraction(): void {
        const canvas = this.canvas;

        canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (this.spec.mode !== 'bezier') {
                // Click cycles: off → bezier → off (skip linear for simplicity)
                const next = this.spec.mode === 'off' ? 'bezier' : 'off';
                this.spec  = { ...this.spec, mode: next as 'off' | 'bezier' };
                this.updateModeLbl();
                this.draw();
                this.onChange({ ...this.spec });
                return;
            }
            // Check if near a control point
            const pt = this.canvasPoint(e);
            const p1 = this.toPixel(this.spec.p1x ?? DEFAULT_P1X, this.spec.p1y ?? DEFAULT_P1Y);
            const p2 = this.toPixel(this.spec.p2x ?? DEFAULT_P2X, this.spec.p2y ?? DEFAULT_P2Y);
            if (dist2(pt, p1) < 10) {
                this.dragging = 1;
                canvas.setPointerCapture(e.pointerId);
            } else if (dist2(pt, p2) < 10) {
                this.dragging = 2;
                canvas.setPointerCapture(e.pointerId);
            } else {
                // Click on empty area: toggle mode
                const next = this.spec.mode === 'off' ? 'bezier' : 'off';
                this.spec  = { ...this.spec, mode: next as 'off' | 'bezier' };
                this.updateModeLbl();
                this.draw();
                this.onChange({ ...this.spec });
            }
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!this.dragging) return;
            const pt  = this.canvasPoint(e);
            const nx  = Math.max(0, Math.min(1, (pt.x - 6) / (this.w - 12)));
            const ny  = Math.max(0, Math.min(1, 1 - (pt.y - 6) / (this.h - 12)));
            if (this.dragging === 1) {
                this.spec = { ...this.spec, p1x: nx, p1y: ny };
            } else {
                this.spec = { ...this.spec, p2x: nx, p2y: ny };
            }
            this.draw();
            this.onChange({ ...this.spec });
        });

        canvas.addEventListener('pointerup', () => {
            this.dragging = null;
            this.draw();
        });

        canvas.addEventListener('pointercancel', () => {
            this.dragging = null;
            this.draw();
        });

        // Right-click to reset to bezier default
        canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            this.spec = { mode: 'bezier', p1x: DEFAULT_P1X, p1y: DEFAULT_P1Y, p2x: DEFAULT_P2X, p2y: DEFAULT_P2Y, min: this.spec.min, max: this.spec.max };
            this.updateModeLbl();
            this.draw();
            this.onChange({ ...this.spec });
        });
    }

    private canvasPoint(e: PointerEvent): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    private toPixel(nx: number, ny: number): { x: number; y: number } {
        const pad = 6;
        return {
            x: pad + nx * (this.w - pad*2),
            y: (this.h - pad) - ny * (this.h - pad*2)
        };
    }

    private updateModeLbl(): void {
        const lbl = (this as any)._modeLbl as HTMLElement;
        if (lbl) lbl.textContent = this.spec.mode;
    }
}

function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx*dx + dy*dy);
}
