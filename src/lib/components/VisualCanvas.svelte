<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { get_input_frame, active_input_frame, min_box, SubKeyframe, VerticalHoverSlider, type SubKeyframeController } from '@legitminh/keyflow';
  import { CanvasRenderer, InputController, ViewTransform, fromPointerEvent, sanitizeBrush, BRUSH_IMPORT_EXTENSIONS,
    type VisualEditor, type Brush, type Rect, type Tool } from 'visual.editor';
  import Control from './Control.svelte';
  import ColorWheel from './ColorWheel.svelte';
  import ChoiceMenu from './ChoiceMenu.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import EditorTitle from './EditorTitle.svelte';
  import { preserveContentFocus } from '../editor-focus';
  import { shortcutScope } from '../shortcut-scope.svelte';
  import { WritePermissionRequired } from '../wiki';
  import { GitHubEditCancelled } from '../github/repository';
  import { draftQueue } from '../github/storage';
  import type { Point } from '../drawing';

  export interface BrushLibraryHost {
    import(file: File): Promise<{ reference: string; brush: Brush }>;
    save(reference: string, brush: Brush): Promise<void>;
  }

  let { editor, name, documentMode = false, layered = true, library, missingBrushes = [], initialDraft = false, stylusOnly, autosaveMs,
    onSave, onCommit, onExit, onDelete, onExport, onRawText, surfaceTarget, usingTools = $bindable(false), initialPoint }: {
    editor: VisualEditor; name: string;
    /** Visual documents: vector layers, raw text, brush files. Plain images: raster layers only. */
    documentMode?: boolean; layered?: boolean; library?: BrushLibraryHost; missingBrushes?: string[];
    initialDraft?: boolean; stylusOnly: boolean; autosaveMs: number;
    onSave: (requestWrite: boolean) => Promise<void>;
    onCommit?: () => Promise<void>; onExit?: () => void | Promise<void>; onDelete?: () => void | Promise<void>;
    onExport?: () => void; onRawText?: () => void; surfaceTarget?: HTMLElement; usingTools?: boolean; initialPoint?: Point;
  } = $props();
  void initialPoint;

  const frame = get_input_frame(), withDraft = draftQueue();
  const view = new ViewTransform(editor.width, editor.height);
  let renderer: CanvasRenderer | undefined;
  let canvas = $state<HTMLCanvasElement>(), viewport = $state<HTMLDivElement>(), toolbar = $state<HTMLDivElement>();
  let panelMenu = $state<SubKeyframeController>();
  let panelTool = $state<'brush' | 'eraser'>('brush');
  let brushImport = $state<HTMLInputElement>();

  /** Read engine values while subscribing to the given version counters. */
  const read = <T,>(...args: [...unknown[], T]): T => args[args.length - 1] as T;
  // Reactive mirrors of engine state, refreshed from change events.
  let revision = $state(0), layersVersion = $state(0), stateVersion = $state(0), selectionVersion = $state(0);
  let viewVersion = $state(0);
  let saving = $state(false), publishing = $state(false), githubPending = $state(false), waitingForPermission = $state(false), error = $state.raw<unknown>();
  let savedRevision = $state(0);
  let dirty = $state(false);
  let notice = $state('');
  let trace = $state.raw<[number, number][]>([]);
  let gestureCount = $state(0);
  let active = false, timer: ReturnType<typeof setTimeout> | undefined, lastSave = 0, space = false;

  const tool = $derived(read(stateVersion, editor.state.tool));
  const layers = $derived(read(layersVersion, revision, [...editor.layers]));
  const activeLayer = $derived(read(layersVersion, revision, editor.activeLayer));
  const selection = $derived(read(selectionVersion, editor.selection));
  const floating = $derived(read(selectionVersion, editor.floating));
  const brushes = $derived(read(stateVersion, [...editor.brushes].map(([reference, brush]) => ({ reference, brush }))));
  const palette = $derived(read(stateVersion, editor.doc.brushes));
  const missingLayers = $derived(read(layersVersion, revision, editor.missingLayers));
  const color = $derived(read(stateVersion, editor.state.color));
  const paletteColors = $derived(read(stateVersion, [...editor.doc.config.palette]));
  const recentColors = $derived(read(stateVersion, [...editor.state.recentColors]));
  const brushOpacity = $derived(read(stateVersion, editor.state.brushOpacity));
  const canUndo = $derived(read(revision, editor.canUndo)), canRedo = $derived(read(revision, editor.canRedo));

  function refreshDirty() { dirty = editor.dirty; }
  const off = editor.on((change) => {
    if (change === 'history' || change === 'content') revision++;
    if (change === 'layers') layersVersion++;
    if (change === 'state' || change === 'brushes') stateVersion++;
    if (change === 'selection') selectionVersion++;
    if (change !== 'content' || !gesture) { refreshDirty(); schedule(); }
  });

  function redraw() { viewVersion++; renderer?.request(); }
  function portal(element: HTMLElement, target?: HTMLElement) {
    if (!target) return;
    const marker = document.createComment('visual workspace'); element.before(marker); target.append(element);
    target.classList.add('raster-inline-host');
    return { destroy() { marker.before(element); marker.remove(); target.classList.remove('raster-inline-host'); } };
  }

  // ------------------------------------------------------------------ input
  type Gesture = { kind: 'paint' | 'lasso' | 'move' | 'resize'; origin: [number, number]; box?: Rect; corner?: string };
  let gesture: Gesture | undefined;
  let pendingCorner: string | undefined;
  let pinchStart: { zoom: number; anchor: [number, number] } | undefined;
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x <= editor.width && y <= editor.height;
  const docPoint = (x: number, y: number) => view.toDocument(x, y);

  const input = new InputController({
    strokeBegin(point) {
      // Drawing continues while a save is in flight; only publishing locks the canvas.
      if (publishing) return;
      resumeEditing();
      const p = docPoint(point.x, point.y), current = editor.state.tool;
      if (current === 'lasso') {
        const sel = editor.selection, box = editor.floating?.box ?? sel?.rect;
        const within = box && p[0] >= box.x && p[0] <= box.x + box.width && p[1] >= box.y && p[1] <= box.y + box.height;
        if (sel && box && (pendingCorner || within)) {
          if (!editor.floating) editor.beginTransform();
          gesture = { kind: pendingCorner ? 'resize' : 'move', origin: p, box: { ...editor.floating!.box }, corner: pendingCorner };
        } else { editor.deselect(); gesture = { kind: 'lasso', origin: p }; trace = [p]; }
        return;
      }
      if (current !== 'brush' && current !== 'eraser') return;
      if (!inside(p)) return;
      if (editor.beginStroke(p[0], p[1], point.pressure, current)) gesture = { kind: 'paint', origin: p };
      else if (activeLayer?.missing) notice = 'This layer’s file is missing, so it cannot be edited.';
      else if (activeLayer && !activeLayer.entry.visible) notice = 'Show the layer before drawing on it.';
      else if (activeLayer?.entry.locked) notice = 'This layer is locked.';
    },
    strokeMove(point) {
      const p = docPoint(point.x, point.y);
      if (!gesture) return;
      if (gesture.kind === 'paint') editor.strokeTo(p[0], p[1], point.pressure);
      else if (gesture.kind === 'lasso') { const last = trace.at(-1)!; if (Math.hypot(p[0] - last[0], p[1] - last[1]) * view.zoom >= 1) trace = [...trace, p]; }
      else transform(gesture, p);
    },
    strokeEnd(point) {
      const current = gesture; gesture = undefined;
      if (!current) return;
      const p = docPoint(point.x, point.y);
      if (current.kind === 'paint') { editor.strokeTo(p[0], p[1], point.pressure); editor.endStroke(); gestureCount++; }
      else if (current.kind === 'lasso') { editor.lasso(trace); trace = []; }
      else { transform(current, p); editor.commitTransform(); gestureCount++; }
      refreshDirty(); schedule();
    },
    strokeCancel() {
      const current = gesture; gesture = undefined; trace = [];
      if (current?.kind === 'paint') editor.cancelStroke();
      else if (current?.kind === 'move' || current?.kind === 'resize') editor.cancelTransform();
    },
    pan(dx, dy) { view.panBy(dx, dy); redraw(); },
    pinch(phase, scale, x, y) {
      if (phase === 'begin') pinchStart = { zoom: view.zoom, anchor: view.toDocument(x, y) };
      else if (phase === 'move' && pinchStart) { view.anchor(pinchStart.anchor[0], pinchStart.anchor[1], x, y, pinchStart.zoom * scale); redraw(); }
      else pinchStart = undefined;
    },
    undo, redo
  }, { taps: false });
  let lastPenAt = 0;

  function transform(g: Gesture, p: [number, number]) {
    const box = g.box!, dx = Math.round(p[0] - g.origin[0]), dy = Math.round(p[1] - g.origin[1]);
    if (g.kind === 'move') { editor.setTransform({ ...box, x: box.x + dx, y: box.y + dy }); return; }
    const west = g.corner!.endsWith('w'), north = g.corner!.startsWith('n');
    const x = west ? Math.min(box.x + dx, box.x + box.width - 1) : box.x, y = north ? Math.min(box.y + dy, box.y + box.height - 1) : box.y;
    editor.setTransform({ x, y, width: west ? box.x + box.width - x : Math.max(1, box.width + dx), height: north ? box.y + box.height - y : Math.max(1, box.height + dy) });
  }

  function syncInputOptions() {
    input.options.stylusOnly = stylusOnly;
    input.options.panMode = space || editor.state.tool === 'pan';
    input.options.smoothing = editor.state.tool === 'brush' ? editor.currentBrush.smoothing : 0;
  }
  function pointer(event: PointerEvent, phase: 'down' | 'move' | 'up' | 'cancel') {
    if (!viewport) return;
    if (event.pointerType === 'pen') lastPenAt = Date.now();
    if (phase === 'down') {
      if (event.button > 1 || publishing) return;
      event.preventDefault();
      viewport.setPointerCapture(event.pointerId);
      pendingCorner = (event.target as Element).getAttribute?.('data-raster-corner') ?? undefined;
      syncInputOptions();
    }
    const rect = viewport.getBoundingClientRect();
    const samples = phase === 'move' ? event.getCoalescedEvents?.() ?? [] : [];
    for (const sample of samples.length ? samples : [event]) input.handle(fromPointerEvent(sample, rect, phase));
    if (phase !== 'move') pendingCorner = undefined;
  }

  // ------------------------------------------------------------------ actions
  function undo() { if (saving || publishing || gesture) return; editor.undo(); redraw(); }
  function redo() { if (saving || publishing || gesture) return; editor.redo(); redraw(); }
  function setTool(next: Tool) { editor.setState({ tool: next }); syncInputOptions(); }
  function chooseTool(next: Tool) {
    input.interrupt();
    if (next === editor.state.tool && (next === 'brush' || next === 'eraser')) { panelTool = next; usingTools = true; void panelMenu?.enter(); }
    else setTool(next);
  }
  function zoomBy(factor: number) { view.zoomAt(view.zoom * factor); redraw(); }
  function fit() { view.fit(); redraw(); }
  function clearSelection() { if (editor.clearSelection()) gestureCount++; }
  export function focusToolbar() { usingTools = true; toolbar?.focus({ preventScroll: true }); }
  export function resumeEditing() { usingTools = false; viewport?.focus({ preventScroll: true }); }

  // ------------------------------------------------------------------ brush panel
  const panelBrushRef = $derived(read(stateVersion, panelTool === 'eraser' ? editor.state.eraser : editor.state.brush));
  const panelBrush = $derived(read(stateVersion, panelTool === 'eraser' ? editor.currentEraser : editor.currentBrush));
  const panelSize = $derived(read(stateVersion, editor.brushSize(panelTool)));
  // The Keyflow slider binds a plain number; mirror it into the document state both ways.
  let sliderSize = $state(10), sliderFor = '';
  $effect(() => {
    const key = `${panelTool}:${panelSize}`;
    if (key !== sliderFor) { sliderFor = key; sliderSize = panelSize; }
  });
  $effect(() => { const size = sliderSize; untrack(() => { if (size !== panelSize) { sliderFor = `${panelTool}:${size}`; setSize(size); } }); });
  function setSize(size: number) { editor.setState(panelTool === 'eraser' ? { eraserSize: size } : { brushSize: size }); }
  function chooseBrush(reference: string) {
    const brush = editor.brushes.get(reference);
    if (!brush) return;
    if (!editor.doc.brushes.includes(reference)) editor.addBrush(reference, brush, true);
    editor.setState(panelTool === 'eraser' ? { eraser: reference, eraserSize: brush.size } : { brush: reference, brushSize: brush.size, brushOpacity: brush.opacity });
  }
  function editBrush(patch: Partial<Brush>) {
    const reference = panelBrushRef;
    if (!reference) return;
    editor.addBrush(reference, sanitizeBrush({ ...panelBrush, ...patch }), editor.doc.brushes.includes(reference));
    brushEdited = true;
  }
  let brushEdited = $state(false), brushBusy = $state(false);
  async function saveBrushFile() {
    if (!library || !panelBrushRef) return;
    brushBusy = true;
    try { await library.save(panelBrushRef, panelBrush); brushEdited = false; notice = `Saved ${panelBrush.name}.`; }
    catch (cause) { error = cause; } finally { brushBusy = false; }
  }
  async function importBrush(file: File) {
    if (!library) return;
    brushBusy = true;
    try {
      const imported = await library.import(file);
      editor.addBrush(imported.reference, imported.brush, true);
      chooseBrush(imported.reference);
      notice = `Imported ${imported.brush.name}.`;
    } catch (cause) { error = cause; } finally { brushBusy = false; }
  }
  function addPaletteColor() {
    const color = editor.state.color;
    if (!editor.doc.config.palette.includes(color)) editor.setConfig({ palette: [...editor.doc.config.palette, color] });
  }
  function removePaletteColor(color: string) { editor.setConfig({ palette: editor.doc.config.palette.filter((item) => item !== color) }); }

  // ------------------------------------------------------------------ layers
  const kindLabel = (kind: string) => kind === 'vector' ? 'vector' : 'raster';
  function layerAction(action: () => unknown) { input.interrupt(); action(); redraw(); }

  // ------------------------------------------------------------------ saving
  function schedule() {
    clearTimeout(timer);
    if (!active || !dirty || gesture || saving || publishing || waitingForPermission) return;
    timer = setTimeout(() => { void save(false, false); }, Math.max(0, lastSave + autosaveMs - Date.now()));
  }
  async function snapshot(requestWrite: boolean) {
    if (!editor.dirty) return;
    await onSave(requestWrite);
    savedRevision = revision;
    if (onCommit) githubPending = true;
    waitingForPermission = false; lastSave = Date.now();
  }
  async function save(exit = false, requestWrite = true, publish = true) {
    if (saving || publishing || gesture) return false;
    saving = true; error = undefined; clearTimeout(timer);
    try {
      if (onCommit) await withDraft(() => snapshot(requestWrite)); else await snapshot(requestWrite);
      if (exit && onCommit && publish && githubPending) { publishing = true; await onCommit(); githubPending = false; }
      if (exit) await onExit?.();
      refreshDirty();
      return !dirty;
    } catch (cause) {
      lastSave = Date.now();
      if (cause instanceof WritePermissionRequired) waitingForPermission = true;
      else if (!(cause instanceof GitHubEditCancelled)) error = cause;
      return false;
    } finally { saving = false; publishing = false; refreshDirty(); schedule(); }
  }
  export async function saveForNavigation(publish = true) {
    if (!await save(false, false, false)) return false;
    if (publish && onCommit) { try { await onCommit(); githubPending = false; } catch (cause) { error = cause; return false; } }
    return true;
  }

  // ------------------------------------------------------------------ lifecycle
  onMount(() => {
    active = true; githubPending = initialDraft; lastSave = Date.now();
    view.minimumVisible = min_box.value;
    renderer = new CanvasRenderer(canvas!, editor, view);
    renderer.overlay = undefined;
    let initialized = false;
    const resize = new ResizeObserver(() => {
      if (!viewport) return;
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (width !== view.viewportWidth || height !== view.viewportHeight) input.interrupt();
      renderer!.resize(width, height, devicePixelRatio || 1);
      if (!initialized && width > 1 && height > 1) { initialized = true; view.fit(); }
      redraw();
    });
    resize.observe(viewport!);
    const keys = (event: KeyboardEvent) => {
      if ($active_input_frame !== frame) return;
      const modal = shortcutScope.dialog, target = event.target;
      if (modal && (!modal.contains(toolbar!) || !(target instanceof Node) || !toolbar?.closest('.image-editor')?.contains(target))) return;
      if (event.isComposing || event.altKey || (target instanceof HTMLElement && (target.isContentEditable || target.matches('input,textarea,select')))) return;
      const key = event.key.toLowerCase(), primary = event.ctrlKey || event.metaKey;
      if (primary && ['s', 'b', 'z', 'y', 'escape'].includes(key)) {
        event.preventDefault(); event.stopImmediatePropagation(); if (event.repeat) return;
        if (key === 's') void save(); else if (key === 'b') chooseTool('brush'); else if (key === 'escape') void save(true);
        else if (key === 'y' || event.shiftKey) redo(); else undo();
      } else if (key === 'escape' && !usingTools) { event.preventDefault(); input.reset(); editor.deselect(); trace = []; focusToolbar(); }
      else if ((key === 'delete' || key === 'backspace') && editor.selection) { event.preventDefault(); clearSelection(); }
      else if (key === ' ' && document.activeElement === viewport) { event.preventDefault(); space = true; syncInputOptions(); }
    };
    const release = (event: KeyboardEvent) => { if (event.key === ' ') { space = false; syncInputOptions(); } };
    const blur = () => { space = false; input.interrupt(); };
    const unload = (event: BeforeUnloadEvent) => { if (editor.dirty || gesture || publishing) { event.preventDefault(); event.returnValue = ''; } };
    const move = (event: PointerEvent) => pointer(event, 'move'), up = (event: PointerEvent) => pointer(event, 'up'), cancel = (event: PointerEvent) => pointer(event, 'cancel');
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); input.interrupt();
      const rect = viewport!.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey || !event.shiftKey) view.zoomAt(view.zoom * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .01), event.clientX - rect.left, event.clientY - rect.top);
      else view.panBy(-event.deltaX, -event.deltaY);
      redraw();
    };
    // Two/three-finger taps undo/redo. Read from touch events (as on iPad), ignoring palms near pen input.
    let touchTap: { count: number; start: number; points: Map<number, [number, number]>; moved: boolean } | undefined;
    const touchStart = (event: TouchEvent) => {
      if (Date.now() - lastPenAt < 500) { touchTap = undefined; return; }
      const fingers = [...event.touches].filter((touch) => (touch as Touch & { touchType?: string }).touchType !== 'stylus');
      if (fingers.length >= 2) touchTap = { count: Math.max(touchTap?.count ?? 0, fingers.length), start: touchTap?.start ?? performance.now(),
        points: new Map(fingers.map((touch) => [touch.identifier, [touch.clientX, touch.clientY]])), moved: touchTap?.moved ?? false };
    };
    const touchMove = (event: TouchEvent) => {
      if (!touchTap) return;
      for (const touch of event.touches) { const origin = touchTap.points.get(touch.identifier); if (origin && Math.hypot(touch.clientX - origin[0], touch.clientY - origin[1]) > 8) touchTap.moved = true; }
    };
    const touchEnd = (event: TouchEvent) => {
      if (event.touches.length) return;
      const tap = touchTap; touchTap = undefined;
      if (!tap || tap.moved || performance.now() - tap.start >= 300 || Date.now() - lastPenAt < 500) return;
      input.interrupt(false);
      if (tap.count === 2) undo(); else if (tap.count === 3) redo();
    };
    const touchCancel = () => { touchTap = undefined; };
    viewport?.addEventListener('touchstart', touchStart, { passive: true }); viewport?.addEventListener('touchmove', touchMove, { passive: true });
    viewport?.addEventListener('touchend', touchEnd, { passive: true }); viewport?.addEventListener('touchcancel', touchCancel, { passive: true });
    window.addEventListener('keydown', keys, true); window.addEventListener('keyup', release, true);
    window.addEventListener('pointermove', move, { capture: true, passive: true }); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', blur); window.addEventListener('beforeunload', unload);
    viewport?.addEventListener('wheel', wheel, { passive: false });
    refreshDirty();
    // Test and automation hook: the engine behind this canvas.
    Object.assign(viewport!, { visualEditor: editor, visualView: view });
    return () => {
      active = false; clearTimeout(timer); resize.disconnect(); off(); renderer?.destroy();
      window.removeEventListener('keydown', keys, true); window.removeEventListener('keyup', release, true);
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', blur); window.removeEventListener('beforeunload', unload);
      viewport?.removeEventListener('wheel', wheel);
      viewport?.removeEventListener('touchstart', touchStart); viewport?.removeEventListener('touchmove', touchMove);
      viewport?.removeEventListener('touchend', touchEnd); viewport?.removeEventListener('touchcancel', touchCancel);
    };
  });
  $effect(() => { void autosaveMs; void revision; if (active) schedule(); });
  $effect(() => { void stylusOnly; syncInputOptions(); });

  const selectionBox = $derived(read(selectionVersion, viewVersion, floating?.box ?? selection?.rect));
  const transformStyle = $derived(read(viewVersion, `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`));
</script>

<div class="editor-controls drawing-controls" role="group" aria-label="Drawing toolbar" tabindex="-1" bind:this={toolbar}
  use:preserveContentFocus={() => !usingTools && document.activeElement === viewport}>
  {#if onExit}<Control onclick={() => { void save(true); }} disabled={saving || publishing}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></Control>{/if}
  <Control onclick={() => chooseTool('brush')} aria-pressed={tool === 'brush'}>Brush</Control>
  <Control onclick={() => chooseTool('eraser')} aria-pressed={tool === 'eraser'}>Eraser</Control>
  <SubKeyframe label={panelTool === 'brush' ? 'Brush settings' : 'Eraser settings'} showTrigger={false} enterTrigger={null} bind:this={panelMenu} class="visual-brush-menu"
    onclose={resumeEditing} disabled={saving || publishing}>
    {#snippet children()}
      <div class="brush-panel">
        <section class="brush-size">
          {#if panelTool === 'brush'}
            <p>Pen size: {Math.round(panelSize * 10) / 10}</p><VerticalHoverSlider bind:value={sliderSize} min={1} max={300} step={1} speed={20} label="Pen size" />
            <label class="range">Opacity <input type="range" min="1" max="100" value={Math.round((brushOpacity ?? panelBrush.opacity) * 100)} oninput={(e) => editor.setState({ brushOpacity: Number(e.currentTarget.value) / 100 })} aria-label="Brush opacity" /></label>
          {:else}
            <p>Eraser size: {Math.round(panelSize * 10) / 10}</p><VerticalHoverSlider bind:value={sliderSize} min={1} max={500} step={1} speed={40} label="Eraser size" />
          {/if}
        </section>
        {#if panelTool === 'brush'}
          <section>
            <h3>Color</h3>
            <ColorWheel value={color} onchange={(color) => editor.setState({ color })} />
            <div class="swatches" aria-label="Palette">
              {#each paletteColors as swatch (swatch)}
                <span class="swatch-control" style:--swatch={swatch}><Control onclick={() => editor.setState({ color: swatch })} aria-label={`Use color ${swatch}`} aria-pressed={color === swatch}><span class="swatch" aria-hidden="true"></span></Control></span>
              {/each}
              <Control onclick={addPaletteColor} aria-label="Add current color to palette">+</Control>
              {#if paletteColors.includes(color)}<Control onclick={() => removePaletteColor(color)} aria-label="Remove current color from palette">−</Control>{/if}
            </div>
            {#if recentColors.length}
              <div class="swatches" aria-label="Recent colors">
                {#each recentColors as recent (recent)}
                  <span class="swatch-control small" style:--swatch={recent}><Control onclick={() => editor.setState({ color: recent })} aria-label={`Use recent color ${recent}`}><span class="swatch" aria-hidden="true"></span></Control></span>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
        <section>
          <h3>{panelTool === 'brush' ? 'Brush type' : 'Eraser type'}</h3>
          <div class="brush-list">
            {#each brushes.filter(({ brush }) => panelTool === 'eraser' ? brush.eraser : !brush.eraser).sort((a, b) => Number(palette.includes(b.reference)) - Number(palette.includes(a.reference)) || a.brush.name.localeCompare(b.brush.name, undefined, { numeric: true })) as item (item.reference)}
              <Control onclick={() => chooseBrush(item.reference)} aria-pressed={item.reference === panelBrushRef}>{item.brush.name.replace(/^[a-z]\)\s*/, '')}</Control>
            {/each}
          </div>
          <details class="brush-config">
            <summary>Configure {panelBrush.name.replace(/^[a-z]\)\s*/, '')}</summary>
            <label class="range">Hardness <input type="range" min="0" max="100" value={Math.round(panelBrush.hardness * 100)} oninput={(e) => editBrush({ hardness: Number(e.currentTarget.value) / 100 })} /></label>
            <label class="range">Flow <input type="range" min="1" max="100" value={Math.round(panelBrush.flow * 100)} oninput={(e) => editBrush({ flow: Number(e.currentTarget.value) / 100 })} /></label>
            <label class="range">Spacing <input type="range" min="1" max="100" value={Math.round(panelBrush.spacing * 100)} oninput={(e) => editBrush({ spacing: Number(e.currentTarget.value) / 100 })} /></label>
            <label class="range">Smoothing <input type="range" min="0" max="95" value={Math.round(panelBrush.smoothing * 100)} oninput={(e) => editBrush({ smoothing: Number(e.currentTarget.value) / 100 })} /></label>
            <label class="range">Min size <input type="range" min="0" max="100" value={Math.round(panelBrush.minSize * 100)} oninput={(e) => editBrush({ minSize: Number(e.currentTarget.value) / 100 })} /></label>
            <label class="range">Roundness <input type="range" min="5" max="100" value={Math.round(panelBrush.ratio * 100)} oninput={(e) => editBrush({ ratio: Number(e.currentTarget.value) / 100 })} /></label>
            <label class="range">Angle <input type="range" min="-180" max="180" value={Math.round(panelBrush.angle)} oninput={(e) => editBrush({ angle: Number(e.currentTarget.value) })} /></label>
            <label><input type="checkbox" checked={panelBrush.sizePressure} onchange={(e) => editBrush({ sizePressure: e.currentTarget.checked })} /> Pressure → size</label>
            <label><input type="checkbox" checked={panelBrush.opacityPressure} onchange={(e) => editBrush({ opacityPressure: e.currentTarget.checked })} /> Pressure → opacity</label>
            <label><input type="checkbox" checked={panelBrush.flowPressure} onchange={(e) => editBrush({ flowPressure: e.currentTarget.checked })} /> Pressure → flow</label>
            {#if library && panelBrushRef}<Control onclick={() => { void saveBrushFile(); }} disabled={brushBusy || !brushEdited}>Save brush file</Control>{/if}
          </details>
          {#if library}
            <Control onclick={() => brushImport?.click()} disabled={brushBusy}>Import brush…</Control>
            <input class="visually-hidden" type="file" bind:this={brushImport} accept={BRUSH_IMPORT_EXTENSIONS.join(',')} aria-label="Brush file to import"
              onchange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void importBrush(file); }} />
          {/if}
        </section>
      </div>
    {/snippet}
  </SubKeyframe>
  <Control onclick={() => chooseTool('lasso')} aria-pressed={tool === 'lasso'}>Lasso</Control>
  <Control onclick={() => chooseTool('pan')} aria-pressed={tool === 'pan'}>Pan</Control>
  <Control onclick={undo} disabled={!canUndo || saving || publishing}>Undo</Control><Control onclick={redo} disabled={!canRedo || saving || publishing}>Redo</Control>
  <Control onclick={() => zoomBy(1 / 1.25)}>Zoom out</Control><Control onclick={() => zoomBy(1.25)}>Zoom in</Control><Control onclick={fit}>Fit canvas</Control>
  {#if selection}<Control onclick={clearSelection} disabled={saving || publishing} aria-label="Clear selected pixels">Clear</Control><Control onclick={() => editor.deselect()}>Deselect</Control>{/if}
  {#if onRawText}<Control onclick={() => { void save(false, true).then(() => onRawText?.()); }} disabled={saving || publishing}>Raw text</Control>{/if}
  {#if onDelete}<Control onclick={() => { input.interrupt(); void onDelete?.(); }} disabled={saving || publishing}>Delete drawing</Control>{/if}
  {#if onExport}<Control onclick={() => onExport?.()} disabled={saving || publishing}>Export</Control>{/if}
</div>
{#if missingLayers.length || missingBrushes.length}
  <div class="visual-missing" role="alert">
    {#if missingLayers.length}<p><strong>Missing layer {missingLayers.length === 1 ? 'file' : 'files'}:</strong> {missingLayers.map((layer) => layer.entry.file).join(', ')}. The document keeps {missingLayers.length === 1 ? 'its reference' : 'their references'}; restore or reconnect the {missingLayers.length === 1 ? 'file' : 'files'}, or delete the layer.</p>{/if}
    {#if missingBrushes.length}<p><strong>Missing brush {missingBrushes.length === 1 ? 'file' : 'files'}:</strong> {missingBrushes.join(', ')}. Built-in brushes are used instead.</p>{/if}
  </div>
{/if}
{#if layered}
  <div class="image-layers visual-layers" aria-label="Image layers">
    <ChoiceMenu label="active layer" value={String([...layers].reverse().findIndex((item) => item.id === activeLayer?.id))} disabled={saving || publishing}
      choices={[...layers].reverse().map((item, index) => ({ id: String(index), label: `${item.entry.name ?? item.entry.file}${documentMode ? ` · ${kindLabel(item.entry.kind)}` : ''}${item.missing ? ' (missing)' : ''}${item.entry.visible ? '' : ' (hidden)'}` }))}
      onchange={(index) => layerAction(() => editor.setActiveLayer([...layers].reverse()[Number(index)].id))} />
    <div class="editor-controls">
      <Control onclick={() => layerAction(() => editor.addLayer('raster', `Layer ${editor.layers.length + 1}`))} disabled={layers.length >= 100}>Add layer</Control>
      {#if documentMode}<Control onclick={() => layerAction(() => editor.addLayer('vector'))} disabled={layers.length >= 100}>Add vector layer</Control>{/if}
      <Control onclick={() => layerAction(() => editor.removeLayer())} disabled={layers.length < 2}>Delete layer</Control>
      <Control onclick={() => layerAction(() => activeLayer && editor.updateLayer(activeLayer.id, { visible: !activeLayer.entry.visible }))}>{activeLayer?.entry.visible ? 'Hide layer' : 'Show layer'}</Control>
      <Control onclick={() => layerAction(() => activeLayer && editor.moveLayer(activeLayer.id, 1))} disabled={layers.at(-1)?.id === activeLayer?.id}>Raise layer</Control>
      <Control onclick={() => layerAction(() => activeLayer && editor.moveLayer(activeLayer.id, -1))} disabled={layers[0]?.id === activeLayer?.id}>Lower layer</Control>
      {#if activeLayer}
        <label class="range">Layer opacity <input type="range" min="0" max="100" value={Math.round(activeLayer.entry.opacity * 100)}
          onchange={(e) => layerAction(() => editor.updateLayer(activeLayer!.id, { opacity: Number(e.currentTarget.value) / 100 }))} aria-label="Layer opacity" /></label>
        {#if documentMode}<label class="range">Name <input value={activeLayer.entry.name ?? ''} aria-label="Layer name"
          onchange={(e) => layerAction(() => editor.updateLayer(activeLayer!.id, { name: e.currentTarget.value.trim() || undefined }))} /></label>{/if}
      {/if}
    </div>
  </div>
{/if}
<div class="drawing-surface raster-surface visual-surface" use:portal={surfaceTarget}>
  {#if !surfaceTarget}<EditorTitle {name} onEdit={usingTools ? resumeEditing : undefined} />{/if}
  <p class="muted" role="status">{saving ? 'saving drawing…' : waitingForPermission ? 'autosave is waiting for write permission; exit to save' : dirty ? 'unsaved drawing changes' : githubPending ? 'drawing draft saved in this browser · Exit to sync to GitHub' : 'drawing saved'}{notice ? ` · ${notice}` : ''}</p>
  <p class="raster-info muted">{editor.width} × {editor.height} · {read(viewVersion, Math.round(view.zoom * 10000) / 100)}% · {activeLayer ? `${activeLayer.entry.name ?? activeLayer.entry.file} (${kindLabel(activeLayer.entry.kind)})` : ''}</p>
  {#if error}<StorageNotice {error} />{/if}
  <div class="raster-viewport" bind:this={viewport} role="img" aria-label={`Drawing canvas for ${name}`} tabindex="-1"
    onpointerdown={(event) => pointer(event, 'down')} onlostpointercapture={(event) => { if (!(event.buttons & 3) && !event.pressure) input.interrupt(); }}
    data-raster-revision={revision} data-raster-operations={gestureCount} data-raster-zoom={read(viewVersion, view.zoom)} data-visual-tool={tool}>
    <canvas class="visual-canvas" bind:this={canvas}></canvas>
    <svg class="raster-selection" width="100%" height="100%" aria-hidden="true">
      <g style:transform={transformStyle} style:transform-origin="0 0">
        {#if trace.length}<polygon points={trace.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />{/if}
        {#if selection && selectionBox}
          <path d={selection.path.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') + 'Z'} fill="none" stroke="currentColor" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" opacity={floating ? 0 : 1} />
          <rect x={selectionBox.x} y={selectionBox.y} width={selectionBox.width} height={selectionBox.height} fill="none" stroke="currentColor" vector-effect="non-scaling-stroke" />
          {#each ['nw', 'ne', 'sw', 'se'] as corner}<circle data-raster-corner={corner} cx={corner.endsWith('w') ? selectionBox.x : selectionBox.x + selectionBox.width} cy={corner.startsWith('n') ? selectionBox.y : selectionBox.y + selectionBox.height} r={8 / view.zoom} fill="var(--background)" stroke="currentColor" vector-effect="non-scaling-stroke" />{/each}
        {/if}
      </g>
    </svg>
  </div>
</div>

<style>
  .drawing-controls { position: relative; flex-wrap: wrap; }
  .drawing-controls :global(.visual-brush-menu) { position: absolute; top: 100%; left: 0; z-index: 5; }
  .drawing-controls :global(.subkeyframe-panel) { min-width: 12rem; max-height: min(80vh, 44rem); overflow: auto; }
  .brush-panel { display: grid; gap: 12px; padding: 4px; max-width: min(92vw, 34rem); }
  .brush-panel h3 { margin: 0 0 6px; font-size: 14px; }
  .brush-panel section { display: grid; gap: 6px; }
  .range { display: flex; gap: 8px; align-items: center; font-size: 13px; white-space: nowrap; }
  .range input[type=range] { flex: 1; min-width: 6rem; }
  .swatches, .brush-list { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .swatch-control :global(button) { padding: 2px; min-width: 0; }
  .swatch { display: block; width: 22px; height: 22px; border-radius: 4px; background: var(--swatch); border: 1px solid var(--tertiary); }
  .swatch-control.small .swatch { width: 16px; height: 16px; }
  .brush-config { display: grid; gap: 4px; font-size: 13px; }
  .brush-config summary { cursor: pointer; }
  .visual-missing { flex: none; border: 1px solid #c92a2a; border-radius: 4px; padding: 4px 8px; font-size: 14px; }
  .visual-missing p { margin: 2px 0; }
  .visual-layers { flex: none; display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; font-size: 14px; }
  .raster-surface { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden !important; }
  .raster-surface > :global(*) { flex-shrink: 0; }
  .raster-viewport { position: relative; flex: 1 1 auto !important; min-height: 64px; overflow: hidden; touch-action: none; overscroll-behavior: contain; background: color-mix(in srgb, var(--primary) 8%, var(--background)); isolation: isolate; }
  .visual-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .raster-selection { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  .raster-selection circle { pointer-events: all; cursor: nwse-resize; }
</style>
