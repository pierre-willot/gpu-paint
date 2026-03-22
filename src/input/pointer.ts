// input/pointer.ts
export function setupPointer(
  canvas: HTMLCanvasElement,
  onBegin: (x: number, y: number, p: number, e: PointerEvent) => void,
  onMove: (x: number, y: number, p: number, e: PointerEvent) => void,
  onEnd: (x: number, y: number, p: number, e: PointerEvent) => void
) {
  // Mouse pressure is always 0.5 per the Pointer Events spec — treat as full pressure.
  const p = (e: PointerEvent) => e.pointerType === 'mouse' ? 1.0 : e.pressure;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    onBegin(e.clientX, e.clientY, p(e), e);
  });

  canvas.addEventListener('pointermove', (e) => {
    onMove(e.clientX, e.clientY, p(e), e);
  });

  canvas.addEventListener('pointerup', (e) => {
    canvas.releasePointerCapture(e.pointerId);
    onEnd(e.clientX, e.clientY, p(e), e);
  });
}