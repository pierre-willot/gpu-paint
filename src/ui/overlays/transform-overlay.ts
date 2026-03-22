import { TransformTool, HandleType } from '../../core/tools/transform-tool';

const HANDLE_SIZE     = 8;   // square handle side length, screen px
const ROTATE_RADIUS   = 6;   // circular rotation handle radius, screen px
const BOX_COLOR       = '#38b2ff';
const HANDLE_FILL     = '#ffffff';

const SCALE_HANDLES: HandleType[] = [
    'scale-tl','scale-tc','scale-tr',
    'scale-ml',            'scale-mr',
    'scale-bl','scale-bc','scale-br',
];

const RESIZE_CURSORS: Partial<Record<HandleType, string>> = {
    'scale-tl': 'nwse-resize',
    'scale-br': 'nwse-resize',
    'scale-tr': 'nesw-resize',
    'scale-bl': 'nesw-resize',
    'scale-tc': 'ns-resize',
    'scale-bc': 'ns-resize',
    'scale-ml': 'ew-resize',
    'scale-mr': 'ew-resize',
    'rotate':   'grab',
    'move':     'move',
};

export class TransformOverlay {
    private canvas: HTMLCanvasElement;
    private ctx:    CanvasRenderingContext2D;

    public canvasToScreen?: (nx: number, ny: number) => { x: number; y: number };
    public screenToCanvas?: (cx: number, cy: number) => { x: number; y: number };

    private _active = false;
    private resizeObserver: ResizeObserver;
    private _shiftKey = false;

    constructor(
        private tool:           TransformTool,
        private onCommit:       () => void,
        private onCancel:       () => void,
    ) {
        this.canvas         = document.createElement('canvas');
        this.canvas.style.cssText =
            'position:fixed;inset:0;width:100%;height:100%;z-index:200;display:none;touch-action:none;';
        document.body.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d')!;

        this._resize();
        this.resizeObserver = new ResizeObserver(() => { this._resize(); this.draw(); });
        this.resizeObserver.observe(document.documentElement);

        this._attachEvents();
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public show(): void {
        this._active = true;
        this.canvas.style.display = '';
        this.canvas.style.cursor  = 'default';
        this.draw();
    }

    public hide(): void {
        this._active = false;
        this.canvas.style.display = 'none';
    }

    public draw(): void {
        if (!this._active || !this.canvasToScreen) return;
        const { width, height } = this.canvas;
        this.ctx.clearRect(0, 0, width, height);

        const handles = this.tool.getHandlePositions();
        const toS = (nx: number, ny: number): [number, number] => {
            const s = this.canvasToScreen!(nx, ny);
            return [s.x, s.y];
        };

        // Bounding box (dashed)
        const corners: [number, number][] = [
            toS(handles['scale-tl'].x, handles['scale-tl'].y),
            toS(handles['scale-tr'].x, handles['scale-tr'].y),
            toS(handles['scale-br'].x, handles['scale-br'].y),
            toS(handles['scale-bl'].x, handles['scale-bl'].y),
        ];
        this.ctx.strokeStyle = BOX_COLOR;
        this.ctx.lineWidth   = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.beginPath();
        this.ctx.moveTo(corners[0][0], corners[0][1]);
        for (let i = 1; i < 4; i++) this.ctx.lineTo(corners[i][0], corners[i][1]);
        this.ctx.closePath();
        this.ctx.stroke();

        // Rotation arm
        const tcS  = toS(handles['scale-tc'].x, handles['scale-tc'].y);
        const rotS = toS(handles['rotate'].x,   handles['rotate'].y);
        this.ctx.setLineDash([]);
        this.ctx.beginPath();
        this.ctx.moveTo(tcS[0],  tcS[1]);
        this.ctx.lineTo(rotS[0], rotS[1]);
        this.ctx.stroke();

        // Scale handles
        const hs = HANDLE_SIZE;
        for (const name of SCALE_HANDLES) {
            const [sx, sy] = toS(handles[name].x, handles[name].y);
            this.ctx.fillStyle   = HANDLE_FILL;
            this.ctx.strokeStyle = BOX_COLOR;
            this.ctx.lineWidth   = 1.5;
            this.ctx.beginPath();
            this.ctx.rect(sx - hs / 2, sy - hs / 2, hs, hs);
            this.ctx.fill();
            this.ctx.stroke();
        }

        // Rotation handle
        this.ctx.fillStyle   = HANDLE_FILL;
        this.ctx.strokeStyle = BOX_COLOR;
        this.ctx.lineWidth   = 1.5;
        this.ctx.beginPath();
        this.ctx.arc(rotS[0], rotS[1], ROTATE_RADIUS, 0, Math.PI * 2);
        this.ctx.fill();
        this.ctx.stroke();
    }

    public destroy(): void {
        this.resizeObserver.disconnect();
        document.body.removeChild(this.canvas);
    }

    // ── Events ────────────────────────────────────────────────────────────────

    private _attachEvents(): void {
        this.canvas.addEventListener('pointerdown',  e => this._onDown(e),   { passive: false });
        this.canvas.addEventListener('pointermove',  e => this._onMove(e),   { passive: false });
        this.canvas.addEventListener('pointerup',    e => this._onUp(e),     { passive: false });
        this.canvas.addEventListener('pointercancel',e => this._onUp(e),     { passive: false });
        this.canvas.addEventListener('dblclick',     () => this.onCommit(),  { passive: false });
        window.addEventListener('keydown', e => {
            this._shiftKey = e.shiftKey;
            if (!this._active) return;
            if (e.key === 'Enter') { e.preventDefault(); this.onCommit(); }
            if (e.key === 'Escape'){ e.preventDefault(); this.onCancel(); }
        });
        window.addEventListener('keyup', e => { this._shiftKey = e.shiftKey; });
    }

    private _onDown(e: PointerEvent): void {
        if (!this._active || !this.screenToCanvas) return;
        e.preventDefault();
        this.canvas.setPointerCapture(e.pointerId);

        const { x: nx, y: ny } = this.screenToCanvas(e.clientX, e.clientY);
        const hitR = 12 / (this.canvas.width || 1);   // ~12 screen px in norm space
        const hit  = this.tool.hitTest(nx, ny, hitR);
        if (!hit) return;

        this.tool.pointerDown(hit, nx, ny);
        this.canvas.style.cursor = RESIZE_CURSORS[hit as HandleType] ?? (hit === 'inside' ? 'move' : 'default');
    }

    private _onMove(e: PointerEvent): void {
        if (!this._active || !this.screenToCanvas) return;
        e.preventDefault();

        const { x: nx, y: ny } = this.screenToCanvas(e.clientX, e.clientY);

        if (!this.tool.isDragging) {
            // Update cursor on hover
            const hitR = 12 / (this.canvas.width || 1);
            const hit  = this.tool.hitTest(nx, ny, hitR);
            this.canvas.style.cursor =
                hit === null    ? 'default'
              : hit === 'inside'? 'move'
              : RESIZE_CURSORS[hit] ?? 'default';
            return;
        }

        this.tool.pointerMove(nx, ny, this._shiftKey);
        this.draw();
    }

    private _onUp(e: PointerEvent): void {
        if (!this._active) return;
        e.preventDefault();
        this.tool.pointerUp();
    }

    private _resize(): void {
        this.canvas.width  = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
}
