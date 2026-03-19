// src/ui/panel-manager.ts
const PANEL_TOP      = 52 + 16; // header-h + 16px gap
const INTERACTIVE    = 'button,input,select,textarea,[contenteditable],a,.layer-drag-handle';

let globalResizing = false; // prevents drag firing during resize

// ── Draggable (entire panel surface) ─────────────────────────────────────────

export function makeDraggable(panel: HTMLElement): void {
    let ox = 0, oy = 0, dragging = false;

    panel.addEventListener('mousedown', (e) => {
        if (globalResizing) return;
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        dragging = true;
        const r  = panel.getBoundingClientRect();
        ox = e.clientX - r.left;
        oy = e.clientY - r.top;
        document.body.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const vw = window.innerWidth, vh = window.innerHeight;
        const pw = panel.offsetWidth,  ph = panel.offsetHeight;
        panel.style.left      = Math.max(0, Math.min(vw - pw, e.clientX - ox)) + 'px';
        panel.style.top       = Math.max(PANEL_TOP, Math.min(vh - ph, e.clientY - oy)) + 'px';
        panel.style.right     = 'auto';
        panel.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
        if (dragging) { dragging = false; document.body.style.cursor = ''; }
    });
}

// ── All-edge resize ───────────────────────────────────────────────────────────

export interface ResizeOptions { minW?: number; minH?: number; }

export function addResizeHandles(panel: HTMLElement, opts: ResizeOptions = {}): void {
    const minW = opts.minW ?? 80, minH = opts.minH ?? 60, T = 7;

    const edges = [
        { d: 'n',  s: `top:0;left:${T*2}px;right:${T*2}px;height:${T}px;cursor:n-resize;` },
        { d: 's',  s: `bottom:0;left:${T*2}px;right:${T*2}px;height:${T}px;cursor:s-resize;` },
        { d: 'e',  s: `top:${T*2}px;right:0;bottom:${T*2}px;width:${T}px;cursor:e-resize;` },
        { d: 'w',  s: `top:${T*2}px;left:0;bottom:${T*2}px;width:${T}px;cursor:w-resize;` },
        { d: 'ne', s: `top:0;right:0;width:${T*2}px;height:${T*2}px;cursor:ne-resize;` },
        { d: 'nw', s: `top:0;left:0;width:${T*2}px;height:${T*2}px;cursor:nw-resize;` },
        { d: 'se', s: `bottom:0;right:0;width:${T*2}px;height:${T*2}px;cursor:se-resize;` },
        { d: 'sw', s: `bottom:0;left:0;width:${T*2}px;height:${T*2}px;cursor:sw-resize;` },
    ];

    for (const { d, s } of edges) {
        const handle = document.createElement('div');
        handle.style.cssText = 'position:absolute;z-index:30;' + s;
        panel.appendChild(handle);

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation();
            globalResizing = true;
            const sx = e.clientX, sy = e.clientY;
            const sw = panel.offsetWidth, sh = panel.offsetHeight;
            const rect = panel.getBoundingClientRect();
            const sl = rect.left, st = rect.top;
            document.body.style.cursor = handle.style.cursor;

            const onMove = (e: MouseEvent) => {
                const dx = e.clientX - sx, dy = e.clientY - sy;
                const vw = window.innerWidth, vh = window.innerHeight;
                if (d.includes('e')) panel.style.width  = Math.max(minW, Math.min(vw - sl, sw + dx)) + 'px';
                if (d.includes('s')) panel.style.height = Math.max(minH, Math.min(vh - st, sh + dy)) + 'px';
                if (d.includes('w')) {
                    const nw = Math.max(minW, sw - dx), nl = sl + sw - nw;
                    if (nl >= 0) { panel.style.width = nw + 'px'; panel.style.left = nl + 'px'; panel.style.right = 'auto'; }
                }
                if (d.includes('n')) {
                    const nh = Math.max(minH, sh - dy), nt = st + sh - nh;
                    if (nt >= PANEL_TOP) { panel.style.height = nh + 'px'; panel.style.top = nt + 'px'; }
                }
            };

            const onUp = () => {
                document.body.style.cursor = '';
                globalResizing = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });
    }
}

// ── PanelManager — toggle visibility ─────────────────────────────────────────

export class PanelManager {
    private colorVisible = true;
    private layerVisible = false;

    constructor() {
        document.getElementById('colorToggleBtn')
            ?.addEventListener('click', () => this.toggleColor());
        document.getElementById('layerToggleBtn')
            ?.addEventListener('click', () => this.toggleLayer());

        // Position layer panel below color panel on first show
        requestAnimationFrame(() => this.positionLayerPanel());
    }

    private toggleColor(): void {
        this.colorVisible = !this.colorVisible;
        const panel = document.getElementById('rightPanel');
        const btn   = document.getElementById('colorToggleBtn');
        if (panel) panel.style.display = this.colorVisible ? 'flex' : 'none';
        btn?.classList.toggle('active', this.colorVisible);
    }

    private toggleLayer(): void {
        this.layerVisible = !this.layerVisible;
        const panel = document.getElementById('layerPanel');
        const btn   = document.getElementById('layerToggleBtn');
        if (panel) panel.style.display = this.layerVisible ? 'flex' : 'none';
        btn?.classList.toggle('active', this.layerVisible);
    }

    private positionLayerPanel(): void {
        const color = document.getElementById('rightPanel');
        const layer = document.getElementById('layerPanel');
        if (!color || !layer) return;
        const r = color.getBoundingClientRect();
        layer.style.right = '20px';
        layer.style.top   = (r.bottom + 12) + 'px';
        layer.style.left  = 'auto';
    }
}
