<script lang="ts">
  import { onMount } from 'svelte';
  import { VisualEditor, decodeImage, encodePng } from 'visual.editor';
  import VisualCanvas from './VisualCanvas.svelte';
  import ImageLoading from './ImageLoading.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import type { ImageDocument } from '../images';
  import type { Point } from '../drawing';

  /** PNG/JPEG/HEIC/ORA images edited through the visual.editor engine; saved back in their own format. */
  let { name, initial, initialDraft = false, stylusOnly, autosaveMs, onSave, onCommit, onExit, onDelete, onExport, surfaceTarget, usingTools = $bindable(false), initialPoint }: {
    name: string; initial: ImageDocument; initialDraft?: boolean; stylusOnly: boolean; autosaveMs: number;
    onSave: (image: ImageDocument, requestWrite: boolean) => Promise<void>;
    onCommit?: () => Promise<void>; onExit?: () => void | Promise<void>; onDelete?: () => void | Promise<void>;
    onExport?: (image: ImageDocument) => void; surfaceTarget?: HTMLElement; usingTools?: boolean; initialPoint?: Point;
  } = $props();
  const layered = $derived(name.toLowerCase().endsWith('.ora'));
  let editor = $state.raw<VisualEditor>(), error = $state.raw<unknown>();
  let canvas = $state<VisualCanvas>();

  export async function saveForNavigation() { return await canvas?.saveForNavigation() ?? !editor; }
  export async function focusToolbar() {
    // The canvas mounts after decoding; wait briefly so editor-history navigation can focus its toolbar.
    for (let waited = 0; !canvas && !error && waited < 10_000; waited += 20) await new Promise((resolve) => setTimeout(resolve, 20));
    canvas?.focusToolbar();
  }
  export function resumeEditing() { canvas?.resumeEditing(); }

  /** Engine layers are bottom→top; ImageDocument layers are top→bottom. */
  async function toImage(source: VisualEditor): Promise<ImageDocument> {
    const layers = [];
    for (const layer of [...source.layers].reverse()) {
      const png = new Blob([await encodePng(source.layerPixels(layer)) as BlobPart], { type: 'image/png' });
      layers.push({ name: layer.entry.name ?? 'Layer', png, visible: layer.entry.visible, opacity: layer.entry.opacity });
    }
    return { width: source.width, height: source.height, layers };
  }

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        const layers = await Promise.all([...initial.layers].reverse().map(async (layer) => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity, image: await decodeImage(layer.png) })));
        if (!active) return;
        const created = VisualEditor.fromImages(name.replace(/\.[^.]+$/, ''), initial.width, initial.height, layers);
        // Keep the image editor's familiar defaults: a 3 px pen and 16 px eraser.
        created.setState({ brushSize: 3, eraserSize: 16 });
        editor = created;
      } catch (cause) { if (active) error = cause; }
    })();
    return () => { active = false; };
  });
</script>

<div class="image-editor" class:standalone-drawing-editor={!surfaceTarget}>
  {#if editor}
    <VisualCanvas bind:this={canvas} bind:usingTools {editor} {name} {layered} {initialDraft} {stylusOnly} {autosaveMs} {surfaceTarget} {initialPoint}
      onSave={async (requestWrite) => {
        const source = editor!, versions = new Map(source.layers.map((layer) => [layer.id, source.layerVersion(layer)]));
        await onSave(await toImage(source), requestWrite);
        source.markSaved({ main: '', versions });
      }}
      {onCommit} {onExit} {onDelete} onExport={onExport ? () => { void toImage(editor!).then(onExport).catch((cause) => error = cause); } : undefined} />
  {:else if error}<StorageNotice {error} />
  {:else}<ImageLoading />{/if}
</div>
<style>.image-editor { min-height: 0; height: 100%; display: flex; flex-direction: column; }</style>
