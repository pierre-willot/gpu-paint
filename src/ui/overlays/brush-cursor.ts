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

// ── BrushCursor ───────────────────────────────────────────────────────────────

export class BrushCursor {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private dpr = Math.min(window.devicePixelRatio || 1, 2);
    private visible = false;

    // Brush state
    private size = 0.05;
    private tiltX = 0;
    private tiltY = 0;
    private tiltActive = false;
    
    // Live pressure scaling
    private pressure = 1.0;
    private sizePressureActive = false;

    // Tip texture
    private tipCanvas: OffscreenCanvas | null = null;

    // Viewport callback
    private getDisplayWidth: () => number;

    // Performance tracking: Only clear the area we drew on the last frame
    private lastDrawRect = { x: 0, y: 0, size: 0 };

    // Store bound listener references for clean removal
    private boundPointerMove: (e: PointerEvent) => void;
    private boundResize: () => void;

    constructor(
        private webgpuCanvas: HTMLCanvasElement,
        getDisplayWidth: () => number
    ) {
        this.getDisplayWidth = getDisplayWidth;

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9000;';
        document.body.appendChild(this.canvas);

        this.ctx = this.canvas.getContext('2d', { alpha: true, desynchronized: true })!;
        
        // Bind methods so they can be removed later
        this.boundPointerMove = this.handlePointerMove.bind(this);
        this.boundResize = this.resize.bind(this);

        this.resize();
        this.setupEvents();
    }

    // ── Public ────────────────────────────────────────────────────────────────

    public setSize(normalizedSize: number): void { this.size = normalizedSize; }
    public setVisible(v: boolean): void { 
        this.visible = v; 
        if (!v) this.clearLastFrame(); 
    }
    public show(): void { this.setVisible(true); }
    public hide(): void { this.setVisible(false); }
    public setTiltActive(v: boolean): void { this.tiltActive = v; }
    public setSizePressureActive(v: boolean): void { this.sizePressureActive = v; }

    /** Convert bitmap R channel → alpha. Pre-bake shadows here, NOT in the draw loop. */
    public setTipBitmap(bmp: ImageBitmap | null): void {
        if (!bmp) { this.tipCanvas = null; return; }
        
        const size = 128;
        // Make the offscreen canvas slightly larger to accommodate the pre-baked shadow padding
        const pad = 10; 
        const totalSize = size + pad * 2;
        
        const off = new OffscreenCanvas(totalSize, totalSize);
        const oct = off.getContext('2d')!;
        
        // Pre-bake the shadow for performance
        oct.shadowColor = 'rgba(0,0,0,0.8)';
        oct.shadowBlur = 4;
        oct.shadowOffsetX = 0;
        oct.shadowOffsetY = 0;
        
        oct.drawImage(bmp, pad, pad, size, size);
        
        // Extract and manipulate pixel data
        const imgData = oct.getImageData(0, 0, totalSize, totalSize);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            // Assuming Red channel defines shape. Map Red to Alpha, set RGB to white.
            d[i + 3] = d[i]; 
            d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
        }
        oct.putImageData(imgData, 0, 0);
        this.tipCanvas = off;
    }

    /** MUST be called when the tool is switched or the app unmounts */
    public destroy(): void {
        window.removeEventListener('pointermove', this.boundPointerMove);
        window.removeEventListener('resize', this.boundResize);
        if (this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private resize(): void {
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = window.innerWidth * this.dpr;
        this.canvas.height = window.innerHeight * this.dpr;
    }

    private setupEvents(): void {
        window.addEventListener('resize', this.boundResize);
        window.addEventListener('pointermove', this.boundPointerMove);

        this.webgpuCanvas.addEventListener('pointerleave', () => this.clearLastFrame());
        this.webgpuCanvas.addEventListener('pointerenter', (e) => {
            if (this.visible) this.webgpuCanvas.style.cursor = 'none';
            this.updateTilt(e);
        });
    }

    private handlePointerMove(e: PointerEvent): void {
        if (!this.visible) return;

        // Note: Using document.elementFromPoint is slow. e.target is fine, 
        // but remember it reflects where the pointer DOWN happened if dragging.
        const target = e.target as Node;
        const overCanvas = target === this.webgpuCanvas || this.webgpuCanvas.contains(target);
        if (!overCanvas) { 
            this.clearLastFrame(); 
            return; 
        }

        this.updateTilt(e);

        if (this.sizePressureActive) {
            const p = e.pressure;
            this.pressure = (e.pointerType !== 'mouse' && p > 0) ? p : 1.0;
        }

        // Use requestAnimationFrame so we don't draw faster than the screen can display
        requestAnimationFrame(() => this.draw(e.clientX, e.clientY));
    }

    private updateTilt(e: PointerEvent): void {
        this.tiltX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
        this.tiltY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
    }

    private clearLastFrame(): void {
        if (this.lastDrawRect.size === 0) return;
        
        const { x, y, size } = this.lastDrawRect;
        // Pad the clear area slightly to account for antialiasing/stroke widths
        const padding = 4 * this.dpr; 
        this.ctx.clearRect(
            x - size / 2 - padding, 
            y - size / 2 - padding, 
            size + padding * 2, 
            size + padding * 2
        );
        this.lastDrawRect.size = 0;
    }

    private draw(clientX: number, clientY: number): void {
        this.clearLastFrame(); // Erase only the previous cursor

        const pressureMult = this.sizePressureActive ? this.pressure : 1.0;
        const radiusPx = (this.size / 2) * this.getDisplayWidth() * pressureMult;
        
        if (radiusPx < 0.5) return;

        const ctx = this.ctx;
        const x = clientX * this.dpr;
        const y = clientY * this.dpr;
        const r = radiusPx * this.dpr;

        const tiltMag = this.tiltActive ? Math.sqrt(this.tiltX ** 2 + this.tiltY ** 2) : 0;
        const aspect = tiltMag > 5 ? 1 + (tiltMag / 90) * 2 : 1;
        const azimuth = tiltMag > 5 ? Math.atan2(this.tiltY, this.tiltX) : 0;

        // Save layout for the next frame's clearRect
        // Multiply by aspect to ensure the bounding box covers the elongated ellipse
        this.lastDrawRect = { x, y, size: r * 2 * Math.max(1, aspect) };

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(azimuth);
        ctx.scale(aspect, 1);

        if (this.tipCanvas) {
            const d = r * 2;
            ctx.globalAlpha = 0.6;
            // Shadow is already baked into tipCanvas, no filter needed!
            ctx.drawImage(this.tipCanvas, -r, -r, d, d);
            ctx.globalAlpha = 1;
        } else {
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            
            // Photoshop classic: Outer dark, inner white
            ctx.strokeStyle = 'rgba(0,0,0,0.4)';
            ctx.lineWidth = 2.5 * this.dpr;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(0, 0, r, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 1.0 * this.dpr;
            ctx.stroke();

            if (r < 8 * this.dpr) {
                ctx.beginPath();
                ctx.arc(0, 0, 1.5 * this.dpr, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(255,255,255,0.9)';
                ctx.fill();
            }
        }

        ctx.restore();
    }
}
