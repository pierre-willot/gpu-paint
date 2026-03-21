import { StrokePredictor, Point } from './strokePrediction';
import { FLOATS_PER_STAMP }        from './pipeline-cache';
import type { BrushDescriptor }    from './brush-descriptor';
import {
    sampleDynLUT,
    DLUT_SIZE_PRESSURE, DLUT_SIZE_TILT,     DLUT_SIZE_SPEED,
    DLUT_OPACITY_PRESSURE, DLUT_OPACITY_SPEED,
    DLUT_FLOW_PRESSURE,
    DLUT_ROUNDNESS_TILT, DLUT_ROUNDNESS_PRESSURE,
    DLUT_SCATTER_PRESSURE,
    DLUT_GRAIN_DEPTH,
    DLUT_WETNESS_PRESSURE,
    DLUT_COLOR_MIX,
} from './dynamics-lut';

// ── Internal point type ───────────────────────────────────────────────────────
interface FullPoint extends Point {
    tiltX:    number;
    tiltY:    number;
    velocity: number;
}

// ── StrokeEngine ──────────────────────────────────────────────────────────────

export class StrokeEngine {
    private buffer:    FullPoint[] = [];
    private stamps:    number[]    = [];
    private predictor  = new StrokePredictor();
    public  isDrawing  = false;

    private descriptor:  BrushDescriptor | null = null;
    private pressureLUT: Float32Array | null     = null;
    private dynLUTs:     Float32Array | null     = null;

    // Spacing / distance tracking
    private distanceCarry:  number = 0;
    private strokeDistance: number = 0; // cumulative distance so far

    // PRNG state
    private rngState: number = 0;

    // Per-stroke color jitter (constant for the whole stroke)
    private strokeHueDelta:  number = 0;
    private strokeSatDelta:  number = 0;
    private strokeValDelta:  number = 0;

    // Pull-string stabilization
    private pullX:      number  = 0;
    private pullY:      number  = 0;
    private pullActive: boolean = false;

    // Stroke tangent (for followStroke angle)
    private tangentX: number = 1;
    private tangentY: number = 0;

    // Velocity tracking
    private lastPointTime: number = 0;

    // Per-stroke paint depletion charge (0..1)
    private paintCharge: number = 1.0;

    // P8: Bristle — fixed per-stroke fiber offsets (in unit circle, rotated per stamp)
    private bristleOffsets: { x: number; y: number }[] = [];

    // P9: Wet edge — per-stroke paint density accumulation grid
    private static readonly DENSITY_GRID = 192;
    private densityGrid: Float32Array = new Float32Array(
        StrokeEngine.DENSITY_GRID * StrokeEngine.DENSITY_GRID
    );

    // End taper — recent stamps buffered until stroke ends
    // Each entry: { floats: number[FLOATS_PER_STAMP], dist: number }
    private tailBuffer: Array<{ floats: number[]; dist: number }> = [];

    public smoothingStrength: number = 0;

    // ── Configuration ─────────────────────────────────────────────────────────

    public setDescriptor(d: BrushDescriptor): void {
        this.descriptor = d;
    }

    public setPressureLUT(lut: Float32Array): void {
        this.pressureLUT = lut;
    }

    public setDynamicsLUTs(packed: Float32Array): void {
        this.dynLUTs = packed;
    }

    // ── Stroke lifecycle ──────────────────────────────────────────────────────

    public beginStroke(
        x: number, y: number, p: number,
        tiltX = 0, tiltY = 0
    ): void {
        if (!this.descriptor) return;
        const d = this.descriptor;

        this.isDrawing     = true;
        this.stamps        = [];
        this.distanceCarry = 0;
        this.strokeDistance = 0;
        this.lastPointTime = performance.now();
        this.tangentX      = 1;
        this.tangentY      = 0;
        this.predictor.reset();
        // Initialize paint charge from descriptor (re-fill on each new stroke)
        this.paintCharge = d.paintLoad;

        // Seed PRNG — fixed seed locks scatter/jitter pattern across strokes
        this.rngState = d.jitterSeedLock
            ? ((d.jitterSeed * 2654435769) >>> 0) ^ 0xDE4DBE3F
            : (Math.random() * 0xFFFFFFFF) >>> 0;

        // Per-stroke color jitter
        this.strokeHueDelta  = (this.nextRand() - 0.5) * 2 * d.hueJitterPerStroke;
        this.strokeSatDelta  = (this.nextRand() - 0.5) * 2 * d.satJitterPerStroke;
        this.strokeValDelta  = (this.nextRand() - 0.5) * 2 * d.valJitterPerStroke;

        // P8: Bristle — generate fixed fiber positions (unit circle, varied radius)
        this.bristleOffsets = [];
        if (d.bristleCount > 0) {
            for (let i = 0; i < d.bristleCount; i++) {
                const angle = (i / d.bristleCount) * Math.PI * 2;
                // Vary radius per fiber for natural look; inner fibers get ~0.4, outer ~1.0
                const r = 0.35 + (i % 3 === 0 ? 0.2 : 0.55) + this.nextRand() * 0.25;
                this.bristleOffsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
            }
        }

        // P9: Wet edge — clear per-stroke density accumulator
        if (d.wetEdge > 0) this.densityGrid.fill(0);

        // End taper — clear tail buffer for new stroke
        this.tailBuffer = [];

        // Pull-string init
        this.pullX      = x;
        this.pullY      = y;
        this.pullActive = d.pullStringLength > 0;

        const start: FullPoint = { x, y, p, tiltX, tiltY, velocity: 0 };
        this.buffer = [start, start, start];
        this.predictor.update(start);
    }

    public addPoint(x: number, y: number, p: number, tiltX = 0, tiltY = 0): void {
        if (!this.isDrawing || !this.descriptor) return;
        const d = this.descriptor;

        const now      = performance.now();
        const dt       = Math.max(1, now - this.lastPointTime);
        const prev     = this.buffer[this.buffer.length - 1];
        const dx       = x - prev.x, dy = y - prev.y;
        const velocity = Math.sqrt(dx*dx + dy*dy) / dt * 1000; // norm-canvas-units/sec

        // ── Pull-string stabilization ──────────────────────────────────────
        let effX = x, effY = y;
        if (this.pullActive && d.pullStringLength > 0) {
            const pdx  = x - this.pullX, pdy = y - this.pullY;
            const dist = Math.sqrt(pdx*pdx + pdy*pdy);
            if (dist > d.pullStringLength) {
                const excess = dist - d.pullStringLength;
                const nx = pdx / dist, ny = pdy / dist;
                this.pullX += nx * excess;
                this.pullY += ny * excess;
            }
            if (d.catchUpEnabled) {
                this.pullX += (x - this.pullX) * 0.05;
                this.pullY += (y - this.pullY) * 0.05;
            }
            effX = this.pullX;
            effY = this.pullY;
        }

        const smoothed = this.smoothPoint(effX, effY, p, tiltX, tiltY, velocity);
        this.buffer.push(smoothed);
        this.predictor.update(smoothed);
        this.lastPointTime = now;

        if (this.buffer.length >= 4) {
            const len = this.buffer.length;
            this.stampSegment(
                this.buffer[len-4], this.buffer[len-3],
                this.buffer[len-2], this.buffer[len-1]
            );
        }
    }

    public flush(): Float32Array {
        // Promote safe tail-buffer entries (definitely not in the taperEnd zone)
        const d = this.descriptor;
        const taperEnd = d?.taperEnd ?? 0;
        if (taperEnd > 0 && this.tailBuffer.length > 0) {
            const safeBelow = this.strokeDistance - taperEnd;
            let kept = 0;
            for (let i = 0; i < this.tailBuffer.length; i++) {
                const entry = this.tailBuffer[i];
                if (entry.dist <= safeBelow) {
                    for (const f of entry.floats) this.stamps.push(f);
                } else {
                    this.tailBuffer[kept++] = entry;
                }
            }
            this.tailBuffer.length = kept;
        }

        if (this.stamps.length === 0) return new Float32Array();
        const data  = new Float32Array(this.stamps);
        this.stamps = [];
        return data;
    }

    // Called once at stroke end — applies linear opacity fade to buffered tail.
    // Opacity is at float index 10 per stamp.
    public flushTail(): Float32Array {
        if (this.tailBuffer.length === 0) return new Float32Array();
        const d = this.descriptor;
        const taperEnd = d?.taperEnd ?? 0;
        const result: number[] = [];
        for (const entry of this.tailBuffer) {
            const floats = entry.floats.slice();
            if (taperEnd > 0) {
                const t = Math.max(0, Math.min(1, (this.strokeDistance - entry.dist) / taperEnd));
                floats[10] *= t; // opacity index
            }
            for (const f of floats) result.push(f);
        }
        this.tailBuffer = [];
        return new Float32Array(result);
    }

    public endStroke(): void {
        this.isDrawing      = false;
        this.buffer         = [];
        this.distanceCarry  = 0;
        this.strokeDistance = 0;
        this.tailBuffer     = [];
        this.predictor.reset();
    }

    public getPredictedStamps(): Float32Array {
        if (!this.descriptor) return new Float32Array();
        const raw = this.predictor.getPrediction(8);
        if (raw.length === 0 || this.buffer.length === 0) return new Float32Array();

        const last  = this.buffer[this.buffer.length - 1];
        const count = raw.length / 3;
        const res   = new Float32Array(count * FLOATS_PER_STAMP);
        const d     = this.descriptor;

        for (let i = 0; i < count; i++) {
            const s       = i * 3, dst = i * FLOATS_PER_STAMP;
            const falloff = 1.0 - (i / count);
            res[dst]      = raw[s];
            res[dst+1]    = raw[s+1];
            res[dst+2]    = last.p * falloff * 0.5;
            res[dst+3]    = d.size;
            res[dst+4]    = d.color[0]; res[dst+5] = d.color[1];
            res[dst+6]    = d.color[2]; res[dst+7] = d.color[3];
            res[dst+8]    = last.tiltX; res[dst+9]  = last.tiltY;
            res[dst+10]   = d.opacity * falloff * 0.5;
            res[dst+11]   = 0;
            res[dst+12]   = d.roundness; // roundness
            res[dst+13]   = 1.0;         // grainDepthScale
            res[dst+14]   = 0;           // pad
            res[dst+15]   = 0;           // pad
        }
        return res;
    }

    // ── Adaptive stamping ─────────────────────────────────────────────────────

    private stampSegment(p0: FullPoint, p1: FullPoint, p2: FullPoint, p3: FullPoint): void {
        const d = this.descriptor!;
        const spacing = Math.max(0.0001, d.size * d.spacing);

        const STEPS = 16;
        const arc   = new Float32Array(STEPS + 1);
        let   prev  = this.catmullRom(p0, p1, p2, p3, 0);

        for (let i = 1; i <= STEPS; i++) {
            const cur = this.catmullRom(p0, p1, p2, p3, i / STEPS);
            const ddx = cur.x - prev.x, ddy = cur.y - prev.y;
            arc[i]    = arc[i-1] + Math.sqrt(ddx*ddx + ddy*ddy);
            prev      = cur;
        }

        const total = arc[STEPS];
        if (total < 1e-9) return;

        const carry = Math.min(this.distanceCarry, spacing - 1e-9);
        let   dist  = carry > 0 ? spacing - carry : 0;

        while (dist <= total) {
            const t    = this.arcLengthToT(arc, STEPS, dist);
            const pt   = this.catmullRom(p0, p1, p2, p3, t);
            const tang = this.catmullRomTangent(p0, p1, p2, p3, t);

            const tLen = Math.sqrt(tang.x*tang.x + tang.y*tang.y);
            if (tLen > 1e-9) {
                this.tangentX = tang.x / tLen;
                this.tangentY = tang.y / tLen;
            }

            this.pushStamp(pt.x, pt.y, pt.p, pt.tiltX, pt.tiltY, pt.velocity, spacing);
            dist += spacing;
        }

        this.distanceCarry = total - (dist - spacing);
    }

    // ── Per-stamp dynamics ────────────────────────────────────────────────────

    private pushStamp(
        x: number, y: number, p: number,
        tiltX: number, tiltY: number, velocity: number,
        spacing: number
    ): void {
        const d    = this.descriptor!;
        const luts = this.dynLUTs;

        // Pressure remapping
        const effP = this.pressureLUT ? this.mapPressure(p) : p;

        // Derived inputs for LUT lookup
        const tiltMag  = Math.sqrt(tiltX*tiltX + tiltY*tiltY) / 90; // 0..1 (90° = 1)
        const normSpeed = Math.min(1.0, velocity / 20.0);            // 0..1

        // ── Size dynamics ─────────────────────────────────────────────────────
        let sizeMult = 1.0;
        if (luts) {
            if (d.sizePressureCurve.mode !== 'off') {
                sizeMult *= sampleDynLUT(luts, DLUT_SIZE_PRESSURE, effP);
            } else {
                sizeMult *= 1.0 - d.pressureSize * (1.0 - effP);
            }
            if (d.sizeTiltCurve.mode !== 'off')
                sizeMult *= sampleDynLUT(luts, DLUT_SIZE_TILT, tiltMag);
            if (d.sizeSpeedCurve.mode !== 'off')
                sizeMult *= sampleDynLUT(luts, DLUT_SIZE_SPEED, normSpeed);
        } else {
            sizeMult *= 1.0 - d.pressureSize * (1.0 - effP);
        }
        sizeMult *= 1.0 - d.sizeJitter * this.nextRand();
        sizeMult  = Math.max(d.sizeMin, Math.min(d.sizeMax === 0 ? 1 : d.sizeMax, sizeMult));

        // ── Opacity dynamics ──────────────────────────────────────────────────
        let opacityMult = 1.0;
        if (luts) {
            if (d.opacityPressureCurve.mode !== 'off') {
                opacityMult *= sampleDynLUT(luts, DLUT_OPACITY_PRESSURE, effP);
            } else {
                opacityMult *= 1.0 - d.pressureOpacity * (1.0 - effP);
            }
            if (d.opacitySpeedCurve.mode !== 'off')
                opacityMult *= sampleDynLUT(luts, DLUT_OPACITY_SPEED, normSpeed);
        } else {
            opacityMult *= 1.0 - d.pressureOpacity * (1.0 - effP);
        }
        opacityMult *= 1.0 - d.opacityJitter * this.nextRand();
        opacityMult  = Math.max(d.opacityMin, Math.min(d.opacityMax === 0 ? 1 : d.opacityMax, opacityMult));

        // ── Flow dynamics ─────────────────────────────────────────────────────
        let flowMult = 1.0;
        if (luts && d.flowPressureCurve.mode !== 'off') {
            flowMult = sampleDynLUT(luts, DLUT_FLOW_PRESSURE, effP);
        }
        flowMult = Math.max(d.flowMin, Math.min(d.flowMax === 0 ? 1 : d.flowMax, flowMult));

        // ── Roundness dynamics ────────────────────────────────────────────────
        let roundness = d.roundness;
        if (luts) {
            if (d.roundnessTiltCurve.mode !== 'off') {
                roundness *= sampleDynLUT(luts, DLUT_ROUNDNESS_TILT, tiltMag);
            } else if (d.tiltShape && tiltMag > 0) {
                roundness *= Math.max(0, 1 - tiltMag * 2);
            }
            if (d.roundnessPressureCurve.mode !== 'off') {
                roundness *= sampleDynLUT(luts, DLUT_ROUNDNESS_PRESSURE, effP);
            }
        } else if (d.tiltShape && tiltMag > 0) {
            roundness *= Math.max(0, 1 - tiltMag * 2);
        }
        roundness = Math.max(d.roundnessMin, Math.min(1, roundness));

        // ── Stamp angle ───────────────────────────────────────────────────────
        let stampAngle = d.angle * (Math.PI / 180);
        if (d.followStroke) {
            stampAngle = Math.atan2(this.tangentY, this.tangentX);
        }
        if (d.tiltAngleInfluence > 0 && (tiltX !== 0 || tiltY !== 0)) {
            // Convert tiltX/tiltY from degrees to azimuth radians using proper formula
            const tiltAz = Math.atan2(Math.tan(tiltY * Math.PI / 180), Math.tan(tiltX * Math.PI / 180));
            stampAngle = stampAngle * (1 - d.tiltAngleInfluence) + tiltAz * d.tiltAngleInfluence;
        } else if (d.tiltAngle && (tiltX !== 0 || tiltY !== 0)) {
            stampAngle = Math.atan2(Math.tan(tiltY * Math.PI / 180), Math.tan(tiltX * Math.PI / 180));
        }
        stampAngle += (this.nextRand() - 0.5) * 2 * d.angleJitter * (Math.PI / 180);

        // ── Scatter ───────────────────────────────────────────────────────────
        let scatterScale = 1.0;
        if (luts && d.scatterPressureCurve.mode !== 'off') {
            scatterScale = sampleDynLUT(luts, DLUT_SCATTER_PRESSURE, effP);
        }

        // ── Color dynamics ────────────────────────────────────────────────────
        let colorMix = d.colorFgBgMix;
        if (luts && d.colorMixPressureCurve.mode !== 'off') {
            colorMix *= sampleDynLUT(luts, DLUT_COLOR_MIX, effP);
        }
        colorMix = Math.max(0, Math.min(1, colorMix));

        let r = d.color[0] * (1 - colorMix) + d.color2[0] * colorMix;
        let g = d.color[1] * (1 - colorMix) + d.color2[1] * colorMix;
        let b = d.color[2] * (1 - colorMix) + d.color2[2] * colorMix;
        const a = d.color[3];

        // HSV jitter (per-stroke + per-tip)
        const doHsv = d.hueJitter > 0 || d.satJitter > 0 || d.valJitter > 0
                   || this.strokeHueDelta !== 0 || this.strokeSatDelta !== 0 || this.strokeValDelta !== 0;
        if (doHsv) {
            const hsv  = rgbToHsv(r, g, b);
            const hJit = (this.nextRand() - 0.5) * 2 * d.hueJitter + this.strokeHueDelta;
            const sJit = (this.nextRand() - 0.5) * 2 * d.satJitter + this.strokeSatDelta;
            const vJit = (this.nextRand() - 0.5) * 2 * d.valJitter + this.strokeValDelta;
            const rgb  = hsvToRgb(
                (hsv.h + hJit + 360) % 360,
                Math.max(0, Math.min(1, hsv.s + sJit)),
                Math.max(0, Math.min(1, hsv.v + vJit))
            );
            r = rgb.r; g = rgb.g; b = rgb.b;
        }

        // ── Grain depth curve ─────────────────────────────────────────────────
        let grainDepthScale = 1.0;
        if (luts && d.grainDepthCurve.mode !== 'off') {
            grainDepthScale = sampleDynLUT(luts, DLUT_GRAIN_DEPTH, effP);
        }

        // ── Start taper ───────────────────────────────────────────────────────
        let taperMult = 1.0;
        if (d.taperStart > 0 && this.strokeDistance < d.taperStart) {
            taperMult = this.strokeDistance / d.taperStart;
        }
        const taperSize    = d.taperSizeLink    ? taperMult : 1.0;
        const taperOpacity = d.taperOpacityLink ? taperMult : 1.0;

        // ── Paint depletion ───────────────────────────────────────────────────
        // paintCharge depletes over the stroke when paintLoad < 1.
        // At paintLoad=1: no depletion. At paintLoad=0.5: brush fades over stroke.
        if (d.paintLoad < 1.0) {
            const depletionRate = (1.0 - d.paintLoad) * d.spacing * 0.5;
            this.paintCharge = Math.max(0, this.paintCharge - depletionRate);
        }

        // ── Wet mixing (dilution) ─────────────────────────────────────────────
        // wetness dilutes the brush; paintCharge tracks remaining paint load
        let wetness = d.wetness;
        if (luts && d.wetnessPressureCurve && d.wetnessPressureCurve.mode !== 'off') {
            wetness *= sampleDynLUT(luts, DLUT_WETNESS_PRESSURE, effP);
        }
        const wetFactor = wetness > 0
            ? this.paintCharge * (1.0 - wetness * 0.65) + wetness * 0.08
            : this.paintCharge;

        const finalSize = d.size * sizeMult * taperSize;
        let   finalOpacity = d.opacity * opacityMult * d.flow * flowMult * taperOpacity * wetFactor;

        this.strokeDistance += spacing;

        // ── P9: Wet edge — density-based opacity modulation ───────────────────
        if (d.wetEdge > 0) {
            const G  = StrokeEngine.DENSITY_GRID;
            const gx = Math.max(0, Math.min(G - 1, Math.floor(x * G)));
            const gy = Math.max(0, Math.min(G - 1, Math.floor(y * G)));
            const current = this.densityGrid[gy * G + gx];

            // Edge factor: peaks where neighbours have paint but current cell is fresh
            let adjMax = 0;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const nx = Math.max(0, Math.min(G - 1, gx + dx));
                    const ny = Math.max(0, Math.min(G - 1, gy + dy));
                    const v  = this.densityGrid[ny * G + nx];
                    if (v > adjMax) adjMax = v;
                }
            }
            // Bell-curve: peaks when adjacent is saturated but current cell is low
            const edgeFactor = adjMax * (1 - current) * Math.exp(-current * 5);
            finalOpacity = Math.min(2.0, finalOpacity * (1 + d.wetEdge * edgeFactor * 4));

            // Accumulate density at stamp position via small gaussian splat
            const splatR = Math.max(2, Math.min(8, Math.round(finalSize * G * 0.6)));
            for (let dy = -splatR; dy <= splatR; dy++) {
                for (let dx = -splatR; dx <= splatR; dx++) {
                    if (dx * dx + dy * dy > splatR * splatR) continue;
                    const nx = Math.max(0, Math.min(G - 1, gx + dx));
                    const ny = Math.max(0, Math.min(G - 1, gy + dy));
                    const falloff = 1 - Math.sqrt(dx * dx + dy * dy) / splatR;
                    this.densityGrid[ny * G + nx] = Math.min(1,
                        this.densityGrid[ny * G + nx] + finalOpacity * falloff * 0.15
                    );
                }
            }
        }

        // ── P8: Bristle tip — emit cluster of micro-stamps ────────────────────
        if (d.bristleCount > 0) {
            // Each bristle is a smaller stamp; size scaled so coverage is comparable
            const bristleSize = finalSize * (0.55 / Math.sqrt(d.bristleCount));
            const spread      = finalSize * d.bristleLength * 0.5;
            const ca          = Math.cos(stampAngle);
            const sa          = Math.sin(stampAngle);

            for (let bi = 0; bi < this.bristleOffsets.length; bi++) {
                const off = this.bristleOffsets[bi];
                // Rotate fiber offset by current stamp angle so bristle cluster
                // aligns with stroke direction when followStroke is on
                const rx = off.x * ca - off.y * sa;
                const ry = off.x * sa + off.y * ca;
                const bx = x + rx * spread;
                const by = y + ry * spread;
                // Per-fiber opacity variation for natural hair texture
                const bOpacity = finalOpacity * (0.6 + this.nextRand() * 0.4);
                this.emitStamp(d.taperEnd, [
                    bx, by, effP, bristleSize,
                    r, g, b, a,
                    tiltX, tiltY,
                    bOpacity, stampAngle,
                    roundness, grainDepthScale,
                    0, 0
                ]);
            }
            return; // bristle mode replaces normal stamp emission
        }

        // ── Normal stamp count (scatter) ──────────────────────────────────────
        const stampCount = Math.max(1,
            Math.round(d.stampCount + (this.nextRand() - 0.5) * 2 * d.stampCountJitter)
        );

        for (let si = 0; si < stampCount; si++) {
            const sx = x + (this.nextRand() - 0.5) * 2 * d.scatterX * scatterScale;
            const sy = y + (this.nextRand() - 0.5) * 2 * d.scatterY * scatterScale;

            this.emitStamp(d.taperEnd, [
                sx, sy, effP, finalSize,
                r, g, b, a,
                tiltX, tiltY,
                finalOpacity, stampAngle,
                roundness, grainDepthScale,
                0, 0
            ]);
        }
    }

    // Route a stamp through the tail buffer (for end taper) or directly to stamps.
    // opacity is at index 10 in the floats array.
    private emitStamp(taperEnd: number, floats: number[]): void {
        if (taperEnd > 0) {
            this.tailBuffer.push({ floats, dist: this.strokeDistance });
        } else {
            for (const f of floats) this.stamps.push(f);
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private nextRand(): number {
        this.rngState = (Math.imul(this.rngState, 1664525) + 1013904223) >>> 0;
        return this.rngState / 0xFFFFFFFF;
    }

    private smoothPoint(x: number, y: number, p: number, tiltX: number, tiltY: number, velocity: number): FullPoint {
        if (this.smoothingStrength === 0 || this.buffer.length === 0) {
            return { x, y, p, tiltX, tiltY, velocity };
        }
        const prev = this.buffer[this.buffer.length - 1];
        const s    = this.smoothingStrength;
        return {
            x:        x     * (1-s) + prev.x     * s,
            y:        y     * (1-s) + prev.y     * s,
            p,
            tiltX:    tiltX * (1-s) + prev.tiltX * s,
            tiltY:    tiltY * (1-s) + prev.tiltY * s,
            velocity: velocity * (1-s) + prev.velocity * s
        };
    }

    private mapPressure(p: number): number {
        const lut   = this.pressureLUT!;
        const index = Math.max(0, Math.min(1, p)) * (lut.length - 1);
        const lo    = Math.floor(index);
        const hi    = Math.min(lo + 1, lut.length - 1);
        return lut[lo] * (1 - (index - lo)) + lut[hi] * (index - lo);
    }

    private arcLengthToT(arc: Float32Array, steps: number, d: number): number {
        const total = arc[steps];
        if (d <= 0) return 0; if (d >= total) return 1;
        let lo = 0, hi = steps;
        while (lo + 1 < hi) { const mid = (lo+hi)>>1; if (arc[mid] <= d) lo=mid; else hi=mid; }
        const range = arc[hi] - arc[lo];
        if (range < 1e-10) return lo / steps;
        return (lo + (d - arc[lo]) / range) / steps;
    }

    private catmullRom(p0: FullPoint, p1: FullPoint, p2: FullPoint, p3: FullPoint, t: number): FullPoint {
        const t2 = t*t, t3 = t2*t;
        const f  = (a: number, b: number, c: number, d: number) =>
            0.5 * ((2*b) + (-a+c)*t + (2*a-5*b+4*c-d)*t2 + (-a+3*b-3*c+d)*t3);
        return {
            x:        f(p0.x,        p1.x,        p2.x,        p3.x),
            y:        f(p0.y,        p1.y,        p2.y,        p3.y),
            p:        f(p0.p,        p1.p,        p2.p,        p3.p),
            tiltX:    f(p0.tiltX,    p1.tiltX,    p2.tiltX,    p3.tiltX),
            tiltY:    f(p0.tiltY,    p1.tiltY,    p2.tiltY,    p3.tiltY),
            velocity: f(p0.velocity, p1.velocity, p2.velocity, p3.velocity)
        };
    }

    private catmullRomTangent(p0: FullPoint, p1: FullPoint, p2: FullPoint, p3: FullPoint, t: number): { x: number; y: number } {
        const t2 = t*t;
        const fd = (a: number, b: number, c: number, d: number) =>
            0.5 * ((-a+c) + 2*(2*a-5*b+4*c-d)*t + 3*(-a+3*b-3*c+d)*t2);
        return {
            x: fd(p0.x, p1.x, p2.x, p3.x),
            y: fd(p0.y, p1.y, p2.y, p3.y)
        };
    }
}

// ── Color conversion helpers ──────────────────────────────────────────────────

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d > 0) {
        if      (mx === r) h = ((g - b) / d) % 6;
        else if (mx === g) h = (b - r) / d + 2;
        else               h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
    }
    return { h, s: mx > 0 ? d / mx : 0, v: mx };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
    const k = (n: number) => (n + h / 60) % 6;
    const f = (n: number) => v * (1 - s * Math.max(0, Math.min(k(n), 4 - k(n), 1)));
    return { r: f(5), g: f(3), b: f(1) };
}
