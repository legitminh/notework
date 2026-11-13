<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { InputFrame } from '@legitminh/keyflow';
  import Control from './Control.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import type { Workspace } from '../workspace';
  let { workspace, from, graphRevision, onSelect, onClose }: { workspace: Workspace; from: string; graphRevision: number;
    onSelect: (id: string, open: boolean) => Promise<boolean>; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let busy = $state(false);
  let error = $state('');
  onMount(() => { const element = dialog; element.showModal(); void tick().then(() => element.querySelector<HTMLInputElement>('input[type=search]')?.focus()); return () => element.close(); });
  async function choose(id: string, open = false) {
    if (busy) return;
    busy = true; error = '';
    try { if (!await onSelect(id, open)) error = 'Save could not finish. Exit search to resolve the editor’s save message, then try again.'; }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
</script>

<InputFrame active name="Global search">
  <dialog class="local-picker global-search" bind:this={dialog} use:dialogShortcuts aria-label="Search all files"
    oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <Control onclick={onClose} disabled={busy}>Exit search</Control>
    <SearchPanel {workspace} {from} {graphRevision} {busy} escapeShortcut={false}
      onNavigate={(id) => { void choose(id); }} onOpen={(node) => { void choose(node.id, true); }} />
    {#if error}<p role="alert" class="notice">{error}</p>{/if}
  </dialog>
</InputFrame>
