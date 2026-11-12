<script lang="ts">
  import { onMount } from 'svelte';
  import Control from './Control.svelte';
  import GitHubConflictVersion from './GitHubConflictVersion.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import type { GitHubConflict } from '../github/repository';

  let { conflict, onChoose, stylusOnly, autosaveMs }: {
    conflict: GitHubConflict; onChoose: (value?: Blob | null) => void; stylusOnly: boolean; autosaveMs: number;
  } = $props();
  let dialog: HTMLDialogElement;
  let local: GitHubConflictVersion;
  let upstream: GitHubConflictVersion;
  let busy = $state(false);
  let error = $state('');
  onMount(() => { dialog.showModal(); });

  async function choose(version: GitHubConflictVersion) {
    if (busy) return;
    busy = true; error = '';
    try { onChoose(await version.value()); }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Could not keep this version. Try again.'; }
    finally { busy = false; }
  }
</script>

<dialog class="github-conflict local-picker" bind:this={dialog} use:dialogShortcuts aria-labelledby="github-conflict-heading"
  oncancel={(event) => { event.preventDefault(); if (!busy) onChoose(); }}>
  <h2 id="github-conflict-heading">GitHub conflict</h2>
  <p>“{conflict.path}” changed on GitHub while you were editing. Edit either version, then choose which one to keep.</p>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="conflict-versions">
    <GitHubConflictVersion bind:this={local} blob={conflict.local} path={conflict.path} label="Your version"
      {stylusOnly} {autosaveMs} disabled={busy} onChoose={() => { void choose(local); }} />
    <GitHubConflictVersion bind:this={upstream} blob={conflict.upstream} path={conflict.path} label="GitHub version"
      {stylusOnly} {autosaveMs} disabled={busy} onChoose={() => { void choose(upstream); }} />
  </div>
  <Control disabled={busy} onclick={() => onChoose()}>Cancel</Control>
</dialog>

<style>
  .github-conflict { width: min(92vw, 86rem); max-width: 92vw; }
  .conflict-versions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .75rem; margin-block: 1rem; }
  @media (max-width: 700px) { .conflict-versions { grid-template-columns: minmax(0, 1fr); } }
</style>
