<script lang="ts">
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import { getBackgroundSync } from '../github/background.svelte';
  const sync = getBackgroundSync();
</script>

{#if sync.pending}
<div class="sync-progress">
  {#if sync.running}
    <p role="status">Syncing to GitHub in the background · {sync.pending} pending</p>
    <progress aria-label="Syncing to GitHub"></progress>
  {:else}
    <p role="status">{sync.conflict ? 'GitHub sync needs review' : 'GitHub sync paused'} · {sync.pending} pending · resumes when available</p>
    {#if sync.problem}<StorageNotice error={sync.problem} role="status" />{/if}
    <Control onclick={() => sync.retry(sync.conflict)}>{sync.conflict ? 'Review GitHub conflict' : 'Retry GitHub sync'}</Control>
  {/if}
</div>
{/if}

<style>
  .sync-progress { position: fixed; inset: auto 0 0; z-index: 40; padding: 6px 10px calc(6px + env(safe-area-inset-bottom)); color: var(--primary); background: var(--background); border-top: 1px solid var(--tertiary); font-size: 14px; }
  .sync-progress :global(.notice) { margin: 0; font-size: inherit; }
  progress { display: block; width: 100%; height: 4px; margin-top: 4px; accent-color: var(--primary); }
  :global(.virtual-keyboard-open) .sync-progress { bottom: var(--keyboard-height); }
</style>
