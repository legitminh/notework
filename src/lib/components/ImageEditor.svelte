<script lang="ts">
  import ExportDialog from './ExportDialog.svelte';
  import ImageCanvasEditor from './ImageCanvasEditor.svelte';
  import { exportStyle } from '../export-style';
  import type { PdfMargins } from '../export-preferences';
  import type { PdfSource } from '../pdf-export';
  import { canvasBlob, composite, type ImageDocument } from '../images';
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
  let current: DrawingResource;
  let editor: ImageCanvasEditor;
  export async function saveForNavigation() { return await editor?.saveForNavigation() ?? false; }
  export function resumeEditing() { editor?.resumeEditing(); }
  async function persist(image: ImageDocument, requestWrite: boolean) {
    current = await saveImage(current ?? resource, image, requestWrite);
    onSaved?.(current);
  }
  async function commit() {
    const handle = (current ?? resource).handle;
    if (handle instanceof GitHubFile) await sync.enqueue(node, handle);
  }
  async function exportPng(image: ImageDocument) {
    const blob = await canvasBlob(await composite(image));
    const surface = surfaceTarget ?? host.querySelector<HTMLElement>('.drawing-surface')!;
    exportSource = { kind: 'image', name: resource.handle.name, image: { blob, width: image.width, height: image.height },
      style: exportStyle(surface, surface.clientWidth, true, pdfMargins) };
  }
</script>

<div class="image-editor-host" bind:this={host}>
  <ImageCanvasEditor bind:this={editor} bind:usingTools name={resource.handle.name} initial={resource.image!}
    initialDraft={resource.handle instanceof GitHubFile && !!resource.handle.repository.draft(resource.handle.path)}
    {stylusOnly} {autosaveMs} {surfaceTarget} onSave={persist}
    onCommit={resource.storage === 'github' ? commit : undefined} {onExit} {onDelete} onExport={exportPng} />
</div>

<style>
  .image-editor-host { height: 100%; min-height: 0; }
</style>

{#if exportSource}<ExportDialog source={exportSource} onClose={() => { exportSource = undefined; }} />{/if}
