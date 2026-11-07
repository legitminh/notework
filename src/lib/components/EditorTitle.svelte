<script lang="ts">
  import Control from './Control.svelte';

  let { name, onEdit }: { name: string; onEdit?: () => void } = $props();
</script>

<h1>
  {#if onEdit}
    <Control class="edit-page-title" keys="esc" aria-keyshortcuts="Escape" onclick={onEdit}>Edit {name}</Control>
  {:else}
    {name}
  {/if}
</h1>
