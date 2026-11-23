<script lang="ts">
  import Control from './Control.svelte';
  import ChoiceMenu from './ChoiceMenu.svelte';
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

  function close() {
    dialog.close();
    onClose();
  }

  async function deliver() {
    if (!file || sharing) return;
    error = ''; status = '';
    if (!canShare) { downloadExport(file); close(); return; }
    sharing = true;
    try {
      // The PDF is already prepared: call share synchronously from this fresh tap.
      await navigator.share({ files: [file], title: file.name });
      close();
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') status = 'sharing cancelled.';
      else error = `the share sheet could not open. try again or download the ${label()}.`;
    } finally { sharing = false; }
  }

  function selectFormat(value: string) {
    format = value as ExportFormat;
    void prepare(format);
  }
</script>

<dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={dialog} aria-labelledby="export-heading"
  oncancel={(event) => { event.preventDefault(); if (!sharing) close(); }}>
  <h2 id="export-heading">export</h2>
  <ChoiceMenu label="export format" value={format} choices={[{ id: 'pdf', label: 'PDF' }, { id: 'png', label: 'PNG' }, { id: 'jpeg', label: 'JPEG' }]}
    onchange={selectFormat} disabled={sharing} />
  <p class="muted">one page. exports the current draft.</p>
  <p class="muted">margins (min-box): left {source.style.margins.left}, right {source.style.margins.right}, top {source.style.margins.top}, bottom {source.style.margins.bottom}.</p>
  {#if preparing}<p class="muted" role="status">preparing {label()}…</p>{/if}
  {#if status}<p class="muted" role="status">{status}</p>{/if}
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="editor-controls">
    <Control disabled={!file || sharing} onclick={deliver}>{canShare ? `share ${label()}` : `download ${label()}`}</Control>
    {#if canShare}<Control disabled={!file || sharing} onclick={() => { downloadExport(file!); close(); }}>download {label()}</Control>{/if}
    <Control onclick={close} disabled={sharing}>cancel</Control>
  </div>
</dialog>
