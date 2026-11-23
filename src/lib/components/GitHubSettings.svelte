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
  <p class="muted">connect a repository as a folder under home. use Cmd/Ctrl+S to save a draft in this browser while you keep editing. exiting an editor syncs it to GitHub in the background without waiting.</p>
  <ol>
    <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">create a fine-grained personal access token on GitHub</a>.</li>
    <li>choose the repository owner and select only the repository you want to connect. under repository permissions, click <strong>Add permissions</strong>, select <strong>Contents</strong>, then choose <strong>Read and write</strong>.</li>
    <li>copy the token here. use a repository with an initial commit and a branch where your account can push directly.</li>
  </ol>
  <p class="muted">the token is saved in this browser so Notework can connect next time. Notework sends it only to GitHub's API.</p>
  <form bind:this={form} use:submitOnEnter onsubmit={connect}>
    <label class="field">repository <input bind:value={repository} placeholder="owner/repository" spellcheck="false" required disabled={busy} /></label>
    <label class="field">branch <input bind:value={branch} placeholder="default branch" spellcheck="false" disabled={busy} /></label>
    <label class="field">personal access token <input bind:value={token} type="password" autocomplete="off" required disabled={busy} /></label>
    <Control onclick={() => form.requestSubmit()} disabled={busy}>connect repository</Control>
  </form>
  {#if inputError || error}<StorageNotice error={inputError || error} />{/if}
  {#if sources.length}
    <h3>connected repositories</h3>
    {#each sources as { id, github } (id)}
      <div class="config-row">
        <span>{github?.owner}/{github?.repo} · {github?.branch}</span>
        <Control class="small-button" onclick={() => onUpdate(id)} disabled={busy}>update token</Control>
        <Control class="small-button" onclick={() => onDisconnect(id)} disabled={busy}>disconnect</Control>
      </div>
    {/each}
  {/if}
</section>

<style>
  ol { padding-inline-start: 2.25em; font-size: .55em; line-height: 1.65; overflow-wrap: anywhere; }
</style>
