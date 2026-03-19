// ── BrushCursor ───────────────────────────────────────────────────────────────
// Renders the brush preview circle at the screen-space pointer position.
//
// Key design decisions:
//   • The overlay canvas is `position:fixed; inset:0` on document.body — it
//     covers the full viewport and is completely independent of the WebGPU
//     canvas transform (zoom, rotation, pan). This is the only correct approach
//     when the canvas can be rotated and zoomed: getBoundingClientRect() on a
//     rotated element returns its bounding box, not its visible rect, making
//     coordinate math wrong at any non-zero rotation.
//
//   • Cursor position = raw e.clientX / e.clientY — no rect subtraction needed.
//
//   • Cursor radius is derived from the normalized brush size × the canvas
//     display width, which is `canvasLogicalWidth × zoom`. This makes the
//     preview circle match the actual stamp size regardless of zoom level.

export class BrushCursor {
    private canvas:  HTMLCanvasElement;
    private ctx:     CanvasRenderingContext2D;
    private dpr      = Math.min(window.devicePixelRatio || 1, 2);
    private visible  = false;

    // Brush state
    private size   = 0.05;    // normalized 0..1
    private tiltX  = 0;
    private tiltY  = 0;

    // Supplied by app so cursor radius matches the displayed canvas size.
    // Must be kept up to date when zoom changes.
    private getDisplayWidth: () => number;

    constructor(
        private webgpuCanvas: HTMLCanvasElement,
        getDisplayWidth: () => number
    ) {
        this.getDisplayWidth = getDisplayWidth;

        this.canvas         = document.createElement('canvas');
        this.canvas.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:9000;';
        document.body.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d')!;
        this.resize();

        window.addEventListener('resize', () => this.resize());

        this.setupEvents();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    public setSize(normalizedSize: number): void  { this.size = normalizedSize; }
    public setVisible(v: boolean): void           { this.visible = v; if (!v) this.clear(); }
    public show(): void                           { this.setVisible(true);  }
    public hide(): void                           { this.setVisible(false); }

    // ── Private ───────────────────────────────────────────────────────────────

    private resize(): void {
        this.dpr            = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width   = window.innerWidth  * this.dpr;
        this.canvas.height  = window.innerHeight * this.dpr;
        this.canvas.style.width  = window.innerWidth  + 'px';
        this.canvas.style.height = window.innerHeight + 'px';
    }

    private setupEvents(): void {
        // Listen globally — cursor must update even when pointer is moving fast
        window.addEventListener('pointermove', (e) => {
            if (!this.visible) return;
            // Only draw when pointer is over the painting canvas
            const target = e.target as HTMLElement;
            const overCanvas = target === this.webgpuCanvas || this.webgpuCanvas.contains(target);
            if (!overCanvas) { this.clear(); return; }

            this.tiltX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
            this.tiltY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
            this.draw(e.clientX, e.clientY);
        });

        this.webgpuCanvas.addEventListener('pointerleave', () => this.clear());
        this.webgpuCanvas.addEventListener('pointerenter', (e) => {
            if (this.visible) this.webgpuCanvas.style.cursor = 'none';
            this.tiltX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
            this.tiltY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
        });
    }

    private draw(clientX: number, clientY: number): void {
        this.clear();

        // Radius in CSS pixels: normalizedSize × displayed canvas width ÷ 2
        const radiusPx = (this.size / 2) * this.getDisplayWidth();
        if (radiusPx < 0.5) return;

        const ctx = this.ctx;
        // Scale to DPR — all coordinates are in CSS pixels
        const x   = clientX * this.dpr;
        const y   = clientY * this.dpr;
        const r   = radiusPx * this.dpr;

        // Tilt-driven ellipse — matches brush.wgsl aspect calculation
        const tiltMag = Math.sqrt(this.tiltX ** 2 + this.tiltY ** 2);
        const aspect  = tiltMag > 5 ? 1 + (tiltMag / 90) * 2 : 1;
        const azimuth = tiltMag > 5 ? Math.atan2(this.tiltY, this.tiltX) : 0;

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(azimuth);
        ctx.scale(aspect, 1);

        // Outer dark shadow — visibility on light backgrounds
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth   = 2.5 * this.dpr;
        ctx.stroke();

        // Inner white ring
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth   = 1.5 * this.dpr;
        ctx.stroke();

        // Crosshair dot for tiny brushes
        if (r < 8 * this.dpr) {
            ctx.beginPath();
            ctx.arc(0, 0, 1.5 * this.dpr, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.92)';
            ctx.fill();
        }

        ctx.restore();
    }

    private clear(): void {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
}
