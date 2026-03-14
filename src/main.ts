import { initGPU } from "./renderer/webgpu";
import { setupPointer } from "./input/pointer";
import { StrokeEngine } from "./brush/stroke";
import { PaintPipeline } from "./renderer/pipeline";
import { NavigationManager } from "./input/navigation";
import './style.css';

async function start() {
  const { device, context, format, canvas } = await initGPU();
  const dpr = window.devicePixelRatio || 1;
  const canvasSize = { width: 1000, height: 1400 };

  // 1. Core Logic Setup
  canvas.width = canvasSize.width * dpr;
  canvas.height = canvasSize.height * dpr;

  const pipeline = new PaintPipeline(device, context, format, canvas.width, canvas.height);
  const strokeEngine = new StrokeEngine();
  const sizeSlider = document.getElementById('sizeSlider') as HTMLInputElement;

  // 2. Navigation Setup (Using your new separate file!)
  const nav = new NavigationManager(canvas, () => updateCanvasTransform());

  function updateCanvasTransform() {
    canvas.style.width = `${canvasSize.width * nav.state.zoom}px`;
    canvas.style.height = `${canvasSize.height * nav.state.zoom}px`;
    canvas.style.left = `calc(50% + ${nav.state.x}px)`;
    canvas.style.top = `calc(50% + ${nav.state.y}px)`;
    canvas.style.transform = `translate(-50%, -50%)`;
    canvas.style.position = "absolute";
  }

  // 3. The Math Helper (Needed for zoom/pan drawing)
  const translateCoords = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height
    };
  };

  // 4. Input Orchestration
  setupPointer(
    canvas,
    (x: number, y: number, p: number, e: PointerEvent) => {
      // Check nav.isNavigating (the getter we made)
      if (nav.isNavigating || e.buttons !== 1) return;
      const coords = translateCoords(e.clientX, e.clientY);
      strokeEngine.beginStroke(coords.x, coords.y, p);
    },
    (x: number, y: number, p: number, e: PointerEvent) => {
      // If we start navigating (press Space) mid-stroke, end it.
      if (nav.isNavigating || e.buttons !== 1) {
        if (strokeEngine.isDrawing) {
           const coords = translateCoords(e.clientX, e.clientY);
           strokeEngine.endStroke(coords.x, coords.y, p);
        }
        return;
      }
      const coords = translateCoords(e.clientX, e.clientY);
      strokeEngine.addPoint(coords.x, coords.y, p);
    },
    (x: number, y: number, p: number, e: PointerEvent) => {
      const coords = translateCoords(e.clientX, e.clientY);
      strokeEngine.endStroke(coords.x, coords.y, p);
    }
  );

  // 5. UI Button Listeners
  document.getElementById('clearBtn')?.addEventListener('click', () => pipeline.clear());
  document.getElementById('saveBtn')?.addEventListener('click', () => pipeline.saveImage());
  
  sizeSlider?.addEventListener('input', () => {
    pipeline.updateUniforms(canvas.width, canvas.height, parseFloat(sizeSlider.value));
  });

  // 6. The Heartbeat (Render Loop)
  function renderLoop() {
    const stamps = strokeEngine.flush();
    pipeline.draw(stamps); 
    requestAnimationFrame(renderLoop);
  }

  // Initialize view and start loop
  updateCanvasTransform();
  pipeline.draw(new Float32Array([])); // Clear to white initially
  renderLoop();
}

// Global safety: disable context menu for Ctrl+Click (Zoom)
window.addEventListener('contextmenu', (e) => e.preventDefault());

start();