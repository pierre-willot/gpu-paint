// ── project-format.ts ─────────────────────────────────────────────────────────
// .gpaint project file: a ZIP archive produced by fflate containing a JSON
// manifest and one PNG per layer.
//
// Format:
//   manifest.json    — version, canvas dimensions, layer metadata
//   layers/layer-0.png
//   layers/layer-1.png
//   ...
//
// Design decisions:
//   - Layer PNGs are stored with fflate level 0 (store mode). PNG is already
//     compressed internally — re-compressing costs time and saves nothing.
//   - Manifest is tiny and deflated at level 9 for good measure.
//   - No command history — opening a .gpaint file starts a clean session from
//     the visual state. Undo history lives in the autosave/IndexedDB layer.
//   - bgra8unorm vs rgba8unorm: the manifest records the byte order so future
//     versions can handle either correctly. Current code always swaps BGRA→RGBA
//     before encoding so PNGs are always in standard RGBA order.

import { zip, unzip, strToU8, strFromU8 } from 'fflate';
import { textureToBytes, bytesToPng }      from '../utils/export';
import type { LayerState }                  from './layer-manager';

// ── Manifest types ────────────────────────────────────────────────────────────

export interface GpaintLayerMeta {
    name:      string;
    opacity:   number;
    blendMode: string;
    visible:   boolean;
}

export interface GpaintManifest {
    version:          number;   // schema version — increment on breaking changes
    createdAt:        string;   // ISO 8601
    canvas:           { width: number; height: number };
    format:           string;   // texture format from WebGPU (e.g. 'bgra8unorm')
    layers:           GpaintLayerMeta[];
    activeLayerIndex: number;
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Serializes all layer textures and metadata into a .gpaint ZIP archive.
 * Returns a Uint8Array of the raw ZIP bytes, ready for download.
 *
 * The caller passes the canvas format string so the manifest can record it.
 * The PNG encoder always outputs RGBA, so bgra8unorm textures are channel-swapped
 * before encoding.
 */
export async function serializeProject(
    device:           GPUDevice,
    layers:           LayerState[],
    activeLayerIndex: number,
    canvasWidth:      number,
    canvasHeight:     number,
    format:           string
): Promise<Uint8Array> {
    const manifest: GpaintManifest = {
        version:          1,
        createdAt:        new Date().toISOString(),
        canvas:           { width: canvasWidth, height: canvasHeight },
        format,
        layers: layers.map(l => ({
            name:      l.name,
            opacity:   l.opacity,
            blendMode: l.blendMode,
            visible:   l.visible
        })),
        activeLayerIndex
    };

    // Build the fflate file map
    const files: Record<string, [Uint8Array, { level: 0 | 9 }]> = {};

    files['manifest.json'] = [
        strToU8(JSON.stringify(manifest, null, 2)),
        { level: 9 }
    ];

    // Render each layer texture to a PNG
    for (let i = 0; i < layers.length; i++) {
        const raw    = await textureToBytes(device, layers[i].texture);
        const pixels = format === 'bgra8unorm' ? swapBgraToRgba(raw) : raw;
        const png    = await bytesToPng(pixels, canvasWidth, canvasHeight);

        // level: 0 = store — PNG is already compressed, no benefit from deflating again
        files[`layers/layer-${i}.png`] = [png, { level: 0 }];
    }

    return new Promise((resolve, reject) => {
        zip(files, (err, data) => err ? reject(err) : resolve(data));
    });
}

// ── Load ──────────────────────────────────────────────────────────────────────

export interface DeserializedProject {
    manifest: GpaintManifest;
    // One ImageBitmap per layer, in layer order, ready for GPU upload
    bitmaps:  ImageBitmap[];
}

/**
 * Parses a .gpaint ZIP archive.
 * Returns the manifest and one decoded ImageBitmap per layer.
 * The caller (pipeline.ts) uploads the bitmaps to GPU textures.
 */
export async function deserializeProject(
    zipBytes: Uint8Array
): Promise<DeserializedProject> {
    // Unzip synchronously — fflate's unzip callback returns all files at once
    const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(zipBytes, (err, data) => err ? reject(err) : resolve(data));
    });

    const manifestFile = files['manifest.json'];
    if (!manifestFile) throw new Error('.gpaint: manifest.json missing');

    const manifest = JSON.parse(strFromU8(manifestFile)) as GpaintManifest;

    if (manifest.version > 1) {
        console.warn(`[gpaint] File version ${manifest.version} is newer than this app (1). Some features may not load correctly.`);
    }

    const bitmaps: ImageBitmap[] = [];

    for (let i = 0; i < manifest.layers.length; i++) {
        const key  = `layers/layer-${i}.png`;
        const data = files[key];

        if (!data) throw new Error(`.gpaint: ${key} missing`);

        const blob   = new Blob([data], { type: 'image/png' });
        const bitmap = await createImageBitmap(blob);
        bitmaps.push(bitmap);
    }

    return { manifest, bitmaps };
}

// ── Layered PNG ZIP ───────────────────────────────────────────────────────────

/**
 * Exports each layer as a separate PNG, bundled into a ZIP file.
 * Useful for bringing individual layers into Photoshop, Figma, etc.
 * The flat composite is NOT included — callers can use downloadTexture for that.
 */
export async function serializeLayeredPngs(
    device:      GPUDevice,
    layers:      LayerState[],
    canvasWidth: number,
    canvasHeight: number,
    format:      string
): Promise<Uint8Array> {
    const files: Record<string, [Uint8Array, { level: 0 }]> = {};

    for (let i = 0; i < layers.length; i++) {
        const safe    = layers[i].name.replace(/[^a-z0-9_-]/gi, '_');
        const raw     = await textureToBytes(device, layers[i].texture);
        const pixels  = format === 'bgra8unorm' ? swapBgraToRgba(raw) : raw;
        const png     = await bytesToPng(pixels, canvasWidth, canvasHeight);
        files[`${safe}.png`] = [png, { level: 0 }];
    }

    return new Promise((resolve, reject) => {
        zip(files, (err, data) => err ? reject(err) : resolve(data));
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Swaps BGRA → RGBA in-place on a copy.
 * Required when reading bgra8unorm textures before PNG encoding,
 * since PNG expects RGBA byte order.
 */
function swapBgraToRgba(src: Uint8Array): Uint8Array {
    const dst = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i += 4) {
        dst[i]     = src[i + 2]; // R ← B
        dst[i + 1] = src[i + 1]; // G ← G
        dst[i + 2] = src[i];     // B ← R
        dst[i + 3] = src[i + 3]; // A ← A
    }
    return dst;
}

// ── Download helpers ──────────────────────────────────────────────────────────

/** Triggers a browser download of arbitrary bytes with a given filename. */
export function downloadBytes(bytes: Uint8Array, filename: string): void {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const link = document.createElement('a');
    link.href     = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}
