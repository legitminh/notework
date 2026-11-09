<script lang="ts">
  import Control from './Control.svelte';
  import { storageError } from '../browser-documents';
  import { GitHubApiError } from '../github/api';
  import { getGitHubRecovery } from '../github/recovery';

  let { error, role = 'alert' }: { error: unknown; role?: 'alert' | 'status' } = $props();
  const recovery = getGitHubRecovery();
  let dismissed = $state.raw<unknown>();
  const repositoryId = $derived(error instanceof GitHubApiError && error.canReconnect && error.repositoryId &&
    recovery.available(error.repositoryId) ? error.repositoryId : undefined);

  async function reconnect(id: string) {
    const before = error;
    if (await recovery.reconnect(id)) dismissed = before;
  }
</script>

{#if error !== dismissed}
  <div class="notice">
    <p {role}>{typeof error === 'string' ? error : storageError(error)}</p>
    {#if repositoryId}
      <Control onclick={() => reconnect(repositoryId!)}>Reconnect GitHub</Control>
    {/if}
  </div>
{/if}
