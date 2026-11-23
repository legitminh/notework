<script lang="ts">
  import { getBackgroundSync } from '../github/background.svelte';
  import { GitHubFile } from '../github/repository';
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import ImageLoading from './ImageLoading.svelte';
  import { onMount } from 'svelte';
  import type { Workspace, StateNode } from '../workspace';
  import { hasDrawingDraft, loadDrawing, saveDrawing, type DrawingResource } from '../drawing-files';
  import { isMissing } from '../filesystem';
  import ExportDialog from './ExportDialog.svelte';
  import type { PdfMargins } from '../export-preferences';
  import { exportStyle } from '../export-style';
  import type { PdfSource } from '../pdf-export';
  import type { Drawing, Point } from '../drawing';
  import DrawingEditor from './DrawingEditor.svelte';
  import ImageEditor from './ImageEditor.svelte';
  import VisualDocumentEditor from './VisualDocumentEditor.svelte';

  let { workspace, node, onExit, onMissing, onRawText, stylusOnly, pdfMargins, autosaveMs, initialPoint }: {
    initialPoint?: Point;
    /** Visual documents: switch to the plaintext main file. */
    onRawText?: () => void;
    stylusOnly: boolean;
    autosaveMs: number;
    pdfMargins: PdfMargins;
    workspace: Workspace; node: StateNode; onExit: () => void | Promise<void>; onMissing: () => void;
  } = $props();
  const sync = getBackgroundSync();
  let drawingEditor = $state<{ saveForNavigation: () => Promise<boolean>; focusToolbar: () => void | Promise<void> }>();
  let mounted = false;
  export async function focusToolbar() {
    while (mounted && !drawingEditor && !error) await new Promise((resolve) => setTimeout(resolve, 20));
    await drawingEditor?.focusToolbar();
  }
  export async function saveForNavigation() { return await drawingEditor?.saveForNavigation() ?? !resource; }
  let resource = $state.raw<DrawingResource>();
  let error = $state.raw<unknown>();
  let exportSource = $state.raw<PdfSource>();
  let editor = $state<HTMLDivElement>();
  function exportDrawing(strokes: Drawing) {
    const surface = editor!.querySelector<HTMLElement>('.drawing-surface')!;
    const width = surface.querySelector<HTMLElement>('.drawing-page-viewport')!.clientWidth;
    exportSource = { kind: 'drawing', name: node.name, strokes, style: exportStyle(surface, width, true, pdfMargins) };
  }

  onMount(() => {
    mounted = true;
    let active = true;
    let releaseGitHubFile: (() => void) | undefined;
    void (async () => {
      try {
        const handle = await workspace.handle(node.id);
        if (handle.kind !== 'file') throw new Error('the drawing is no longer a file.');
        if (handle instanceof GitHubFile) {
          const file = await handle.getFile();
          if (!active) return;
          releaseGitHubFile = handle.repository.retainFile(handle.path, file);
        }
        const loaded = await loadDrawing(handle, node.storage, { workspace, node });
        if (active) resource = loaded;
      } catch (cause) {
        if (!active) return;
        if (isMissing(cause)) onMissing();
        else error = cause;
      }
    })();
    return () => { active = false; mounted = false; releaseGitHubFile?.(); };
  });
</script>

{#if resource}
  {#if resource.visual}
    <VisualDocumentEditor {initialPoint} bind:this={drawingEditor} {resource} {stylusOnly} {autosaveMs} {pdfMargins} {onExit} {onRawText} onSaved={(saved) => { resource = saved; }} />
  {:else if resource.image}
    <ImageEditor {initialPoint} bind:this={drawingEditor} {resource} {node} {stylusOnly} {autosaveMs} {pdfMargins} {onExit} onSaved={(saved) => { resource = saved; }} />
  {:else}
  <div class="standalone-drawing-editor" bind:this={editor}>
  <DrawingEditor {initialPoint} bind:this={drawingEditor} {stylusOnly} {autosaveMs} name={node.name} initial={resource.strokes} initialDraft={hasDrawingDraft(resource)} {onExit} onExport={exportDrawing}
    onSave={async (strokes, requestWrite) => { resource = await saveDrawing(resource!, strokes, requestWrite); }}
    onCommit={node.storage === 'github' ? async () => {
      if (resource?.handle instanceof GitHubFile) await sync.enqueue(node, resource.handle);
    } : undefined} />
  </div>
  {/if}
{:else if error}
  <Control onclick={onExit}>exit</Control>
  <StorageNotice {error} />
{:else}
  <ImageLoading />
{/if}

{#if exportSource}
  <ExportDialog source={exportSource} onClose={() => { exportSource = undefined; }} />
{/if}
