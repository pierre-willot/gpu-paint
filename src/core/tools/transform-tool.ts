import type { TransformState } from '../../renderer/transform-pipeline';
export type { TransformState };

export type HandleType =
    | 'move'
    | 'rotate'
    | 'scale-tl' | 'scale-tc' | 'scale-tr'
    | 'scale-ml' |               'scale-mr'
    | 'scale-bl' | 'scale-bc' | 'scale-br';

// Local-space offsets for each handle (signs only — multiplied by hw/hh in _cornerLocal).
// Using a lookup table avoids the String.includes('-l') / '-r' bug where
// 'scale-tl'.includes('-l') === false (the '-' is followed by 't', not 'l').
const HANDLE_LX_SIGN: Partial<Record<HandleType, number>> = {
    'scale-tl': -1, 'scale-ml': -1, 'scale-bl': -1,
    'scale-tr':  1, 'scale-mr':  1, 'scale-br':  1,
    'scale-tc':  0, 'scale-bc':  0,
};
const HANDLE_LY_SIGN: Partial<Record<HandleType, number>> = {
    'scale-tl': -1, 'scale-tc': -1, 'scale-tr': -1,
    'scale-bl':  1, 'scale-bc':  1, 'scale-br':  1,
    'scale-ml':  0, 'scale-mr':  0,
    'rotate':   -1,
};

export class TransformTool {
    public  state:  TransformState = { cx: 0.5, cy: 0.5, scaleX: 1, scaleY: 1, rotation: 0 };
    public onTransformChange?: (state: TransformState) => void;

    /**
     * Canvas aspect ratio (width / height). MUST be set before any geometry
     * query so that handle positions and drag math use pixel-correct rotation.
     */
    public canvasAspect: number = 1;

    private dragHandle:       HandleType | null = null;
    private dragStart:        { x: number; y: number } | null = null;
    private stateAtDragStart: TransformState | null = null;

    // ── Query ─────────────────────────────────────────────────────────────────

    /** Returns handle positions in normalized canvas (0..1) coordinates. */
    public getHandlePositions(): Record<HandleType, { x: number; y: number }> {
        const { cx, cy, scaleX, scaleY, rotation } = this.state;
        const ar  = this.canvasAspect;
        const r   = rotation * Math.PI / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        const hw  = scaleX * 0.5, hh = scaleY * 0.5;

        // Correct pixel-space rotation in normalized coords:
        //   world_x = cx + lx*cos  - ly*sin/ar
        //   world_y = cy + lx*sin*ar + ly*cos
        const w = (lx: number, ly: number) => ({
            x: cx + lx * cos   - ly * sin / ar,
            y: cy + lx * sin * ar + ly * cos,
        });

        return {
            'scale-tl': w(-hw, -hh),
            'scale-tc': w(  0, -hh),
            'scale-tr': w( hw, -hh),
            'scale-ml': w(-hw,   0),
            'scale-mr': w( hw,   0),
            'scale-bl': w(-hw,  hh),
            'scale-bc': w(  0,  hh),
            'scale-br': w( hw,  hh),
            'rotate':   w(  0, -hh - 0.06),
            'move':     w(  0,   0),
        };
    }

    /**
     * Hit-test pointer against handles then bounding-box interior.
     * @param nx, ny  normalized canvas coords
     * @param hitR    hit radius in normalized canvas units (e.g. 10/canvasWidth)
     */
    public hitTest(nx: number, ny: number, hitR: number): HandleType | 'inside' | null {
        const handles = this.getHandlePositions();
        const order: HandleType[] = [
            'scale-tl','scale-tr','scale-bl','scale-br',
            'scale-tc','scale-bc','scale-ml','scale-mr',
            'rotate', 'move',
        ];
        for (const name of order) {
            const p = handles[name];
            const dx = nx - p.x, dy = ny - p.y;
            if (dx * dx + dy * dy < hitR * hitR) return name;
        }
        if (this._isInsideBounds(nx, ny)) return 'inside';
        return null;
    }

    // ── Drag lifecycle ────────────────────────────────────────────────────────

    public pointerDown(hit: HandleType | 'inside', nx: number, ny: number): void {
        this.dragHandle       = hit === 'inside' ? 'move' : hit;
        this.dragStart        = { x: nx, y: ny };
        this.stateAtDragStart = { ...this.state };
    }

    public pointerMove(nx: number, ny: number, shiftKey = false): void {
        if (!this.dragHandle || !this.dragStart || !this.stateAtDragStart) return;
        this._applyDrag(nx, ny, shiftKey);
        this.onTransformChange?.(this.state);
    }

    public pointerUp(): void {
        this.dragHandle       = null;
        this.dragStart        = null;
        this.stateAtDragStart = null;
    }

    public get isDragging(): boolean { return this.dragHandle !== null; }

    // ── Private ───────────────────────────────────────────────────────────────

    private _isInsideBounds(nx: number, ny: number): boolean {
        const { cx, cy, scaleX, scaleY, rotation } = this.state;
        const ar  = this.canvasAspect;
        const r   = rotation * Math.PI / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        const dx  = nx - cx, dy = ny - cy;
        // Inverse of world→local rotation (pixel-correct):
        //   lx = dx*cos + dy*sin/ar
        //   ly = -dx*sin*ar + dy*cos
        const lx = dx * cos + dy * sin / ar;
        const ly = -dx * sin * ar + dy * cos;
        return Math.abs(lx) <= scaleX * 0.5 && Math.abs(ly) <= scaleY * 0.5;
    }

    private _applyDrag(nx: number, ny: number, shiftKey: boolean): void {
        const base = this.stateAtDragStart!;
        const ar   = this.canvasAspect;

        // ── Move ──────────────────────────────────────────────────────────────
        if (this.dragHandle === 'move') {
            const dx = nx - this.dragStart!.x;
            const dy = ny - this.dragStart!.y;
            this.state = { ...base, cx: base.cx + dx, cy: base.cy + dy };
            return;
        }

        // ── Rotate ────────────────────────────────────────────────────────────
        if (this.dragHandle === 'rotate') {
            // Compute angle in pixel space: atan2(dy_px, dx_px) = atan2(dy/ar, dx)
            const a0 = Math.atan2((this.dragStart!.y - base.cy) / ar, this.dragStart!.x - base.cx);
            const a1 = Math.atan2((ny - base.cy) / ar, nx - base.cx);
            let   delta = (a1 - a0) * 180 / Math.PI;
            if (shiftKey) delta = Math.round(delta / 15) * 15;
            this.state = { ...base, rotation: base.rotation + delta };
            return;
        }

        // ── Scale ─────────────────────────────────────────────────────────────
        const handle = this.dragHandle!;
        const r      = base.rotation * Math.PI / 180;
        const cos    = Math.cos(r), sin = Math.sin(r);
        const hw     = base.scaleX * 0.5, hh = base.scaleY * 0.5;

        const isCorner = handle === 'scale-tl' || handle === 'scale-tr' ||
                         handle === 'scale-bl' || handle === 'scale-br';
        const isEdgeH  = handle === 'scale-tc' || handle === 'scale-bc';
        const isEdgeV  = handle === 'scale-ml' || handle === 'scale-mr';

        if (isCorner) {
            // Opposite corner stays fixed in world space.
            const oppLocal   = this._cornerLocal(this._opposite(handle), hw, hh);
            const fixedWorld = {
                x: base.cx + oppLocal.x * cos   - oppLocal.y * sin / ar,
                y: base.cy + oppLocal.x * sin * ar + oppLocal.y * cos,
            };

            const newCx0 = (fixedWorld.x + nx) / 2;
            const newCy0 = (fixedWorld.y + ny) / 2;
            const dxW    = nx - newCx0, dyW = ny - newCy0;

            // De-rotate into local space (pixel-correct inverse):
            const dxL =  dxW * cos + dyW * sin / ar;
            const dyL = -dxW * sin * ar + dyW * cos;

            let newSX = Math.max(0.01, Math.abs(dxL) * 2);
            let newSY = Math.max(0.01, Math.abs(dyL) * 2);

            let newCx = newCx0, newCy = newCy0;

            if (shiftKey) {
                // Lock aspect ratio — scale uniformly by the larger delta factor.
                const fx = newSX / base.scaleX;
                const fy = newSY / base.scaleY;
                const f  = (Math.abs(fx - 1) >= Math.abs(fy - 1)) ? fx : fy;
                newSX = base.scaleX * f;
                newSY = base.scaleY * f;

                // Recompute center so the fixed (opposite) corner stays pinned.
                const newHW = newSX * 0.5, newHH = newSY * 0.5;
                const oppNew = this._cornerLocal(this._opposite(handle), newHW, newHH);
                newCx = fixedWorld.x - (oppNew.x * cos   - oppNew.y * sin / ar);
                newCy = fixedWorld.y - (oppNew.x * sin * ar + oppNew.y * cos);
            }

            this.state = { ...base, cx: newCx, cy: newCy, scaleX: newSX, scaleY: newSY };

        } else if (isEdgeH) {
            // Top/bottom edge: scaleY (and cy) change; shift = uniform scale.
            const isTop      = handle === 'scale-tc';
            const fixedLocal = { x: 0, y: isTop ? hh : -hh };
            const fixedWorld = {
                x: base.cx - fixedLocal.y * sin / ar,
                y: base.cy + fixedLocal.y * cos,
            };

            // Project pointer onto local-Y axis (pixel-correct):
            const projDist = -(nx - base.cx) * sin * ar + (ny - base.cy) * cos;
            const dragWorld = {
                x: base.cx - projDist * sin / ar,
                y: base.cy + projDist * cos,
            };

            const newCx = (fixedWorld.x + dragWorld.x) / 2;
            const newCy = (fixedWorld.y + dragWorld.y) / 2;
            const newSY = Math.max(0.01, Math.abs(projDist - fixedLocal.y));

            if (shiftKey && base.scaleY > 0) {
                // Uniform scale: both axes change proportionally; cx unchanged.
                const newSX = Math.max(0.01, newSY * base.scaleX / base.scaleY);
                this.state = { ...base, cx: newCx, cy: newCy, scaleX: newSX, scaleY: newSY };
            } else {
                this.state = { ...base, cx: newCx, cy: newCy, scaleY: newSY };
            }

        } else if (isEdgeV) {
            // Left/right edge: scaleX (and cx) change; shift = uniform scale.
            const isLeft     = handle === 'scale-ml';
            const fixedLocal = { x: isLeft ? hw : -hw, y: 0 };
            const fixedWorld = {
                x: base.cx + fixedLocal.x * cos,
                y: base.cy + fixedLocal.x * sin * ar,
            };

            // Project pointer onto local-X axis (pixel-correct):
            const projDist = (nx - base.cx) * cos + (ny - base.cy) * sin / ar;
            const dragWorld = {
                x: base.cx + projDist * cos,
                y: base.cy + projDist * sin * ar,
            };

            const newCx = (fixedWorld.x + dragWorld.x) / 2;
            const newCy = (fixedWorld.y + dragWorld.y) / 2;
            const newSX = Math.max(0.01, Math.abs(projDist - fixedLocal.x));

            if (shiftKey && base.scaleX > 0) {
                // Uniform scale: both axes change proportionally; cy unchanged.
                const newSY = Math.max(0.01, newSX * base.scaleY / base.scaleX);
                this.state = { ...base, cx: newCx, cy: newCy, scaleX: newSX, scaleY: newSY };
            } else {
                this.state = { ...base, cx: newCx, cy: newCy, scaleX: newSX };
            }
        }
    }

    private _cornerLocal(h: HandleType, hw: number, hh: number): { x: number; y: number } {
        return {
            x: (HANDLE_LX_SIGN[h] ?? 0) * hw,
            y: (HANDLE_LY_SIGN[h] ?? 0) * hh,
        };
    }

    private _opposite(h: HandleType): HandleType {
        const map: Partial<Record<HandleType, HandleType>> = {
            'scale-tl': 'scale-br', 'scale-br': 'scale-tl',
            'scale-tr': 'scale-bl', 'scale-bl': 'scale-tr',
            'scale-tc': 'scale-bc', 'scale-bc': 'scale-tc',
            'scale-ml': 'scale-mr', 'scale-mr': 'scale-ml',
        };
        return map[h] ?? h;
    }
}
