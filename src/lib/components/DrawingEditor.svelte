<script lang="ts">
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import EditorTitle from './EditorTitle.svelte';
  import { preserveContentFocus } from '../editor-focus';
  import { onMount } from 'svelte';
  import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, STROKE_WIDTH, drawingBottom, strokePoints, touchesStroke, type Drawing, type Point } from '../drawing';
  import { drawingGestures } from '../drawing-gestures';
  import { areaPath, dragBox, growSelection, roundCoordinate, transformSelection, type Corner, type Selection } from '../drawing-selection';
  import { WritePermissionRequired } from '../wiki';
  import { GitHubEditCancelled } from '../github/repository';
  import { draftQueue } from '../github/storage';

  let { name, initial, initialDraft = false, onSave, onCommit, onDelete, onExit, backgroundHref, foregroundHref, imageHeight, strokeOpacity = 1, surfaceTarget, stylusOnly, onExport, autosaveMs, usingTools = $bindable(false) }: {
    name: string;
    backgroundHref?: string;
    foregroundHref?: string;
    imageHeight?: number;
    strokeOpacity?: number;
    stylusOnly: boolean;
    autosaveMs: number;
    initial: Drawing;
    initialDraft?: boolean;
    onSave: (strokes: Drawing, requestWrite: boolean) => Promise<void>;
    onCommit?: () => Promise<void>;
    onDelete?: () => void | Promise<void>;
    onExport: (strokes: Drawing) => void;
    onExit: () => void | Promise<void>;
    surfaceTarget?: HTMLElement;
    usingTools?: boolean;
  } = $props();

  let strokes = $state.raw<Drawing>([]);
  let saved: Drawing = [];
  let undoStack = $state.raw<Drawing[]>([]);
  let redoStack = $state.raw<Drawing[]>([]);
  let points = $state.raw<Point[]>([]);
  type Tool = 'brush' | 'eraser' | 'lasso';
  type Gesture = { input: number | string; limit: number; before: Drawing } & (
    { kind: Tool } | { kind: 'transform'; origin?: Point; selection: Selection; corner?: Corner }
  );
  const moveKey = 'm';
  const corners: Corner[] = ['nw', 'ne', 'sw', 'se'];
  let tool = $state<Tool>('brush');
  let selection = $state.raw<Selection>();
  let saving = $state(false);
  let publishing = $state(false);
  let githubPending = $state(false);
  const withDraft = draftQueue();
  let dirty = $state(false);
  let error = $state.raw<unknown>();
  let waitingForPermission = $state(false);
  let toolbar: HTMLDivElement;
  let canvas: SVGSVGElement;
  let canvasLayer: HTMLDivElement;
  let pageViewport: HTMLDivElement;
  const touches = new Set<number>();
  let multiTouch = false;
  let gesture = $state.raw<Gesture>();
  let mouse: PointerEvent | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaveAt = 0;
  let active = false;
  let canvasWidth = $state(DRAWING_WIDTH);
  const scale = $derived(canvasWidth / DRAWING_WIDTH || 1);
  const frameMinimum = $derived(64 / scale);
  const height = $derived(imageHeight ?? Math.max(drawingBottom(strokes) + DRAWING_PAGE_HEIGHT, selection?.box.bottom ?? 0));
  const canvasHeight = $derived(gesture?.limit ?? height);
  const penOnly = $derived(stylusOnly && tool !== 'lasso');
  const outline = $derived(selection ? areaPath(selection.area) : '');
  const tracing = $derived(gesture?.kind === 'lasso');
  const moving = $derived(gesture?.kind === 'transform' && !gesture.corner);

  function portal(element: HTMLElement, target?: HTMLElement) {
    if (!target) return;
    const placeholder = document.createComment('inline drawing portal');
    element.before(placeholder);
    target.append(element);
    return { destroy() {
      // Put the Svelte-owned node back beside its block marker before unmount.
      // Removing a portalled root in place can make Svelte consume the text
      // editor siblings that follow the component.
      placeholder.before(element);
      placeholder.remove();
    } };
  }

  function commit(before: Drawing, after: Drawing) {
    if (before === after) return;
    undoStack = [...undoStack, before].slice(-100);
    redoStack = [];
    strokes = after;
    dirty = strokes !== saved;
    waitingForPermission = false;
  }

  function undo() {
    if (saving || publishing || gesture || !undoStack.length) return;
    selection = undefined;
    redoStack = [...redoStack, strokes];
    strokes = undoStack.at(-1)!;
    undoStack = undoStack.slice(0, -1);
    dirty = strokes !== saved;
    waitingForPermission = false;
  }

  function redo() {
    if (saving || publishing || gesture || !redoStack.length) return;
    selection = undefined;
    undoStack = [...undoStack, strokes];
    strokes = redoStack.at(-1)!;
    redoStack = redoStack.slice(0, -1);
    dirty = strokes !== saved;
    waitingForPermission = false;
  }

  function point(event: PointerEvent, limit?: number): Point | undefined {
    const matrix = canvas.getScreenCTM();
    if (!matrix) return;
    const position = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    if (limit === undefined) return [roundCoordinate(position.x), roundCoordinate(position.y)];
    return [roundCoordinate(Math.max(0, Math.min(DRAWING_WIDTH, position.x))),
      roundCoordinate(Math.max(0, Math.min(limit, position.y)))];
  }

  function startTransform(input: number | string, origin?: Point, corner?: Corner) {
    if (!selection?.indices.size || gesture || saving || publishing) return;
    resumeEditing();
    if (typeof input === 'number') canvas.setPointerCapture(input);
    gesture = { input, limit: height, before: strokes, kind: 'transform', origin, selection, corner };
  }

  function applyTransform(p: Point) {
    if (gesture?.kind !== 'transform') return;
    const { before, selection: original, origin, limit, corner } = gesture;
    if (!origin) {
      gesture = { ...gesture, origin: p };
      return;
    }
    const box = dragBox(original.box, [p[0] - origin[0], p[1] - origin[1]], limit, corner, frameMinimum);
    ({ strokes, selection } = transformSelection(before, original, box));
  }

  function sample(event: PointerEvent, final = false) {
    if (!gesture || event.pointerId !== gesture.input) return;
    const p = point(event, gesture.kind === 'transform' ? undefined : gesture.limit);
    if (!p) return;
    if (gesture.kind === 'brush' || gesture.kind === 'lasso') {
      const previous = points.at(-1);
      const distance = previous ? Math.hypot(p[0] - previous[0], p[1] - previous[1]) : Infinity;
      if (distance >= 1 || (final && gesture.kind === 'lasso' && distance > 0)) points = [...points, p];
    } else if (gesture.kind === 'eraser') {
      const remaining = strokes.filter((stroke) => !touchesStroke(stroke, p, scale));
      if (remaining.length !== strokes.length) strokes = remaining;
    } else applyTransform(p);
  }

  function cancelGesture() {
    if (!gesture) return;
    const { input, before } = gesture;
    if (gesture.kind === 'transform') selection = gesture.selection;
    strokes = before; points = []; gesture = undefined;
    if (typeof input === 'number' && canvas.hasPointerCapture(input)) canvas.releasePointerCapture(input);
    if (dirty && !waitingForPermission) scheduleAutosave();
  }

  function chooseTool(next: Tool) {
    if (tool === next && next !== 'lasso') return;
    cancelGesture();
    selection = undefined;
    tool = next;
  }

  function clearSelection() {
    if (!selection || gesture || saving || publishing) return;
    const { indices } = selection;
    resumeEditing();
    selection = undefined;
    commit(strokes, strokes.filter((_, i) => !indices.has(i)));
    scheduleAutosave();
  }

  export function resumeEditing() {
    usingTools = false;
    canvas.focus({ preventScroll: true });
  }

  function beginMoveButton(event: PointerEvent) {
    if (event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('button:not(:disabled)')) return;
    const origin = point(event);
    if (!origin) return;
    event.preventDefault();
    startTransform(event.pointerId, origin);
  }

  function dragFromButton(element: HTMLElement) {
    element.addEventListener('pointerdown', beginMoveButton);
    return { destroy: () => element.removeEventListener('pointerdown', beginMoveButton) };
  }

  function begin(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      touches.add(event.pointerId);
      if (touches.size >= 2) { multiTouch = true; cancelGesture(); }
      if (multiTouch) return;
    }
    if (penOnly && event.pointerType !== 'pen') return;
    if (event.button !== 0 || gesture || saving || publishing) return;
    const origin = point(event);
    if (!origin) return;
    event.preventDefault();
    const target = event.target as SVGElement;
    if (selection && target.hasAttribute('data-lasso-drag')) {
      const corner = (target.getAttribute('data-lasso-drag') || undefined) as Corner | undefined;
      startTransform(event.pointerId, origin, corner);
      return;
    }
    resumeEditing();
    canvas.setPointerCapture(event.pointerId);
    gesture = { input: event.pointerId, limit: height, before: strokes, kind: tool };
    sample(event);
  }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.input) return;
    if (gesture.kind !== 'transform') {
      for (const item of event.getCoalescedEvents?.() ?? []) sample(item);
    }
    sample(event);
  }

  function finish(event: PointerEvent, cancel = false) {
    if (event.pointerType === 'touch') touches.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.input) return;
    if (cancel) { cancelGesture(); return; }
    sample(event, true);
    finishGesture();
  }

  function finishGesture() {
    if (!gesture) return;
    const { before, kind, limit } = gesture;
    gesture = undefined;
    if (kind === 'lasso') selection = growSelection(strokes, points, frameMinimum, limit, selection);
    else commit(before, kind === 'brush' && points.length ? [...strokes, points] : strokes);
    points = [];
    if (dirty) scheduleAutosave();
  }

  function clearAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }

  function scheduleAutosave() {
    clearAutosave();
    if (!active || !dirty || saving || publishing || gesture) return;
    const delay = Math.max(0, lastSaveAt + autosaveMs - Date.now());
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined;
      void save(false, false);
    }, delay);
  }

  async function save(exit = false, requestWrite = true) {
    if (gesture || publishing) return;
    if (exit && onCommit && (dirty || githubPending)) {
      await publish(onCommit);
      return;
    }
    if (saving) return;
    if (!dirty) {
      if (exit) await onExit();
      return;
    }
    clearAutosave();
    saving = true;
    if (requestWrite || !onCommit) error = '';
    try {
      if (onCommit) await withDraft(() => saveSnapshot(requestWrite));
      else await saveSnapshot(requestWrite);
      if (exit) await onExit();
    } catch (cause) {
      lastSaveAt = Date.now();
      if (cause instanceof WritePermissionRequired) waitingForPermission = true;
      else if (!(cause instanceof GitHubEditCancelled)) error = cause;
    } finally {
      saving = false;
      if (dirty && !waitingForPermission) scheduleAutosave();
    }
  }

  async function saveSnapshot(requestWrite: boolean) {
    // Erasing and transforming can change the visible strokes before the gesture completes.
    const snapshot = gesture?.before ?? strokes;
    if (snapshot !== saved) {
      await onSave(snapshot, requestWrite);
      if (onCommit) githubPending = true;
    }
    saved = snapshot;
    dirty = (gesture?.before ?? strokes) !== saved;
    waitingForPermission = false;
    lastSaveAt = Date.now();
  }

  async function publish(commit: NonNullable<typeof onCommit>) {
    publishing = true; error = '';
    clearAutosave();
    try {
      await withDraft(() => saveSnapshot(true));
      await commit();
      githubPending = false;
      if (active) await onExit();
    } catch (cause) {
      if (!(cause instanceof GitHubEditCancelled)) error = cause;
    } finally {
      publishing = false;
      if (dirty) scheduleAutosave();
    }
  }

  export async function saveForNavigation(publish = true) {
    if (saving || publishing || gesture) return false;
    await save(false, false);
    if (dirty) return false;
    if (onCommit && publish) {
      try { await onCommit(); } catch (cause) { error = cause; return false; }
    }
    return true;
  }

  function exit() {
    void save(true, true);
  }

  $effect(() => {
    autosaveMs;
    dirty;
    if (dirty && !waitingForPermission) scheduleAutosave();
    else if (!dirty) clearAutosave();
  });

  onMount(() => {
    active = true;
    strokes = initial;
    saved = initial;
    githubPending = initialDraft;
    lastSaveAt = Date.now();
    const shortcuts = (event: KeyboardEvent) => {
      if (event.altKey || event.isComposing || document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey)) {
        const input = event.code || key;
        const target = event.target;
        const textInput = target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'));
        const focusedMove = (key === ' ' || key === 'enter') &&
          (gesture?.input === input || (target instanceof Element && target.closest('.lasso-move')));
        if ((key === moveKey || focusedMove) && selection?.indices.size && !textInput &&
            !event.defaultPrevented && !document.querySelector('dialog[open]')) {
          if (focusedMove) event.preventDefault();
          if (!event.repeat) startTransform(input, mouse && point(mouse));
          return;
        }
        if (key !== 'escape' || event.shiftKey || usingTools || document.querySelector('dialog[open]')) return;
        event.preventDefault();
        if (!event.repeat) {
          cancelGesture();
          selection = undefined;
          usingTools = true;
          toolbar.focus({ preventScroll: true });
        }
        return;
      }
      if (!['b', 's', 'z', 'y', 'escape'].includes(key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat || document.querySelector('dialog[open][aria-labelledby="export-heading"]')) return;
      if (key === 's') void save(false, true);
      else if (key === 'b') chooseTool('brush');
      else if (key === 'escape') exit();
      else if (key === 'y' || event.shiftKey) redo();
      else undo();
    };
    const removeGestures = drawingGestures(canvas, canvasLayer, pageViewport, {
      stylusOnly: () => penOnly, cancelGesture,
      endTouches: () => { touches.clear(); multiTouch = false; }, undo, redo
    });
    canvasWidth = canvas.getBoundingClientRect().width;
    const resize = new ResizeObserver(() => {
      const nextWidth = canvas.getBoundingClientRect().width;
      if (Math.abs(nextWidth - canvasWidth) > .5) cancelGesture();
      canvasWidth = nextWidth;
    });
    resize.observe(canvas);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty || gesture || (publishing && githubPending)) { event.preventDefault(); event.returnValue = ''; }
    };
    const trackMouse = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      mouse = event;
      if (typeof gesture?.input !== 'string') return;
      const p = point(event);
      if (p) applyTransform(p);
    };
    const releaseKey = (event: KeyboardEvent) => {
      if (gesture?.input === (event.code || event.key.toLowerCase())) finishGesture();
    };
    const loseFocus = () => {
      mouse = undefined;
      if (typeof gesture?.input === 'string') cancelGesture();
    };
    window.addEventListener('keydown', shortcuts, true);
    window.addEventListener('keyup', releaseKey, true);
    window.addEventListener('pointermove', trackMouse, { passive: true });
    window.addEventListener('blur', loseFocus);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      active = false;
      clearAutosave();
      resize.disconnect();
      removeGestures();
      window.removeEventListener('keydown', shortcuts, true);
      window.removeEventListener('keyup', releaseKey, true);
      window.removeEventListener('pointermove', trackMouse);
      window.removeEventListener('blur', loseFocus);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  });
</script>

<div class="editor-controls drawing-controls" role="group" aria-label="Drawing toolbar" tabindex="-1" bind:this={toolbar}
  use:preserveContentFocus={() => !usingTools && document.activeElement === canvas}>
  <Control onclick={exit} disabled={saving || publishing}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></Control>
  <Control onclick={() => chooseTool('brush')} aria-pressed={tool === 'brush'}>Brush<span class="shortcut-hint" aria-hidden="true">Command+B</span></Control>
  <Control onclick={() => chooseTool('eraser')} aria-pressed={tool === 'eraser'}>Eraser</Control>
  <Control onclick={() => chooseTool('lasso')} aria-pressed={tool === 'lasso'}>Lasso</Control>
  <Control onclick={undo} disabled={!undoStack.length || saving || publishing}>Undo<span class="shortcut-hint" aria-hidden="true">Command+Z</span></Control>
  <Control onclick={redo} disabled={!redoStack.length || saving || publishing}>Redo<span class="shortcut-hint" aria-hidden="true">Command+Shift+Z</span></Control>
  {#if onDelete}<Control onclick={() => { cancelGesture(); void onDelete?.(); }} disabled={saving || publishing}>Delete drawing</Control>{/if}
  <Control onclick={() => onExport(strokes)} disabled={saving || publishing || !!gesture}>Export</Control>
</div>

<div class="drawing-surface" use:portal={surfaceTarget}>
  {#if !surfaceTarget}<EditorTitle {name} onEdit={usingTools ? resumeEditing : undefined} />{/if}
  <p class="muted" role="status" style:visibility={publishing ? 'hidden' : undefined}>{saving ? 'saving drawing…' : waitingForPermission ? 'autosave is waiting for write permission; exit to save' : dirty ? 'unsaved drawing changes' : githubPending ? 'drawing draft saved in this browser · Exit to sync to GitHub' : 'drawing saved'}</p>
  {#if error}<StorageNotice {error} />{/if}
  <div class="drawing-page-viewport" bind:this={pageViewport}>
    <div class="drawing-canvas-layer" bind:this={canvasLayer}>
      <svg bind:this={canvas} class:image-canvas={!!backgroundHref} class:eraser={tool === 'eraser'} class:moving class="drawing-canvas" role="img" aria-label={`Drawing canvas for ${name}`} tabindex="-1"
        viewBox={`0 0 ${DRAWING_WIDTH} ${canvasHeight}`} preserveAspectRatio="xMinYMin meet"
        width={DRAWING_WIDTH} height={canvasHeight}
        style:touch-action={penOnly ? 'pan-x pan-y pinch-zoom' : 'none'} onpointerdown={begin} onpointermove={move}
        onpointerup={(event) => finish(event)} onpointercancel={(event) => finish(event, true)}
        onlostpointercapture={(event) => finish(event, true)}>
        {#if backgroundHref}<image href={backgroundHref} width={DRAWING_WIDTH} height={imageHeight} pointer-events="none" />{/if}
        {#each [...strokes, ...(gesture?.kind === 'brush' && points.length ? [points] : [])] as stroke, index}
          <polyline points={strokePoints(stroke)} fill="none" stroke="currentColor" opacity={strokeOpacity} stroke-width={STROKE_WIDTH}
            stroke-linecap="round" stroke-linejoin="round" data-lasso-drag={selection?.indices.has(index) && !tracing ? '' : undefined} />
        {/each}
        {#if foregroundHref}<image href={foregroundHref} width={DRAWING_WIDTH} height={imageHeight} pointer-events="none" />{/if}
        {#if outline}
          <g class="lasso-area" aria-hidden="true">
            <path d={outline} class="lasso-underlay" vector-effect="non-scaling-stroke" />
            <path d={outline} class="lasso-dashes" vector-effect="non-scaling-stroke" />
          </g>
        {/if}
        {#if tracing && points.length}
          {@const draft = strokePoints(points)}
          <g class="lasso-contour" aria-hidden="true">
            <polygon points={draft} class="lasso-underlay" vector-effect="non-scaling-stroke" />
            <polygon points={draft} class="lasso-dashes" vector-effect="non-scaling-stroke" />
            <circle cx={points[0][0]} cy={points[0][1]} r={5 / scale} class="lasso-grip" vector-effect="non-scaling-stroke" />
            {#if points.length > 1}
              {@const end = points.at(-1)!}
              <circle cx={end[0]} cy={end[1]} r={3 / scale} class="lasso-grip lasso-end" vector-effect="non-scaling-stroke" />
            {/if}
          </g>
        {/if}
        {#if selection?.indices.size && !tracing}
          {@const { left, right, top, bottom } = selection.box}
          <g aria-hidden="true">
            <rect class="lasso-frame" x={left} y={top} width={right - left} height={bottom - top}
              vector-effect="non-scaling-stroke" />
            <rect class="lasso-move-zone" data-lasso-drag="" x={left} y={top} width={right - left} height={bottom - top}
              vector-effect="non-scaling-stroke" />
            {#each corners as corner}
              {@const x = corner[1] === 'w' ? left : right}
              {@const y = corner[0] === 'n' ? top : bottom}
              <circle data-lasso-drag={corner} class="lasso-resize" cx={x} cy={y} r={14 / scale} />
              <circle class="lasso-grip" cx={x} cy={y} r={5 / scale} vector-effect="non-scaling-stroke" />
            {/each}
          </g>
        {/if}
      </svg>
      {#if selection?.indices.size && !tracing}
        <div class="lasso-actions" class:inside={selection.box.top * scale < 48} class:moving
          style:left={`clamp(72px, ${(selection.box.left + selection.box.right) / 2 / DRAWING_WIDTH * 100}%, calc(100% - 72px))`}
          style:top={`${selection.box.top / canvasHeight * 100}%`}>
          <Control onclick={clearSelection} disabled={saving || publishing || !!gesture} aria-label="Clear selected strokes">Clear</Control>
          <span class="lasso-move" use:dragFromButton title="Hold and drag, or hold M and move the mouse">
            <Control keys={moveKey} onclick={resumeEditing} disabled={saving || publishing}
              aria-label="Move selected strokes" aria-keyshortcuts="M">Move</Control>
          </span>
        </div>
      {/if}
    </div>
  </div>
</div>



<style>
  .drawing-canvas-layer { position: relative; width: 100%; max-width: var(--page-max-width); }
  .drawing-canvas { max-width: 100%; }
  .drawing-canvas.image-canvas { background-image: conic-gradient(#ddd 25%, #fff 0 50%, #ddd 0 75%, #fff 0); background-size: 16px 16px; color: #202733; }
  .lasso-contour, .lasso-area { pointer-events: none; fill: none; stroke-linejoin: round; }
  .lasso-underlay { stroke: var(--background); stroke-width: 3; }
  .lasso-dashes { stroke: currentColor; stroke-width: 1.5; stroke-dasharray: 5 4; animation: march .45s linear infinite; }
  @keyframes march { to { stroke-dashoffset: -9; } }
  .lasso-frame { fill: none; stroke: currentColor; stroke-opacity: .5; pointer-events: none; }
  .lasso-move-zone { fill: none; stroke: transparent; stroke-width: 18px; pointer-events: stroke; }
  .lasso-move-zone, polyline[data-lasso-drag] { cursor: move; }
  .lasso-grip { fill: var(--background); stroke: currentColor; stroke-width: 1.5; pointer-events: none; }
  .lasso-end { fill: currentColor; stroke: var(--background); }
  .lasso-resize { fill: transparent; }
  .lasso-resize[data-lasso-drag="nw"], .lasso-resize[data-lasso-drag="se"] { cursor: nwse-resize; }
  .lasso-resize[data-lasso-drag="ne"], .lasso-resize[data-lasso-drag="sw"] { cursor: nesw-resize; }
  .lasso-actions {
    position: absolute; translate: -50% calc(-100% - 4px); font-size: 14px; display: flex; gap: 4px;
  }
  .lasso-actions.inside { translate: -50% 4px; }
  .lasso-actions :global(button) {
    background: var(--background); color: var(--primary); border: 1px solid var(--tertiary);
    padding: 0 8px; line-height: 36px; white-space: nowrap;
  }
  .lasso-move { display: inline-flex; touch-action: none; }
  .lasso-move :global(button) { cursor: grab; }
  .drawing-canvas.moving, .drawing-canvas.moving [data-lasso-drag], .moving .lasso-move :global(button) { cursor: grabbing; }
  .moving .lasso-move :global(button) { outline: 2px solid var(--primary); outline-offset: -2px; }
</style>
