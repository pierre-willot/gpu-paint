import { initGPU } from "./renderer/webgpu";
import { setupPointer } from "./input/pointer";
import { StrokeEngine } from "./renderer/stroke";
import { PaintPipeline } from "./renderer/pipeline";
import { UndoManager } from "./renderer/history";
import { NavigationManager } from "./input/navigation";
import './style.css';

async function start() {
  const { device, context, format, canvas } = await initGPU();
  const dpr = window.devicePixelRatio || 1;
  const canvasSize = { width: 3000, height: 3000 };

  canvas.width = canvasSize.width * dpr;
  canvas.height = canvasSize.height * dpr;

  const pipeline = new PaintPipeline(device, context, format, canvas.width, canvas.height);
  const strokeEngine = new StrokeEngine();
  const undoManager = new UndoManager();
  const nav = new NavigationManager(canvas, () => updateCanvasTransform());
  
  const sizeSlider = document.getElementById('sizeSlider') as HTMLInputElement;
  const layerList = document.getElementById('layer-list');
  const addLayerBtn = document.getElementById('add-layer-btn');
  const undoBtn = document.getElementById('undoBtn') as HTMLButtonElement;
  const redoBtn = document.getElementById('redoBtn') as HTMLButtonElement;

  let currentStrokeStamps: number[] = [];

  // --- UI: LAYERS ---
  function refreshLayerUI() {
    if (!layerList) return;
    layerList.innerHTML = '';
    [...pipeline.layers].reverse().forEach((_, i) => {
      const actualIndex = pipeline.layers.length - 1 - i;
      const layerItem = document.createElement('div');
      layerItem.className = `layer-item ${actualIndex === pipeline.activeLayerIndex ? 'active' : ''}`;
      layerItem.innerHTML = `
        <span>Layer ${actualIndex + 1}</span>
        ${pipeline.layers.length > 1 ? `<button class="delete-layer">×</button>` : ''}
      `;
      
      const deleteBtn = layerItem.querySelector('.delete-layer') as HTMLButtonElement;
      if (deleteBtn) {
        deleteBtn.onclick = async (e) => {
          e.stopPropagation();
          // 1. Push delete command to history
          undoManager.push({ 
            type: 'delete-layer', 
            layerIndex: actualIndex 
          });
          // 2. Reconstruct everything
          await pipeline.reconstructFromHistory(undoManager.getHistory());
          refreshLayerUI();
          pipeline.composite();
          updateHistoryButtons();
        };
      }
      
      layerItem.onclick = () => {
        pipeline.activeLayerIndex = actualIndex;
        refreshLayerUI();
      };
      layerList.appendChild(layerItem);
    });
  }

  function updateHistoryButtons() {
    if (undoBtn) undoBtn.disabled = !undoManager.canUndo();
    if (redoBtn) redoBtn.disabled = !undoManager.canRedo();
  }

  // --- UTILS ---
  function updateCanvasTransform() {
    canvas.style.width = `${canvasSize.width * nav.state.zoom}px`;
    canvas.style.height = `${canvasSize.height * nav.state.zoom}px`;
    canvas.style.left = `calc(50% + ${nav.state.x}px)`;
    canvas.style.top = `calc(50% + ${nav.state.y}px)`;
    canvas.style.transform = `translate(-50%, -50%)`;
    canvas.style.position = "absolute";
  }

  const translateCoords = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / rect.width,
      y: (clientY - rect.top) / rect.height
    };
  };

  // --- UNDO/REDO HANDLERS ---
  const handleUndo = async () => {
    // Prevent removing the very first 'add-layer' command
    if (undoManager.getHistory().length <= 1) return; 

    if (undoManager.undo()) {
      await pipeline.reconstructFromHistory(undoManager.getHistory());
      refreshLayerUI(); 
      pipeline.composite(); // This call now works!
      updateHistoryButtons();
    }
  };

  const handleRedo = async () => {
    if (undoManager.redo()) {
      await pipeline.reconstructFromHistory(undoManager.getHistory());
      refreshLayerUI(); // Important: Layers might have changed
      pipeline.composite(); 
      updateHistoryButtons();
    }
  };

  // --- INPUT LOGIC ---
  setupPointer(
    canvas,
    (x, y, p, e) => {
      if (nav.isNavigating || e.buttons !== 1) return;
      currentStrokeStamps = [];
      const coords = translateCoords(e.clientX, e.clientY);
      strokeEngine.beginStroke(coords.x, coords.y, p);
    },
    (x, y, p, e) => {
      if (nav.isNavigating || e.buttons !== 1) {
        if (strokeEngine.isDrawing) strokeEngine.endStroke(x, y, p);
        return;
      }
      const events = (e as any).getCoalescedEvents?.() || [e];
      for (const ev of events) {
        const coords = translateCoords(ev.clientX, ev.clientY);
        strokeEngine.addPoint(coords.x, coords.y, ev.pressure || p);
      }
    },
    (x, y, p, e) => {
      const coords = translateCoords(e.clientX, e.clientY);
      strokeEngine.endStroke(coords.x, coords.y, p);

      const finalStamps = strokeEngine.flush();
      if (finalStamps.length > 0) {
        pipeline.draw(finalStamps);
        currentStrokeStamps.push(...finalStamps);
      }

      if (currentStrokeStamps.length > 0) {
        undoManager.push({
          type: 'stroke',
          layerIndex: pipeline.activeLayerIndex,
          stamps: new Float32Array(currentStrokeStamps)
        });
        currentStrokeStamps = []; 
      }
      updateHistoryButtons();
    }
  );

  function renderLoop() {
    if (!strokeEngine) {
      requestAnimationFrame(renderLoop);
      return;
    }
    const stamps = strokeEngine.flush();
    if (stamps.length > 0) {
      pipeline.draw(stamps); 
      if (strokeEngine.isDrawing) {
        currentStrokeStamps.push(...stamps);
      }
    }
    const prediction = strokeEngine.getPredictedStamps();
    pipeline.drawPrediction(prediction); 
    pipeline.composite(); 
    requestAnimationFrame(renderLoop);
  }

  // --- REVISED LAYER LISTENERS ---
  addLayerBtn?.addEventListener('click', async () => {
    // 1. Push to history
    undoManager.push({ 
      type: 'add-layer', 
      layerIndex: pipeline.layers.length 
    });
    // 2. Reconstruct state
    await pipeline.reconstructFromHistory(undoManager.getHistory());
    refreshLayerUI();
    pipeline.composite();
    updateHistoryButtons();
  });

  undoBtn?.addEventListener('click', handleUndo);
  redoBtn?.addEventListener('click', handleRedo);

  window.addEventListener('keydown', async (e) => {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      await handleUndo();
    }
    if ((e.ctrlKey && key === 'y') || (e.ctrlKey && e.shiftKey && key === 'z')) {
      e.preventDefault();
      await handleRedo();
    }
  });

  document.getElementById('saveBtn')?.addEventListener('click', () => pipeline.saveImage());
  
  sizeSlider?.addEventListener('input', () => {
    pipeline.updateUniforms(canvas.width, canvas.height, parseFloat(sizeSlider.value));
  });

  updateCanvasTransform();
  // Ensure we start with the first "Add Layer" in history if you want it undoable
  // Or just call refresh directly if you want the first layer to be permanent.
  

  // 1. Manually push the first layer into history so it's the base of everything
  undoManager.push({ 
    type: 'add-layer', 
    layerIndex: 0 
  });

  // 2. Run reconstruction to actually create that first layer on the GPU
  await pipeline.reconstructFromHistory(undoManager.getHistory());


  
  
  refreshLayerUI();
  updateHistoryButtons();
  renderLoop();
}

window.addEventListener('contextmenu', (e) => e.preventDefault());
start();