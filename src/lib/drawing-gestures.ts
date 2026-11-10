interface GestureActions {
  stylusOnly: () => boolean;
  cancelGesture: () => void;
  endTouches: () => void;
  undo: () => void;
  redo: () => void;
}

/** Two/three-finger taps never commit the first finger's tentative stroke. */
export function drawingGestures(canvas: SVGSVGElement, layer: HTMLElement, viewport: HTMLElement, actions: GestureActions) {
  let started = 0, fingers = 0, moved = false, zoom = 1;
  const origins = new Map<number, { x: number; y: number }>();
  let previous: { x: number; y: number; distance: number } | undefined;
  const fingerTouches = (touches: TouchList) => Array.from(touches).filter((touch) =>
    (touch as Touch & { touchType?: string }).touchType !== 'stylus');
  const hasPen = (touches: TouchList) => fingerTouches(touches).length !== touches.length;
  const pair = (touches: TouchList) => {
    const [a, b] = fingerTouches(touches);
    return b ? { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) } : undefined;
  };
  function scrollVertical(delta: number) {
    for (let element = viewport.parentElement; element; element = element.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(element).overflowY)) continue;
      const before = element.scrollTop;
      element.scrollBy({ top: delta, behavior: 'instant' });
      delta -= element.scrollTop - before;
      if (Math.abs(delta) < .5) return;
    }
    document.scrollingElement?.scrollBy({ top: delta, behavior: 'instant' });
  }
  function start(event: TouchEvent) {
    // iPad also exposes Pencil contacts through Touch Events. Prevent its native
    // pan behavior without treating the Pencil as one of the gesture fingers.
    if (hasPen(event.touches) && event.cancelable) event.preventDefault();
    const contacts = fingerTouches(event.touches);
    if (!contacts.length) return;
    if (!fingers) { started = performance.now(); moved = false; origins.clear(); }
    fingers = Math.max(fingers, contacts.length);
    for (const touch of fingerTouches(event.changedTouches)) origins.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    previous = pair(event.touches);
    if (fingers >= 2) {
      actions.cancelGesture();
      if ((!actions.stylusOnly() || fingers >= 3) && event.cancelable) event.preventDefault();
    }
  }
  function move(event: TouchEvent) {
    if (hasPen(event.touches) && event.cancelable) event.preventDefault();
    for (const touch of fingerTouches(event.touches)) {
      const origin = origins.get(touch.identifier);
      if (origin && Math.hypot(touch.clientX - origin.x, touch.clientY - origin.y) > 12) moved = true;
    }
    const current = pair(event.touches);
    // In stylus-only mode fingers use the browser's native pan/pinch handling.
    if (!current || actions.stylusOnly()) return;
    if (event.cancelable) event.preventDefault();
    if (previous && moved && fingerTouches(event.touches).length === 2) {
      const nextZoom = Math.max(1, Math.min(4, zoom * current.distance / Math.max(1, previous.distance)));
      const factor = nextZoom / zoom;
      const rect = canvas.getBoundingClientRect();
      const anchorX = previous.x - rect.left;
      const anchorY = previous.y - rect.top;
      const left = viewport.scrollLeft;
      layer.style.width = `${nextZoom * 100}%`;
      layer.style.maxWidth = 'none';
      viewport.scrollLeft = left + anchorX * (factor - 1) - (current.x - previous.x);
      scrollVertical(anchorY * (factor - 1) - (current.y - previous.y));
      zoom = nextZoom;
    }
    previous = current;
  }
  function end(event: TouchEvent) {
    previous = pair(event.touches);
    if (fingerTouches(event.touches).length) return;
    if (!moved && performance.now() - started < 350) {
      if ((fingers === 2 || fingers === 3) && event.cancelable) event.preventDefault();
      if (fingers === 2) actions.undo();
      else if (fingers === 3) actions.redo();
    }
    fingers = 0; origins.clear(); actions.endTouches();
  }
  function cancel() {
    fingers = 0; previous = undefined; origins.clear(); actions.cancelGesture(); actions.endTouches();
  }
  canvas.addEventListener('touchstart', start, { passive: false });
  canvas.addEventListener('touchmove', move, { passive: false });
  canvas.addEventListener('touchend', end);
  canvas.addEventListener('touchcancel', cancel);
  return () => {
    canvas.removeEventListener('touchstart', start);
    canvas.removeEventListener('touchmove', move);
    canvas.removeEventListener('touchend', end);
    canvas.removeEventListener('touchcancel', cancel);
  };
}
