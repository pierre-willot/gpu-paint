// src/core/tools/selection-tool.ts
// C2/C3 — Rect, Lasso, and Polygon selection tools.
//
// Selection type and mode are set externally (by the UI popup) via setType()
// and setMode(). The tool reads them on each gesture.
//
// Rect:    drag to define a rectangle — live preview via canvas overlay
// Lasso:   freehand draw while pointer is held — point cloud sent on release
// Polygon: click to add vertices, double-click or click near start to close
//
// All operations delegate to pipeline.setRectSelection() / setLassoSelection()
// which forward to SelectionManager, update the GPU mask, and emit marching ants.

import type { PaintPipeline }  from '../../renderer/pipeline';
import type { BrushBlendMode } from '../../renderer/brush-descriptor';
import type { Tool }           from '../tool';
import { SelectionMode }       from '../../renderer/pipeline';

export type SelectionType = 'rect' | 'lasso' | 'poly';
export type { SelectionMode };

// ── Selection overlay canvas ─────────────────────────────────────────────────
// Drawn in CSS-pixel space on top of the WebGPU canvas.
// Shows live rect / lasso / polygon preview while the gesture is in progress.

let overlayCanvas: HTMLCanvasElement | null = null;
let overlayCtx:    CanvasRenderingContext2D | null = null;

function ensureOverlay(webgpuCanvas: HTMLCanvasElement): CanvasRenderingContext2D {
    if (!overlayCanvas) {
        overlayCanvas = document.createElement('canvas');
        overlayCanvas.style.cssText =
            'position:fixed;inset:0;pointer-events:none;z-index:8999;';
        document.body.appendChild(overlayCanvas);
        overlayCtx = overlayCanvas.getContext('2d')!;
        const resize = () => {
            overlayCanvas!.width  = window.innerWidth;
            overlayCanvas!.height = window.innerHeight;
        };
        resize();
        window.addEventListener('resize', resize);
    }
    return overlayCtx!;
}

function clearOverlay(): void {
    if (overlayCtx && overlayCanvas) {
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

// ── SelectionTool ─────────────────────────────────────────────────────────────

export class SelectionTool implements Tool {
    public readonly blendMode: BrushBlendMode = 'normal';
    public get isActive(): boolean { return this._active; }

    private _active = false;

    // Current gesture state
    private type: SelectionType   = 'rect';
    private mode: SelectionMode   = 'replace';

    // Rect
    private startX = 0;
    private startY = 0;
    private endX = 0;
    private endY = 0;

    // Lasso — normalized canvas coordinates collected during drag
    private lassoPoints: number[] = [];

    // Polygon — click-to-place points; close on double-click or near first vertex
    private polyPoints:     number[]  = [];
    private polyActive      = false;
    private polyLastClickMs = 0;

    // Screen-space tracking (for overlay drawing)
    private screenStartX = 0;
    private screenStartY = 0;
    private screenPoints: { x: number; y: number }[] = [];

    // Injected by app after construction so we can convert screen → canvas coords
    public screenToCanvas: ((cx: number, cy: number) => { x: number; y: number }) | null = null;
    public canvasToScreen: ((nx: number, ny: number) => { x: number; y: number }) | null = null;

    /**
     * Fired when a selection operation is committed.
     * App.ts wires this to push a 'selection' command to history.
     * The callback is responsible for actually calling the pipeline — the tool
     * does NOT call pipeline.setRectSelection/setLassoSelection itself.
     */
    public onSelectionMade: ((op: {
        operation: 'rect' | 'lasso';
        selMode:   string;
        x?:        number; y?: number; w?: number; h?: number;
        points?:   number[];
    }) => void) | null = null;

    constructor(private canvas: HTMLCanvasElement) {}

    // ── Public setters — called from UI popup ─────────────────────────────────

    public setType(t: SelectionType): void {
        if (t !== this.type) {
            this.cancelPoly();
            this.type = t;
        }
    }

    public setMode(m: SelectionMode): void { this.mode = m; }

    public getType(): SelectionType  { return this.type; }
    public getMode(): SelectionMode  { return this.mode; }

    // ── Tool interface ────────────────────────────────────────────────────────

    onPointerDown(nx: number, ny: number, _p: number, pipeline: PaintPipeline, _tx = 0, _ty = 0): void {
        const ctx = ensureOverlay(this.canvas);

        if (this.type === 'rect') {
            this._active = true;
            this.startX = nx; this.startY = ny;
            this.endX   = nx; this.endY   = ny;
        }

        else if (this.type === 'lasso') {
            this._active    = true;
            this.lassoPoints = [nx, ny];
        }

        else if (this.type === 'poly') {
            const now = Date.now();
            const dbl = now - this.polyLastClickMs < 350;
            this.polyLastClickMs = now;

            if (!this.polyActive) {
                // Start new polygon
                this.polyActive  = true;
                this.polyPoints  = [nx, ny];
                this.screenPoints = [this.canvasToScreen
                    ? this.canvasToScreen(nx, ny)
                    : { x: 0, y: 0 }];
                this._active = true;
            } else if (dbl || this.isNearFirst(nx, ny)) {
                // Close polygon
                this.commitPoly(pipeline);
                return;
            } else {
                // Add point
                this.polyPoints.push(nx, ny);
                const sp = this.canvasToScreen ? this.canvasToScreen(nx, ny) : { x: 0, y: 0 };
                this.screenPoints.push(sp);
            }

            this.drawPolyOverlay(ctx);
        }
    }

    onPointerMove(nx: number, ny: number, _p: number, _pipeline: PaintPipeline): void {
        const ctx = ensureOverlay(this.canvas);

        if (this.type === 'rect' && this._active) {
            this.endX = nx; this.endY = ny;
            this.drawRectOverlay(ctx);
        }

        else if (this.type === 'lasso' && this._active) {
            this.lassoPoints.push(nx, ny);
            this.drawLassoOverlay(ctx, nx, ny);
        }

        else if (this.type === 'poly' && this.polyActive) {
            // Draw in-progress line from last committed point to cursor
            this.drawPolyOverlay(ctx, nx, ny);
        }
    }

    async onPointerUp(nx: number, ny: number, _p: number, pipeline: PaintPipeline): Promise<Float32Array | null> {
        if (this.type === 'rect' && this._active) {
            this._active = false;
            clearOverlay();

            const x0 = Math.min(this.startX, nx);
            const y0 = Math.min(this.startY, ny);
            const x1 = Math.max(this.startX, nx);
            const y1 = Math.max(this.startY, ny);

            if (x1 - x0 > 0.001 && y1 - y0 > 0.001) {
                // Apply immediately for visual feedback, then record to history
                pipeline.setRectSelection(x0, y0, x1 - x0, y1 - y0, this.mode);
                this.onSelectionMade?.({
                    operation: 'rect', selMode: this.mode,
                    x: x0, y: y0, w: x1 - x0, h: y1 - y0,
                });
            } else {
                // Tap with no drag → deselect
                pipeline.deselect();
                this.onSelectionMade?.({ operation: 'rect', selMode: 'replace', x: 0, y: 0, w: 0, h: 0 });
            }
        }

        else if (this.type === 'lasso' && this._active) {
            this._active = false;
            clearOverlay();

            if (this.lassoPoints.length >= 6) {
                // Apply immediately, then record to history
                pipeline.setLassoSelection(this.lassoPoints, this.mode);
                this.onSelectionMade?.({
                    operation: 'lasso', selMode: this.mode,
                    points: this.lassoPoints.slice(),
                });
            }
            this.lassoPoints = [];
        }

        // Polygon waits for double-click to commit — no action on single pointerUp
        return null;
    }

    renderTick(_pipeline: PaintPipeline): Float32Array { return new Float32Array(); }
    getPrediction(): Float32Array                      { return new Float32Array(); }

    reset(pipeline: PaintPipeline): void {
        this._active      = false;
        this.lassoPoints  = [];
        this.cancelPoly();
        clearOverlay();
    }

    // ── Polygon helpers ───────────────────────────────────────────────────────

    private cancelPoly(): void {
        this.polyActive   = false;
        this.polyPoints   = [];
        this.screenPoints = [];
        this._active      = false;
        clearOverlay();
    }

    private commitPoly(pipeline: PaintPipeline): void {
        const pts = this.polyPoints.slice();
        this.cancelPoly();
        if (pts.length >= 6) {
            pipeline.setLassoSelection(pts, this.mode);
            this.onSelectionMade?.({
                operation: 'lasso', selMode: this.mode,
                points: pts,
            });
        }
    }

    private isNearFirst(nx: number, ny: number): boolean {
        if (this.polyPoints.length < 2) return false;
        const dx = nx - this.polyPoints[0];
        const dy = ny - this.polyPoints[1];
        return Math.sqrt(dx * dx + dy * dy) < 0.015; // ~15px at 1000px canvas
    }

    // ── Overlay drawing ───────────────────────────────────────────────────────

    private drawRectOverlay(ctx: CanvasRenderingContext2D): void {
        if (!overlayCanvas) return;
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        // Convert normalized → screen coords
        const s = this.canvasToScreen;
        if (!s) return;

        const p0 = s(this.startX, this.startY);
        const p1 = s(this.endX,   this.endY);

        const x = Math.min(p0.x, p1.x), y = Math.min(p0.y, p1.y);
        const w = Math.abs(p1.x - p0.x), h = Math.abs(p1.y - p0.y);

        this.strokeDashed(ctx, () => ctx.rect(x, y, w, h));
    }

    private drawLassoOverlay(ctx: CanvasRenderingContext2D, nx: number, ny: number): void {
        if (!overlayCanvas || !this.canvasToScreen) return;
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

        ctx.beginPath();
        for (let i = 0; i < this.lassoPoints.length; i += 2) {
            const sp = this.canvasToScreen(this.lassoPoints[i], this.lassoPoints[i+1]);
            if (i === 0) ctx.moveTo(sp.x, sp.y);
            else         ctx.lineTo(sp.x, sp.y);
        }
        const last = this.canvasToScreen(nx, ny);
        ctx.lineTo(last.x, last.y);

        this.strokeDashed(ctx, null);
    }

    private drawPolyOverlay(ctx: CanvasRenderingContext2D, curNx?: number, curNy?: number): void {
        if (!overlayCanvas) return;
        ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        if (this.screenPoints.length === 0) return;

        ctx.beginPath();
        ctx.moveTo(this.screenPoints[0].x, this.screenPoints[0].y);
        for (let i = 1; i < this.screenPoints.length; i++) {
            ctx.lineTo(this.screenPoints[i].x, this.screenPoints[i].y);
        }

        if (curNx !== undefined && curNy !== undefined && this.canvasToScreen) {
            const cur = this.canvasToScreen(curNx, curNy);
            ctx.lineTo(cur.x, cur.y);
        }

        this.strokeDashed(ctx, null);

        // Draw vertex dots
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        for (const sp of this.screenPoints) {
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Highlight first vertex when close enough to close
        if (this.screenPoints.length > 1 && curNx !== undefined && this.isNearFirst(curNx, curNy!)) {
            ctx.strokeStyle = '#6cbbff';
            ctx.lineWidth   = 2;
            ctx.beginPath();
            ctx.arc(this.screenPoints[0].x, this.screenPoints[0].y, 7, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    private strokeDashed(ctx: CanvasRenderingContext2D, pathFn: (() => void) | null): void {
        if (pathFn) ctx.beginPath();
        if (pathFn) pathFn();

        // Dark outline
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth   = 2.5;
        ctx.stroke();

        // White marching-ants dashes
        if (pathFn) { ctx.beginPath(); pathFn(); }
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
    }
}
