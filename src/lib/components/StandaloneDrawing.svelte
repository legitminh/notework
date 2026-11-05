<script lang="ts">
  import { onMount } from 'svelte';
  import type { Workspace, StateNode } from '../workspace';
  import { loadDrawing, saveDrawing, type DrawingResource } from '../drawing-files';
  import { isMissing } from '../filesystem';
  import { storageError } from '../browser-documents';
  import ExportDialog from './ExportDialog.svelte';
  import type { PdfMargins } from '../export-preferences';
  import { exportStyle } from '../export-style';
  import type { PdfSource } from '../pdf-export';
  import type { Drawing } from '../drawing';
  import DrawingEditor from './DrawingEditor.svelte';

  let { workspace, node, onExit, onMissing, stylusOnly, pdfMargins }: {
    stylusOnly: boolean;
    pdfMargins: PdfMargins;
    workspace: Workspace; node: StateNode; onExit: () => void; onMissing: () => void;
  } = $props();
  let resource = $state.raw<DrawingResource>();
  let error = $state('');
  let exportSource = $state.raw<PdfSource>();
  let editor = $state<HTMLDivElement>();
  function exportDrawing(strokes: Drawing) {
    const surface = editor!.querySelector<HTMLElement>('.drawing-surface')!;
    const width = surface.querySelector<HTMLElement>('.drawing-page-viewport')!.clientWidth;
    exportSource = { kind: 'drawing', name: node.name, strokes, style: exportStyle(surface, width, true, pdfMargins) };
  }

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        const handle = await workspace.handle(node.id);
        if (handle.kind !== 'file') throw new Error('The drawing is no longer a file.');
        const loaded = await loadDrawing(handle, node.storage);
        if (active) resource = loaded;
      } catch (cause) {
        if (!active) return;
        if (isMissing(cause)) onMissing();
        else error = storageError(cause);
      }
    })();
    return () => { active = false; };
  });
</script>

{#if resource}
  <div bind:this={editor}>
  <DrawingEditor {stylusOnly} name={node.name} initial={resource.strokes} {onExit} onExport={exportDrawing}
    onSave={async (strokes) => { resource = await saveDrawing(resource!, strokes); }} />
  </div>
{:else if error}
  <button type="button" onclick={onExit}>Exit</button>
  <p class="notice" role="alert">{error}</p>
{:else}
  <p class="muted" role="status">opening drawing…</p>
{/if}

{#if exportSource}
  <ExportDialog source={exportSource} onClose={() => { exportSource = undefined; }} />
{/if}
