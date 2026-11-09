<script lang="ts">
  import { onMount } from 'svelte';
  import Control from './Control.svelte';
  import { submitOnEnter } from '../form-shortcuts';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import { storageError } from '../browser-documents';
  import type { GitHubConnection } from '../github/api';

  let { connection, onSave, onClose }: {
    connection: GitHubConnection;
    onSave: (token: string) => Promise<void>;
    onClose: (reconnected: boolean) => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let form: HTMLFormElement;
  let input: HTMLInputElement;
  let token = $state('');
  let busy = $state(false);
  let error = $state('');

  onMount(() => {
    dialog.showModal();
    input.focus();
  });

  function close(reconnected = false) {
    dialog.close();
    onClose(reconnected);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    if (!token.trim()) { error = 'Enter a GitHub personal access token.'; return; }
    busy = true; error = '';
    try {
      await onSave(token.trim());
      close(true);
    } catch (cause) { error = storageError(cause); }
    finally { busy = false; }
  }
</script>

<dialog bind:this={dialog} use:dialogShortcuts class="local-picker editor-exit github-reconnect"
  aria-labelledby="github-reconnect-heading" oncancel={(event) => { event.preventDefault(); if (!busy) close(); }}>
  <h2 id="github-reconnect-heading">Reconnect GitHub</h2>
  <p class="muted">{connection.owner}/{connection.repo} · {connection.branch}</p>
  <p class="muted"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a token on GitHub</a> if you need a new one. Use <strong>Add permissions</strong> to select <strong>Contents</strong> and choose <strong>Read and write</strong>.</p>
  <form bind:this={form} use:submitOnEnter onsubmit={save}>
    <label class="field">New personal access token
      <input bind:this={input} bind:value={token} type="password" autocomplete="off" required disabled={busy} />
    </label>
    {#if error}<p class="notice" role="alert">{error}</p>{/if}
    <div class="editor-controls">
      <Control onclick={() => form.requestSubmit()} disabled={busy}>Save token</Control>
      <Control onclick={() => close()} disabled={busy}>Cancel</Control>
    </div>
  </form>
</dialog>
