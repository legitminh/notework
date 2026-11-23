<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { InputFrame } from '@legitminh/keyflow';
  import Control from './Control.svelte';
  import SearchPanel from './SearchPanel.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import type { Workspace, StateNode } from '../workspace';
  let { workspace, from, everywhere = true, scopeLabel = 'home', graphRevision, relocating = false, onChoose, onSelect, onClose }: { workspace: Workspace; from: string; everywhere?: boolean; scopeLabel?: string; graphRevision: number;
    relocating?: boolean; onChoose: (node: StateNode) => void;
    onSelect: (id: string, open: boolean) => Promise<boolean>; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let busy = $state(false);
  let error = $state('');
  onMount(() => { const element = dialog; element.showModal(); void tick().then(() => element.querySelector<HTMLInputElement>('input[type=search]')?.focus()); return () => element.close(); });
  async function choose(id: string, open = false) {
    if (busy) return;
    busy = true; error = '';
    try { if (!await onSelect(id, open)) error = 'save could not finish. exit search to resolve the editor’s save message, then try again.'; }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
</script>

<InputFrame active name="global search">
  <dialog class="local-picker global-search" bind:this={dialog} use:dialogShortcuts aria-label={everywhere ? 'search all files' : 'search files in folder children'}
    oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <Control onclick={onClose} disabled={busy}>exit search</Control>
    <SearchPanel {workspace} {from} {everywhere} {scopeLabel} {graphRevision} {busy} {relocating} {onChoose}
      onNavigate={(id) => { void choose(id); }} onOpen={(node) => { void choose(node.id, true); }} />
    {#if error}<p role="alert" class="notice">{error}</p>{/if}
  </dialog>
</InputFrame>
