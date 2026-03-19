// src/ui/CanvasBridge.ts
import { ColorState } from '../core/ColorState';

export class CanvasBridge {
    private canvas: HTMLCanvasElement;
    private overlayCtx: CanvasRenderingContext2D; // For drawing the indicator rings
    private isDragging = false;
    private dragTarget: 'hue' | 'sv' | null = null;

    constructor(
        containerId: string, 
        private state: ColorState
    ) {
        const container = document.getElementById(containerId) as HTMLElement;
        
        // We use a 2D overlay canvas for the UI indicator (white rings) 
        // to avoid re-rendering WebGPU just for cursor movement.
        this.canvas = container.querySelector('canvas') as HTMLCanvasElement;
        
        const overlay = document.createElement('canvas');
        overlay.width = this.canvas.width;
        overlay.height = this.canvas.height;
        overlay.style.position = 'absolute';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.pointerEvents = 'none'; // Let clicks pass through to WebGPU canvas
        container.appendChild(overlay);
        container.style.position = 'relative';

        this.overlayCtx = overlay.getContext('2d')!;

        this.setupEvents();
        this.state.subscribe(() => this.drawIndicators());
        this.drawIndicators(); // Initial draw
    }

    private setupEvents() {
        const handleInput = (e: MouseEvent | TouchEvent) => {
            const rect = this.canvas.getBoundingClientRect();
            const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
            const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
            
            // Normalize to canvas coordinates
            const x = (clientX - rect.left) * (this.canvas.width / rect.width);
            const y = (clientY - rect.top) * (this.canvas.height / rect.height);
            
            // Convert to centered coordinates
            const cx = this.canvas.width / 2;
            const cy = this.canvas.height / 2;
            const dx = x - cx;
            const dy = y - cy;
            
            // Math limits matching the WGSL
            const radius = Math.sqrt(dx * dx + dy * dy);
            const outerRadius = cx * 0.95;
            const innerRadius = cx * 0.75;
            const squareHalfSize = innerRadius * 0.7071;

            if (e.type === 'mousedown' || e.type === 'touchstart') {
                if (radius > innerRadius && radius < outerRadius) this.dragTarget = 'hue';
                else if (Math.abs(dx) < squareHalfSize && Math.abs(dy) < squareHalfSize) this.dragTarget = 'sv';
                this.isDragging = true;
            }

            if (this.isDragging) {
                if (this.dragTarget === 'hue') {
                    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
                    if (angle < 0) angle += 360;
                    this.state.setHue(Math.round(angle));
                } else if (this.dragTarget === 'sv') {
                    // Map local coordinates to 0-100%
                    const sNorm = Math.max(0, Math.min(1, (dx + squareHalfSize) / (squareHalfSize * 2)));
                    const vNorm = Math.max(0, Math.min(1, 1 - (dy + squareHalfSize) / (squareHalfSize * 2)));
                    this.state.setHsv(this.state.hsv.h, Math.round(sNorm * 100), Math.round(vNorm * 100));
                }
            }
        };

        this.canvas.addEventListener('mousedown', handleInput);
        window.addEventListener('mousemove', (e) => { if (this.isDragging) handleInput(e); });
        window.addEventListener('mouseup', () => { this.isDragging = false; this.dragTarget = null; });
    }

    private drawIndicators() {
        const ctx = this.overlayCtx;
        const w = this.canvas.width;
        const cx = w / 2;
        const { h, s, v } = this.state.hsv;

        ctx.clearRect(0, 0, w, w);
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 2;
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;

        // 1. Draw Hue Ring Indicator
        const ringRadius = cx * 0.85; // Middle of inner/outer
        const hueRad = h * (Math.PI / 180);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(hueRad) * ringRadius, cx + Math.sin(hueRad) * ringRadius, 6, 0, Math.PI * 2);
        ctx.stroke();

        // 2. Draw SV Square Indicator
        const innerRadius = cx * 0.75;
        const sqHalf = innerRadius * 0.7071;
        const x = (cx - sqHalf) + (s / 100) * (sqHalf * 2);
        const y = (cx - sqHalf) + (1 - v / 100) * (sqHalf * 2);
        
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.stroke();
    }
}