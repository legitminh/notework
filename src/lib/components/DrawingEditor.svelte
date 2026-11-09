<script lang="ts">
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import GitHubSyncProgress from './GitHubSyncProgress.svelte';
  import EditorTitle from './EditorTitle.svelte';
  import { preserveContentFocus } from '../editor-focus';
  import { onMount } from 'svelte';
  import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, STROKE_WIDTH, drawingBottom, strokePoints, touchesStroke, type Drawing, type Point } from '../drawing';
  import { drawingGestures } from '../drawing-gestures';
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
  let tool = $state<'brush' | 'eraser'>('brush');
  let saving = $state(false);
  let publishing = $state(false);
  let githubPending = $state(false);
  const withDraft = draftQueue();
  let dirty = $state(false);
  let error = $state.raw<unknown>();
  let waitingForPermission = $state(false);
  let toolbar: HTMLDivElement;
  let canvas: SVGSVGElement;
  let pageViewport: HTMLDivElement;
  const touches = new Set<number>();
  let multiTouch = false;
  let gesture = $state.raw<{ pointer: number; limit: number; before: Drawing; tool: 'brush' | 'eraser' }>();
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaveAt = 0;
  let active = false;
  const height = $derived(Math.max(1, drawingBottom(strokes) + DRAWING_PAGE_HEIGHT));

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
    redoStack = [...redoStack, strokes];
    strokes = undoStack.at(-1)!;
    undoStack = undoStack.slice(0, -1);
    dirty = strokes !== saved;
    waitingForPermission = false;
  }

  function redo() {
    if (saving || publishing || gesture || !redoStack.length) return;
    undoStack = [...undoStack, strokes];
    strokes = redoStack.at(-1)!;
    redoStack = redoStack.slice(0, -1);
    dirty = strokes !== saved;
    waitingForPermission = false;
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

  export function resumeEditing() {
    usingTools = false;
    canvas.focus({ preventScroll: true });
  }

  function begin(event: PointerEvent) {
    if (event.pointerType === 'touch') {
      touches.add(event.pointerId);
      if (touches.size >= 2) { multiTouch = true; cancelStroke(); }
      if (multiTouch) return;
    }
    if (stylusOnly && event.pointerType !== 'pen') return;
    if (event.button !== 0 || gesture || saving || publishing) return;
    event.preventDefault();
    resumeEditing();
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
    // An eraser gesture can change the visible strokes before it completes.
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
          cancelStroke();
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
  <Control onclick={() => { tool = 'brush'; }} aria-pressed={tool === 'brush'}>Brush<span class="shortcut-hint" aria-hidden="true">Command+B</span></Control>
  <Control onclick={() => { tool = 'eraser'; }} aria-pressed={tool === 'eraser'}>Eraser</Control>
  <Control onclick={undo} disabled={!undoStack.length || saving || publishing}>Undo<span class="shortcut-hint" aria-hidden="true">Command+Z</span></Control>
  <Control onclick={redo} disabled={!redoStack.length || saving || publishing}>Redo<span class="shortcut-hint" aria-hidden="true">Command+Shift+Z</span></Control>
  <Control onclick={() => onExport(strokes)} disabled={saving || publishing || !!gesture}>Export</Control>
</div>

<div class="drawing-surface" use:portal={surfaceTarget}>
  {#if !surfaceTarget}<EditorTitle {name} onEdit={usingTools ? resumeEditing : undefined} />{/if}
  <p class="muted" role="status" style:visibility={publishing ? 'hidden' : undefined}>{saving ? 'saving drawing…' : waitingForPermission ? 'autosave is waiting for write permission; exit to save' : dirty ? 'unsaved drawing changes' : githubPending ? 'drawing draft saved in this browser · Exit to sync to GitHub' : 'drawing saved'}</p>
  {#if error}<StorageNotice {error} />{/if}
  <div class="drawing-page-viewport" bind:this={pageViewport}>
  <svg bind:this={canvas} class:eraser={tool === 'eraser'} class="drawing-canvas" role="img" aria-label={`Drawing canvas for ${name}`} tabindex="-1"
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

{#if publishing}<GitHubSyncProgress />{/if}
