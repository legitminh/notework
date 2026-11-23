<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import { submitOnEnter } from '../form-shortcuts';
  import type { Source } from '../workspace';
  import { isNativeApp } from '../native-fs';
  import { accessibleRepositories, copyLater, finishDeviceLogin, forgetAccount, githubLoginUnavailable, installUrl, openDeviceLogin, savedAccount,
    startDeviceLogin, startRedirectLogin, type AccessibleRepository, type DeviceCode, type GitHubAccount } from '../github/app';

  let { sources, busy, error, onConnect, onLink, onUpdate, onDisconnect }: {
    sources: Source[]; busy: boolean; error: unknown;
    onConnect: (owner: string, repo: string, branch: string, token: string) => Promise<boolean>;
    onLink: (repositories: AccessibleRepository[], token: string) => Promise<boolean>;
    onUpdate: (id: string) => void;
    onDisconnect: (id: string) => void;
  } = $props();

  const unavailable = githubLoginUnavailable();
  let account = $state<GitHubAccount>();
  let code = $state<DeviceCode>();
  let login: AbortController | undefined;
  let repositories = $state<AccessibleRepository[]>();
  let chosen = $state<string[]>([]);
  let working = $state(false);
  let loginError = $state<unknown>();
  let usingToken = $state(false);

  const keyOf = ({ owner, repo }: { owner: string; repo: string }) => `${owner}/${repo}`.toLowerCase();
  const linked = $derived(new Set(sources.map(({ github }) => github ? keyOf(github) : '')));

  onMount(async () => {
    account = await savedAccount();
    if (account) await loadRepositories();
  });
  onDestroy(() => login?.abort());

  async function loadRepositories() {
    if (!account) return;
    working = true; loginError = undefined;
    try { repositories = await accessibleRepositories(account.token); }
    catch (cause) { loginError = cause; }
    finally { working = false; }
  }

  async function logIn() {
    if (working) return;
    working = true; loginError = undefined;
    if (!isNativeApp()) {
      // The browser goes to GitHub and comes back to Notework with the login.
      try { await startRedirectLogin(); }
      catch (cause) { loginError = cause; working = false; }
      return;
    }
    login = new AbortController();
    try {
      const started = startDeviceLogin();
      // Copy while this click still counts as the person's action; the code arrives shortly.
      copyLater(started.then((value) => value.user_code));
      code = await started;
      await openDeviceLogin(code).catch(() => {});
      account = await finishDeviceLogin(code, login.signal);
      code = undefined;
      working = false;
      await loadRepositories();
    } catch (cause) {
      if (!login?.signal.aborted) loginError = cause;
      code = undefined;
    } finally { working = false; login = undefined; }
  }

  function cancelLogin() { login?.abort(); code = undefined; working = false; }

  async function logOut() {
    if (!confirm('log out of GitHub in Notework? linked repositories keep syncing with their saved access until you revoke Notework on GitHub.')) return;
    await forgetAccount();
    account = undefined; repositories = undefined; chosen = [];
  }

  async function link() {
    if (!account || !repositories || busy) return;
    const selection = repositories.filter((item) => chosen.includes(keyOf(item)));
    if (await onLink(selection, account.token)) chosen = [];
  }

  let repository = $state('');
  let branch = $state('');
  let token = $state('');
  let form = $state<HTMLFormElement>();
  let inputError = $state('');

  async function connect(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    inputError = '';
    const repo = repository.trim().match(/^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)\/?$/i);
    if (!repo || !token.trim()) { inputError = 'enter owner/repository and a GitHub personal access token.'; return; }
    if (await onConnect(repo[1], repo[2].replace(/\.git$/i, ''), branch.trim(), token.trim())) {
      repository = ''; branch = ''; token = '';
    }
  }
</script>

<section class="panel" aria-labelledby="github-heading">
  <h2 id="github-heading">GitHub</h2>
  <p class="muted">link repositories as folders under home. use Cmd/Ctrl+S to save a draft while you keep editing. exiting an editor syncs it to GitHub in the background.</p>

  {#if unavailable}
    <p class="muted" role="status">{unavailable}</p>
  {:else if !account}
    {#if code}
      <p>enter this code on GitHub: <strong class="device-code">{code.user_code}</strong></p>
      <p class="muted">the code is copied and GitHub is open in your browser. paste the code there and approve Notework. Notework comes back to the front once GitHub approves it. <a href={code.verification_uri} target="_blank" rel="noreferrer">open GitHub again</a>.</p>
      <Control onclick={cancelLogin}>cancel login</Control>
    {:else}
      <p class="muted">log in once with the Notework GitHub App. Notework can reach only the repositories you allow, and you stay logged in until you log out or revoke the app on GitHub.</p>
      <Control onclick={() => { void logIn(); }} disabled={working || busy}>log in with GitHub</Control>
    {/if}
  {:else}
    <div class="config-row">
      <span>logged in as {account.login}</span>
      <Control class="small-button" onclick={() => { void logOut(); }} disabled={working || busy}>log out</Control>
    </div>
    <h3>choose repositories</h3>
    {#if repositories?.length}
      <div class="repository-list" role="group" aria-label="repositories Notework can reach">
        {#each repositories as item (keyOf(item))}
          {@const key = keyOf(item)}
          {@const selected = chosen.includes(key)}
          {@const name = `${item.owner}/${item.repo}${item.private ? ' · private' : ''}${linked.has(key) ? ' · linked' : !item.canPush ? ' · read-only' : ''}`}
          <Control class="repository" aria-label={name} aria-pressed={selected} disabled={busy || linked.has(key) || !item.canPush}
            onclick={() => { chosen = selected ? chosen.filter((other) => other !== key) : [...chosen, key]; }}>
            {selected ? '✓ ' : ''}{name}
          </Control>
        {/each}
      </div>
      <Control onclick={() => { void link(); }} disabled={busy || working || !chosen.length}>
        {chosen.length > 1 ? `link ${chosen.length} repositories` : 'link repository'}
      </Control>
    {:else if repositories}
      <p class="muted">Notework can't reach any repositories yet. allow some on GitHub, then refresh the list.</p>
    {/if}
    <div class="editor-controls">
      <Control onclick={() => { window.open(installUrl(), '_blank', 'noreferrer'); }} disabled={working}>allow more repositories on GitHub</Control>
      <Control onclick={() => { void loadRepositories(); }} disabled={working || busy}>refresh list</Control>
    </div>
  {/if}
  {#if loginError}<StorageNotice error={loginError} />{/if}

  <Control onclick={() => { usingToken = !usingToken; }} aria-pressed={usingToken}>
    {usingToken ? 'hide personal access token' : 'use a personal access token instead'}
  </Control>
  {#if usingToken}
    <ol>
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">create a fine-grained personal access token on GitHub</a>.</li>
      <li>choose the repository owner and select only the repository you want to link. under repository permissions, click <strong>Add permissions</strong>, select <strong>Contents</strong>, then choose <strong>Read and write</strong>.</li>
      <li>copy the token here. use a repository with an initial commit and a branch where your account can push directly.</li>
    </ol>
    <form bind:this={form} use:submitOnEnter onsubmit={connect}>
      <label class="field">repository <input bind:value={repository} placeholder="owner/repository" spellcheck="false" required disabled={busy} /></label>
      <label class="field">branch <input bind:value={branch} placeholder="default branch" spellcheck="false" disabled={busy} /></label>
      <label class="field">personal access token <input bind:value={token} type="password" autocomplete="off" required disabled={busy} /></label>
      <Control onclick={() => form?.requestSubmit()} disabled={busy}>link repository</Control>
    </form>
    {#if inputError}<StorageNotice error={inputError} />{/if}
  {/if}
  <p class="muted">your GitHub access is saved in this app so it can sync next time. Notework sends it only to GitHub.</p>
  {#if error}<StorageNotice {error} />{/if}

  {#if sources.length}
    <h3>linked repositories</h3>
    {#each sources as { id, github } (id)}
      <div class="config-row">
        <span>{github?.owner}/{github?.repo} · {github?.branch}</span>
        <Control class="small-button" onclick={() => onUpdate(id)} disabled={busy}>update token</Control>
        <Control class="small-button" onclick={() => onDisconnect(id)} disabled={busy}>unlink</Control>
      </div>
    {/each}
  {/if}
</section>

<style>
  ol { padding-inline-start: 2.25em; font-size: .55em; line-height: 1.65; overflow-wrap: anywhere; }
  .device-code { font-family: ui-monospace, monospace; letter-spacing: .1em; user-select: all; }
  .repository-list { display: grid; gap: .25em; margin-block: .5em; }
</style>
