// ── PressureCurveUI ───────────────────────────────────────────────────────────
// Interactive Procreate-style cubic bezier pressure curve editor.
//
// Layout:
//   X axis = input pressure (left = 0, right = 1)
//   Y axis = output pressure (bottom = 0, top = 1)
//   Fixed anchors: P0 = (0,0) bottom-left, P3 = (1,1) top-right
//   Two draggable control points P1 and P2
//
// The curve is a standard CSS/SVG cubic bezier sampled at 256 t-values.
// For each of the 256 LUT entries, we find the bezier t that gives x ≈ i/255
// by building a sorted (x→y) table and linear-interpolating.
//
// Renders into the element with id="pressureCurveContainer" in the brush panel.

export class PressureCurveUI {
    // SVG dimensions
    private readonly W  = 180;
    private readonly H  = 100;
    private readonly PAD = 10; // padding inside SVG for draggable area

    // Normalized control points (0..1 range)
    private p1 = { x: 0.33, y: 0.33 };
    private p2 = { x: 0.67, y: 0.67 };

    private svg!:        SVGSVGElement;
    private curvePath!:  SVGPathElement;
    private line1!:      SVGLineElement;
    private line2!:      SVGLineElement;
    private handle1!:    SVGCircleElement;
    private handle2!:    SVGCircleElement;

    private dragging: 1 | 2 | null = null;

    constructor(
        private container: HTMLElement,
        private onLUTChange: (lut: Float32Array) => void
    ) {
        this.buildSVG();
        this.updateSVG();
        this.emitLUT();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    /** Reset to linear (identity) curve. */
    public reset(): void {
        this.p1 = { x: 0.33, y: 0.33 };
        this.p2 = { x: 0.67, y: 0.67 };
        this.updateSVG();
        this.emitLUT();
    }

    /** Load a named preset. */
    public setPreset(name: 'linear' | 'soft' | 'hard' | 'heavy' | 'light'): void {
        const presets: Record<string, [typeof this.p1, typeof this.p2]> = {
            linear: [{ x: 0.33, y: 0.33 }, { x: 0.67, y: 0.67 }],
            soft:   [{ x: 0.20, y: 0.50 }, { x: 0.70, y: 0.85 }],
            hard:   [{ x: 0.30, y: 0.10 }, { x: 0.80, y: 0.60 }],
            heavy:  [{ x: 0.10, y: 0.40 }, { x: 0.60, y: 0.90 }],
            light:  [{ x: 0.40, y: 0.10 }, { x: 0.90, y: 0.60 }],
        };
        [this.p1, this.p2] = presets[name];
        this.updateSVG();
        this.emitLUT();
    }

    // ── Private — SVG construction ────────────────────────────────────────────

    private buildSVG(): void {
        const ns  = 'http://www.w3.org/2000/svg';
        this.svg  = document.createElementNS(ns, 'svg') as SVGSVGElement;
        this.svg.setAttribute('viewBox', `0 0 ${this.W} ${this.H}`);
        this.svg.setAttribute('width',   String(this.W));
        this.svg.setAttribute('height',  String(this.H));
        this.svg.style.cssText = 'display:block;width:100%;height:auto;border-radius:6px;background:rgba(0,0,0,0.22);border:1px solid rgba(255,255,255,0.1);touch-action:none;cursor:default;';

        // Grid lines (subtle)
        const grid = document.createElementNS(ns, 'g') as SVGGElement;
        grid.setAttribute('stroke', 'rgba(255,255,255,0.07)');
        grid.setAttribute('stroke-width', '0.5');
        for (let i = 1; i < 4; i++) {
            const x = (i / 4) * this.W;
            const y = (i / 4) * this.H;
            const vl = document.createElementNS(ns, 'line') as SVGLineElement;
            vl.setAttribute('x1', String(x)); vl.setAttribute('y1', '0');
            vl.setAttribute('x2', String(x)); vl.setAttribute('y2', String(this.H));
            const hl = document.createElementNS(ns, 'line') as SVGLineElement;
            hl.setAttribute('x1', '0');          hl.setAttribute('y1', String(y));
            hl.setAttribute('x2', String(this.W)); hl.setAttribute('y2', String(y));
            grid.appendChild(vl); grid.appendChild(hl);
        }
        this.svg.appendChild(grid);

        // Diagonal reference (linear = identity)
        const diag = document.createElementNS(ns, 'line') as SVGLineElement;
        diag.setAttribute('x1', '0');          diag.setAttribute('y1', String(this.H));
        diag.setAttribute('x2', String(this.W)); diag.setAttribute('y2', '0');
        diag.setAttribute('stroke', 'rgba(255,255,255,0.18)');
        diag.setAttribute('stroke-width', '0.5');
        diag.setAttribute('stroke-dasharray', '3 3');
        this.svg.appendChild(diag);

        // Control lines (from anchors to control points)
        this.line1 = document.createElementNS(ns, 'line') as SVGLineElement;
        this.line2 = document.createElementNS(ns, 'line') as SVGLineElement;
        for (const l of [this.line1, this.line2]) {
            l.setAttribute('stroke', 'rgba(255,255,255,0.25)');
            l.setAttribute('stroke-width', '0.8');
            l.setAttribute('stroke-dasharray', '2 2');
        }
        this.svg.appendChild(this.line1);
        this.svg.appendChild(this.line2);

        // Main bezier curve
        this.curvePath = document.createElementNS(ns, 'path') as SVGPathElement;
        this.curvePath.setAttribute('fill',         'none');
        this.curvePath.setAttribute('stroke',       'rgba(255,255,255,0.9)');
        this.curvePath.setAttribute('stroke-width', '2');
        this.curvePath.setAttribute('stroke-linecap', 'round');
        this.svg.appendChild(this.curvePath);

        // Fixed anchor dots
        for (const [nx, ny] of [[0, 0], [1, 1]] as [number, number][]) {
            const dot = document.createElementNS(ns, 'circle') as SVGCircleElement;
            dot.setAttribute('cx', String(this.toSVGX(nx)));
            dot.setAttribute('cy', String(this.toSVGY(ny)));
            dot.setAttribute('r',  '3');
            dot.setAttribute('fill', 'rgba(255,255,255,0.5)');
            dot.setAttribute('stroke', 'none');
            this.svg.appendChild(dot);
        }

        // Draggable control point handles
        this.handle1 = this.makeHandle(ns, '#6cbbff');
        this.handle2 = this.makeHandle(ns, '#6cbbff');
        this.svg.appendChild(this.handle1);
        this.svg.appendChild(this.handle2);

        // Pointer events for drag
        this.setupDrag(this.handle1, 1);
        this.setupDrag(this.handle2, 2);

        // Clear and inject
        this.container.innerHTML = '';
        this.container.appendChild(this.svg);

        // Presets row
        const presetRow = document.createElement('div');
        presetRow.style.cssText = 'display:flex;gap:3px;margin-top:6px;';
        for (const name of ['linear', 'soft', 'hard', 'heavy', 'light'] as const) {
            const btn = document.createElement('button');
            btn.textContent = name[0].toUpperCase() + name.slice(1);
            btn.style.cssText = 'flex:1;height:22px;border-radius:5px;font-size:9px;font-family:inherit;font-weight:500;cursor:pointer;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.1);color:var(--text-3);transition:all 0.1s;';
            btn.addEventListener('click', () => this.setPreset(name));
            btn.addEventListener('mouseenter', () => { btn.style.color = 'var(--text-1)'; btn.style.borderColor = 'rgba(255,255,255,0.25)'; });
            btn.addEventListener('mouseleave', () => { btn.style.color = 'var(--text-3)'; btn.style.borderColor = 'rgba(255,255,255,0.1)'; });
            presetRow.appendChild(btn);
        }
        this.container.appendChild(presetRow);
    }

    private makeHandle(ns: string, color: string): SVGCircleElement {
        const h = document.createElementNS(ns, 'circle') as SVGCircleElement;
        h.setAttribute('r',      '5');
        h.setAttribute('fill',   color);
        h.setAttribute('stroke', 'rgba(255,255,255,0.8)');
        h.setAttribute('stroke-width', '1.2');
        h.style.cursor = 'grab';
        return h;
    }

    // ── Private — drag interaction ────────────────────────────────────────────

    private setupDrag(handle: SVGCircleElement, which: 1 | 2): void {
        handle.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handle.setPointerCapture(e.pointerId);
            handle.style.cursor = 'grabbing';
            this.dragging = which;
        });

        handle.addEventListener('pointermove', (e) => {
            if (this.dragging !== which) return;
            const rect = this.svg.getBoundingClientRect();
            const nx   = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            const ny   = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top)  / rect.height));

            if (which === 1) this.p1 = { x: nx, y: ny };
            else             this.p2 = { x: nx, y: ny };

            this.updateSVG();
            this.emitLUT();
        });

        handle.addEventListener('pointerup', () => {
            this.dragging = null;
            handle.style.cursor = 'grab';
        });
    }

    // ── Private — SVG update ──────────────────────────────────────────────────

    private updateSVG(): void {
        const cx1 = this.toSVGX(this.p1.x), cy1 = this.toSVGY(this.p1.y);
        const cx2 = this.toSVGX(this.p2.x), cy2 = this.toSVGY(this.p2.y);
        const ax0 = this.toSVGX(0), ay0 = this.toSVGY(0);
        const ax3 = this.toSVGX(1), ay3 = this.toSVGY(1);

        this.curvePath.setAttribute('d', `M ${ax0} ${ay0} C ${cx1} ${cy1} ${cx2} ${cy2} ${ax3} ${ay3}`);

        this.handle1.setAttribute('cx', String(cx1));
        this.handle1.setAttribute('cy', String(cy1));
        this.handle2.setAttribute('cx', String(cx2));
        this.handle2.setAttribute('cy', String(cy2));

        // Control lines
        this.line1.setAttribute('x1', String(ax0)); this.line1.setAttribute('y1', String(ay0));
        this.line1.setAttribute('x2', String(cx1)); this.line1.setAttribute('y2', String(cy1));
        this.line2.setAttribute('x1', String(ax3)); this.line2.setAttribute('y1', String(ay3));
        this.line2.setAttribute('x2', String(cx2)); this.line2.setAttribute('y2', String(cy2));
    }

    // ── Private — LUT generation ──────────────────────────────────────────────

    private emitLUT(): void {
        this.onLUTChange(this.generateLUT());
    }

    private generateLUT(): Float32Array {
        // Sample bezier at 512 t values → build sorted (x, y) table
        const SAMPLES = 512;
        const xs = new Float32Array(SAMPLES);
        const ys = new Float32Array(SAMPLES);

        for (let i = 0; i < SAMPLES; i++) {
            const t = i / (SAMPLES - 1);
            const pt = this.bezierPoint(t);
            xs[i] = pt.x;
            ys[i] = pt.y;
        }

        // For each of 256 input values, interpolate output
        const lut = new Float32Array(256);
        for (let i = 0; i < 256; i++) {
            const targetX = i / 255;
            lut[i] = this.interpolateY(xs, ys, SAMPLES, targetX);
        }

        return lut;
    }

    private bezierPoint(t: number): { x: number; y: number } {
        const mt = 1 - t;
        const x  = mt*mt*mt*0 + 3*mt*mt*t*this.p1.x + 3*mt*t*t*this.p2.x + t*t*t*1;
        const y  = mt*mt*mt*0 + 3*mt*mt*t*this.p1.y + 3*mt*t*t*this.p2.y + t*t*t*1;
        return { x, y };
    }

    private interpolateY(xs: Float32Array, ys: Float32Array, n: number, targetX: number): number {
        // Binary search for the segment containing targetX
        let lo = 0, hi = n - 1;
        while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (xs[mid] <= targetX) lo = mid; else hi = mid;
        }
        const range = xs[hi] - xs[lo];
        if (range < 1e-10) return Math.max(0, Math.min(1, ys[lo]));
        const t = (targetX - xs[lo]) / range;
        return Math.max(0, Math.min(1, ys[lo] + t * (ys[hi] - ys[lo])));
    }

    // ── Private — coordinate conversion ──────────────────────────────────────

    private toSVGX(nx: number): number { return nx * this.W; }
    private toSVGY(ny: number): number { return (1 - ny) * this.H; }
}
