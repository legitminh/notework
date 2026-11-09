<script lang="ts">
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import { submitOnEnter } from '../form-shortcuts';
  import type { Source } from '../workspace';

  let { sources, busy, error, onConnect, onUpdate, onDisconnect }: {
    sources: Source[]; busy: boolean; error: unknown;
    onConnect: (owner: string, repo: string, branch: string, token: string) => Promise<boolean>;
    onUpdate: (id: string) => void;
    onDisconnect: (id: string) => void;
  } = $props();
  let repository = $state('');
  let branch = $state('');
  let token = $state('');
  let form: HTMLFormElement;
  let inputError = $state('');

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    inputError = '';
    const repo = repository.trim().match(/^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)\/?$/i);
    if (!repo || !token.trim()) { inputError = 'Enter owner/repository and a GitHub personal access token.'; return; }
    if (await onConnect(repo[1], repo[2].replace(/\.git$/i, ''), branch.trim(), token.trim())) {
      repository = ''; branch = ''; token = '';
    }
  }
</script>

<section class="panel" aria-labelledby="github-heading">
  <h2 id="github-heading">GitHub repositories</h2>
  <p class="muted">Connect a repository as a folder under Home. Notework checks the branch when it opens and saves edited files to GitHub when you exit them.</p>
  <ol>
    <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Create a fine-grained personal access token on GitHub</a>.</li>
    <li>Choose the repository owner and select only the repository you want to connect. Under repository permissions, click <strong>Add permissions</strong>, select <strong>Contents</strong>, then choose <strong>Read and write</strong>.</li>
    <li>Copy the token here. Use a repository with an initial commit and a branch where your account can push directly.</li>
  </ol>
  <p class="muted">The token is saved in this browser so Notework can connect next time. Notework sends it only to GitHub's API.</p>
  <form bind:this={form} use:submitOnEnter onsubmit={connect}>
    <label class="field">Repository <input bind:value={repository} placeholder="owner/repository" spellcheck="false" required disabled={busy} /></label>
    <label class="field">Branch <input bind:value={branch} placeholder="Default branch" spellcheck="false" disabled={busy} /></label>
    <label class="field">Personal access token <input bind:value={token} type="password" autocomplete="off" required disabled={busy} /></label>
    <Control onclick={() => form.requestSubmit()} disabled={busy}>Connect repository</Control>
  </form>
  {#if inputError || error}<StorageNotice error={inputError || error} />{/if}
  {#if sources.length}
    <h3>Connected repositories</h3>
    {#each sources as { id, github } (id)}
      <div class="config-row">
        <span>{github?.owner}/{github?.repo} · {github?.branch}</span>
        <Control class="small-button" onclick={() => onUpdate(id)} disabled={busy}>Update token</Control>
        <Control class="small-button" onclick={() => onDisconnect(id)} disabled={busy}>Disconnect</Control>
      </div>
    {/each}
  {/if}
</section>

<style>
  ol { padding-inline-start: 2.25em; font-size: .55em; line-height: 1.65; overflow-wrap: anywhere; }
</style>
