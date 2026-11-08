<script lang="ts">
  import { onMount } from 'svelte';
  import Control from './Control.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import { decodedChunks, encodedChunks, inspectTextFile, type TextFormat } from '../text-resource';
  import type { GitHubConflict } from '../github/repository';

  let { conflict, onChoose }: { conflict: GitHubConflict; onChoose: (value?: Blob | null) => void } = $props();
  let dialog: HTMLDialogElement;
  let local = $state('');
  let upstream = $state('');
  let left = $state.raw<{ text: string; format: TextFormat } | null>();
  let right = $state.raw<{ text: string; format: TextFormat } | null>();
  let ready = $state(false);
  let error = $state('');

  async function read(blob: Blob | null) {
    if (!blob) return null;
    const file = new File([blob], conflict.path.split('/').at(-1)!);
    const format = await inspectTextFile(file);
    if (!format) return null;
    let text = '';
    for await (const chunk of decodedChunks(file, format)) text += chunk;
    return { text: text.replace(/\r\n?/g, '\n'), format };
  }

  onMount(() => {
    dialog.showModal();
    void Promise.all([read(conflict.local), read(conflict.upstream)]).then(([a, b]) => {
      left = a; right = b; local = a?.text ?? ''; upstream = b?.text ?? ''; ready = true;
    }).catch(() => { error = 'Could not open the versions for comparison. Cancel and retry the save.'; });
  });

  function choose(side: 'local' | 'upstream') {
    const original = conflict[side];
    const editor = side === 'local' ? left : right;
    const text = side === 'local' ? local : upstream;
    onChoose(!editor || editor.text === text ? original : new Blob([...encodedChunks([text], editor.format)]));
  }
</script>

<dialog class="github-conflict local-picker" bind:this={dialog} use:dialogShortcuts aria-labelledby="github-conflict-heading"
  oncancel={(event) => { event.preventDefault(); onChoose(); }}>
  <h2 id="github-conflict-heading">GitHub conflict</h2>
  <p>“{conflict.path}” changed on GitHub while you were editing. Edit either version, then choose which one to keep.</p>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if ready}
    <div class="conflict-versions">
      <div>
        {#if left}
          <label>Your version <textarea bind:value={local} spellcheck="false"></textarea></label>
        {:else}
          <p>Your version cannot be edited as text.</p>
        {/if}
        <Control onclick={() => choose('local')}>Keep your version</Control>
      </div>
      <div>
        {#if right}
          <label>GitHub version <textarea bind:value={upstream} spellcheck="false"></textarea></label>
        {:else}
          <p>{conflict.upstream ? 'The GitHub version cannot be edited as text.' : 'This file was deleted on GitHub.'}</p>
        {/if}
        <Control onclick={() => choose('upstream')}>{conflict.upstream ? 'Keep GitHub version' : 'Keep GitHub deletion'}</Control>
      </div>
    </div>
  {:else if !error}
    <p role="status">Opening versions…</p>
  {/if}
  <Control onclick={() => onChoose()}>Cancel</Control>
</dialog>

<style>
  .github-conflict { width: min(92vw, 86rem); max-width: 92vw; }
  .conflict-versions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .75rem; margin-block: 1rem; }
  textarea {
    display: block; box-sizing: border-box; width: 100%; height: 46dvh; resize: vertical;
    font: .95rem/1.5 var(--font-mono); color: var(--primary); background: var(--background);
    border: 1px solid var(--tertiary); padding: .45rem; margin-block: .35rem;
  }
</style>
