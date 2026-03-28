/**
 * grain-texture.ts
 *
 * Procedurally generates a tileable R8Unorm grayscale grain texture used by
 * the smudge brush. 4-octave value noise produces organic, paper-like grain.
 *
 * Created once at renderer startup and reused for the app's lifetime. If a
 * hand-crafted or scanned grain is preferred, replace with loadGrainTexture()
 * that uploads an ImageBitmap to the same format and usage flags.
 *
 * The shader samples this texture in stroke-direction-aligned UV space
 * (grain_mask in smudge.wgsl) so the grain feels attached to the tool.
 */

// ---------------------------------------------------------------------------
// Noise helpers
// ---------------------------------------------------------------------------

/**
 * Bijective 32-bit integer hash — two inputs, range 0-255 output.
 * Produces well-distributed values with no visible lattice pattern.
 */
function hash2(x: number, y: number): number {
  let h = (Math.imul(x & 0xffff, 1619) ^ Math.imul(y & 0xffff, 31337)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) & 0xff;
}

/**
 * Single-octave tileable value noise. Both inputs are normalized [0, 1).
 * `gridSize` sets the underlying hash grid — must equal the texture size for
 * seamless tiling.
 */
function valueNoise(nx: number, ny: number, gridSize: number): number {
  const px = ((nx % 1) + 1) % 1;   // ensure [0,1) with wrap
  const py = ((ny % 1) + 1) % 1;

  const fx = px * gridSize;
  const fy = py * gridSize;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;

  // C1 smoothstep
  const ux = tx * tx * (3 - 2 * tx);
  const uy = ty * ty * (3 - 2 * ty);

  // Wrap for tileability
  const x0 =  ix      % gridSize;
  const x1 = (ix + 1) % gridSize;
  const y0 =  iy      % gridSize;
  const y1 = (iy + 1) % gridSize;

  const a = hash2(x0, y0) / 255;
  const b = hash2(x1, y0) / 255;
  const c = hash2(x0, y1) / 255;
  const d = hash2(x1, y1) / 255;

  return a + (b - a) * ux
           + (c - a) * uy
           + (a - b - c + d) * ux * uy;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a tileable R8Unorm grain texture and uploads it to the GPU.
 *
 * @param device  Active WebGPU device.
 * @param size    Square texture side length in pixels. Must be power-of-two.
 *                Default 512 — balances quality vs memory (256 KB per texture).
 */
export function createGrainTexture(device: GPUDevice, size = 512): GPUTexture {
  const data = new Uint8Array(size * size);

  // Four octaves: coarse grain + progressively finer detail.
  // Frequencies are integer multiples so each octave tiles cleanly.
  const octaves: Array<{ freq: number; amp: number }> = [
    { freq: 1, amp: 0.50 },
    { freq: 2, amp: 0.25 },
    { freq: 4, amp: 0.15 },
    { freq: 8, amp: 0.10 },
  ];
  const totalAmp = octaves.reduce((s, o) => s + o.amp, 0);

  for (let y = 0; y < size; y++) {
    const ny = y / size;
    for (let x = 0; x < size; x++) {
      const nx = x / size;
      let v = 0;

      for (const { freq, amp } of octaves) {
        // Each octave tiles at freq×freq within the same texture space.
        v += valueNoise(nx * freq, ny * freq, size) * amp;
      }

      // Normalize, apply subtle gamma lift for richer mid-range grain.
      const n       = Math.min(1, v / totalAmp);
      const boosted = Math.pow(n, 0.75);
      data[y * size + x] = Math.round(boosted * 255);
    }
  }

  const texture = device.createTexture({
    label:  'smudge:grain',
    size:   [size, size, 1],
    format: 'r8unorm',
    usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: size },
    [size, size],
  );

  return texture;
}
