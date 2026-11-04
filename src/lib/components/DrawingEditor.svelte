<script lang="ts">
  import { onMount } from 'svelte';
  import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, STROKE_WIDTH, drawingBottom, strokePoints, touchesStroke, type Drawing, type Point } from '../drawing';
  import { drawingGestures } from '../drawing-gestures';
  import { storageError } from '../browser-documents';

  let { name, initial, onSave, onExit, surfaceTarget, stylusOnly, onExport }: {
    name: string;
    stylusOnly: boolean;
    initial: Drawing;
    onSave: (strokes: Drawing) => Promise<void>;
    onExport: (strokes: Drawing) => void;
    onExit: () => void;
    surfaceTarget?: HTMLElement;
  } = $props();

  let strokes = $state.raw<Drawing>([]);
  let saved: Drawing = [];
  let undoStack = $state.raw<Drawing[]>([]);
  let redoStack = $state.raw<Drawing[]>([]);
  let points = $state.raw<Point[]>([]);
  let tool = $state<'brush' | 'eraser'>('brush');
  let saving = $state(false);
  let dirty = $state(false);
  let error = $state('');
  let canvas: SVGSVGElement;
  let exitDialog: HTMLDialogElement;
  let pageViewport: HTMLDivElement;
  const touches = new Set<number>();
  let multiTouch = false;
  let gesture = $state.raw<{ pointer: number; limit: number; before: Drawing; tool: 'brush' | 'eraser' }>();
  const height = $derived(Math.max(1, drawingBottom(strokes) + DRAWING_PAGE_HEIGHT));

  function portal(element: HTMLElement, target?: HTMLElement) {
    if (!target) return;
    target.append(element);
    return { destroy() { element.remove(); } };
  }

  function commit(before: Drawing, after: Drawing) {
    if (before === after) return;
    undoStack = [...undoStack, before].slice(-100);
    redoStack = [];
    strokes = after;
    dirty = strokes !== saved;
  }

  function undo() {
    if (saving || gesture || !undoStack.length) return;
    redoStack = [...redoStack, strokes];
    strokes = undoStack.at(-1)!;
    undoStack = undoStack.slice(0, -1);
    dirty = strokes !== saved;
  }

  function redo() {
    if (saving || gesture || !redoStack.length) return;
    undoStack = [...undoStack, strokes];
    strokes = redoStack.at(-1)!;
    redoStack = redoStack.slice(0, -1);
    dirty = strokes !== saved;
  }

  function point(event: PointerEvent, limit: number): Point | undefined {
    const matrix = canvas.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    const round = (value: number) => Math.round(value * 100) / 100;
    return [round(Math.max(0, Math.min(DRAWING_WIDTH, position.x))),
      round(Math.max(0, Math.min(limit, position.y)))] as Point;
  }

  function sample(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const p = point(event, gesture.limit);
    if (!p) return;
    if (gesture.tool === 'brush') {
      const previous = points.at(-1);
      if (!previous || Math.hypot(p[0] - previous[0], p[1] - previous[1]) >= 1) points = [...points, p];
    } else {
      const scale = canvas.getBoundingClientRect().width / DRAWING_WIDTH;
      const remaining = strokes.filter((stroke) => !touchesStroke(stroke, p, scale));
      if (remaining.length !== strokes.length) strokes = remaining;
    }
  }

  function cancelStroke() {
    if (!gesture) return;
    const pointer = gesture.pointer;
    strokes = gesture.before; points = []; gesture = undefined;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
  }

  function begin(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      touches.add(event.pointerId);
      if (touches.size >= 2) { multiTouch = true; cancelStroke(); }
      if (multiTouch) return;
    }
    if (stylusOnly && event.pointerType !== 'pen') return;
    if (event.button !== 0 || gesture || saving) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    gesture = { pointer: event.pointerId, limit: height, before: strokes, tool };
    sample(event);
  }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    for (const item of event.getCoalescedEvents?.() ?? []) sample(item);
    sample(event);
  }

  function finish(event: PointerEvent, cancel = false) {
    if (event.pointerType === 'touch') touches.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (!cancel) sample(event);
    const { before, tool } = gesture;
    gesture = undefined;
    if (cancel) strokes = before;
    else commit(before, tool === 'brush' && points.length ? [...strokes, points] : strokes);
    points = [];
  }

  async function save(exit = false) {
    if (saving || gesture) return;
    saving = true; error = '';
    try {
      await onSave(strokes);
      saved = strokes; dirty = false;
      if (exit) onExit();
    } catch (cause) {
      error = storageError(cause);
      if (exitDialog.open) exitDialog.close();
    } finally { saving = false; }
  }

  function exit() {
    if (saving || gesture || exitDialog.open) return;
    if (dirty) exitDialog.showModal();
    else onExit();
  }

  onMount(() => {
    strokes = initial;
    saved = initial;
    const shortcuts = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
      const key = event.key.toLowerCase();
      if (!['b', 's', 'z', 'y', 'escape'].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || exitDialog.open || document.querySelector('dialog[open][aria-labelledby="export-heading"]')) return;
      if (key === 's') void save();
      else if (key === 'b') tool = 'brush';
      else if (key === 'escape') exit();
      else if (key === 'y' || event.shiftKey) redo();
      else undo();
    };
    const removeGestures = drawingGestures(canvas, pageViewport, {
      stylusOnly: () => stylusOnly, cancelStroke,
      endTouches: () => { touches.clear(); multiTouch = false; }, undo, redo
    });
    let width = canvas.getBoundingClientRect().width;
    const resize = new ResizeObserver(() => {
      const nextWidth = canvas.getBoundingClientRect().width;
      if (Math.abs(nextWidth - width) > .5 && gesture) {
        cancelStroke();
      }
      width = nextWidth;
    });
    resize.observe(canvas);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || gesture) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', shortcuts, true);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      resize.disconnect();
      removeGestures();
      window.removeEventListener('keydown', shortcuts, true);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });
</script>

<div class="editor-controls drawing-controls" role="group" aria-label="Drawing toolbar">
  <button type="button" onclick={exit} disabled={saving}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></button>
  <button type="button" onclick={() => save()} disabled={saving}>Save<span class="shortcut-hint" aria-hidden="true">Command+S</span></button>
  <button type="button" onclick={() => { tool = 'brush'; }} aria-pressed={tool === 'brush'}>Brush<span class="shortcut-hint" aria-hidden="true">Command+B</span></button>
  <button type="button" onclick={() => { tool = 'eraser'; }} aria-pressed={tool === 'eraser'}>Eraser</button>
  <button type="button" onclick={undo} disabled={!undoStack.length || saving}>Undo<span class="shortcut-hint" aria-hidden="true">Command+Z</span></button>
  <button type="button" onclick={redo} disabled={!redoStack.length || saving}>Redo<span class="shortcut-hint" aria-hidden="true">Command+Shift+Z</span></button>
  <button type="button" onclick={() => onExport(strokes)} disabled={saving || !!gesture}>Export</button>
</div>

<div class="drawing-surface" use:portal={surfaceTarget}>
  {#if !surfaceTarget}<h1>{name}</h1>{/if}
  <p class="muted" role="status">{saving ? 'saving drawing…' : dirty ? 'unsaved drawing changes' : ''}</p>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="drawing-page-viewport" bind:this={pageViewport}>
  <svg bind:this={canvas} class:eraser={tool === 'eraser'} class="drawing-canvas" role="img" aria-label={`Drawing canvas for ${name}`}
    viewBox={`0 0 ${DRAWING_WIDTH} ${gesture?.limit ?? height}`} preserveAspectRatio="xMinYMin meet"
    width={DRAWING_WIDTH} height={gesture?.limit ?? height}
    style:touch-action={stylusOnly ? 'pan-x pan-y pinch-zoom' : 'none'} onpointerdown={begin} onpointermove={move}
    onpointerup={(event) => finish(event)} onpointercancel={(event) => finish(event, true)}
    onlostpointercapture={(event) => finish(event, true)}>
    {#each [...strokes, ...(points.length ? [points] : [])] as stroke}
      <polyline points={strokePoints(stroke)} fill="none" stroke="currentColor" stroke-width={STROKE_WIDTH}
        stroke-linecap="round" stroke-linejoin="round" />
    {/each}
  </svg>
  </div>
</div>

<dialog class="local-picker editor-exit" bind:this={exitDialog} aria-labelledby="drawing-exit-title"
  oncancel={(event) => { if (saving) event.preventDefault(); }}>
  <h2 id="drawing-exit-title">Save drawing before exiting?</h2>
  <div class="editor-controls">
    <button type="button" onclick={() => save(true)} disabled={saving}>Save and exit</button>
    <button type="button" onclick={onExit} disabled={saving}>Don’t save</button>
    <button type="button" onclick={() => exitDialog.close()} disabled={saving}>Cancel</button>
  </div>
</dialog>
