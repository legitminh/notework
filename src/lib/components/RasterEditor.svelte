<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { get_input_frame, active_input_frame, min_box, SubKeyframe, VerticalHoverSlider, type SubKeyframeController } from '@legitminh/keyflow';
  import Control from './Control.svelte';
  import ChoiceMenu from './ChoiceMenu.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import EditorTitle from './EditorTitle.svelte';
  import ImageLoading from './ImageLoading.svelte';
  import { preserveContentFocus } from '../editor-focus';
  import { shortcutScope } from '../shortcut-scope.svelte';
  import { imageCanvas, type ImageDocument } from '../images';
  import { Raster, type PixelSelection, type PixelBox, type RasterLayer } from '../raster';
  import type { Point } from '../drawing';
  import { WritePermissionRequired } from '../wiki';
  import { GitHubEditCancelled } from '../github/repository';
  import { draftQueue } from '../github/storage';
  let { name, initial, initialDraft = false, stylusOnly, autosaveMs, onSave, onCommit, onExit, onDelete, onExport, surfaceTarget, usingTools = $bindable(false), initialPoint }: {
    name: string; initial: ImageDocument; initialDraft?: boolean; stylusOnly: boolean; autosaveMs: number;
    onSave: (image: ImageDocument, requestWrite: boolean) => Promise<void>;
    onCommit?: () => Promise<void>; onExit?: () => void | Promise<void>; onDelete?: () => void | Promise<void>;
    onExport?: (image: ImageDocument) => void; surfaceTarget?: HTMLElement; usingTools?: boolean; initialPoint?: Point;
  } = $props();
  const frame = get_input_frame(), withDraft = draftQueue();
  const layered = $derived(name.toLowerCase().endsWith('.ora'));
  let raster = $state.raw<Raster>();
  let revision = $state(0), savedRevision = $state(0);
  let layers = $state.raw<RasterLayer[]>([]), selected = $state('');
  const layer = $derived(layers.find(item => item.id === selected) ?? layers[0]);
  let canUndo = $state(false), canRedo = $state(false);
  let selection = $state.raw<PixelSelection>(), trace = $state.raw<Point[]>([]);
  let tool = $state<'brush' | 'eraser' | 'lasso' | 'pan'>('brush');
  let penSize = $state(3), eraserSize = $state(16), sizeTool = $state<'brush' | 'eraser'>('brush');
  let sizeMenu = $state<SubKeyframeController>();
  let toolbar = $state<HTMLDivElement>(), viewport = $state<HTMLDivElement>();
  let surface = $state<HTMLDivElement>();
  let zoom = $state(1), panX = $state(0), panY = $state(0), viewportWidth = $state(1), viewportHeight = $state(1);
  const minimumZoom = $derived(min_box.value / Math.max(initial.width, initial.height));
  let initializedView = false;
  let saving = $state(false), publishing = $state(false), githubPending = $state(false), waitingForPermission = $state(false), error = $state.raw<unknown>();
  const dirty = $derived(revision !== savedRevision);
  let active = false, timer: ReturnType<typeof setTimeout> | undefined, lastSave = 0;
  let gesture: { id: number; pointerType: string; kind: 'brush' | 'eraser' | 'lasso' | 'move' | 'resize' | 'pan'; origin: Point; last: Point; selection?: PixelSelection; box?: PixelBox; pan: Point; corner?: string } | undefined;
  let floating = $state.raw<PixelBox>();
  let space = false;
  const contacts = new Map<number, Point>();
  let pinch: { distance: number; zoom: number; anchor: Point } | undefined;
  let lastPenAt = 0;
  let touchTap: { count: number; start: number; points: Map<number,Point>; moved: boolean } | undefined;
  let gestureCount = $state(0);
  function sync() {
    if (!raster) return;
    revision = raster.revision; layers = [...raster.layers]; canUndo = raster.canUndo; canRedo = raster.canRedo;
    if (!layers.some(item => item.id === selected)) selected = layers[0].id;
    waitingForPermission = false;
  }
  function portal(element: HTMLElement, target?: HTMLElement) {
    if (!target) return;
    const marker = document.createComment('raster workspace'); element.before(marker); target.append(element);
    target.classList.add('raster-inline-host');
    return { destroy() { marker.before(element); marker.remove(); target.classList.remove('raster-inline-host'); } };
  }
  function mountCanvas(node: HTMLElement, canvas: HTMLCanvasElement) { node.append(canvas); return { destroy() { canvas.remove(); } }; }
  function clampPan() {
    // Keep at least one min-box (or the entire tiny canvas) visible on both axes.
    const width = initial.width * zoom, height = initial.height * zoom;
    const visibleX = Math.min(min_box.value, width, viewportWidth), visibleY = Math.min(min_box.value, height, viewportHeight);
    panX = Math.min(viewportWidth - visibleX, Math.max(visibleX - width, panX));
    panY = Math.min(viewportHeight - visibleY, Math.max(visibleY - height, panY));
  }
  function fit() {
    if (!viewport) return;
    zoom = Math.max(minimumZoom, Math.min((viewportWidth - 24) / initial.width, (viewportHeight - 24) / initial.height, 1));
    panX = (viewportWidth - initial.width * zoom) / 2; panY = (viewportHeight - initial.height * zoom) / 2; clampPan();
  }
  function setZoom(next: number, x = viewportWidth / 2, y = viewportHeight / 2) {
    if (!Number.isFinite(next)) return;
    // CSS transforms do not allocate a larger backing bitmap when zooming.
    next = Math.max(minimumZoom, next);
    panX = x - (x - panX) * next / zoom; panY = y - (y - panY) * next / zoom; zoom = next; clampPan();
  }
  function screen(event: PointerEvent): Point { const rect = viewport!.getBoundingClientRect(); return [event.clientX - rect.left, event.clientY - rect.top]; }
  function point(event: PointerEvent): Point { const p = screen(event); return [(p[0] - panX) / zoom, (p[1] - panY) / zoom]; }
  function inside(p: Point) { return p[0] >= 0 && p[1] >= 0 && p[0] <= initial.width && p[1] <= initial.height; }
  function finish(cancel = false) {
    const current = gesture; gesture = undefined;
    if (!current || !raster) return;
    if (cancel) raster.cancel();
    else if (current.kind === 'lasso') selection = raster.select(layer, trace);
    else if (current.kind === 'move' || current.kind === 'resize') {
      raster.place(layer, current.selection!, floating!); raster.commit(); selection = undefined;
    } else if (current.kind !== 'pan') { raster.commit(); gestureCount++; }
    floating = undefined; trace = []; sync();
    if (viewport?.hasPointerCapture(current.id)) viewport.releasePointerCapture(current.id);
    schedule();
  }
  function interrupt() { if (gesture?.pointerType !== 'touch' && (gesture?.kind === 'brush' || gesture?.kind === 'eraser')) finish(); else finish(true); }
  function begin(event: PointerEvent) {
    if (!raster || publishing || event.button > 1) return;
    if (event.pointerType === 'pen') lastPenAt = Date.now();
    if (event.pointerType === 'touch') {
      if (gesture?.pointerType === 'pen' || Date.now()-lastPenAt < 500) return;
      contacts.set(event.pointerId, screen(event));
      if (contacts.size === 2) {
        finish(true); const [a,b] = [...contacts.values()];
        const center: Point = [(a[0]+b[0])/2,(a[1]+b[1])/2];
        pinch = { distance: Math.max(1, Math.hypot(a[0]-b[0],a[1]-b[1])), zoom, anchor: [(center[0]-panX)/zoom,(center[1]-panY)/zoom] }; return;
      }
      if (pinch || (stylusOnly && tool !== 'lasso' && tool !== 'pan')) return;
    }
    if (event.pointerType === 'pen' && gesture?.pointerType === 'touch') finish(true);
    if (gesture) { if (gesture.pointerType !== 'touch' && ['brush','eraser'].includes(gesture.kind)) finish(); else return; }
    const p = point(event), pan = event.button === 1 || space || tool === 'pan';
    if (!pan && !inside(p)) return;
    event.preventDefault(); resumeEditing(); viewport!.setPointerCapture(event.pointerId);
    const target = event.target as Element, corner = target.getAttribute('data-raster-corner') ?? undefined;
    const transform = selection && tool === 'lasso' && (corner || (p[0] >= selection.x && p[0] <= selection.x + selection.width && p[1] >= selection.y && p[1] <= selection.y + selection.height));
    const kind = pan ? 'pan' : transform ? (corner ? 'resize' : 'move') : tool === 'pan' ? 'pan' : tool;
    gesture = { id: event.pointerId, pointerType: event.pointerType, kind, origin: p, last: p, pan: screen(event), corner };
    if (transform && !pan) {
      // Refresh pixels: painting inside an existing selection may have changed them.
      selection = raster.select(layer, selection!.path)!;
      gesture.selection = selection; gesture.box = { x: selection.x, y: selection.y, width: selection.width, height: selection.height };
      raster.clear(layer, selection); floating = gesture.box;
    } else if (!pan) {
      if (kind === 'lasso') { selection = undefined; trace = [p]; }
      else raster.brush(layer, p, p, kind === 'eraser' ? eraserSize : penSize, kind === 'eraser', selection);
    }
  }
  function sample(event: PointerEvent) {
    const current = gesture;
    if (!current || current.id !== event.pointerId || !raster) return;
    const p = point(event);
    if (current.kind === 'pan') { const at = screen(event); panX += at[0] - current.pan[0]; panY += at[1] - current.pan[1]; current.pan = at; clampPan(); }
    else if (current.kind === 'lasso') { if (Math.hypot(p[0]-current.last[0],p[1]-current.last[1]) * zoom >= 1) trace = [...trace,p]; }
    else if (current.kind === 'move' || current.kind === 'resize') {
      const box = current.box!, dx = Math.round(p[0]-current.origin[0]), dy = Math.round(p[1]-current.origin[1]);
      if (current.kind === 'move') floating = { ...box, x: box.x+dx, y: box.y+dy };
      else { const west = current.corner!.endsWith('w'), north = current.corner!.startsWith('n');
        const x = west ? Math.min(box.x + dx, box.x + box.width - 1) : box.x, y = north ? Math.min(box.y + dy,box.y + box.height - 1) : box.y;
        floating = { x, y, width: west ? box.x+box.width-x : Math.max(1,box.width+dx), height: north ? box.y+box.height-y : Math.max(1,box.height+dy) }; }
    } else raster.brush(layer, current.last, p, current.kind === 'eraser' ? eraserSize : penSize, current.kind === 'eraser', selection);
    current.last = p;
  }
  function move(event: PointerEvent) {
    if (event.pointerType === 'pen' && gesture?.id === event.pointerId) lastPenAt = Date.now();
    if (contacts.has(event.pointerId)) contacts.set(event.pointerId,screen(event));
    if (pinch && contacts.size >= 2) {
      const [a,b] = [...contacts.values()], x = (a[0]+b[0])/2, y = (a[1]+b[1])/2;
      zoom = Math.max(minimumZoom, pinch.zoom * Math.hypot(a[0]-b[0],a[1]-b[1]) / pinch.distance);
      panX = x-pinch.anchor[0]*zoom; panY = y-pinch.anchor[1]*zoom; clampPan(); return;
    }
    if (!gesture || gesture.id !== event.pointerId) return;
    if (gesture.pointerType !== 'touch' && !(event.buttons & 3) && event.pressure === 0) { finish(); return; }
    for (const sampleEvent of event.getCoalescedEvents?.() ?? []) sample(sampleEvent);
    sample(event);
  }
  function up(event: PointerEvent) {
    if (event.pointerType === 'pen') lastPenAt = Date.now();
    contacts.delete(event.pointerId); if (!contacts.size) pinch = undefined;
    if (gesture?.id !== event.pointerId) return;
    sample(event); finish();
  }
  function cancel(event: PointerEvent) { contacts.delete(event.pointerId); if (!contacts.size) pinch = undefined; if (gesture?.id === event.pointerId) interrupt(); }
  function lostCapture(event: PointerEvent) { if (gesture?.id === event.pointerId && !(event.buttons & 3) && !event.pressure) interrupt(); }
  function wheel(event: WheelEvent) {
    event.preventDefault(); finish();
    const rect = viewport!.getBoundingClientRect(); setZoom(zoom * Math.exp(-Math.max(-100,Math.min(100,event.deltaY)) * .01),event.clientX-rect.left,event.clientY-rect.top);
  }
  function undo() { if (saving || publishing || gesture || !raster) return; selection = undefined; raster.undo(); sync(); schedule(); }
  function redo() { if (saving || publishing || gesture || !raster) return; selection = undefined; raster.redo(); sync(); schedule(); }
  function chooseTool(next: typeof tool) {
    finish();
    if (next === tool && (next === 'brush' || next === 'eraser')) { sizeTool = next; usingTools = true; void sizeMenu?.enter(); }
    else tool = next;
  }
  function clearSelection() { if (!raster || !selection || gesture) return; raster.clear(layer,selection); raster.commit(); selection = undefined; sync(); schedule(); }
  function changeLayers(change: (items: RasterLayer[]) => RasterLayer[]) { if (!raster) return; finish(); selection = undefined; raster.changeLayers(change); sync(); schedule(); }
  function changeLayer(id: string) { finish(); selection = undefined; selected = id; }
  export function focusToolbar() { usingTools = true; toolbar?.focus({ preventScroll: true }); }
  export function resumeEditing() { usingTools = false; viewport?.focus({ preventScroll: true }); }
  function schedule() {
    clearTimeout(timer); if (!active || !dirty || gesture || saving || publishing || waitingForPermission) return;
    timer = setTimeout(() => { void save(false,false); },Math.max(0,lastSave + autosaveMs-Date.now()));
  }
  async function snapshot(requestWrite: boolean) {
    if (!raster || !dirty) return;
    const version = revision, image = await raster.snapshot();
    await onSave(image,requestWrite); savedRevision = version; revision = raster.revision;
    if (onCommit) githubPending = true;
    waitingForPermission = false; lastSave = Date.now();
  }
  async function save(exit = false, requestWrite = true, publish = true) {
    if (saving || publishing || gesture || !raster) return false;
    saving = true; error = undefined; clearTimeout(timer);
    try {
      if (onCommit) await withDraft(() => snapshot(requestWrite)); else await snapshot(requestWrite);
      if (exit && onCommit && publish && githubPending) { publishing = true; await onCommit(); githubPending = false; }
      if (exit) await onExit?.(); return !dirty;
    } catch (cause) {
      lastSave = Date.now(); if (cause instanceof WritePermissionRequired) waitingForPermission = true;
      else if (!(cause instanceof GitHubEditCancelled)) error = cause;
      return false;
    } finally { saving = false; publishing = false; schedule(); }
  }
  export async function saveForNavigation(publish = true) {
    if (!await save(false,false,false)) return false;
    if (publish && onCommit) { try { await onCommit(); githubPending = false; } catch (cause) { error = cause; return false; } }
    return true;
  }
  onMount(() => {
    active = true; githubPending = initialDraft; lastSave = Date.now();
    void Raster.open(initial).then(value => { if (!active) return; raster = value; sync(); return tick(); }).then(() => { if (active) fit(); }).catch(cause => error = cause);
    const resize = new ResizeObserver(() => {
      if (!viewport) return;
      if (viewportWidth !== viewport.clientWidth || viewportHeight !== viewport.clientHeight) interrupt(); viewportWidth = viewport.clientWidth; viewportHeight = viewport.clientHeight;
      if (!initializedView && viewportWidth > 1 && viewportHeight > 1) { initializedView = true; fit(); }
      else clampPan();
    });
    if (viewport) resize.observe(viewport);
    const keys = (event: KeyboardEvent) => {
      if ($active_input_frame !== frame) return;
      const modal = shortcutScope.dialog, target = event.target;
      if (modal && (!modal.contains(toolbar!) || !(target instanceof Node) || !toolbar?.closest('.image-editor')?.contains(target))) return;
      if (event.isComposing || event.altKey || (event.target instanceof HTMLElement && (event.target.isContentEditable || event.target.matches('input,textarea,select')))) return;
      const key = event.key.toLowerCase(), primary = event.ctrlKey || event.metaKey;
      if (primary && ['s','b','z','y','escape'].includes(key)) {
        event.preventDefault(); event.stopImmediatePropagation(); if (event.repeat) return;
        if (key === 's') void save(); else if (key === 'b') chooseTool('brush'); else if (key === 'escape') void save(true); else if (key === 'y' || event.shiftKey) redo(); else undo();
      } else if (key === 'escape' && !usingTools) { event.preventDefault(); finish(true); selection = undefined; focusToolbar(); }
      else if ((key === 'delete' || key === 'backspace') && selection) { event.preventDefault(); clearSelection(); }
      else if (key === ' ' && document.activeElement === viewport) { event.preventDefault(); space = true; }
    };
    const release = (event: KeyboardEvent) => { if (event.key === ' ') space = false; };
    const blur = () => { space = false; contacts.clear(); pinch = undefined; interrupt(); };
    const unload = (event: BeforeUnloadEvent) => { if (dirty || gesture || publishing) { event.preventDefault(); event.returnValue = ''; } };
    const touchStart = (event: TouchEvent) => {
      if (gesture?.pointerType === 'pen' || Date.now()-lastPenAt < 500) { touchTap = undefined; return; }
      if (event.touches.length >= 2) { touchTap = { count:event.touches.length,start:performance.now(),points:new Map([...event.touches].map(touch => [touch.identifier,[touch.clientX,touch.clientY] as Point])),moved:false }; }
    };
    const touchMove = (event: TouchEvent) => { if (touchTap) for (const touch of event.touches) { const origin = touchTap.points.get(touch.identifier); if (origin && Math.hypot(touch.clientX-origin[0],touch.clientY-origin[1])>8) touchTap.moved = true; } };
    const touchEnd = (event: TouchEvent) => { if (event.touches.length) return; const tap = touchTap; touchTap = undefined; if (tap && !tap.moved && performance.now()-tap.start<300) { finish(true); if (tap.count===2) undo(); else if(tap.count===3) redo(); } };
    const touchCancel = () => { touchTap = undefined; };
    viewport?.addEventListener('touchstart',touchStart,{passive:true}); viewport?.addEventListener('touchmove',touchMove,{passive:true}); viewport?.addEventListener('touchend',touchEnd,{passive:true}); viewport?.addEventListener('touchcancel',touchCancel,{passive:true});
    window.addEventListener('keydown',keys,true); window.addEventListener('keyup',release,true);
    window.addEventListener('pointermove',move,{ capture: true, passive: true }); window.addEventListener('pointerup',up,true); window.addEventListener('pointercancel',cancel,true);
    window.addEventListener('blur',blur); window.addEventListener('beforeunload',unload);
    viewport?.addEventListener('wheel',wheel,{ passive:false });
    return () => { viewport?.removeEventListener('touchstart',touchStart); viewport?.removeEventListener('touchmove',touchMove); viewport?.removeEventListener('touchend',touchEnd); viewport?.removeEventListener('touchcancel',touchCancel); active = false; clearTimeout(timer); resize.disconnect(); window.removeEventListener('keydown',keys,true); window.removeEventListener('keyup',release,true);
      window.removeEventListener('pointermove',move,true); window.removeEventListener('pointerup',up,true); window.removeEventListener('pointercancel',cancel,true);
      window.removeEventListener('blur',blur); window.removeEventListener('beforeunload',unload); viewport?.removeEventListener('wheel',wheel); };
  });
  $effect(() => { autosaveMs; revision; if (active) schedule(); });
</script>

<div class="editor-controls drawing-controls" role="group" aria-label="Drawing toolbar" tabindex="-1" bind:this={toolbar}
  use:preserveContentFocus={() => !usingTools && document.activeElement === viewport}>
  {#if onExit}<Control onclick={() => { void save(true); }} disabled={saving || publishing}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></Control>{/if}
  <Control onclick={() => chooseTool('brush')} aria-pressed={tool === 'brush'}>Brush</Control>
  <Control onclick={() => chooseTool('eraser')} aria-pressed={tool === 'eraser'}>Eraser</Control>
  <SubKeyframe label={sizeTool === 'brush' ? 'Pen size' : 'Eraser size'} showTrigger={false} enterTrigger={null} bind:this={sizeMenu} class="raster-size-menu"
    onclose={resumeEditing} disabled={saving || publishing}>
    {#snippet children()}
      {#if sizeTool === 'brush'}<p>Pen size: {penSize}</p><VerticalHoverSlider bind:value={penSize} min={1} max={64} step={1} speed={20} label="Pen size" />
      {:else}<p>Eraser size: {eraserSize}</p><VerticalHoverSlider bind:value={eraserSize} min={1} max={128} step={1} speed={40} label="Eraser size" />{/if}
    {/snippet}
  </SubKeyframe>
  <Control onclick={() => chooseTool('lasso')} aria-pressed={tool === 'lasso'}>Lasso</Control>
  <Control onclick={() => chooseTool('pan')} aria-pressed={tool === 'pan'}>Pan</Control>
  <Control onclick={undo} disabled={!canUndo || saving || publishing}>Undo</Control><Control onclick={redo} disabled={!canRedo || saving || publishing}>Redo</Control>
  <Control onclick={() => setZoom(zoom / 1.25)}>Zoom out</Control><Control onclick={() => setZoom(zoom * 1.25)}>Zoom in</Control><Control onclick={fit}>Fit canvas</Control>
  {#if selection}<Control onclick={clearSelection} disabled={saving || publishing} aria-label="Clear selected pixels">Clear</Control><Control onclick={() => selection = undefined}>Deselect</Control>{/if}
  {#if onDelete}<Control onclick={() => { finish(); void onDelete?.(); }} disabled={saving || publishing}>Delete drawing</Control>{/if}
  {#if onExport}<Control onclick={() => { if (raster) void raster.snapshot().then(onExport).catch(cause => error = cause); }} disabled={saving || publishing}>Export</Control>{/if}
</div>
{#if layered && raster}
  <div class="image-layers" aria-label="Image layers">
    <ChoiceMenu label="active layer" value={String(layers.findIndex(item => item.id === selected))} choices={layers.map((item,index) => ({ id:String(index),label:item.name + (item.visible ? '' : ' (hidden)') }))} onchange={(index) => changeLayer(layers[Number(index)].id)} disabled={saving || publishing} />
    <Control onclick={() => { const item = { id:crypto.randomUUID(),name:`Layer ${layers.length+1}`,visible:true,opacity:1,canvas:imageCanvas(initial.width,initial.height) }; changeLayers(items => [item,...items]); selected = item.id; }} disabled={layers.length >= 100}>Add layer</Control>
    <Control onclick={() => changeLayers(items => items.filter(item => item.id !== selected))} disabled={layers.length < 2}>Delete layer</Control>
    <Control onclick={() => changeLayers(items => items.map(item => item.id === selected ? { ...item,visible:!item.visible } : item))}>{layer?.visible ? 'Hide layer' : 'Show layer'}</Control>
    <Control onclick={() => changeLayers(items => { const index = items.findIndex(item => item.id === selected); [items[index-1],items[index]] = [items[index],items[index-1]]; return items; })} disabled={layers[0]?.id === selected}>Raise layer</Control>
    <Control onclick={() => changeLayers(items => { const index = items.findIndex(item => item.id === selected); [items[index+1],items[index]] = [items[index],items[index+1]]; return items; })} disabled={layers.at(-1)?.id === selected}>Lower layer</Control>
  </div>
{/if}
<div class="drawing-surface raster-surface" use:portal={surfaceTarget} bind:this={surface}>
  {#if !surfaceTarget}<EditorTitle {name} onEdit={usingTools ? resumeEditing : undefined} />{/if}
  <p class="muted" role="status">{saving ? 'saving drawing…' : waitingForPermission ? 'autosave is waiting for write permission; exit to save' : dirty ? 'unsaved drawing changes' : githubPending ? 'drawing draft saved in this browser · Exit to sync to GitHub' : 'drawing saved'}</p><p class="raster-info muted">{initial.width} × {initial.height} · {Math.round(zoom*10000)/100}%</p>
  {#if error}<StorageNotice {error} />{/if}
  <div class="raster-viewport" bind:this={viewport} role="img" aria-label={`Drawing canvas for ${name}`} tabindex="-1" onpointerdown={begin} onlostpointercapture={lostCapture}
    data-raster-revision={revision} data-raster-operations={gestureCount} data-raster-zoom={zoom}>
    {#if !raster}<ImageLoading />{:else}
    <div class="raster-canvas" style:width={`${initial.width}px`} style:height={`${initial.height}px`} style:transform={`translate(${panX}px,${panY}px) scale(${zoom})`}>
      {#each [...layers].reverse() as item (item.id)}
        <div class="raster-layer" data-image-layer={item.id === selected ? 'active' : undefined} style:opacity={item.visible ? item.opacity : 0} use:mountCanvas={item.canvas}></div>
      {/each}
      {#if floating && selection}<div class="floating-pixels" style:left={`${floating.x}px`} style:top={`${floating.y}px`} style:transform={`scale(${floating.width/selection.width},${floating.height/selection.height})`} use:mountCanvas={selection.pixels}></div>{/if}
      <svg class="raster-selection" width={initial.width} height={initial.height} viewBox={`0 0 ${initial.width} ${initial.height}`} aria-hidden="true">
        {#if trace.length}<polygon points={trace.map(p => p.join(',')).join(' ')} fill="none" stroke="currentColor" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" />{/if}
        {#if selection}
          {@const box = floating ?? selection}
          <path d={selection.path.map((p,i) => `${i ? 'L':'M'}${p[0]},${p[1]}`).join(' ')+'Z'} fill="none" stroke="currentColor" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" opacity={floating ? 0 : 1} />
          <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="none" stroke="currentColor" vector-effect="non-scaling-stroke" />
          {#each ['nw','ne','sw','se'] as corner}<circle data-raster-corner={corner} cx={corner.endsWith('w') ? box.x : box.x+box.width} cy={corner.startsWith('n') ? box.y : box.y+box.height} r={8/zoom} fill="var(--background)" stroke="currentColor" vector-effect="non-scaling-stroke" />{/each}
        {/if}
      </svg>
    </div>
    {/if}
  </div>
</div>
<style>
  .drawing-controls { position: relative; flex-wrap: wrap; }
  .drawing-controls :global(.raster-size-menu) { position:absolute;top:100%;left:0;z-index:5; }
  .drawing-controls :global(.subkeyframe-panel) { min-width:12rem; }
  .raster-surface { display:flex;flex-direction:column;flex:1 1 auto;min-height:0;overflow:hidden !important; }
  .raster-surface > :global(*) { flex-shrink:0; }
  .raster-viewport { position:relative;flex:1 1 auto !important;min-height:64px;overflow:hidden;touch-action:none;overscroll-behavior:contain;background:color-mix(in srgb,var(--primary) 8%,var(--background));isolation:isolate; }
  .raster-canvas { position:absolute;left:0;top:0;transform-origin:0 0;background-image:conic-gradient(#ddd 25%,#fff 0 50%,#ddd 0 75%,#fff 0);background-size:16px 16px; }
  .raster-layer,.raster-selection { position:absolute;inset:0;pointer-events:none; }
  .raster-layer :global(canvas) { display:block;max-width:none; }
  .raster-selection { overflow:visible; }
  .raster-selection circle { pointer-events:all;cursor:nwse-resize; }
  .floating-pixels { position:absolute;transform-origin:0 0;pointer-events:none; }
  .image-layers { flex:none;display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:14px; }
</style>
