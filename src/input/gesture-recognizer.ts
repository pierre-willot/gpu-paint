// src/input/gesture-recognizer.ts
// Multi-touch gesture detection for iPad and trackpads.
//
// Touch priority (runs BEFORE the pointer event painting path):
//   1 finger  → pass through to pointer events (pen or finger painting)
//   2 fingers → pan + pinch-zoom + rotate view
//   3 fingers → tap = undo, swipe right = redo
//   4 fingers → tap = toggle focus mode
//
// Pencil is a pointer event — it is never in this.touches because it arrives
// as a separate pointer type. Two-finger gestures will never accidentally
// block a Pencil stroke.

import { NavigationManager } from './navigation';

interface TouchPoint {
    id:   number;
    x:    number;
    y:    number;
}

export interface GestureCallbacks {
    onUndo:        () => void;
    onRedo:        () => void;
    onFocusToggle: () => void;
}

export class GestureRecognizer {
    private touches: Map<number, TouchPoint> = new Map();
    private prevDistance   = 0;
    private prevAngle      = 0;
    private prevMidX       = 0;
    private prevMidY       = 0;

    // Track gesture start for swipe detection
    private gestureStartX  = 0;
    private gestureStartY  = 0;
    private gestureStartMs = 0;

    // 3-finger state — detect tap vs swipe
    private threeFingerDownMs = 0;

    constructor(
        private canvas:    HTMLCanvasElement,
        private nav:       NavigationManager,
        private callbacks: GestureCallbacks
    ) {
        this.bindEvents();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private bindEvents(): void {
        // Use { passive: false } so we can call preventDefault() on multi-touch
        this.canvas.addEventListener('touchstart',  this.onTouchStart,  { passive: false });
        this.canvas.addEventListener('touchmove',   this.onTouchMove,   { passive: false });
        this.canvas.addEventListener('touchend',    this.onTouchEnd,    { passive: false });
        this.canvas.addEventListener('touchcancel', this.onTouchCancel, { passive: false });
    }

    private onTouchStart = (e: TouchEvent): void => {
        for (const t of Array.from(e.changedTouches)) {
            this.touches.set(t.identifier, { id: t.identifier, x: t.clientX, y: t.clientY });
        }

        const count = this.touches.size;

        if (count === 1) {
            // Single touch — let pointer events handle it
            return;
        }

        // 2+ fingers — we own this gesture, prevent pointer events
        e.preventDefault();

        if (count === 2) {
            this.nav.gestureActive = true;
            const [a, b]         = this.getTwoPoints();
            this.prevDistance    = this.dist(a, b);
            this.prevAngle       = this.angle(a, b);
            this.prevMidX        = (a.x + b.x) / 2;
            this.prevMidY        = (a.y + b.y) / 2;
            this.gestureStartX   = this.prevMidX;
            this.gestureStartY   = this.prevMidY;
            this.gestureStartMs  = Date.now();
        }

        if (count === 3) {
            e.preventDefault();
            this.threeFingerDownMs = Date.now();
            this.gestureStartX = this.getMidpoint().x;
            this.gestureStartY = this.getMidpoint().y;
        }

        if (count === 4) {
            e.preventDefault();
            // 4-finger tap handled on touchend
        }
    };

    private onTouchMove = (e: TouchEvent): void => {
        for (const t of Array.from(e.changedTouches)) {
            if (this.touches.has(t.identifier)) {
                this.touches.set(t.identifier, { id: t.identifier, x: t.clientX, y: t.clientY });
            }
        }

        const count = this.touches.size;
        if (count < 2) return;

        e.preventDefault();

        if (count === 2) {
            const [a, b] = this.getTwoPoints();

            // Current midpoint between the two fingers (screen clientX/Y)
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;

            // Pan — move canvas by how much the midpoint moved
            this.nav.pan(midX - this.prevMidX, midY - this.prevMidY);

            // Zoom (pinch) — zoom toward the midpoint between the two fingers,
            // exactly like Procreate / Google Maps.
            const d = this.dist(a, b);
            if (this.prevDistance > 0) {
                const factor = d / this.prevDistance;
                this.nav.applyZoomAt(factor, midX, midY);
            }

            // Rotate
            const ang  = this.angle(a, b);
            const dAng = ang - this.prevAngle;
            // Only rotate if change is meaningful (avoids jitter)
            if (Math.abs(dAng) < 30) {
                this.nav.rotateBy(dAng);
            }

            this.prevDistance = d;
            this.prevAngle    = ang;
            this.prevMidX     = midX;
            this.prevMidY     = midY;
        }
    };

    private onTouchEnd = (e: TouchEvent): void => {
        const count = this.touches.size;

        if (count === 3) {
            const elapsed   = Date.now() - this.threeFingerDownMs;
            const mid        = this.getMidpoint();
            const dx         = mid.x - this.gestureStartX;

            if (elapsed < 400) {
                // Quick tap/swipe gesture
                if (Math.abs(dx) > 40) {
                    // Swipe: right = redo, left = undo
                    if (dx > 0) this.callbacks.onRedo();
                    else        this.callbacks.onUndo();
                } else {
                    // Tap = undo
                    this.callbacks.onUndo();
                }
            }
        }

        if (count === 4) {
            const elapsed = Date.now() - this.gestureStartMs;
            if (elapsed < 300) {
                this.callbacks.onFocusToggle();
            }
        }

        for (const t of Array.from(e.changedTouches)) {
            this.touches.delete(t.identifier);
        }

        if (this.touches.size < 2) {
            this.nav.gestureActive = false;
        }
    };

    private onTouchCancel = (e: TouchEvent): void => {
        for (const t of Array.from(e.changedTouches)) {
            this.touches.delete(t.identifier);
        }
        if (this.touches.size < 2) {
            this.nav.gestureActive = false;
        }
    };

    // ── Helpers ───────────────────────────────────────────────────────────────

    private getTwoPoints(): [TouchPoint, TouchPoint] {
        const pts = Array.from(this.touches.values());
        return [pts[0], pts[1]];
    }

    private getMidpoint(): { x: number; y: number } {
        const pts = Array.from(this.touches.values());
        const x   = pts.reduce((s, p) => s + p.x, 0) / pts.length;
        const y   = pts.reduce((s, p) => s + p.y, 0) / pts.length;
        return { x, y };
    }

    private dist(a: TouchPoint, b: TouchPoint): number {
        const dx = a.x - b.x, dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /** Returns angle in degrees between two touch points. */
    private angle(a: TouchPoint, b: TouchPoint): number {
        return Math.atan2(b.y - a.y, b.x - a.x) * (180 / Math.PI);
    }
}
