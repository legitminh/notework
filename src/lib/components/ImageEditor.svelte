<script lang="ts">
  import { onMount } from 'svelte';
  import ExportDialog from './ExportDialog.svelte';
  import { exportStyle } from '../export-style';
  import type { PdfMargins } from '../export-preferences';
  import type { PdfSource } from '../pdf-export';
  import DrawingEditor from './DrawingEditor.svelte';
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import { imageFormat, imageCanvas, canvasBlob, composite, paintBlob, type ImageDocument, type ImageLayer } from '../images';
  import { DRAWING_WIDTH, STROKE_WIDTH, type Drawing } from '../drawing';
  import { saveImage, type DrawingResource } from '../drawing-files';
  import type { StateNode } from '../workspace';
  import { GitHubFile } from '../github/repository';
  import { getBackgroundSync } from '../github/background.svelte';

  let { resource, node, stylusOnly, autosaveMs, pdfMargins, onExit, onSaved, onDelete, surfaceTarget, usingTools = $bindable(false) }: {
    resource: DrawingResource; node: StateNode; stylusOnly: boolean; autosaveMs: number; pdfMargins: PdfMargins;
    onExit: () => void | Promise<void>; onSaved?: (resource: DrawingResource) => void;
    onDelete?: () => void | Promise<void>; surfaceTarget?: HTMLElement; usingTools?: boolean;
  } = $props();
  const sync = getBackgroundSync();
  let exportSource = $state.raw<PdfSource>();
  let host: HTMLDivElement;
  let current = $state.raw<DrawingResource>();
  let document = $state.raw<ImageDocument>();
  let selected = $state(0);
  let session = $state(0);
  let ready = $state(false);
  let busy = $state(false);
  let error = $state.raw<unknown>();
  let background = $state('');
  let foreground = $state('');
  let base: Blob;
  let editor = $state<{ saveForNavigation: (publish?: boolean) => Promise<boolean>; resumeEditing: () => void }>();
  const layered = $derived(imageFormat(resource.handle.name) === 'ora');
  const urls = new Set<string>();
  function url(blob: Blob) { const value = URL.createObjectURL(blob); urls.add(value); return value; }
  async function prepare() {
    ready = false;
    for (const value of urls) URL.revokeObjectURL(value);
    urls.clear();
    base = document!.layers[selected].png;
    // ORA stores its topmost layer first; strokes live at the selected layer's position.
    background = url(await canvasBlob(await composite(document!, document!.layers.slice(selected))));
    foreground = url(await canvasBlob(await composite(document!, document!.layers.slice(0, selected))));
    session++; ready = true;
  }
  async function withStrokes(strokes: Drawing) {
    const canvas = imageCanvas(document!.width, document!.height), context = canvas.getContext('2d')!;
    await paintBlob(context, base);
    context.scale(document!.width / DRAWING_WIDTH, document!.width / DRAWING_WIDTH);
    context.strokeStyle = '#202733'; context.lineWidth = STROKE_WIDTH; context.lineCap = 'round'; context.lineJoin = 'round';
    for (const stroke of strokes) {
      if (!stroke.length) continue;
      context.beginPath(); context.moveTo(stroke[0][0], stroke[0][1]);
      for (const [x, y] of stroke.slice(1)) context.lineTo(x, y);
      if (stroke.length === 1) context.lineTo(stroke[0][0] + .01, stroke[0][1]);
      context.stroke();
    }
    const layers = document!.layers.map((layer, index) => index === selected ? { ...layer } : layer);
    layers[selected].png = await canvasBlob(canvas);
    return { ...document!, layers };
  }
  async function persist(image: ImageDocument, requestWrite: boolean) {
    current = await saveImage(current!, image, requestWrite);
    document = image;
    onSaved?.(current);
  }
  async function commit() { if (current?.handle instanceof GitHubFile) await sync.enqueue(node, current.handle); }
  export async function saveForNavigation() { return await editor?.saveForNavigation() ?? false; }
  export function resumeEditing() { editor?.resumeEditing(); }
  async function changeLayer(index: number) {
    if (busy || !editor) return;
    busy = true; error = undefined;
    try {
      if (!await editor.saveForNavigation(false)) return;
      selected = index; await prepare();
    } catch (cause) { error = cause; }
    finally { busy = false; }
  }
  async function modifyLayers(action: (layers: ImageLayer[]) => Promise<{ layers: ImageLayer[]; index: number }>) {
    if (busy || !editor) return;
    busy = true; error = undefined;
    try {
      if (!await editor.saveForNavigation(false)) return;
      const { layers, index } = await action(document!.layers.map((layer) => ({ ...layer })));
      await persist({ ...document!, layers }, true);
      selected = index; await prepare();
    } catch (cause) { error = cause; }
    finally { busy = false; }
  }
  async function exportPng(strokes: Drawing) {
    try {
      const blob = await canvasBlob(await composite(await withStrokes(strokes)));
      const surface = surfaceTarget ?? host.querySelector<HTMLElement>('.drawing-surface')!;
      exportSource = { kind: 'image', name: resource.handle.name, image: { blob, width: document!.width, height: document!.height },
        style: exportStyle(surface, surface.clientWidth, true, pdfMargins) };
    } catch (cause) { error = cause; }
  }
  onMount(() => {
    let active = true;
    current = resource; document = { ...resource.image!, layers: resource.image!.layers.map((layer) => ({ ...layer })) };
    void prepare().catch((cause) => { if (active) error = cause; });
    return () => { active = false; for (const value of urls) URL.revokeObjectURL(value); };
  });
</script>

<div class="image-editor" bind:this={host} class:standalone-drawing-editor={!surfaceTarget}>
  {#if layered && document}
    <div class="image-layers" aria-label="Image layers">
      <label class="field">active layer <select aria-label="active layer" value={selected} disabled={busy} onchange={(event) => { void changeLayer(Number(event.currentTarget.value)); }}>
        {#each document.layers as layer, index}<option value={index}>{layer.name}{layer.visible ? '' : ' (hidden)'}</option>{/each}
      </select></label>
      <Control disabled={busy || document.layers.length >= 100} onclick={() => { void modifyLayers(async (layers) => {
        const canvas = imageCanvas(document!.width, document!.height);
        layers.unshift({ name: `Layer ${layers.length + 1}`, png: await canvasBlob(canvas), visible: true, opacity: 1 });
        return { layers, index: 0 };
      }); }}>Add layer</Control>
      <Control disabled={busy || document.layers.length < 2} onclick={() => { void modifyLayers(async (layers) => {
        layers.splice(selected, 1); return { layers, index: Math.min(selected, layers.length - 1) };
      }); }}>Delete layer</Control>
      <Control disabled={busy} onclick={() => { void modifyLayers(async (layers) => {
        layers[selected].visible = !layers[selected].visible; return { layers, index: selected };
      }); }}>{document.layers[selected].visible ? 'Hide layer' : 'Show layer'}</Control>
      <Control disabled={busy || selected === 0} onclick={() => { void modifyLayers(async (layers) => {
        [layers[selected - 1], layers[selected]] = [layers[selected], layers[selected - 1]]; return { layers, index: selected - 1 };
      }); }}>Raise layer</Control>
      <Control disabled={busy || selected === document.layers.length - 1} onclick={() => { void modifyLayers(async (layers) => {
        [layers[selected + 1], layers[selected]] = [layers[selected], layers[selected + 1]]; return { layers, index: selected + 1 };
      }); }}>Lower layer</Control>
    </div>
  {/if}
  {#if error}<StorageNotice {error} />{/if}
  {#if ready && document}
    {#key session}
      <DrawingEditor bind:this={editor} bind:usingTools name={resource.handle.name} initial={[]} {stylusOnly} {autosaveMs} {surfaceTarget}
        backgroundHref={background} foregroundHref={foreground} imageHeight={document.height / document.width * DRAWING_WIDTH}
        strokeOpacity={document.layers[selected].visible ? document.layers[selected].opacity : 0}
        initialDraft={current?.handle instanceof GitHubFile && !!current.handle.repository.draft(current.handle.path)}
        onSave={async (strokes, requestWrite) => persist(await withStrokes(strokes), requestWrite)}
        onCommit={resource.storage === 'github' ? commit : undefined} {onExit} {onDelete} onExport={exportPng} />
    {/key}
  {/if}
</div>

<style>
  .image-editor { min-height: 0; }
  .image-layers { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; }
  .image-layers .field { margin: 0; font-size: inherit; }
  .image-layers :global(button) { min-height: 36px; }
</style>

{#if exportSource}<ExportDialog source={exportSource} onClose={() => { exportSource = undefined; }} />{/if}
