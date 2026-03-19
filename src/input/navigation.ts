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
        const HEADER_H = 52;
        const padding  = 40;
        const availW   = window.innerWidth  - padding * 2;
        const availH   = window.innerHeight - HEADER_H - padding * 2;
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

    public applyZoom(factor: number): void {
        this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom * factor));
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
            // Scrubby zoom — Ctrl + Space + left drag
            if (this.keys.Space && this.keys.Control && e.buttons === 1) {
                this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom + e.movementX * 0.005));
                this.onUpdate();
            }
        });

        // Mouse wheel — zoom. Ctrl+wheel = trackpad pinch gesture.
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {
                // Trackpad pinch (browser sends Ctrl+wheel for pinch)
                const factor = e.deltaY > 0 ? 0.95 : 1.05;
                this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom * factor));
            } else {
                this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom - e.deltaY * 0.001));
            }
            this.onUpdate();
        }, { passive: false });
    }
}
