# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Vite dev server
npm run build      # TypeScript compile + Vite bundle (minified, no source maps)
npm run preview    # Preview production build locally
npm run deploy     # Deploy to GitHub Pages (gh-pages)
```

No test suite is configured.

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
| `src/core/app.ts` | `PaintApp` — top-level app class wiring all subsystems |
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
| `src/renderer/effects-pipeline.ts` | Post-process effects: blur, hue/sat |
| `src/renderer/selection-manager.ts` | Selection mask rendering |
| `src/input/navigation.ts` | Pan/zoom/rotate view state (zoom range: 0.1–5.0) |
| `src/input/gesture-recognizer.ts` | Touch gesture detection |
| `src/core/event-bus.ts` | Typed `AppEventMap` event bus (app → UI) |
| `src/core/history-manager.ts` | Undo/redo using checkpoint snapshots |
| `src/core/autosave-manager.ts` | IndexedDB session persistence |
| `src/utils/project-format.ts` | `.gpaint` file format (fflate compressed) |
| `src/utils/export.ts` | PNG/JPEG export |

### Shaders (WGSL)

All shaders live in `src/renderer/shaders/` and `src/brush/brush.wgsl`:
- `brush.wgsl` — stamp rendering (soft/hard round, hardness-based falloff)
- `composite.wgsl` — layer compositing (normal / multiply / screen / overlay)
- `selection.wgsl` — selection mask
- `effects/gaussian-blur.wgsl` — blur kernel

### Performance Design

- **Dirty rect optimization**: `CompositeRenderer` only composites changed regions during active strokes (`loadOp: 'load'` + scissor rect). Full recomposite (`loadOp: 'clear'`) happens on undo/redo.
- **Ring buffer**: Stamp vertex data uses a 4MB GPU ring buffer.
- **Pipeline cache**: `pipeline-cache.ts` caches `GPURenderPipeline` per blend mode to avoid recompilation.
- **GPU timing**: Optional `timestamp-query` feature for frame time measurement.
- **Worker isolation**: Stroke math runs off the main thread to keep input latency low.

### Blend Modes & Eraser

Blend modes are encoded as integers in the composite shader (0=normal, 1=multiply, 2=screen, 3=overlay). The eraser is implemented as a brush with `blendMode: 'erase'` in `BrushDescriptor` — not a separate rendering path.

### Path Aliases (tsconfig)

```
@/*        → src/*
@core/*    → src/core/*
@renderer/* → src/renderer/*
@ui/*      → src/ui/*
```

### Deployment

The app deploys to GitHub Pages at base path `/gpu-paint/` (set in `vite.config.ts`). The build drops all `console.*` calls and enables Terser variable mangling.
