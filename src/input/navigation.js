// src/input/navigation.ts
export class NavigationManager {
    state = { x: 0, y: 0, zoom: 0.8 };
    keys = { Space: false, Control: false };
    canvas;
    onUpdate;
    constructor(canvas, onUpdate) {
        this.canvas = canvas;
        this.onUpdate = onUpdate;
        this.initListeners();
    }
    // Helper to check if we should block drawing
    get isNavigating() {
        return this.keys.Space;
    }
    initListeners() {
        // Keyboard State
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                this.keys.Space = true;
                this.canvas.style.cursor = 'grab';
                if (e.target === document.body)
                    e.preventDefault();
            }
            if (e.key === 'Control')
                this.keys.Control = true;
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.keys.Space = false;
                this.canvas.style.cursor = 'crosshair';
            }
            if (e.key === 'Control')
                this.keys.Control = false;
        });
        // Pointer Navigation (Pan & Scrubby Zoom)
        window.addEventListener('pointermove', (e) => {
            // 1. Pan (Space + Left Click) OR Middle Mouse
            if ((this.keys.Space && !this.keys.Control && e.buttons === 1) || e.buttons === 4) {
                this.state.x += e.movementX;
                this.state.y += e.movementY;
                this.onUpdate();
            }
            // 2. Scrubby Zoom (Ctrl + Space + Left Click)
            if (this.keys.Space && this.keys.Control && e.buttons === 1) {
                const scrubSpeed = 0.005;
                this.state.zoom += e.movementX * scrubSpeed;
                this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom));
                this.onUpdate();
            }
        });
        // Mouse Wheel Zoom
        window.addEventListener('wheel', (e) => {
            if (e.target === this.canvas || this.keys.Space) {
                e.preventDefault();
                const zoomSpeed = 0.001;
                this.state.zoom -= e.deltaY * zoomSpeed;
                this.state.zoom = Math.max(0.1, Math.min(5.0, this.state.zoom));
                this.onUpdate();
            }
        }, { passive: false });
    }
}
//# sourceMappingURL=navigation.js.map