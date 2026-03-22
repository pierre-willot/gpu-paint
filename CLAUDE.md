# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # TypeScript compile + Vite bundle (minified, no source maps)
npm run preview    # Preview production build locally
npm run deploy     # Deploy to GitHub Pages (gh-pages — broken on Windows, use git push instead)
```

Deployment is handled automatically by GitHub Actions on every push to `main` (`.github/workflows/deploy.yml`). No test suite configured.

---

## Architecture Overview

**gpu-paint** is a WebGPU-based digital painting app. The rendering pipeline is fully GPU-accelerated with stroke processing offloaded to a Web Worker.

### Data Flow

```
Pointer/Touch Events
    → NavigationManager (pan/zoom/rotate) or Tool (brush/eraser/fill/etc.)
    → StrokeEngine (main thread) — buffers points, applies pressure curve
    → WorkerBridge → stroke-worker.ts (Web Worker) — computes stamp positions
    → BrushRenderer — GPU stamp rendering to active layer texture
    → CompositeRenderer — blends all visible layers to canvas
```

### Key Modules

| Path | Responsibility |
|---|---|
| `src/core/app.ts` | `PaintApp` — top-level orchestrator wiring all subsystems |
| `src/main.ts` | Bootstrap: GPU init, DPR/refresh rate, UI wiring, autosave |
| `src/renderer/pipeline.ts` | `PaintPipeline` — owns all renderer subsystems, dirty-rect tracking |
| `src/renderer/webgpu.ts` | GPU adapter/device init, canvas context setup |
| `src/renderer/brush-renderer.ts` | Renders stamp batches to a layer texture |
| `src/renderer/composite-renderer.ts` | Composites all layers with blend modes |
| `src/renderer/layer-manager.ts` | Layer state (opacity, blend mode, visibility, locks) |
| `src/renderer/stroke.ts` | `StrokeEngine` — point buffering, velocity, pressure dynamics |
| `src/renderer/stroke-worker.ts` | Worker-thread stamp processing |
| `src/renderer/worker-bridge.ts` | Main ↔ Worker IPC (transferable stamp buffers) |
| `src/renderer/checkpoint-manager.ts` | Full-canvas snapshots for undo/redo |
| `src/renderer/brush-descriptor.ts` | Serializable brush parameters (single source of truth) |
| `src/renderer/effects-pipeline.ts` | Post-process effects: blur, hue/sat (CPU path) |
| `src/renderer/selection-manager.ts` | R8Unorm mask + marching ants |
| `src/input/navigation.ts` | Pan/zoom/rotate view state (zoom range: 0.1–5.0) |
| `src/input/gesture-recognizer.ts` | Touch gesture detection |
| `src/core/event-bus.ts` | Typed `AppEventMap` event bus (app → UI) |
| `src/core/history-manager.ts` | Undo/redo using checkpoint snapshots |
| `src/core/autosave-manager.ts` | IndexedDB session persistence |
| `src/utils/project-format.ts` | `.gpaint` file format (fflate compressed) |
| `src/utils/export.ts` | PNG/JPEG export |

### Shaders (WGSL)

- `src/brush/brush.wgsl` — stamp rendering (soft/hard round, hardness-based falloff)
- `src/renderer/shaders/composite.wgsl` — layer compositing (normal/multiply/screen/overlay)
- `src/renderer/shaders/selection.wgsl` — marching ants
- `src/renderer/shaders/effects/gaussian-blur.wgsl` — present but unused (CPU path used instead)

### Path Aliases (tsconfig)

```
@/*         → src/*
@core/*     → src/core/*
@renderer/* → src/renderer/*
@ui/*       → src/ui/*
```

---

## Critical Constants & Stamp Layout

```
FLOATS_PER_STAMP = 12   (pipeline-cache.ts)
BYTES_PER_STAMP  = 48

Stamp layout (48 bytes per instance):
  offset  0 : vec2<f32>  pos        (normalized 0..1 canvas coords)
  offset  8 : f32        pressure   (raw device pressure, 0..1)
  offset 12 : f32        size       (ALREADY pressure-baked by StrokeEngine)
  offset 16 : vec4<f32>  color      (RGBA 0..1, non-premultiplied)
  offset 32 : vec2<f32>  tilt       (tiltX, tiltY in degrees)
  offset 40 : f32        opacity    (per-stamp final opacity, 0..1)
  offset 44 : f32        stampAngle (radians)

CRITICAL: shader uses `size` directly — pressure is already baked.
Never multiply by pressure again in the shader.
```

---

## Coordinate System

All canvas coordinates are **normalized 0..1** throughout the codebase.
- `translatePoint(clientX, clientY)` in `app.ts` converts screen → normalized
- Accounts for: pan (`nav.state.x/y`), zoom (`nav.state.zoom`), rotation (`nav.state.rotation`)
- Uses inverse rotation matrix: `rad = -(rotation * π / 180)`
- `canvasToScreen(nx, ny)` is the inverse — used by SelectionTool overlay

Canvas center in screen space:
```
centerX = window.innerWidth / 2 + nav.state.x
centerY = HEADER_H + (window.innerHeight - HEADER_H) / 2 + nav.state.y
```

`SelectionManager` expects **normalized 0..1** coords in `setRect`/`setLasso`.
It scales internally: `px = round(x * maskWidth)`.

---

## Shader Rules

**brush.wgsl:**
- Returns NON-PREMULTIPLIED `vec4(color.rgb, alpha)`
- Blend state: `src-alpha / one-minus-src-alpha`
- NEVER return premultiplied — causes dark ring artifact
- `radius_px = size * resolution.x * 0.5` — NO pressure multiply

**selection.wgsl:**
- Full-screen triangle, no vertex buffer
- `u.time * 8.0` for march speed (≈ 1 cycle/sec at 60fps)
- Was `80.0` — do not revert

---

## Command History Types

**Architecture: pixel-based direct undo/redo.** All pixel-changing operations store `beforePixels`/`afterPixels` (packed full-layer RGBA `Uint8Array`). Undo/redo restores pixels directly — no replay needed. Structural commands (`add-layer`, `delete-layer`, `paste`) still use `reconstructFromHistory`.

```typescript
type Command =
  | { type: 'stroke';    layerIndex, beforePixels, afterPixels, timestamp }
  | { type: 'smudge';   layerIndex, beforePixels, afterPixels, timestamp }
  | { type: 'cut';      layerIndex, beforePixels, afterPixels, timestamp }
  | { type: 'selection'; operation, beforeMask, afterMask, maskWidth, maskHeight, timestamp }
  | { type: 'add-layer';    layerIndex, timestamp }
  | { type: 'delete-layer'; layerIndex, timestamp }
  | { type: 'paste';   pixels, timestamp }

type SelectionOperation = 'rect' | 'lasso' | 'selectAll' | 'deselect' | 'invertSelection'
```

**History rules:**
- `canUndo()` returns true when `undoStack.length > 1` (first command is "Initial Layer")
- Max 200 commands OR 256MB pixel data — oldest dropped when exceeded
- Checkpoint every 10 commands (used only for session restore / structural command replay)
- `HistoryManager` constructor: `(onNewCommand, onReplay, onDirectUndo, onDirectRedo, options)`
- Direct undo/redo path: `stroke`, `smudge`, `cut`, `selection` — calls `pipeline.directUndoCommand/directRedoCommand`
- Replay path: `add-layer`, `delete-layer`, `paste` — calls `pipeline.reconstructFromHistory`

**`pipeline.hadPaintingSinceReset`** — flag set by `draw()`/`drawSmudge()`, reset by `resetPaintingFlag()`. Used in `app.ts` pointerUp to decide whether to push to history.

---

## Selection Architecture

Selection is **undoable**.

**Flow for new selections:**
1. `app.ts` pointerDown: `_selectionBeforeMask = selectionManager.getMaskSnapshot()` (before state)
2. `SelectionTool` calls `pipeline.setRectSelection()` directly (immediate visual feedback)
3. `SelectionTool` fires `onSelectionMade` callback
4. `app.ts`: captures `afterSnapshot = selectionManager.getMaskSnapshot()`, pushes `{ type:'selection', beforeMask, afterMask }` to history
5. `pipeline.applyCommand` for `'selection'`: no-op (already applied), marks dirty only

**Undo/redo:**
- **Direct path** (most operations): `pipeline.directUndoCommand` restores `beforeMask` via `selectionManager.restoreFromSnapshot()` + `syncMask()`
- **Replay path** (session restore / structural): `replayCommand` for selection restores `afterMask` + calls `syncMask()`. `reconstructFromHistory` clears selection state first, then replays ALL selection commands in sequence.

**Selection state is ephemeral in GPU** — lives in `SelectionManager.maskData` (CPU `Uint8Array`) + `maskTexture` (R8Unorm GPU texture). Saved to autosave (IDB) via `beforeBuffer`/`afterBuffer` in `StoredCommandRecord`. NOT saved to `.gpaint`.

**`SelectionManager` new methods:**
- `getMaskSnapshot()` → `{ data: Uint8Array; hasMask: boolean }` — returns a copy
- `restoreFromSnapshot({ data, hasMask })` — restores CPU data + uploads to GPU

**`onSelectionMade` contract:**
```typescript
selectionTool.onSelectionMade = (op: {
    operation: 'rect' | 'lasso';
    selMode:   string;
    x?:  number; y?: number; w?: number; h?: number;  // rect
    points?: number[];                                  // lasso/poly
}) => void
```
For deselect (tap with no drag): fires with `{ operation:'rect', selMode:'replace', x:0, y:0, w:0, h:0 }`.
App.ts detects this as deselect when `op.w < 0.001`.

`app.selectAll()`, `app.deselect()`, `app.invertSelection()` — bypass the tool and push directly to history. Use from menu/keyboard, not `pipeline.*`.

---

## Transform Architecture (C4)

### State
```typescript
interface TransformState { cx, cy, scaleX, scaleY, rotation }
// cx/cy = normalized canvas center (0..1)
// scaleX/scaleY = content size in normalized canvas units (1.0 = full canvas width/height)
// rotation = degrees clockwise
```

### GPU pipeline (transform-pipeline.ts)
- Shader: `src/renderer/shaders/transform-preview.wgsl`
- Inverse affine matrix: maps destination UV → source UV (2 vec4 rows)
- Source texture: original pixels (not scaled) — shader handles the UV remapping
- Preview texture: result of inverse-affine sample, used in composite

### PaintPipeline transform methods
```typescript
pipeline.beginTransform(sourcePixels, initialState)   // enters transform mode
pipeline.updateTransform(state)                        // re-renders preview (call on each drag)
pipeline.commitTransform()                             // copies preview → layer, returns afterPixels
pipeline.cancelTransform(sourcePixels)                 // restores original pixels
pipeline.transformActive: boolean                      // read-only
```

### Composite override
When `transformActive`, `composite()` passes `{ layerIndex, texture: transformPreviewTex }` to `compositeRenderer.render()`. The composite renders the preview texture instead of the layer texture for that slot.

### TransformTool handle geometry
- Handles at corners/edges/rotation at `(cx ± scaleX/2, cy ± scaleY/2)` in local space, then rotated
- Corner scale: opposite corner stays fixed, new center = midpoint of fixed + dragged
- Edge scale: only one axis changes, project pointer to local axis
- Rotate: angle delta from center
- Shift on corner drag = aspect ratio lock

### Image Import (D7)
`app.importImage(file)`:
1. `createImageBitmap(file)` → compute fit-to-canvas scale
2. Create OffscreenCanvas, `drawImage` stretched to canvasW×canvasH (fills UV 0..1)
3. `copyExternalImageToTexture` → new layer
4. `app.enterTransform(srcPixels, { cx:0.5, cy:0.5, scaleX:dw/canvasW, scaleY:dh/canvasH })`

### History
- Transform committed → pushed as `{ type:'transform', layerIndex, beforePixels, afterPixels }`
- Undo/redo: same `directUndoCommand`/`directRedoCommand` path as 'stroke'
- Cancel → no history entry, original pixels restored

### UX
- T key → enter transform on active layer
- Enter or double-click → commit
- Escape → cancel
- Ctrl+I / File→Import Image → import and auto-enter transform
- Drag-drop image file → import and auto-enter transform
- Shift drag corner → aspect ratio lock

---

## Effects Pipeline (Live Preview Pattern)

Pattern for both Hue/Sat and Gaussian Blur:
1. Panel opens → `pipeline.snapshotActiveLayer()` → stores `Uint8Array`
2. Each slider change → `pipeline.restoreActiveLayer(snapshot)` → re-apply effect
3. Apply button → discard snapshot (keep GPU state)
4. Cancel/close → `pipeline.restoreActiveLayer(snapshot)` → restore original

Both effects are **CPU-only** (no compute shader):
- `EffectsPipeline.snapshotTexture(tex)` → GPU readback to `Uint8Array`
- `EffectsPipeline.restoreTexture(tex, pixels)` → `writeTexture`
- Gaussian blur: separable box blur in JS (60ms debounce on slider)
- Hue/Sat: RGB→HSL→shift→RGB in JS

Why CPU: `bgra8unorm` (default on Windows/DX12) does not support `STORAGE_BINDING` without optional features.

**Timing:** `snapshotActiveLayer()` is async (GPU readback). The panel fade-in animation (0.12s) plays during the await — snapshot completes before user can touch a slider. Never call snapshot inside a slider `input` handler.

---

## Autosave (IndexedDB)

`SessionStore` exact API:
```typescript
store.open()
store.hasSession()
store.getSessionMeta()                        → SessionMeta | null
store.updateSessionMeta(meta: SessionMeta)    // id:'meta' required
store.appendCommand(record: StoredCommandRecord)
store.deleteCommand(seq)
store.deleteCommandsAboveSeq(cutoffSeq)
store.loadCommandRange(minSeq, maxSeq)        → StoredCommandRecord[]
store.putCheckpoint(record: StoredCheckpointRecord)
store.deleteCheckpointsAboveStack(cutoff)
store.loadAllCheckpoints()                    → StoredCheckpointRecord[]
store.clearAll()
```

`SessionMeta` requires: `{ id: 'meta', canvasWidth, canvasHeight, minSeq, maxSeq, checkpointStackOffset, timestamp, version: 1 }`

`StoredCommandRecord` stamps stored as `ArrayBuffer` (not `number[]`).

Helpers exported from `autosave-manager.ts`:
```typescript
export function recordToCommand(r: StoredCommandRecord): Command
export function recordToCheckpoint(r: StoredCheckpointRecord, stackOffset: number): Checkpoint
```

---

## Worker Bridge Contract

```typescript
class WorkerBridge {
    isDrawing: boolean                         // true between beginStroke and endStrokeAndFlush
    getPredictedStamps(): Float32Array
    flush(): Float32Array                      // consume buffered stamps (call in renderTick)
    setDescriptor(d: BrushDescriptor): void
    setPressureLUT(lut: Float32Array): void
    beginStroke(x, y, pressure, tiltX?, tiltY?): void
    addPoint(x, y, pressure, tiltX?, tiltY?): void
    async endStrokeAndFlush(): Promise<Float32Array>
    reset(): void
}
```

---

## CheckpointManager Types

```typescript
interface LayerMeta { name: string; opacity: number; blendMode: string; visible: boolean; }

interface LayerSnapshot {
    data:        Uint8Array;   // compressed (deflate-raw via CompressionStream)
    bytesPerRow: number;
    meta:        LayerMeta;
}

interface Checkpoint {
    stackLength:      number;
    snapshots:        LayerSnapshot[];
    activeLayerIndex: number;
}

class CheckpointManager {
    onCheckpointSaved?: (cp: Checkpoint) => Promise<void>;
    async save(stackLength, layers, device, width, height, activeLayerIndex): Promise<void>
    findNearest(stackLength: number): Checkpoint | null
    async restore(cp, layerManager, device, w, h): Promise<void>
    shiftDown(): void        // when oldest command is dropped
    pruneAbove(len: number): void  // when redo is invalidated
    loadFromPersisted(checkpoints: Checkpoint[]): void
    clear?(): void           // on canvas resize
}
MAX_CHECKPOINTS = 20
```

---

## ColorState Interface

```typescript
class ColorState {
    get rgb(): { r: number; g: number; b: number }
    get hsv(): { h: number; s: number; v: number }
    get hex(): string
    colorMode: 'hsv' | 'hsl'

    setRgb(r, g, b): void
    setHsv(h, s, v): void
    toggleMode(): void
    subscribeLocal(listener: () => void): () => void  // returns unsubscribe fn
    broadcastLocal(): void  // has re-entrancy guard (broadcasting flag)
}
```

`broadcastLocal()` has a `broadcasting: boolean` re-entrancy guard. Prevents infinite loop: eyedropper → `color:change` bus → `setRgb()` → `broadcastLocal()` → loop.

Color picker slider IDs: `hue-slider`, `sat-slider`, `val-slider` (**hyphenated**, not camelCase).

---

## PressureCurve

```typescript
const PRESSURE_PRESETS = {
    natural: { x1: 0.25, y1: 0.10, x2: 0.75, y2: 0.90 },
    // + others: light, heavy, linear, etc.
}

class PressureCurve {
    constructor(preset?: PressureCurvePreset)
    update(preset: PressureCurvePreset): void
    toLUT(): Float32Array   // 256-entry lookup table
}
```

`PressureLUT` is `Float32Array(256)` mapping input pressure (index/255) → output. Set on `BrushTool`/`EraserTool` via `setPressureLUT(lut)`, forwarded to worker via `WorkerBridge`.

---

## Performance Rules

- Never allocate GPU buffers inside `renderFrame()`
- Never do synchronous GPU readback during a stroke (only on tool release or effect apply)
- Selection mask: dummy 1×1 white `R8Unorm` texture when no selection (zero overhead)
- Marching ants: only `needsRedraw = true` every frame when `hasMask` is true
- CheckpointManager: saves every 10 commands, async, never blocks render loop
- Dirty rect optimization: `CompositeRenderer` uses `loadOp:'load'` + scissor during active stroke; `loadOp:'clear'` on undo/redo

---

## Dependency Notes

- `fflate`: required for `.gpaint` ZIP format (`project-format.ts`)
- WebGPU format on Windows/DX12: default is `bgra8unorm`. Everywhere pixels are read back (eyedropper, fill tool, effects), swap channels: `[r,g,b] = [data[2], data[1], data[0]]`

---

## Vite Config Notes

- WGSL files imported with `?raw` suffix: `import src from './shader.wgsl?raw'`
- Workers: `new Worker(new URL('./stroke-worker.ts', import.meta.url), { type: 'module' })`
- Do NOT import `gaussian-blur.wgsl?raw` unless the file exists — Vite fails hard at build time if the import target is missing

---

## Layer System

`LayerState`: `{ texture, opacity(0-1), blendMode, visible, locked, alphaLock, name }`

`BlendMode` = `'normal' | 'multiply' | 'screen' | 'overlay'`

Layers displayed in **reverse** order in UI (top layer = first in list).

**Alpha lock**: stored in state, GPU enforcement deferred to Tier C (brush shader needs second texture binding).

---

## Project File Format (.gpaint)

ZIP (fflate, store mode — no double-compression):
```
manifest.json  { version, canvasWidth, canvasHeight, activeLayerIndex, layers[] }
layers/layer-0.png
layers/layer-1.png
...
```
BGRA→RGBA swap required for `bgra8unorm` textures on Windows.

---

## Brush Cursor

- Lives on `document.body` as `position:fixed; inset:0` canvas (z-index 9000)
- Position: raw `e.clientX / e.clientY` — **NO** `getBoundingClientRect`
- Radius: `(normalizedSize / 2) × canvasSize.width × nav.state.zoom`
- Hides for non-painting tools (eyedropper, fill, selection)

---

## Navigation

`ViewState = { x: number, y: number, zoom: number, rotation: number }`
- `gestureActive: boolean` — set by `GestureRecognizer` during multi-touch
- `isNavigating = keys.Space || gestureActive`
- Canvas CSS: `translate(-50%, -50%) rotate(${rot}deg)`
- Wheel listener on canvas element (not window) with `passive: false`

---

## Focus Mode

Uses `body.focus-mode` CSS class (not inline opacity).
CSS hides: `header`, `.float-panel`, `.transform-bar`, `.effect-panel`.
`#focusExitBtn` shown only in focus mode via `body.focus-mode #focusExitBtn { display:flex }`.
Tab key toggles (guarded against inputs/contenteditable). 4-finger tap triggers via `GestureRecognizer`.

---

## Panel System

`makeDraggable(panel)` — whole panel surface draggable, skips `INTERACTIVE` selector:
```
INTERACTIVE = 'button,input,select,textarea,[contenteditable],a,.layer-drag-handle'
```
`globalResizing` flag prevents drag during resize.
`addResizeHandles(panel, { minW, minH })` — 8 edge/corner handles, z-index 30.

Panel IDs: `leftPanel`, `rightPanel`, `layerPanel`, `brushSettingsPanel`, `prefsPanel`, `exportPanel`

---

## HTML Element IDs (canonical)

```
Canvas:         #canvas  (NOT #mainCanvas)
Canvas wrapper: #canvasStack

Left panel:     #leftPanel
  Size slider:  #sizeSlider (min=0.005 max=0.15 step=0.001, NORMALIZED)
  Brush dot:    #brushDot
  Undo/redo:    #undoBtn, #redoBtn

Color panel:    #rightPanel, #rightBody
  Swatch:       #active-color-preview
  Tabs:         #tabRgb, #tabHsv
  Sliders:      #redSlider, #greenSlider, #blueSlider
  HSV sliders:  #hue-slider, #sat-slider, #val-slider  ← HYPHENATED
  Text inputs:  #redVal, #greenVal, #blueVal, #hue-val, #sat-val, #val-val

Layer panel:    #layerPanel
  Toolbar:      #add-layer-btn, #lyrLockBtn, #lyrAlphaLockBtn, #lyrVisBtn, #lyrDeleteBtn
  Opacity:      #layerOpacity, #layerOpacityVal, #layerBlend
  List:         #layer-list  ← HYPHENATED

Tool buttons:   #toolBrush, #toolEraser, #toolEyedropper, #toolFill, #toolSmudge, #toolSelect
Panel toggles:  #layerToggleBtn, #colorToggleBtn
Save status:    #save-status

Brush settings: #brushSettingsPanel, #bs-opacity, #bs-flow, #bs-hardness, #bs-spacing
Pressure curve: #pressureCurveContainer

Effect panels:  #efx-hueSat, #efx-blur
HueSat:         #efx-hue, #efx-sat, #efx-light + -val variants
                #efx-hueSat-apply, #efx-hueSat-reset, #efx-hueSat-close
Blur:           #efx-blur-radius, #efx-blur-val, #efx-blur-apply, #efx-blur-reset, #efx-blur-close

Export:         #exportPanel, #export-png-btn, #export-zip-btn, #export-gpaint-btn
Selection popup:#selectionPopup, #selTypeRect, #selTypeLasso, #selTypePoly
                #selModeReplace, #selModeAdd, #selModeSub, #selModeInt

Menus:          #btnFile, #btnEdit, #btnEffects, #btnView, #btnAbout
                #menuFile, #menuEdit, #menuEffects, #menuView, #menuAbout
Menu items:     #menu-new, #menu-open, #menu-save, #menu-save-project
                #menu-undo, #menu-redo, #menu-select-all, #menu-deselect, #menu-invert-sel
                #menu-clear, #menu-resize
                #menu-hue-sat, #menu-blur, #menu-zoom-in, #menu-zoom-out, #menu-zoom-fit
                #menu-rotate-cw, #menu-rotate-ccw, #menu-reset-rotation, #menu-focus
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| B | Brush tool |
| E | Eraser tool |
| I | Eyedropper |
| G | Fill tool |
| M | Selection tool |
| [ / ] | Brush size −/+ |
| R / Shift+R | Rotate canvas CW/CCW 15° |
| Tab | Focus mode toggle |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+S | Save session (autosave) |
| Ctrl+Shift+S | Save as .gpaint |
| Ctrl+O | Open .gpaint |
| Ctrl+N | New canvas dialog |
| Ctrl+Alt+C | Resize canvas dialog |
| Ctrl+U | Hue/Sat effect |
| Ctrl+= / Ctrl+- | Zoom in/out |
| Ctrl+0 | Fit to screen |
| Ctrl+A | Select all |
| Ctrl+D | Deselect |
| Escape | Deselect + return to brush |
| Shift+drag | Straight line (B8) |

Touch gestures: 2-finger = pan/pinch/rotate, 3-finger tap = undo, 3-finger swipe right = redo, 4-finger tap = focus mode.

---

## CSS Design Tokens

```css
--bg: #565b62                          /* workspace background */
--header-bg: rgba(46,50,58,0.98)
--panel-bg: rgba(50,55,65,0.94)
--track-bg: rgba(28,31,38,0.9)
--border: rgba(255,255,255,0.1)
--text-1: #f4f7fd
--text-2: #bcc8da
--text-3: #7e8fa2
--track-h: 22px
--thumb-d: 18px
--header-h: 52px
--panel-w: 228px
```

Font: `'DM Sans'` (UI), `'DM Mono'` (values). Loaded from Google Fonts.

---

## Bootstrap Sequence (main.ts)

1. `measureRefreshRate()` → 60/90/120 Hz
2. `initGPU()` → finds `#canvas`
3. Set `canvas.width/height` (DPR-capped at 2)
4. `new PaintApp(canvas, device, context, format, canvasSize, supportsTimestamps, fps)`
5. `app.initBrushCursor()`
6. `makeDraggable + addResizeHandles` for all panels
7. `new PanelManager()`
8. `new ColorState(app.bus)` + `new ColorPickerUI(colorState)`
9. `colorState.subscribeLocal` → `app.setBrushColor()`
10. `app.bus.on('color:change')` → `colorState.setRgb()` (eyedropper sync)
11. `new LayerUI` + `new ToolbarUI`
12. `subscribeUI(app, layerUI, toolbarUI)`
13. Brush settings sliders (`wireBrushSettings`)
14. `new PressureCurveUI` (into `#pressureCurveContainer`)
15. `new CanvasSizeDialog`, `new FocusMode`, `new GestureRecognizer`
16. Autosave: `SessionStore` → `AutosaveManager` → `RestoreBanner`
17. `new MenuManager(app, autosave, triggerFileInput, sizeDialog)`
18. `await app.init()` — adds initial layer, starts render loop
19. `colorState.broadcastLocal()`
20. Keyboard shortcuts + drag-drop `.gpaint` handler + device-lost recovery

---

## Bugs Fixed — Do Not Reintroduce

1. **Brush outline dark ring**: shader must return non-premultiplied `vec4(color.rgb, alpha)`. Never return premultiplied.

2. **Brush cursor offset at zoom/rotation**: uses `position:fixed` on body, raw `clientX/Y`. Never use `getBoundingClientRect()` on a rotated canvas.

3. **Brush cursor size mismatch**: shader had `size * pressure * resolution`. Pressure is already baked into `size`. Remove `* pressure` from radius calculation.

4. **Selection invisible**: `setRect`/`setLasso` passed normalized 0..1 to rasterizers expecting pixels. Now scaled: `px = round(x * maskWidth)`.

5. **Selection disappears on release**: Tool calls `pipeline.setRectSelection()` for immediate feedback AND fires `onSelectionMade` for history. `applyCommand` skips (already applied), `replayCommand` applies.

6. **Undo clips old strokes to selection**: `reconstructFromHistory` must call `brushRenderer.setMaskTexture(null)` BEFORE replay and `syncMask()` AFTER.

7. **Canvas shadow bleed**: `box-shadow` must be on `#canvas`, not `.canvas-stack`. At zoom < 1 the wrapper is larger than the canvas.

8. **Color re-entrancy loop**: `ColorState.broadcastLocal()` has `broadcasting` guard. Without it: eyedropper → `color:change` bus → `setRgb()` → `broadcastLocal()` → infinite loop.

9. **Marching ants too fast**: `u.time * 80.0` → `u.time * 8.0` in `selection.wgsl`.

10. **Autosave wrong method names**: Must use `updateSessionMeta`, `appendCommand`, `loadCommandRange`, `loadAllCheckpoints`. Do NOT invent `putMeta`, `putCommand`, `getAllCommands`.

11. **`history.now()` missing**: `HistoryManager` must have `public now(): number { return performance.now() - this.sessionStartTime; }`.

12. **`SelectionMode` Vite ESM error**: Must export as `const` object, not type-only alias: `export const SelectionMode = { replace: 'replace', ... } as const`.

13. **Stamp-based undo changes stroke appearance**: Brush `hardness` (and other GPU renderer state) is NOT stored in stamps, so replaying stamps produces different pixels if hardness changed. Fix: all pixel-changing commands now store `beforePixels`/`afterPixels` (full layer snapshots). Undo/redo directly restores pixels — no replay, no mask/state dependencies.

14. **Selection undo/redo broken after checkpoint**: `reconstructFromHistory` with checkpoint path skipped selection commands at index < checkpoint. Fix: selection commands are always replayed in order during reconstruction; pixel commands at index < checkpoint are skipped (pixels baked in checkpoint).

---

## Completed Tiers

Tier 0–4, A1–A4, B1–B13, C2/C3, D3, full UI design system.

Key completed items: Worker stroke processing, checkpoint undo, IndexedDB autosave, `.gpaint` format, pressure curves, selection (rect/lasso/poly, all 4 modes, undoable), live effect preview (snapshot/restore), brush cursor, focus mode, layer panel (opacity/blend/lock/alpha-lock/reorder), straight line gesture, fill tool, new canvas/resize dialog, touch gestures, marching ants.

---

## Pending Roadmap

### Tier C — Advanced tools
| Item | Description |
|------|-------------|
| C1 | Smudge tool ✓ DONE — `SmudgeRenderer`, `smudge.wgsl`, `SmudgeTool` |
| C4 | Layer transform / free transform ✓ DONE — `TransformPipeline`, `TransformTool`, `TransformOverlay` |
| C5 | Copy/cut/paste selection |
| C7/C8 | Advanced brush dynamics (opacity jitter, color jitter, dual brush) |
| C9 | Brush panel + presets |

### Tier D — Effects
| Item | Description |
|------|-------------|
| D1 | RGB Curves (CPU, like hue/sat) |
| D2 | Noise (CPU per-pixel random) |
| D4 | Color Balance (shadow/mid/highlight) |
| D5 | Brightness/Contrast |
| D7 | Import image / camera (`copyExternalImageToTexture`) ✓ DONE — `app.importImage()`, drag-drop image files, Ctrl+I, File→Import Image |
| D8 | Timelapse recorder (`TimestampedCommand` data captured, needs `VideoEncoder`) |
| D9 | JPG export (PNG done; JPG via Canvas2D `toBlob`) |

### Tier E — App completeness
| Item | Description |
|------|-------------|
| E2 | Preferences persistence (localStorage) |
| E4 | Quick search wired to actions (currently visual placeholder) |
| E7/E8 | Flip canvas (CSS `scaleX(-1)`), B&W mode (CSS `grayscale`) |
| E9 | History panel (timeline list) |
| E11 | Text tool |
| E12 | Rulers and guides |
