import { EventBus } from './event-bus';

export type RGB = { r: number; g: number; b: number };
export type HSV = { h: number; s: number; v: number };

export class ColorState {
    private _hsv: HSV;
    private _rgb: RGB;
    private _hex: string;
    public colorMode: 'hsv' | 'hsl' = 'hsv';

    private localListeners = new Set<() => void>();
    private broadcasting   = false;

    constructor(private eventBus: EventBus, initialHsv: HSV = { h: 212, s: 100, v: 100 }) {
        this._hsv = { ...initialHsv };
        this._rgb = this.hsvToRgb(this._hsv.h, this._hsv.s, this._hsv.v);
        this._hex = this.buildHex();
    }

    public subscribeLocal(listener: () => void): () => void {
        this.localListeners.add(listener);
        return () => this.localListeners.delete(listener);
    }

    public broadcastLocal() {
        if (this.broadcasting) return;
        this.broadcasting = true;
        this.localListeners.forEach(cb => cb());
        this.eventBus.emit('color:change', { rgb: this._rgb, hsv: this._hsv, hex: this._hex });
        this.broadcasting = false;
    }

    /** Sets color from RGB values (0–255). Recomputes HSV. */
    public setRgb(r: number, g: number, b: number) {
        this._rgb = {
            r: Math.round(Math.max(0, Math.min(255, r))),
            g: Math.round(Math.max(0, Math.min(255, g))),
            b: Math.round(Math.max(0, Math.min(255, b)))
        };
        this._hsv = this.rgbToHsv(this._rgb.r, this._rgb.g, this._rgb.b);
        this._hex = this.buildHex();
        this.broadcastLocal();
    }

    /** Sets color from HSV values (h: 0–360, s/v: 0–100). Recomputes RGB. */
    public setHsv(h: number, s: number, v: number) {
        this._hsv = { h, s, v };
        this._rgb = this.hsvToRgb(h, s, v);
        this._hex = this.buildHex();
        this.broadcastLocal();
    }

    public setHue(h: number) {
        this.setHsv(h, this._hsv.s, this._hsv.v);
    }

    /** Idempotent mode switch — clicking the same button twice is a no-op. */
    public setMode(mode: 'hsv' | 'hsl') {
        if (this.colorMode === mode) return;
        this.colorMode = mode;
        this.broadcastLocal();
    }

    public toggleMode() {
        this.colorMode = this.colorMode === 'hsv' ? 'hsl' : 'hsv';
        this.broadcastLocal();
    }

    public get hsv(): HSV    { return this._hsv; }
    public get rgb(): RGB    { return this._rgb; }
    public get hex(): string { return this._hex; }

    // ── Private math ─────────────────────────────────────────────────────────

    private hsvToRgb(h: number, s: number, v: number): RGB {
        const sN = s / 100, vN = v / 100;
        const k  = (n: number) => (n + h / 60) % 6;
        const f  = (n: number) => vN * (1 - sN * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
        return { r: Math.round(255 * f(5)), g: Math.round(255 * f(3)), b: Math.round(255 * f(1)) };
    }

    private rgbToHsv(r: number, g: number, b: number): HSV {
        const rN = r / 255, gN = g / 255, bN = b / 255;
        const mx = Math.max(rN, gN, bN), mn = Math.min(rN, gN, bN), d = mx - mn;
        let h = 0;
        if (d) {
            if      (mx === rN) h = 60 * (((gN - bN) / d) % 6);
            else if (mx === gN) h = 60 * ((bN - rN) / d + 2);
            else                h = 60 * ((rN - gN) / d + 4);
        }
        if (h < 0) h += 360;
        return {
            h: Math.round(h),
            s: Math.round(mx ? (d / mx) * 100 : 0),
            v: Math.round(mx * 100)
        };
    }

    private buildHex(): string {
        const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
        return `#${hex(this._rgb.r)}${hex(this._rgb.g)}${hex(this._rgb.b)}`;
    }
}
