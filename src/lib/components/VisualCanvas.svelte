<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { get_input_frame, active_input_frame, min_box, SubKeyframe, HorizontalSlider, BoundedText, type SubKeyframeController } from '@legitminh/keyflow';
  import { CanvasRenderer, InputController, ViewTransform, fromPointerEvent, sanitizeBrush, BRUSH_IMPORT_EXTENSIONS,
    rotateQuad, scaleQuad, translateQuad, moveCorner, moveEdge, edgeMidpoint, quadCenter,
    type VisualEditor, type Brush, type Rect, type Quad } from 'visual.editor';
  import Control from './Control.svelte';
  import ColorWheel from './ColorWheel.svelte';
  import ChoiceMenu from './ChoiceMenu.svelte';
  import StorageNotice from './StorageNotice.svelte';
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
  type CanvasTool = 'brush' | 'eraser' | 'lasso' | 'pan' | 'transform';

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
  let brushMenu = $state<SubKeyframeController>(), eraserMenu = $state<SubKeyframeController>();
  let editorMenu = $state<SubKeyframeController>(), layerMenu = $state<SubKeyframeController>();
  let brushImport = $state<HTMLInputElement>();

  /** Read engine values while subscribing to the given version counters. */
  const read = <T,>(...args: [...unknown[], T]): T => args[args.length - 1] as T;
  // Reactive mirrors of engine state, refreshed from change events.
  let revision = $state(0), layersVersion = $state(0), stateVersion = $state(0), selectionVersion = $state(0), viewVersion = $state(0);
  let saving = $state(false), publishing = $state(false), githubPending = $state(false), waitingForPermission = $state(false), error = $state.raw<unknown>();
  let dirty = $state(false), notice = $state('');
  let trace = $state.raw<[number, number][]>([]);
  let gestureCount = $state(0);
  let active = false, timer: ReturnType<typeof setTimeout> | undefined, lastSave = 0, space = false;
  /** The pan tool is a view mode, not a document choice, so it is not persisted. */
  let panTool = $state(false);
  let transformTool = $state(false), allCanvas = $state(false);
  let outsidePrompt = $state<{ resolve: (keep: boolean | undefined) => void }>();

  const tool = $derived(read(stateVersion, panTool ? 'pan' : transformTool ? 'transform' : editor.state.tool) as CanvasTool);
  const layers = $derived(read(layersVersion, revision, [...editor.layers]));
  const activeLayer = $derived(read(layersVersion, revision, editor.activeLayer));
  const selection = $derived(read(selectionVersion, editor.selection));
  const session = $derived(read(selectionVersion, revision, editor.transform));
  const brushes = $derived(read(stateVersion, [...editor.brushes].map(([reference, brush]) => ({ reference, brush }))));
  const palette = $derived(read(stateVersion, editor.doc.brushes));
  const missingLayers = $derived(read(layersVersion, revision, editor.missingLayers));
  const color = $derived(read(stateVersion, editor.state.color));
  const paletteColors = $derived(read(stateVersion, [...editor.doc.config.palette]));
  const recentColors = $derived(read(stateVersion, [...editor.state.recentColors]));
  const canUndo = $derived(read(revision, selectionVersion, editor.canUndo)), canRedo = $derived(read(revision, selectionVersion, editor.canRedo));
  const zoomText = $derived(read(viewVersion, `${Math.round(view.zoom * 10000) / 100}%`));
  const statusText = $derived(saving ? 'saving drawing…' : waitingForPermission ? 'autosave is waiting for write permission; exit to save' : dirty ? 'unsaved drawing changes'
    : githubPending ? 'drawing draft saved in this browser · Exit to sync to GitHub' : 'drawing saved');
  const layerTitle = $derived(activeLayer ? activeLayer.entry.name ?? activeLayer.entry.file : '');
  const title = $derived(documentMode && layerTitle ? `${layerTitle} · ${name}` : name);

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
  type Gesture = { kind: 'paint' | 'lasso' | 'move' | 'resize' | 'quad'; origin: [number, number]; box?: Rect; corner?: string; quad?: Quad; handle?: string };
  let gesture: Gesture | undefined;
  let pendingHandle: string | undefined;
  let pinchStart: { zoom: number; anchor: [number, number] } | undefined;
  const inside = ([x, y]: [number, number]) => x >= 0 && y >= 0 && x <= editor.width && y <= editor.height;
  const docPoint = (x: number, y: number) => view.toDocument(x, y);
  function insideQuad(q: Quad, [x, y]: [number, number]) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (Math.abs(cross) < 1e-9) continue;
      if (!sign) sign = Math.sign(cross); else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  }

  const input = new InputController({
    strokeBegin(point) {
      // Drawing continues while a save is in flight; only publishing locks the canvas.
      if (publishing || outsidePrompt) return;
      resumeEditing();
      const p = docPoint(point.x, point.y), current = tool;
      if (current === 'transform') {
        const quad = editor.transform?.quad;
        if (!quad) return;
        // On thin content the edge handles overlap the inside; there, dragging inside moves instead.
        const xs = quad.map((c) => c[0]), ys = quad.map((c) => c[1]);
        const thin = Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * view.zoom < 32;
        const grabbed = pendingHandle?.startsWith('edge:') && thin && insideQuad(quad, p) ? undefined : pendingHandle;
        if (grabbed || insideQuad(quad, p)) gesture = { kind: 'quad', origin: p, quad: quad.map((c) => [...c]) as Quad, handle: grabbed ?? 'move' };
        return;
      }
      if (current === 'lasso') {
        const sel = editor.selection, box = editor.floating?.box ?? sel?.rect;
        const within = box && p[0] >= box.x && p[0] <= box.x + box.width && p[1] >= box.y && p[1] <= box.y + box.height;
        if (sel && box && (pendingHandle?.startsWith('corner:') || within)) {
          if (!editor.transform && !editor.beginTransform()) return;
          const corner = pendingHandle?.startsWith('corner:') ? pendingHandle.slice(7) : undefined;
          gesture = { kind: corner ? 'resize' : 'move', origin: p, box: { ...editor.floating!.box }, corner };
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
      else if (gesture.kind === 'quad') dragQuad(gesture, p);
      else resizeBox(gesture, p);
    },
    strokeEnd(point) {
      const current = gesture; gesture = undefined;
      if (!current) return;
      const p = docPoint(point.x, point.y);
      if (current.kind === 'paint') { editor.strokeTo(p[0], p[1], point.pressure); editor.endStroke(); gestureCount++; }
      else if (current.kind === 'lasso') { editor.lasso(trace); trace = []; if (!editor.selection) notice = 'Nothing selected: the lasso selects pixels, or strokes lying fully inside it.'; }
      else if (current.kind === 'quad') { dragQuad(current, p); gestureCount++; }
      else { resizeBox(current, p); editor.commitTransform(); gestureCount++; }
      refreshDirty(); schedule();
    },
    strokeCancel() {
      const current = gesture; gesture = undefined; trace = [];
      if (current?.kind === 'paint') editor.cancelStroke();
      else if (current?.kind === 'move' || current?.kind === 'resize') editor.cancelTransform();
      else if (current?.kind === 'quad' && current.quad) editor.setTransformQuad(current.quad);
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

  /** Lasso: rectangle move/resize of the selection. */
  function resizeBox(g: Gesture, p: [number, number]) {
    const box = g.box!, dx = Math.round(p[0] - g.origin[0]), dy = Math.round(p[1] - g.origin[1]);
    if (g.kind === 'move') { editor.setTransform({ ...box, x: box.x + dx, y: box.y + dy }); return; }
    const west = g.corner!.endsWith('w'), north = g.corner!.startsWith('n');
    const x = west ? Math.min(box.x + dx, box.x + box.width - 1) : box.x, y = north ? Math.min(box.y + dy, box.y + box.height - 1) : box.y;
    editor.setTransform({ x, y, width: west ? box.x + box.width - x : Math.max(1, box.width + dx), height: north ? box.y + box.height - y : Math.max(1, box.height + dy) });
  }
  /** Transform tool: corners stretch/shear, edge midpoints scale one axis, the inside moves. */
  function dragQuad(g: Gesture, p: [number, number]) {
    const q = g.quad!, dx = p[0] - g.origin[0], dy = p[1] - g.origin[1], handle = g.handle!;
    if (handle === 'move') editor.setTransformQuad(translateQuad(q, dx, dy));
    else if (handle.startsWith('corner:')) { const corner = Number(handle.slice(7)); editor.setTransformQuad(moveCorner(q, corner, [q[corner][0] + dx, q[corner][1] + dy])); }
    else if (handle.startsWith('edge:')) editor.setTransformQuad(moveEdge(q, Number(handle.slice(5)), dx, dy));
    redraw();
  }

  function syncInputOptions() {
    input.options.stylusOnly = stylusOnly;
    input.options.panMode = space || panTool;
    input.options.smoothing = tool === 'brush' ? editor.currentBrush.smoothing : 0;
  }
  function pointer(event: PointerEvent, phase: 'down' | 'move' | 'up' | 'cancel') {
    if (!viewport) return;
    if (event.pointerType === 'pen') lastPenAt = Date.now();
    if (phase === 'down') {
      if (event.button > 2 || publishing) return;
      event.preventDefault();
      viewport.setPointerCapture(event.pointerId);
      const target = event.target as Element;
      const corner = target.getAttribute?.('data-raster-corner'), quadHandle = target.getAttribute?.('data-transform-handle');
      pendingHandle = quadHandle ?? (corner ? `corner:${corner}` : undefined);
      syncInputOptions();
    }
    const rect = viewport.getBoundingClientRect();
    const samples = phase === 'move' ? event.getCoalescedEvents?.() ?? [] : [];
    for (const sample of samples.length ? samples : [event]) input.handle(fromPointerEvent(sample, rect, phase));
    if (phase !== 'move') pendingHandle = undefined;
  }

  // ------------------------------------------------------------------ tools
  function undo() { if (saving || publishing || gesture) return; editor.undo(); redraw(); }
  function redo() { if (saving || publishing || gesture) return; editor.redo(); redraw(); }
  /** Leave the transform tool, asking first when content ended up outside the canvas. Returns false when cancelled. */
  async function finishTransform(): Promise<boolean> {
    if (!transformTool) return true;
    if (editor.transform && editor.transformOutsideCanvas()) {
      const keep = await new Promise<boolean | undefined>((resolve) => { outsidePrompt = { resolve }; });
      outsidePrompt = undefined;
      if (keep === undefined) return false;
      editor.commitTransformSession(keep);
    } else editor.commitTransformSession(true);
    transformTool = false; resetTransformSliders(); redraw();
    return true;
  }
  async function chooseTool(next: CanvasTool) {
    input.interrupt();
    // Re-selecting the active brush/eraser opens its panel; coming back from pan/transform only switches.
    const reselect = !panTool && !transformTool && next === editor.state.tool;
    if (next === 'transform') {
      if (transformTool) return;
      panTool = false;
      if (!editor.beginTransformSession(allCanvas)) { notice = allCanvas ? 'The canvas is empty.' : 'Nothing to transform on this layer.'; return; }
      transformTool = true; resetTransformSliders(); notice = ''; redraw(); return;
    }
    if (!await finishTransform()) return;
    if (next === 'pan') { panTool = !panTool; syncInputOptions(); return; }
    panTool = false;
    if (reselect && (next === 'brush' || next === 'eraser')) {
      usingTools = true; void (next === 'brush' ? brushMenu : eraserMenu)?.enter();
    } else editor.setState({ tool: next });
    syncInputOptions();
  }
  async function toggleAllCanvas() {
    if (!transformTool) { allCanvas = !allCanvas; return; }
    if (!await finishTransform()) return;
    allCanvas = !allCanvas;
    await chooseTool('transform');
  }
  // Temporary toolbar sliders while transforming. Rotation is absolute for the session; scale is a
  // relative nudge (½×–2×, logarithmic) that snaps back to 0 after each adjustment.
  let rotation = $state(0), lastRotation = 0, scaleStep = $state(0), lastScale = 0;
  function resetTransformSliders() { rotation = 0; lastRotation = 0; scaleStep = 0; lastScale = 0; }
  $effect(() => {
    const value = rotation;
    untrack(() => {
      if (!editor.transform || value === lastRotation) { lastRotation = value; return; }
      editor.setTransformQuad(rotateQuad(editor.transform.quad, (value - lastRotation) * Math.PI / 180, quadCenter(editor.transform.quad)));
      lastRotation = value; redraw();
    });
  });
  $effect(() => {
    const value = scaleStep;
    untrack(() => {
      if (!editor.transform || value === lastScale) { lastScale = value; return; }
      editor.setTransformQuad(scaleQuad(editor.transform.quad, 2 ** (value - lastScale)));
      lastScale = value; redraw();
    });
  });
  function settleScale() { setTimeout(() => { lastScale = 0; scaleStep = 0; }, 0); }

  function zoomBy(factor: number) { view.zoomAt(view.zoom * factor); redraw(); }
  function fit() { view.fit(); redraw(); }
  function clearSelection() { if (editor.clearSelection()) gestureCount++; }
  export function focusToolbar() { usingTools = true; toolbar?.focus({ preventScroll: true }); }
  export function resumeEditing() { usingTools = false; viewport?.focus({ preventScroll: true }); }

  // ------------------------------------------------------------------ brush & eraser panels
  const brushRef = $derived(read(stateVersion, editor.state.brush)), eraserRef = $derived(read(stateVersion, editor.state.eraser));
  const currentBrush = $derived(read(stateVersion, editor.currentBrush)), currentEraser = $derived(read(stateVersion, editor.currentEraser));
  // Keyflow sliders bind plain numbers; mirror them into the document state both ways.
  let penSize = $state(editor.brushSize('brush')), eraserSize = $state(editor.brushSize('eraser'));
  let penOpacity = $state(Math.round((editor.state.brushOpacity ?? editor.currentBrush.opacity) * 100));
  $effect(() => { void stateVersion; untrack(() => {
    penSize = editor.brushSize('brush'); eraserSize = editor.brushSize('eraser');
    penOpacity = Math.round((editor.state.brushOpacity ?? editor.currentBrush.opacity) * 100);
  }); });
  $effect(() => { const size = penSize; untrack(() => { if (size !== editor.brushSize('brush')) editor.setState({ brushSize: size }); }); });
  $effect(() => { const size = eraserSize; untrack(() => { if (size !== editor.brushSize('eraser')) editor.setState({ eraserSize: size }); }); });
  $effect(() => { const value = penOpacity / 100; untrack(() => { if (Math.abs(value - (editor.state.brushOpacity ?? editor.currentBrush.opacity)) > 1e-6) editor.setState({ brushOpacity: value }); }); });
  function chooseBrush(kind: 'brush' | 'eraser', reference: string) {
    const brush = editor.brushes.get(reference);
    if (!brush) return;
    if (!editor.doc.brushes.includes(reference)) editor.addBrush(reference, brush, true);
    editor.setState(kind === 'eraser' ? { eraser: reference, eraserSize: brush.size } : { brush: reference, brushSize: brush.size, brushOpacity: brush.opacity });
  }
  let brushEdited = $state(false), brushBusy = $state(false);
  function editBrush(kind: 'brush' | 'eraser', patch: Partial<Brush>) {
    const reference = kind === 'eraser' ? eraserRef : brushRef, current = kind === 'eraser' ? currentEraser : currentBrush;
    if (!reference) return;
    editor.addBrush(reference, sanitizeBrush({ ...current, ...patch }), editor.doc.brushes.includes(reference));
    brushEdited = true;
  }
  async function saveBrushFile(kind: 'brush' | 'eraser') {
    const reference = kind === 'eraser' ? eraserRef : brushRef;
    if (!library || !reference) return;
    brushBusy = true;
    try { await library.save(reference, kind === 'eraser' ? currentEraser : currentBrush); brushEdited = false; notice = 'Saved brush file.'; }
    catch (cause) { error = cause; } finally { brushBusy = false; }
  }
  let importKind: 'brush' | 'eraser' = 'brush';
  async function importBrush(file: File) {
    if (!library) return;
    brushBusy = true;
    try {
      const imported = await library.import(file);
      editor.addBrush(imported.reference, imported.brush, true);
      chooseBrush(imported.brush.eraser ? 'eraser' : importKind, imported.reference);
      notice = `Imported ${imported.brush.name}.`;
    } catch (cause) { error = cause; } finally { brushBusy = false; }
  }
  function addPaletteColor() { if (!editor.doc.config.palette.includes(color)) editor.setConfig({ palette: [...editor.doc.config.palette, color] }); }
  function removePaletteColor(value: string) { editor.setConfig({ palette: editor.doc.config.palette.filter((item) => item !== value) }); }
  const shortName = (brush: Brush) => brush.name.replace(/^[a-z]\)\s*/, '');

  // ------------------------------------------------------------------ layers
  const kindLabel = (kind: string) => kind === 'vector' ? 'vector' : 'raster';
  function layerAction(action: () => unknown) { input.interrupt(); action(); redraw(); }
  let layerOpacity = $state(100);
  $effect(() => { void layersVersion; void revision; untrack(() => { layerOpacity = Math.round((editor.activeLayer?.entry.opacity ?? 1) * 100); }); });
  $effect(() => { const value = layerOpacity / 100; untrack(() => {
    const layer = editor.activeLayer;
    if (layer && Math.abs(layer.entry.opacity - value) > 1e-6 && !editor.busy) { editor.updateLayer(layer.id, { opacity: value }); redraw(); }
  }); });

  // ------------------------------------------------------------------ saving
  function schedule() {
    clearTimeout(timer);
    // Never autosave mid-transform: saving would commit the session.
    if (!active || !dirty || gesture || saving || publishing || waitingForPermission || editor.transform) return;
    timer = setTimeout(() => { void save(false, false); }, Math.max(0, lastSave + autosaveMs - Date.now()));
  }
  async function snapshot(requestWrite: boolean) {
    if (!editor.dirty) return;
    await onSave(requestWrite);
    if (onCommit) githubPending = true;
    waitingForPermission = false; lastSave = Date.now();
  }
  async function save(exit = false, requestWrite = true, publish = true) {
    if (saving || publishing || gesture) return false;
    if (exit || requestWrite) { if (!await finishTransform()) return false; }
    else if (editor.transform) return false;
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
    if (editor.transform) editor.commitTransformSession(true);
    transformTool = false;
    if (!await save(false, false, false)) return false;
    if (publish && onCommit) { try { await onCommit(); githubPending = false; } catch (cause) { error = cause; return false; } }
    return true;
  }

  // ------------------------------------------------------------------ lifecycle
  onMount(() => {
    active = true; githubPending = initialDraft; lastSave = Date.now();
    view.minimumVisible = min_box.value;
    renderer = new CanvasRenderer(canvas!, editor, view);
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
        if (key === 's') void save(); else if (key === 'b') void chooseTool('brush'); else if (key === 'escape') void save(true);
        else if (key === 'y' || event.shiftKey) redo(); else undo();
      } else if (key === 'escape' && !usingTools) { event.preventDefault(); input.reset(); editor.deselect(); trace = []; focusToolbar(); }
      else if ((key === 'delete' || key === 'backspace') && editor.selection) { event.preventDefault(); clearSelection(); }
      else if (key === ' ' && document.activeElement === viewport) { event.preventDefault(); space = true; syncInputOptions(); }
    };
    const release = (event: KeyboardEvent) => { if (event.key === ' ') { space = false; syncInputOptions(); } };
    const blur = () => { space = false; input.interrupt(); };
    const unload = (event: BeforeUnloadEvent) => { if (editor.dirty || gesture || publishing || editor.transform) { event.preventDefault(); event.returnValue = ''; } };
    const move = (event: PointerEvent) => pointer(event, 'move'), up = (event: PointerEvent) => pointer(event, 'up'), cancel = (event: PointerEvent) => pointer(event, 'cancel');
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); input.interrupt();
      const rect = viewport!.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey || !event.shiftKey) view.zoomAt(view.zoom * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .01), event.clientX - rect.left, event.clientY - rect.top);
      else view.panBy(-event.deltaX, -event.deltaY);
      redraw();
    };
    // Right button pans: keep the context menu away from the canvas.
    const contextMenu = (event: MouseEvent) => event.preventDefault();
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
    viewport?.addEventListener('contextmenu', contextMenu);
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
      viewport?.removeEventListener('wheel', wheel); viewport?.removeEventListener('contextmenu', contextMenu);
      viewport?.removeEventListener('touchstart', touchStart); viewport?.removeEventListener('touchmove', touchMove);
      viewport?.removeEventListener('touchend', touchEnd); viewport?.removeEventListener('touchcancel', touchCancel);
    };
  });
  $effect(() => { void autosaveMs; void revision; if (active) schedule(); });
  $effect(() => { void stylusOnly; syncInputOptions(); });

  const selectionBox = $derived(read(selectionVersion, viewVersion, editor.floating?.box ?? selection?.rect));
  const quad = $derived(read(selectionVersion, viewVersion, revision, transformTool ? editor.transform?.quad : undefined));
  const transformStyle = $derived(read(viewVersion, `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`));
  const handle = $derived(read(viewVersion, 7 / view.zoom));
</script>

{#snippet brushPanel(kind: 'brush' | 'eraser')}
  {@const brush = kind === 'eraser' ? currentEraser : currentBrush}
  <div class="menu-flow">
    <section class="menu-group">
      {#if kind === 'brush'}
        <p class="menu-label">Pen size: {Math.round(penSize)}</p><HorizontalSlider bind:value={penSize} min={1} max={300} step={1} speed={40} label="Pen size" />
        <p class="menu-label">Opacity: {penOpacity}%</p><HorizontalSlider bind:value={penOpacity} min={1} max={100} step={1} speed={50} label="Brush opacity" />
      {:else}
        <p class="menu-label">Eraser size: {Math.round(eraserSize)}</p><HorizontalSlider bind:value={eraserSize} min={1} max={500} step={1} speed={60} label="Eraser size" />
      {/if}
    </section>
    {#if kind === 'brush'}
      <section class="menu-group">
        <ColorWheel value={color} size={132} onchange={(value) => editor.setState({ color: value })} />
      </section>
      <section class="menu-group">
        <p class="menu-label">Palette</p>
        <div class="swatches" aria-label="Palette">
          {#each paletteColors as swatch (swatch)}
            <span class="swatch-control" style:--swatch={swatch}><Control onclick={() => editor.setState({ color: swatch })} aria-label={`Use color ${swatch}`} aria-pressed={color === swatch}><span class="swatch" aria-hidden="true"></span></Control></span>
          {/each}
          <Control onclick={addPaletteColor} aria-label="Add current color to palette">+</Control>
          {#if paletteColors.includes(color)}<Control onclick={() => removePaletteColor(color)} aria-label="Remove current color from palette">−</Control>{/if}
        </div>
        {#if recentColors.length}
          <p class="menu-label">Recent</p>
          <div class="swatches" aria-label="Recent colors">
            {#each recentColors as recent (recent)}
              <span class="swatch-control small" style:--swatch={recent}><Control onclick={() => editor.setState({ color: recent })} aria-label={`Use recent color ${recent}`}><span class="swatch" aria-hidden="true"></span></Control></span>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
    <section class="menu-group">
      <p class="menu-label">{kind === 'brush' ? 'Brush type' : 'Eraser type'}</p>
      <div class="brush-list">
        {#each brushes.filter(({ brush: item }) => kind === 'eraser' ? item.eraser : !item.eraser).sort((a, b) => Number(palette.includes(b.reference)) - Number(palette.includes(a.reference)) || a.brush.name.localeCompare(b.brush.name, undefined, { numeric: true })) as item (item.reference)}
          <Control onclick={() => chooseBrush(kind, item.reference)} aria-pressed={item.reference === (kind === 'eraser' ? eraserRef : brushRef)}>{shortName(item.brush)}</Control>
        {/each}
      </div>
      {#if library}
        <div class="menu-row">
          <Control onclick={() => { importKind = kind; brushImport?.click(); }} disabled={brushBusy}>Import brush…</Control>
          {#if (kind === 'eraser' ? eraserRef : brushRef)}<Control onclick={() => { void saveBrushFile(kind); }} disabled={brushBusy || !brushEdited}>Save brush file</Control>{/if}
        </div>
      {/if}
    </section>
    <details class="menu-group brush-config">
      <summary class="menu-label">Configure {shortName(brush)}</summary>
      <label class="range">Hardness <input type="range" min="0" max="100" value={Math.round(brush.hardness * 100)} oninput={(e) => editBrush(kind, { hardness: Number(e.currentTarget.value) / 100 })} /></label>
      <label class="range">Flow <input type="range" min="1" max="100" value={Math.round(brush.flow * 100)} oninput={(e) => editBrush(kind, { flow: Number(e.currentTarget.value) / 100 })} /></label>
      <label class="range">Spacing <input type="range" min="1" max="100" value={Math.round(brush.spacing * 100)} oninput={(e) => editBrush(kind, { spacing: Number(e.currentTarget.value) / 100 })} /></label>
      <label class="range">Smoothing <input type="range" min="0" max="95" value={Math.round(brush.smoothing * 100)} oninput={(e) => editBrush(kind, { smoothing: Number(e.currentTarget.value) / 100 })} /></label>
      <label class="range">Min size <input type="range" min="0" max="100" value={Math.round(brush.minSize * 100)} oninput={(e) => editBrush(kind, { minSize: Number(e.currentTarget.value) / 100 })} /></label>
      <label class="range">Roundness <input type="range" min="5" max="100" value={Math.round(brush.ratio * 100)} oninput={(e) => editBrush(kind, { ratio: Number(e.currentTarget.value) / 100 })} /></label>
      <label class="range">Angle <input type="range" min="-180" max="180" value={Math.round(brush.angle)} oninput={(e) => editBrush(kind, { angle: Number(e.currentTarget.value) })} /></label>
      <label><input type="checkbox" checked={brush.sizePressure} onchange={(e) => editBrush(kind, { sizePressure: e.currentTarget.checked })} /> Pressure → size</label>
      <label><input type="checkbox" checked={brush.opacityPressure} onchange={(e) => editBrush(kind, { opacityPressure: e.currentTarget.checked })} /> Pressure → opacity</label>
      <label><input type="checkbox" checked={brush.flowPressure} onchange={(e) => editBrush(kind, { flowPressure: e.currentTarget.checked })} /> Pressure → flow</label>
    </details>
  </div>
{/snippet}

<div class="visual-bar" role="group" aria-label="Drawing toolbar">
  <div class="editor-controls drawing-controls visual-tools" tabindex="-1" bind:this={toolbar}
    use:preserveContentFocus={() => !usingTools && document.activeElement === viewport}>
    <span class="visual-title" class:unsaved={dirty} title={statusText}><BoundedText text={title} limit={16} label={`Editing ${title}`} /></span>
    <Control onclick={() => { usingTools = true; void editorMenu?.enter(); }}>Editor</Control>
    {#if onExit}<Control onclick={() => { void save(true); }} disabled={saving || publishing}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></Control>{/if}
    <Control onclick={() => { void chooseTool('brush'); }} aria-pressed={tool === 'brush'}>Brush</Control>
    <Control onclick={() => { void chooseTool('eraser'); }} aria-pressed={tool === 'eraser'}>Eraser</Control>
    <Control onclick={() => { void chooseTool('lasso'); }} aria-pressed={tool === 'lasso'}>Lasso</Control>
    <Control onclick={() => { void chooseTool('transform'); }} aria-pressed={tool === 'transform'}>Transform</Control>
    {#if transformTool}
      <span class="transform-slider"><span class="menu-label">Rotate {rotation}°</span><HorizontalSlider bind:value={rotation} min={-180} max={180} step={1} speed={90} label="Rotate" /></span>
      <span class="transform-slider" role="presentation" onpointerup={settleScale} onkeyup={settleScale} onpointercancel={settleScale}>
        <span class="menu-label">Scale ×{(2 ** scaleStep).toFixed(2)}</span><HorizontalSlider bind:value={scaleStep} min={-1} max={1} step={0.01} speed={1} label="Scale" />
      </span>
      <Control onclick={() => { void toggleAllCanvas(); }} aria-pressed={allCanvas}>All canvas</Control>
    {:else if selection}
      <Control onclick={clearSelection} disabled={saving || publishing} aria-label="Clear selected pixels">Clear</Control><Control onclick={() => editor.deselect()}>Deselect</Control>
    {/if}
    {#if outsidePrompt}
      <span class="outside-prompt" role="alertdialog" aria-label="Content outside the canvas">Keep content moved outside the canvas?</span>
      <Control onclick={() => outsidePrompt?.resolve(true)}>Keep outside</Control>
      <Control onclick={() => outsidePrompt?.resolve(false)}>Crop to canvas</Control>
      <Control onclick={() => outsidePrompt?.resolve(undefined)}>Keep transforming</Control>
    {/if}
    <Control onclick={undo} disabled={!canUndo || saving || publishing}>Undo</Control><Control onclick={redo} disabled={!canRedo || saving || publishing}>Redo</Control>
    {#if layered}<Control onclick={() => { usingTools = true; void layerMenu?.enter(); }}>Layer</Control>{/if}
    {#if onExport}<Control onclick={() => onExport?.()} disabled={saving || publishing}>Export</Control>{/if}
    <span class="visually-hidden" role="status">{statusText}{notice ? ` · ${notice}` : ''}</span>
  </div>

  <!-- Input-frame menus overlay the whole toolbar and flow left to right, wrapping as needed. -->
  <SubKeyframe label="Editor" showTrigger={false} enterTrigger={null} bind:this={editorMenu} class="visual-menu" onclose={resumeEditing} disabled={saving || publishing}>
    {#snippet children()}
      <div class="menu-flow">
        <section class="menu-group menu-row">
          <Control onclick={() => zoomBy(1 / 1.25)}>Zoom out</Control>
          <Control onclick={() => zoomBy(1.25)}>Zoom in</Control>
          <Control onclick={() => { void chooseTool('pan'); editorMenu?.exit(); }} aria-pressed={panTool}>Pan</Control>
          <Control onclick={() => { fit(); }}>Fit canvas</Control>
          {#if onRawText}<Control onclick={() => { void save(false, true).then((ok) => { if (ok !== false || !editor.dirty) onRawText?.(); }); }} disabled={saving || publishing}>Raw text</Control>{/if}
          {#if onDelete}<Control onclick={() => { input.interrupt(); void onDelete?.(); }} disabled={saving || publishing}>Delete drawing</Control>{/if}
        </section>
        <section class="menu-group">
          <p class="menu-label">{name}</p>
          <p class="menu-label raster-info">{editor.width} × {editor.height} px · {zoomText}</p>
          <p class="menu-label">{statusText}{notice ? ` · ${notice}` : ''}</p>
        </section>
      </div>
    {/snippet}
  </SubKeyframe>
  <SubKeyframe label="Brush settings" showTrigger={false} enterTrigger={null} bind:this={brushMenu} class="visual-menu persistent-menu" closeOnOutside={false} onclose={resumeEditing} disabled={saving || publishing}>
    {#snippet children()}{@render brushPanel('brush')}{/snippet}
  </SubKeyframe>
  <SubKeyframe label="Eraser settings" showTrigger={false} enterTrigger={null} bind:this={eraserMenu} class="visual-menu persistent-menu" closeOnOutside={false} onclose={resumeEditing} disabled={saving || publishing}>
    {#snippet children()}{@render brushPanel('eraser')}{/snippet}
  </SubKeyframe>
  {#if layered}
    <SubKeyframe label="Layers" showTrigger={false} enterTrigger={null} bind:this={layerMenu} class="visual-menu" onclose={resumeEditing} disabled={saving || publishing}>
      {#snippet children()}
        <div class="menu-flow">
          <section class="menu-group">
            <ChoiceMenu label="active layer" value={String([...layers].reverse().findIndex((item) => item.id === activeLayer?.id))} disabled={saving || publishing}
              choices={[...layers].reverse().map((item, index) => ({ id: String(index), label: `${item.entry.name ?? item.entry.file}${documentMode ? ` · ${kindLabel(item.entry.kind)}` : ''}${item.missing ? ' (missing)' : ''}${item.entry.visible ? '' : ' (hidden)'}` }))}
              onchange={(index) => layerAction(() => editor.setActiveLayer([...layers].reverse()[Number(index)].id))} />
          </section>
          <section class="menu-group menu-row">
            <Control onclick={() => layerAction(() => editor.addLayer('raster', `Layer ${editor.layers.length + 1}`))} disabled={layers.length >= 100}>Add layer</Control>
            {#if documentMode}<Control onclick={() => layerAction(() => editor.addLayer('vector'))} disabled={layers.length >= 100}>Add vector layer</Control>{/if}
            <Control onclick={() => layerAction(() => editor.removeLayer())} disabled={layers.length < 2}>Delete layer</Control>
            <Control onclick={() => layerAction(() => activeLayer && editor.updateLayer(activeLayer.id, { visible: !activeLayer.entry.visible }))}>{activeLayer?.entry.visible ? 'Hide layer' : 'Show layer'}</Control>
            <Control onclick={() => layerAction(() => activeLayer && editor.moveLayer(activeLayer.id, 1))} disabled={layers.at(-1)?.id === activeLayer?.id}>Raise layer</Control>
            <Control onclick={() => layerAction(() => activeLayer && editor.moveLayer(activeLayer.id, -1))} disabled={layers[0]?.id === activeLayer?.id}>Lower layer</Control>
          </section>
          {#if activeLayer}
            <section class="menu-group">
              <p class="menu-label">Layer opacity: {layerOpacity}%</p>
              <HorizontalSlider bind:value={layerOpacity} min={0} max={100} step={1} speed={50} label="Layer opacity" />
            </section>
            {#if documentMode}
              <section class="menu-group">
                <label class="range">Name <input value={activeLayer.entry.name ?? ''} aria-label="Layer name"
                  onchange={(e) => layerAction(() => editor.updateLayer(activeLayer!.id, { name: e.currentTarget.value.trim() || undefined }))} /></label>
                <p class="menu-label">{activeLayer.entry.file} · {kindLabel(activeLayer.entry.kind)}</p>
              </section>
            {/if}
          {/if}
        </div>
      {/snippet}
    </SubKeyframe>
  {/if}
</div>
{#if library}
  <input class="visually-hidden" type="file" bind:this={brushImport} accept={BRUSH_IMPORT_EXTENSIONS.join(',')} aria-label="Brush file to import" tabindex="-1"
    onchange={(e) => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (file) void importBrush(file); }} />
{/if}
{#if missingLayers.length || missingBrushes.length}
  <div class="visual-missing" role="alert">
    {#if missingLayers.length}<p><strong>Missing layer {missingLayers.length === 1 ? 'file' : 'files'}:</strong> {missingLayers.map((layer) => layer.entry.file).join(', ')}. The document keeps {missingLayers.length === 1 ? 'its reference' : 'their references'}; restore or reconnect the {missingLayers.length === 1 ? 'file' : 'files'}, or delete the layer.</p>{/if}
    {#if missingBrushes.length}<p><strong>Missing brush {missingBrushes.length === 1 ? 'file' : 'files'}:</strong> {missingBrushes.join(', ')}. Built-in brushes are used instead.</p>{/if}
  </div>
{/if}
{#if error}<StorageNotice {error} />{/if}
<div class="drawing-surface raster-surface visual-surface" use:portal={surfaceTarget}>
  <div class="raster-viewport" bind:this={viewport} role="img" aria-label={`Drawing canvas for ${name}`} tabindex="-1"
    onpointerdown={(event) => pointer(event, 'down')} onlostpointercapture={(event) => { if (!(event.buttons & 3) && !event.pressure) input.interrupt(); }}
    data-raster-revision={revision} data-raster-operations={gestureCount} data-raster-zoom={read(viewVersion, view.zoom)} data-visual-tool={tool}>
    <canvas class="visual-canvas" bind:this={canvas}></canvas>
    <svg class="raster-selection" width="100%" height="100%" aria-hidden="true">
      <g style:transform={transformStyle} style:transform-origin="0 0">
        {#if trace.length}
          <polygon class="ants-under" points={trace.map((p) => p.join(',')).join(' ')} vector-effect="non-scaling-stroke" />
          <polygon class="ants" points={trace.map((p) => p.join(',')).join(' ')} vector-effect="non-scaling-stroke" />
        {/if}
        {#if quad}
          {@const points = quad.map((p) => p.join(',')).join(' ')}
          <polygon class="ants-under" {points} vector-effect="non-scaling-stroke" />
          <polygon class="ants transform-outline" {points} vector-effect="non-scaling-stroke" />
          {#each quad as corner, index}<rect class="handle" data-transform-handle={`corner:${index}`} x={corner[0] - handle} y={corner[1] - handle} width={handle * 2} height={handle * 2} vector-effect="non-scaling-stroke" />{/each}
          {#each [0, 1, 2, 3] as edge}{@const mid = edgeMidpoint(quad, edge)}<circle class="handle" data-transform-handle={`edge:${edge}`} cx={mid[0]} cy={mid[1]} r={handle} vector-effect="non-scaling-stroke" />{/each}
        {:else if selection && selectionBox}
          {@const path = selection.path.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ') + 'Z'}
          {#if !session}
            <path class="ants-under" d={path} vector-effect="non-scaling-stroke" />
            <path class="ants" d={path} vector-effect="non-scaling-stroke" />
          {/if}
          <rect class="selection-box" x={selectionBox.x} y={selectionBox.y} width={selectionBox.width} height={selectionBox.height} vector-effect="non-scaling-stroke" />
          {#each ['nw', 'ne', 'sw', 'se'] as corner}<circle class="handle" data-raster-corner={corner} cx={corner.endsWith('w') ? selectionBox.x : selectionBox.x + selectionBox.width} cy={corner.startsWith('n') ? selectionBox.y : selectionBox.y + selectionBox.height} r={handle + 1} vector-effect="non-scaling-stroke" />{/each}
        {/if}
      </g>
    </svg>
  </div>
</div>

<style>
  .visual-bar { position: relative; flex: none; z-index: 4; }
  .visual-tools { flex-wrap: nowrap !important; overflow-x: auto; overflow-y: hidden; align-items: center; scrollbar-width: thin; }
  .visual-tools > :global(*) { flex: none; }
  .visual-title { font-weight: 600; padding-inline: 4px; display: inline-flex; align-items: center; }
  .visual-title.unsaved::after { content: '•'; margin-left: 4px; opacity: .7; }
  .transform-slider { display: inline-flex; align-items: center; gap: 2px; }
  .transform-slider :global(.keyflow-slider) { padding: 0 .25rem; gap: .4rem; }
  .transform-slider :global([role=slider]) { min-width: 7rem; }
  .outside-prompt { font-size: 13px; padding-inline: 6px; color: #c92a2a; }
  /* Menus cover the toolbar edge to edge and grow downward only when a row is full. */
  .visual-bar :global(.visual-menu) { position: absolute; top: 0; left: 0; right: 0; z-index: 10; }
  .visual-bar :global(.visual-menu .subkeyframe-panel) { width: 100%; box-sizing: border-box; max-height: min(70vh, 40rem) !important; overflow: auto;
    background: var(--background); border-bottom: 1px solid var(--tertiary); }
  /* Brush/eraser panels stay open while painting, so they never take more than ~45% of the screen. */
  .visual-bar :global(.persistent-menu .subkeyframe-panel) { max-height: min(45vh, 26rem) !important; }
  .menu-flow { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-start; }
  .menu-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .menu-row { flex-direction: row; flex-wrap: wrap; gap: 4px; align-items: center; }
  .menu-label { margin: 0; font-size: 13px; white-space: nowrap; }
  .range { display: flex; gap: 8px; align-items: center; font-size: 13px; white-space: nowrap; }
  .range input[type=range] { flex: 1; min-width: 6rem; }
  .swatches, .brush-list { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; max-width: 34rem; }
  .swatch-control :global(button) { padding: 2px; min-width: 0; }
  .swatch { display: block; width: 22px; height: 22px; border-radius: 4px; background: var(--swatch); border: 1px solid var(--tertiary); }
  .swatch-control.small .swatch { width: 16px; height: 16px; }
  .brush-config { font-size: 13px; }
  .brush-config summary { cursor: pointer; }
  /* Dense menus: keep panels short so most of the canvas stays reachable underneath. */
  .visual-bar :global(.visual-menu) { font-size: 13px; }
  .brush-list :global(button), .menu-row :global(button) { font-size: 13px; }
  .menu-flow :global(.keyflow-slider) { padding: 0 .25rem; gap: .4rem; }
  .visual-missing { flex: none; border: 1px solid #c92a2a; border-radius: 4px; padding: 4px 8px; font-size: 14px; }
  .visual-missing p { margin: 2px 0; }
  .raster-surface { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden !important; }
  .raster-surface > :global(*) { flex-shrink: 0; }
  .raster-viewport { position: relative; flex: 1 1 auto !important; min-height: 64px; overflow: hidden; touch-action: none; overscroll-behavior: contain; background: color-mix(in srgb, var(--primary) 8%, var(--background)); isolation: isolate; }
  .visual-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .raster-selection { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
  /* High-contrast "marching ants": a light halo under a dark dashed line, legible on any artwork. */
  .ants-under { fill: none; stroke: #fff; stroke-width: 4px; stroke-opacity: .9; }
  .ants { fill: rgb(28 126 214 / .08); stroke: #111; stroke-width: 2px; stroke-dasharray: 6 4; animation: ants .6s linear infinite; }
  .transform-outline { stroke: #1c7ed6; fill: rgb(28 126 214 / .05); }
  .selection-box { fill: none; stroke: #1c7ed6; stroke-width: 1.5px; }
  .handle { fill: #fff; stroke: #1c7ed6; stroke-width: 2px; pointer-events: all; cursor: grab; }
  @keyframes ants { to { stroke-dashoffset: -10; } }
  @media (prefers-reduced-motion: reduce) { .ants { animation: none; } }
</style>
