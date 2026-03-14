// input/pointer.ts
export function setupPointer(
  canvas: HTMLCanvasElement,
  onBegin: (x: number, y: number, p: number, e: PointerEvent) => void,
  onMove: (x: number, y: number, p: number, e: PointerEvent) => void,
  onEnd: (x: number, y: number, p: number, e: PointerEvent) => void
) {
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    // Use clientX/Y so translateCoords in main.ts works correctly
    onBegin(e.clientX, e.clientY, e.pressure, e); 
  });

  canvas.addEventListener('pointermove', (e) => {
    onMove(e.clientX, e.clientY, e.pressure, e);
  });

  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    onEnd(e.clientX, e.clientY, e.pressure, e);
  });
}