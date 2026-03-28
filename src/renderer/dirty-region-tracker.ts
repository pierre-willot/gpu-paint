/**
 * dirty-region-tracker.ts
 *
 * Tracks the axis-aligned bounding box (AABB) of the current smudge stroke in
 * canvas pixel space. The SmudgeRenderer uses this to:
 *
 *   1. On stroke start: clear ONLY the stroke's footprint inside the carry
 *      texture, eliminating stale carry values from previous strokes bleeding
 *      into new ones.
 *   2. On stroke start: seed carry from the layer only within the dirty region,
 *      reducing the GPU copy footprint significantly on large canvases.
 *
 * ── Future optimization — dirty-region carry texture sizing ─────────────────
 * The logical next step is allocating a small carry texture sized to the dirty
 * region rather than the full canvas. This cuts texture bandwidth by 10-100×
 * on typical strokes. It requires:
 *   • A separate vertex transform in vs_main for the pickup pass (renders to
 *     the small carry texture) vs. deposit pass (renders to the full-canvas
 *     layer texture) — i.e. stamp positions must be remapped to dirty-region
 *     NDC for pickup and kept in canvas NDC for deposit.
 *   • A carry_tex_scale uniform: (dirty_pixel_size / carry_tex_pixel_size) so
 *     the shader can map canvas UVs into the oversized carry texture.
 * toUniform() already returns the data needed. Deferred here to keep the
 * coordinate system simple while all other features are validated first.
 */

export interface DirtyRegion {
  /** Un-normalized pixel coordinates in canvas space. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export class DirtyRegionTracker {
  private region: DirtyRegion | null = null;

  constructor(
    private canvasW:        number,
    private canvasH:        number,
    /** Extra pixel margin added around each stamp's radius. Accounts for tilt
     *  stretch so that the dirty region is never smaller than the actual stamp. */
    private readonly padding: number = 64,
  ) {}

  /** Call when canvas is resized. Resets any in-flight region. */
  resize(w: number, h: number): void {
    this.canvasW = w;
    this.canvasH = h;
    this.region  = null;
  }

  /** Call at the start of every stroke to reset the AABB. */
  onStrokeStart(): void {
    this.region = null;
  }

  /**
   * Expand the AABB to include a stamp at (posX, posY).
   * Initialises lazily on the first call after onStrokeStart().
   *
   * @param posX      Stamp center X in canvas pixel space.
   * @param posY      Stamp center Y in canvas pixel space.
   * @param radiusPx  Brush radius in pixels (pre-tilt, pre-pressure scaling).
   * @returns         A snapshot of the updated dirty region.
   */
  expand(posX: number, posY: number, radiusPx: number): DirtyRegion {
    const r = radiusPx + this.padding;

    if (!this.region) {
      this.region = {
        minX: Math.max(0,            posX - r),
        maxX: Math.min(this.canvasW, posX + r),
        minY: Math.max(0,            posY - r),
        maxY: Math.min(this.canvasH, posY + r),
      };
    } else {
      this.region.minX = Math.max(0,            Math.min(this.region.minX, posX - r));
      this.region.maxX = Math.min(this.canvasW, Math.max(this.region.maxX, posX + r));
      this.region.minY = Math.max(0,            Math.min(this.region.minY, posY - r));
      this.region.maxY = Math.min(this.canvasH, Math.max(this.region.maxY, posY + r));
    }

    return { ...this.region };
  }

  /** Current dirty region snapshot, or null before the first expand(). */
  get current(): DirtyRegion | null {
    return this.region ? { ...this.region } : null;
  }

  /**
   * Integer-aligned pixel rect safe to pass to GPUCommandEncoder
   * copyTextureToTexture / setScissorRect. Values are clamped to canvas bounds.
   */
  toPixelRect(): { x: number; y: number; w: number; h: number } {
    if (!this.region) {
      return { x: 0, y: 0, w: this.canvasW, h: this.canvasH };
    }
    const x = Math.floor(this.region.minX);
    const y = Math.floor(this.region.minY);
    return {
      x,
      y,
      w: Math.min(Math.ceil(this.region.maxX) - x, this.canvasW - x),
      h: Math.min(Math.ceil(this.region.maxY) - y, this.canvasH - y),
    };
  }

  /**
   * Float32Array vec4 — normalized dirty region for the GPU:
   *   [ originX, originY, sizeX, sizeY ]  (all values 0..1 in canvas space)
   *
   * Ready for upload to the uniform buffer when dirty-region carry texture
   * sizing is implemented. Currently informational (CPU seeding uses toPixelRect).
   */
  toUniform(): Float32Array {
    if (!this.region) return new Float32Array([0, 0, 1, 1]);
    const { minX, minY, maxX, maxY } = this.region;
    return new Float32Array([
      minX / this.canvasW,
      minY / this.canvasH,
      (maxX - minX) / this.canvasW,
      (maxY - minY) / this.canvasH,
    ]);
  }
}
