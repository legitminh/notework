<script lang="ts">
  import { onMount } from 'svelte';
  import Menu from './Menu.svelte';
  import Control from './Control.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';

  export type SearchMode = 'folder-text' | 'folder-files' | 'all-text' | 'all-files';
  let { onChoose, onClose }: { onChoose: (mode: SearchMode) => void; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => { const element = dialog; element.showModal(); return () => element.close(); });
</script>

<dialog class="local-picker search-menu" bind:this={dialog} use:dialogShortcuts aria-label="search"
    oncancel={(event) => { event.preventDefault(); onClose(); }}>
  <Menu label="search" showTrigger={false} open={true} backLabel="cancel" onclose={onClose}>
    {#snippet children()}
    <h2>search</h2>
    <Control aria-label="search text in folder children" onclick={() => onChoose('folder-text')}>search text in folder children <span class="resource-hint">Cmd/Ctrl+F</span></Control>
    <Control aria-label="search file in folder children" onclick={() => onChoose('folder-files')}>search file in folder children <span class="resource-hint">Cmd/Ctrl+P</span></Control>
    <Control aria-label="search text in all files" onclick={() => onChoose('all-text')}>search text in all files <span class="resource-hint">Cmd/Ctrl+Shift+F</span></Control>
    <Control aria-label="search file in all files" onclick={() => onChoose('all-files')}>search file in all files <span class="resource-hint">Cmd/Ctrl+Shift+P</span></Control>
    {/snippet}
  </Menu>
</dialog>
