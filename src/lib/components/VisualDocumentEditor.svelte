<script lang="ts">
  import { onMount } from 'svelte';
  import type { VisualEditor } from 'visual.editor';
  import VisualCanvas from './VisualCanvas.svelte';
  import Control from './Control.svelte';
  import ExportDialog from './ExportDialog.svelte';
  import ImageLoading from './ImageLoading.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import { exportStyle } from '../export-style';
  import type { PdfMargins } from '../export-preferences';
  import type { PdfSource } from '../pdf-export';
  import type { DrawingResource } from '../drawing-files';
  import type { Point } from '../drawing';
  import { canvasBlob, composite } from '../images';
  import { getBackgroundSync } from '../github/background.svelte';
  import { GitHubDirectory } from '../github/repository';
  import { flattenToImage, importBrushFile, openVisualDocument, publishVisualDocument, saveBrush, saveVisualDocument } from '../visual-documents';

  /** Editor for a `.visual` page-folder document (layers are sibling assets of the main file). */
  let { resource, stylusOnly, autosaveMs, pdfMargins, onExit, onSaved, onDelete, onRawText, surfaceTarget, usingTools = $bindable(false), initialPoint }: {
    resource: DrawingResource; stylusOnly: boolean; autosaveMs: number; pdfMargins: PdfMargins;
    onExit: () => void | Promise<void>; onSaved?: (resource: DrawingResource) => void; onDelete?: () => void | Promise<void>;
    onRawText?: () => void; surfaceTarget?: HTMLElement; usingTools?: boolean; initialPoint?: Point;
  } = $props();
  const sync = getBackgroundSync();
  const context = resource.visual!;
  let editor = $state.raw<VisualEditor>(), missingBrushes = $state<string[]>([]), error = $state.raw<unknown>();
  let canvas = $state<VisualCanvas>(), host = $state<HTMLDivElement>();
  let exportSource = $state.raw<PdfSource>();
  const github = context.folder instanceof GitHubDirectory;

  export async function saveForNavigation() { return await canvas?.saveForNavigation() ?? !editor; }
  export async function focusToolbar() { canvas?.focusToolbar(); }
  export function resumeEditing() { canvas?.resumeEditing(); }

  async function persist(requestWrite: boolean) {
    await saveVisualDocument(context, editor!, requestWrite);
    const { image, preview } = await flattenToImage(editor!);
    onSaved?.({ ...resource, image, preview, file: await resource.handle.getFile() });
  }
  async function exportImage() {
    const { image } = await flattenToImage(editor!);
    const blob = await canvasBlob(await composite(image));
    const surface = surfaceTarget ?? host!.querySelector<HTMLElement>('.drawing-surface')!;
    exportSource = { kind: 'image', name: resource.handle.name, image: { blob, width: image.width, height: image.height },
      style: exportStyle(surface, surface.clientWidth, true, pdfMargins) };
  }

  onMount(() => {
    let active = true;
    void openVisualDocument(context).then((opened) => {
      if (!active) return;
      editor = opened.editor; missingBrushes = opened.missingBrushes;
    }).catch((cause) => { if (active) error = cause; });
    return () => { active = false; };
  });
</script>

<div class="image-editor visual-document-editor" class:standalone-drawing-editor={!surfaceTarget} bind:this={host}>
  {#if editor}
    <VisualCanvas bind:this={canvas} bind:usingTools {editor} name={resource.handle.name} documentMode layered {missingBrushes}
      library={{ import: (file) => importBrushFile(context.workspace, file), save: (reference, brush) => saveBrush(context, reference, brush) }}
      initialDraft={github && context.pendingGitHub.size > 0} {stylusOnly} {autosaveMs} {surfaceTarget} {initialPoint}
      onSave={persist} onCommit={github ? () => publishVisualDocument(context, (node, file) => sync.enqueue(node, file)) : undefined}
      {onExit} {onDelete} {onRawText} onExport={() => { void exportImage().catch((cause) => error = cause); }} />
  {:else if error}<Control onclick={onExit}>Exit</Control><StorageNotice {error} />
  {:else}<ImageLoading />{/if}
</div>

{#if exportSource}<ExportDialog source={exportSource} onClose={() => { exportSource = undefined; }} />{/if}

<style>.visual-document-editor { min-height: 0; height: 100%; display: flex; flex-direction: column; }</style>
