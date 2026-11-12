<script lang="ts">
  import { onMount } from 'svelte';
  import DrawingEditor from './DrawingEditor.svelte';
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import { imageFormat, imageCanvas, canvasBlob, composite, paintBlob, type ImageDocument, type ImageLayer } from '../images';
  import { DRAWING_WIDTH, STROKE_WIDTH, type Drawing } from '../drawing';

  let { name, initial, initialDraft = false, stylusOnly, autosaveMs, onSave, onCommit, onExit, onDelete, onExport, surfaceTarget, usingTools = $bindable(false) }: {
    name: string; initial: ImageDocument; initialDraft?: boolean; stylusOnly: boolean; autosaveMs: number;
    onSave: (image: ImageDocument, requestWrite: boolean) => Promise<void>;
    onCommit?: () => Promise<void>; onExit?: () => void | Promise<void>;
    onDelete?: () => void | Promise<void>; onExport?: (image: ImageDocument) => void;
    surfaceTarget?: HTMLElement; usingTools?: boolean;
  } = $props();
  let document = $state.raw<ImageDocument>();
  let selected = $state(0);
  let session = $state(0);
  let ready = $state(false);
  let busy = $state(false);
  let error = $state.raw<unknown>();
  let background = $state('');
  let foreground = $state('');
  let base: Blob;
  let active = false;
  let editor = $state<{ saveForNavigation: (publish?: boolean) => Promise<boolean>; resumeEditing: () => void }>();
  const layered = $derived(imageFormat(name) === 'ora');
  const urls = new Set<string>();
  function url(blob: Blob) { const value = URL.createObjectURL(blob); urls.add(value); return value; }
  async function prepare() {
    ready = false;
    for (const value of urls) URL.revokeObjectURL(value);
    urls.clear();
    base = document!.layers[selected].png;
    // ORA stores its topmost layer first; strokes live at the selected layer's position.
    const behind = await canvasBlob(await composite(document!, document!.layers.slice(selected)));
    const ahead = await canvasBlob(await composite(document!, document!.layers.slice(0, selected)));
    if (!active) return;
    background = url(behind);
    foreground = url(ahead);
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
    await onSave(image, requestWrite);
    document = image;
  }
  export async function saveForNavigation() { return !busy && ready && (await editor?.saveForNavigation() ?? false); }
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
  onMount(() => {
    active = true;
    document = { ...initial, layers: initial.layers.map((layer) => ({ ...layer })) };
    void prepare().catch((cause) => { if (active) error = cause; });
    return () => { active = false; for (const value of urls) URL.revokeObjectURL(value); };
  });
</script>

<div class="image-editor" class:standalone-drawing-editor={!surfaceTarget}>
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
      <DrawingEditor bind:this={editor} bind:usingTools {name} initial={[]} {stylusOnly} {autosaveMs} {surfaceTarget}
        backgroundHref={background} foregroundHref={foreground} imageHeight={document.height / document.width * DRAWING_WIDTH}
        strokeOpacity={document.layers[selected].visible ? document.layers[selected].opacity : 0}
        {initialDraft}
        onSave={async (strokes, requestWrite) => persist(await withStrokes(strokes), requestWrite)}
        {onCommit} {onExit} {onDelete} onExport={onExport ? (strokes) => { void withStrokes(strokes).then(onExport).catch((cause) => { error = cause; }); } : undefined} />
    {/key}
  {/if}
</div>

<style>
  .image-editor { min-height: 0; }
  .image-layers { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 14px; }
  .image-layers .field { margin: 0; font-size: inherit; }
  .image-layers :global(button) { min-height: 36px; }
</style>
