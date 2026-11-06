<script lang="ts">
  import Control from './Control.svelte';
  import { onMount } from 'svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import type { ExportFormat, PdfSource } from '../pdf-export';
  import { shareAvailable, downloadExport } from '../export-delivery';

  let { source, onClose }: { source: PdfSource; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let file = $state.raw<File>();
  let format = $state<ExportFormat>('pdf');
  let preparing = $state(true), sharing = $state(false), error = $state(''), status = $state('');
  let canShare = $state(false);
  let preparation: AbortController | undefined;
  const label = () => format === 'pdf' ? 'PDF' : format === 'png' ? 'PNG' : 'JPEG';

  async function prepare(next: ExportFormat) {
    preparation?.abort();
    const controller = new AbortController();
    preparation = controller;
    file = undefined; canShare = false; preparing = true; error = ''; status = '';
    try {
      const { createExport } = await import('../pdf-export');
      const prepared = await createExport(source, next, controller.signal);
      if (controller.signal.aborted || preparation !== controller) return;
      file = prepared;
      canShare = shareAvailable(prepared);
    } catch (cause) {
      if (!controller.signal.aborted && preparation === controller) {
        error = cause instanceof Error ? cause.message : `${label()} export failed.`;
      }
    } finally {
      if (preparation === controller) preparing = false;
    }
  }

  onMount(() => {
    dialog.showModal();
    void prepare(format);
    return () => preparation?.abort();
  });

  async function deliver() {
    if (!file || sharing) return;
    error = ''; status = '';
    if (!canShare) { downloadExport(file); onClose(); return; }
    sharing = true;
    try {
      // The PDF is already prepared: call share synchronously from this fresh tap.
      await navigator.share({ files: [file], title: file.name });
      onClose();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') status = 'Sharing cancelled.';
      else error = `The share sheet could not open. Try again or download the ${label()}.`;
    } finally { sharing = false; }
  }

  function selectFormat(event: Event) {
    format = (event.currentTarget as HTMLSelectElement).value as ExportFormat;
    void prepare(format);
  }
</script>

<dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={dialog} aria-labelledby="export-heading"
  oncancel={(event) => { if (sharing) event.preventDefault(); else onClose(); }}>
  <h2 id="export-heading">Export</h2>
  <label class="field">format <select aria-label="Export format" value={format} onchange={selectFormat} disabled={sharing}>
    <option value="pdf">PDF</option><option value="png">PNG</option><option value="jpeg">JPEG</option>
  </select></label>
  <p class="muted">One page. Exports the current draft.</p>
  <p class="muted">Margins (min-box): left {source.style.margins.left}, right {source.style.margins.right}, top {source.style.margins.top}, bottom {source.style.margins.bottom}.</p>
  {#if preparing}<p class="muted" role="status">Preparing {label()}…</p>{/if}
  {#if status}<p class="muted" role="status">{status}</p>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="editor-controls">
    <Control disabled={!file || sharing} onclick={deliver}>{canShare ? `Share ${label()}` : `Download ${label()}`}</Control>
    {#if canShare}<Control disabled={!file || sharing} onclick={() => { downloadExport(file!); onClose(); }}>Download {label()}</Control>{/if}
    <Control onclick={onClose} disabled={sharing}>Cancel</Control>
  </div>
</dialog>
