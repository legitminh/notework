<script lang="ts">
  import { onMount } from 'svelte';
  import type { PdfSource } from '../pdf-export';
  import { shareAvailable, downloadExport } from '../export-delivery';

  let { source, onClose }: { source: PdfSource; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let file = $state.raw<File>();
  let preparing = $state(true), sharing = $state(false), error = $state(''), status = $state('');
  let canShare = $state(false);
  const controller = new AbortController();

  onMount(() => {
    dialog.showModal();
    void (async () => {
      try {
        const { createPdf } = await import('../pdf-export');
        const prepared = await createPdf(source, controller.signal);
        if (controller.signal.aborted) return;
        file = prepared;
        canShare = shareAvailable(prepared);
      } catch (cause) {
        if (!controller.signal.aborted) error = cause instanceof Error ? cause.message : 'PDF export failed.';
      } finally { preparing = false; }
    })();
    return () => controller.abort();
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
      else error = 'The share sheet could not open. Try again or download the PDF.';
    } finally { sharing = false; }
  }
</script>

<dialog class="local-picker editor-exit" bind:this={dialog} aria-labelledby="export-heading"
  oncancel={(event) => { if (sharing) event.preventDefault(); else onClose(); }}>
  <h2 id="export-heading">Export</h2>
  <label class="field">format <select aria-label="Export format" disabled={sharing}><option value="pdf">PDF</option></select></label>
  <p class="muted">One page. Exports the current draft.</p>
  <p class="muted">Margins (min-box): left {source.style.margins.left}, right {source.style.margins.right}, top {source.style.margins.top}, bottom {source.style.margins.bottom}.</p>
  {#if preparing}<p class="muted" role="status">Preparing PDF…</p>{/if}
  {#if status}<p class="muted" role="status">{status}</p>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="editor-controls">
    <button type="button" disabled={!file || sharing} onclick={deliver}>{canShare ? 'Share PDF' : 'Download PDF'}</button>
    {#if canShare}<button type="button" disabled={!file || sharing} onclick={() => { downloadExport(file!); onClose(); }}>Download PDF</button>{/if}
    <button type="button" onclick={onClose} disabled={sharing}>Cancel</button>
  </div>
</dialog>
