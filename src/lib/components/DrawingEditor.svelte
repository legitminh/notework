<script lang="ts">
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import GitHubSyncProgress from './GitHubSyncProgress.svelte';
  import EditorTitle from './EditorTitle.svelte';
  import { preserveContentFocus } from '../editor-focus';
  import { onMount } from 'svelte';
  import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, STROKE_WIDTH, drawingBottom, strokePoints, touchesStroke, type Drawing, type Point } from '../drawing';
  import { drawingGestures } from '../drawing-gestures';
  import { dragBox, roundCoordinate, selectStrokes, transformSelection, type Corner, type Selection } from '../drawing-selection';
  import { WritePermissionRequired } from '../wiki';
  import { GitHubEditCancelled } from '../github/repository';
  import { draftQueue } from '../github/storage';

  let { name, initial, initialDraft = false, onSave, onCommit, onExit, surfaceTarget, stylusOnly, onExport, autosaveMs, usingTools = $bindable(false) }: {
    name: string;
    stylusOnly: boolean;
    autosaveMs: number;
    initial: Drawing;
    initialDraft?: boolean;
    onSave: (strokes: Drawing, requestWrite: boolean) => Promise<void>;
    onCommit?: () => Promise<void>;
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
  type Gesture = { pointer: number; limit: number; before: Drawing } & (
    { kind: Tool } | { kind: 'transform'; origin: Point; selection: Selection; corner?: Corner }
  );
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
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaveAt = 0;
  let active = false;
  let canvasWidth = $state(DRAWING_WIDTH);
  const scale = $derived(canvasWidth / DRAWING_WIDTH || 1);
  const frameMinimum = $derived(64 / scale);
  const height = $derived(Math.max(drawingBottom(strokes) + DRAWING_PAGE_HEIGHT, selection?.box.bottom ?? 0));
  const canvasHeight = $derived(gesture?.limit ?? height);
  const penOnly = $derived(stylusOnly && tool !== 'lasso');
  const contour = $derived(gesture?.kind === 'lasso' ? points : selection?.contour);

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

  function sample(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const p = point(event, gesture.kind === 'transform' ? undefined : gesture.limit);
    if (!p) return;
    if (gesture.kind === 'brush' || gesture.kind === 'lasso') {
      const previous = points.at(-1);
      if (!previous || Math.hypot(p[0] - previous[0], p[1] - previous[1]) >= 1) points = [...points, p];
    } else if (gesture.kind === 'eraser') {
      const remaining = strokes.filter((stroke) => !touchesStroke(stroke, p, scale));
      if (remaining.length !== strokes.length) strokes = remaining;
    } else if (gesture.kind === 'transform') {
      const { before, selection: original, origin, limit, corner } = gesture;
      const box = dragBox(original.box, [p[0] - origin[0], p[1] - origin[1]], limit, corner, frameMinimum);
      ({ strokes, selection } = transformSelection(before, original, box));
    }
  }

  function cancelGesture() {
    if (!gesture) return;
    const { pointer, before } = gesture;
    if (gesture.kind === 'transform') selection = gesture.selection;
    strokes = before; points = []; gesture = undefined;
    if (canvas.hasPointerCapture(pointer)) canvas.releasePointerCapture(pointer);
    if (dirty && !waitingForPermission) scheduleAutosave();
  }

  function chooseTool(next: Tool) {
    if (tool === next) return;
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
    resumeEditing();
    canvas.setPointerCapture(event.pointerId);
    const common = { pointer: event.pointerId, limit: height, before: strokes };
    const target = event.target as SVGElement;
    if (selection && target.hasAttribute('data-lasso-drag')) {
      const corner = (target.getAttribute('data-lasso-drag') || undefined) as Corner | undefined;
      gesture = { ...common, kind: 'transform', origin, selection, corner };
      return;
    }
    selection = undefined;
    gesture = { ...common, kind: tool };
    sample(event);
  }

  function move(event: PointerEvent) {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (gesture.kind !== 'transform') {
      for (const item of event.getCoalescedEvents?.() ?? []) sample(item);
    }
    sample(event);
  }

  function finish(event: PointerEvent, cancel = false) {
    if (event.pointerType === 'touch') touches.delete(event.pointerId);
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (cancel) { cancelGesture(); return; }
    sample(event);
    const { before, kind, limit } = gesture;
    gesture = undefined;
    if (kind === 'lasso') selection = selectStrokes(strokes, points, frameMinimum, limit);
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
      if (event.altKey || event.isComposing || document.querySelector('.github-conflict[open], .github-reconnect[open]')) return;
      const key = event.key.toLowerCase();
      if (!(event.metaKey || event.ctrlKey)) {
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
      if (dirty || gesture) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('keydown', shortcuts, true);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      active = false;
      clearAutosave();
      resize.disconnect();
      removeGestures();
      window.removeEventListener('keydown', shortcuts, true);
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
  <Control onclick={() => onExport(strokes)} disabled={saving || publishing || !!gesture}>Export</Control>
</div>

<div class="drawing-surface" use:portal={surfaceTarget}>
  {#if !surfaceTarget}<EditorTitle {name} onEdit={usingTools ? resumeEditing : undefined} />{/if}
  <p class="muted" role="status" style:visibility={publishing ? 'hidden' : undefined}>{saving ? 'saving drawing…' : waitingForPermission ? 'autosave is waiting for write permission; exit to save' : dirty ? 'unsaved drawing changes' : githubPending ? 'drawing draft saved in this browser · Exit to sync to GitHub' : 'drawing saved'}</p>
  {#if error}<StorageNotice {error} />{/if}
  <div class="drawing-page-viewport" bind:this={pageViewport}>
    <div class="drawing-canvas-layer" bind:this={canvasLayer}>
      <svg bind:this={canvas} class:eraser={tool === 'eraser'} class="drawing-canvas" role="img" aria-label={`Drawing canvas for ${name}`} tabindex="-1"
        viewBox={`0 0 ${DRAWING_WIDTH} ${canvasHeight}`} preserveAspectRatio="xMinYMin meet"
        width={DRAWING_WIDTH} height={canvasHeight}
        style:touch-action={penOnly ? 'pan-x pan-y pinch-zoom' : 'none'} onpointerdown={begin} onpointermove={move}
        onpointerup={(event) => finish(event)} onpointercancel={(event) => finish(event, true)}
        onlostpointercapture={(event) => finish(event, true)}>
        {#each [...strokes, ...(gesture?.kind === 'brush' && points.length ? [points] : [])] as stroke}
          <polyline points={strokePoints(stroke)} fill="none" stroke="currentColor" stroke-width={STROKE_WIDTH}
            stroke-linecap="round" stroke-linejoin="round" />
        {/each}
        {#if contour?.length}
          {@const outline = strokePoints(contour)}
          <g class="lasso-contour" aria-hidden="true">
            <polygon points={outline} class="lasso-underlay" vector-effect="non-scaling-stroke" />
            <polygon points={outline} class="lasso-dashes" vector-effect="non-scaling-stroke" />
            {#if gesture?.kind === 'lasso'}
              <circle cx={contour[0][0]} cy={contour[0][1]} r={5 / scale} class="lasso-grip" vector-effect="non-scaling-stroke" />
              {#if contour.length > 1}
                {@const end = contour.at(-1)!}
                <circle cx={end[0]} cy={end[1]} r={3 / scale} class="lasso-grip lasso-end" vector-effect="non-scaling-stroke" />
              {/if}
            {/if}
          </g>
        {/if}
        {#if selection}
          {@const { left, right, top, bottom } = selection.box}
          <g aria-hidden="true">
            <rect class="lasso-frame" data-lasso-drag="" x={left} y={top} width={right - left} height={bottom - top}
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
      {#if selection && !gesture}
        <div class="lasso-clear" class:inside={selection.box.top * scale < 48}
          style:left={`clamp(40px, ${(selection.box.left + selection.box.right) / 2 / DRAWING_WIDTH * 100}%, calc(100% - 40px))`}
          style:top={`${selection.box.top / canvasHeight * 100}%`}>
          <Control onclick={clearSelection} disabled={saving || publishing} aria-label="Clear selected strokes">Clear</Control>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if publishing}<GitHubSyncProgress />{/if}

<style>
  .drawing-canvas-layer { position: relative; width: 100%; max-width: var(--page-max-width); }
  .drawing-canvas { max-width: 100%; }
  .lasso-contour { pointer-events: none; fill: none; stroke-linejoin: round; }
  .lasso-underlay { stroke: var(--background); stroke-width: 3; }
  .lasso-dashes { stroke: currentColor; stroke-width: 1.5; stroke-dasharray: 5 4; animation: march .45s linear infinite; }
  @keyframes march { to { stroke-dashoffset: -9; } }
  .lasso-frame { fill: transparent; stroke: currentColor; stroke-opacity: .5; cursor: move; }
  .lasso-grip { fill: var(--background); stroke: currentColor; stroke-width: 1.5; pointer-events: none; }
  .lasso-end { fill: currentColor; stroke: var(--background); }
  .lasso-resize { fill: transparent; }
  .lasso-resize[data-lasso-drag="nw"], .lasso-resize[data-lasso-drag="se"] { cursor: nwse-resize; }
  .lasso-resize[data-lasso-drag="ne"], .lasso-resize[data-lasso-drag="sw"] { cursor: nesw-resize; }
  .lasso-clear { position: absolute; translate: -50% calc(-100% - 4px); font-size: 14px; }
  .lasso-clear.inside { translate: -50% 4px; }
  .lasso-clear :global(button) {
    background: var(--background); color: var(--primary); border: 1px solid var(--tertiary);
    padding: 0 8px; line-height: 36px; white-space: nowrap;
  }
</style>
