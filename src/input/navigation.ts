// src/input/navigation.ts

export interface ViewState {
    x:        number;
    y:        number;
    zoom:     number;
    rotation: number;   // degrees 0..360
}

export class NavigationManager {
    public  state: ViewState = { x: 0, y: 0, zoom: 0.8, rotation: 0 };
    public  keys  = { Space: false, Control: false };

    // Set to true by GestureRecognizer when a multi-touch gesture is active
    // so the painting system knows not to draw.
    public  gestureActive = false;

    private canvas:   HTMLCanvasElement;
    private onUpdate: () => void;

    private static readonly HEADER_H = 52;

    constructor(canvas: HTMLCanvasElement, onUpdate: () => void) {
        this.canvas   = canvas;
        this.onUpdate = onUpdate;
        this.initListeners();
    }

    // ── Navigation state ──────────────────────────────────────────────────────

    public get isNavigating(): boolean {
        return this.keys.Space || this.gestureActive;
    }

    // ── Public API — called from menu.ts and gesture-recognizer.ts ────────────

    public zoomIn(): void {
        this.state.zoom = Math.min(5.0, this.state.zoom * 1.25);
        this.onUpdate();
    }

    public zoomOut(): void {
        this.state.zoom = Math.max(0.1, this.state.zoom / 1.25);
        this.onUpdate();
    }

    public resetZoom(): void {
        this.state.zoom     = 1.0;
        this.state.x        = 0;
        this.state.y        = 0;
        this.state.rotation = 0;
        this.onUpdate();
    }

    /**
     * Fits the canvas to fill the available workspace with 40px padding.
     * Resets pan and rotation.
     */
    public fitToScreen(canvasLogicalW: number, canvasLogicalH: number): void {
        const padding  = 40;
        const availW   = window.innerWidth  - padding * 2;
        const availH   = window.innerHeight - NavigationManager.HEADER_H - padding * 2;
        const zoomX    = availW  / canvasLogicalW;
        const zoomY    = availH  / canvasLogicalH;
        this.state.zoom     = Math.min(zoomX, zoomY, 1.0);
        this.state.x        = 0;
        this.state.y        = 0;
        this.state.rotation = 0;
        this.onUpdate();
    }

    public rotateBy(degrees: number): void {
        this.state.rotation = ((this.state.rotation + degrees) % 360 + 360) % 360;
        this.onUpdate();
    }

    public setRotation(degrees: number): void {
        this.state.rotation = ((degrees % 360) + 360) % 360;
        this.onUpdate();
    }

    public pan(dx: number, dy: number): void {
        this.state.x += dx;
        this.state.y += dy;
        this.onUpdate();
    }

    /**
     * Zoom around the canvas center (used by keyboard shortcuts Ctrl+/Ctrl-).
     * Does not adjust pan — the viewport center stays fixed.
     */
    public applyZoom(factor: number): void {
        this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom * factor));
        this.onUpdate();
    }

    /**
     * Zoom toward an arbitrary focal point in screen coordinates (clientX/Y).
     * Adjusts pan so the canvas point currently under focalX/focalY stays
     * fixed on screen after the zoom — exactly like Procreate or Google Maps.
     *
     * Used by:
     *   • Mouse wheel
     *   • Trackpad pinch (Ctrl+wheel)
     *   • Two-finger touch pinch (called from GestureRecognizer)
     */
    public applyZoomAt(factor: number, focalX: number, focalY: number): void {
        const oldZoom = this.state.zoom;
        const newZoom = Math.max(0.1, Math.min(5.0, oldZoom * factor));
        const actual  = newZoom / oldZoom;   // real factor after clamping

        // Current canvas center in screen space (mirrors updateCanvasTransform in app.ts)
        const cx = window.innerWidth  / 2 + this.state.x;
        const cy = NavigationManager.HEADER_H
                 + (window.innerHeight - NavigationManager.HEADER_H) / 2
                 + this.state.y;

        // Shift pan so the focal point stays stationary on screen.
        // Derivation: focalPoint_canvas must satisfy:
        //   focalX = cx + (focalX - cx) * actual   →   Δpan = (focal - cx)(1 - actual)
        this.state.x   += (focalX - cx) * (1 - actual);
        this.state.y   += (focalY - cy) * (1 - actual);
        this.state.zoom = newZoom;
        this.onUpdate();
    }

    // ── Private — keyboard + pointer listeners ────────────────────────────────

    private initListeners(): void {
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                this.keys.Space = true;
                this.canvas.style.cursor = 'grab';
                if (e.target === document.body) e.preventDefault();
            }
            if (e.key === 'Control') this.keys.Control = true;
        });

        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.keys.Space = false;
                this.canvas.style.cursor = 'crosshair';
            }
            if (e.key === 'Control') this.keys.Control = false;
        });

        window.addEventListener('pointermove', (e) => {
            // Pan — Space + left drag, or middle mouse button
            if ((this.keys.Space && !this.keys.Control && e.buttons === 1) || e.buttons === 4) {
                this.state.x += e.movementX;
                this.state.y += e.movementY;
                this.onUpdate();
            }
            // Scrubby zoom — Ctrl + Space + left drag.
            // Intentionally zooms around the canvas center (not the cursor):
            // the cursor is held still and horizontal drag is the zoom lever.
            if (this.keys.Space && this.keys.Control && e.buttons === 1) {
                this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom + e.movementX * 0.005));
                this.onUpdate();
            }
        });

        // Mouse wheel — zoom toward cursor.
        // Ctrl/Meta + wheel = trackpad pinch (browser remaps it to this).
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                // Trackpad pinch — step factor keeps it feeling natural
                const factor = e.deltaY > 0 ? 0.95 : 1.05;
                this.applyZoomAt(factor, e.clientX, e.clientY);
            } else {
                // Mouse wheel — convert additive delta to multiplicative factor
                const factor = 1 - e.deltaY * 0.001;
                this.applyZoomAt(factor, e.clientX, e.clientY);
            }
        }, { passive: false });
    }
}
