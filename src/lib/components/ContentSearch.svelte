<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { InputFrame } from '@legitminh/keyflow';
  import Control from './Control.svelte';
  import Action from './Action.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import { ContentSearch, type IndexProgress } from '../content-search';
  import type { ContentResults } from '../content-index';
  import type { StateNode, Workspace } from '../workspace';

  let { workspace, index, from, label, graphRevision, onOpen, onClose }: {
    workspace: Workspace; index: ContentSearch; from: string; label: string; graphRevision: number;
    onOpen: (node: StateNode, position: number) => Promise<void>; onClose: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let input: HTMLInputElement;
  let heading: HTMLHeadingElement;
  let query = $state('');
  let progress = $state<IndexProgress>({ visited: 0, total: 0, errors: 0, done: false });
  let results = $state.raw<ContentResults>();
  let failure = $state('');
  let busy = $state(false);
  let searching = $state(false);
  let limit = $state(200);
  let rescan = $state(0);
  let stopped = $state(false);
  let generation = 0;
  let controller: AbortController | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let ready = false;

  onMount(() => {
    const element = dialog;
    element.showModal();
    void tick().then(() => input.focus());
    const refresh = () => { if (!document.hidden && !stopped) rescan++; };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh);
    return () => { element.close(); clearInterval(timer); window.removeEventListener('focus', refresh); clearTimeout(updateTimer); generation++; };
  });

  $effect(() => {
    void graphRevision;
    void rescan;
    const currentWorkspace = workspace, origin = from;
    const abort = new AbortController();
    controller = abort;
    ready = false; results = undefined; failure = '';
    stopped = false;
    progress = { visited: 0, total: 0, errors: 0, done: false };
    generation++;
    void index.prepare(currentWorkspace, origin, abort.signal, (status) => {
      if (abort.signal.aborted) return;
      progress = status;
      ready = true;
      // Streaming indexing must not enqueue one query per file.
      if (!updateTimer) updateTimer = setTimeout(() => {
        updateTimer = undefined;
        if (!abort.signal.aborted) void search();
      }, 80);
    }).catch((error) => { if (!abort.signal.aborted) { failure = String(error); searching = false; } });
    return () => { abort.abort(); clearTimeout(updateTimer); updateTimer = undefined; generation++; };
  });

  $effect(() => {
    void query; void limit;
    generation++; results = undefined;
    // Coalesce a burst of keystrokes without a perceptible debounce.
    const timer = setTimeout(() => { void search(); }, 35);
    return () => clearTimeout(timer);
  });

  async function search() {
    const current = ++generation;
    if (!query || !ready) { searching = false; results = undefined; return; }
    searching = true;
    try {
      const found = await index.search(query, limit);
      if (current === generation) results = found;
    } catch (error) { if (current === generation) failure = String(error); }
    finally { if (current === generation) searching = false; }
  }

  async function open(node: StateNode, position: number) {
    if (busy) return;
    busy = true;
    try { await onOpen(node, position); }
    catch (error) { failure = String(error); }
    finally { busy = false; }
  }

  async function stop() {
    stopped = true;
    controller?.abort(); clearTimeout(updateTimer); updateTimer = undefined;
    progress = { ...progress, done: true };
    failure = 'Indexing stopped. Results include only files checked so far.';
    try { await index.freeze(); await search(); }
    catch (error) { failure = String(error); }
  }
</script>

<InputFrame active name="Find in contents">
  <dialog class="local-picker content-search" bind:this={dialog} use:dialogShortcuts aria-label="Find in contents"
    oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <Control onclick={onClose} disabled={busy}>Exit search</Control>
    <h2 tabindex="-1" bind:this={heading}>find in contents</h2>
    <p class="muted">Search text in {label} and its reachable children. Case insensitive, literal text. Contents stay in this tab.</p>
    <label class="field">
      <span>containing text</span>
      <input bind:this={input} bind:value={query} type="search" placeholder="text, code, or punctuation…" autocomplete="off"
        onkeydown={(event) => {
          if (event.key === 'Escape' && !event.isComposing) {
            event.preventDefault(); event.stopPropagation(); heading.focus({ preventScroll: true });
          }
        }} />
    </label>
    <Control class="search-field-exit" onclick={() => heading.focus({ preventScroll: true })}>search results</Control>
    <Action label="edit search" onSelect={() => input.focus()} />
    <p class="content-search-status muted" role="status" aria-live="polite">
      {#if !progress.done}indexing… {progress.visited}/{progress.total} files checked
      {:else}{stopped ? 'index paused' : 'index ready'} · {progress.visited} files checked{/if}
      {#if query && results} · {results.hits.length}{results.limited ? '+' : ''} matching {results.hits.length === 1 ? 'file' : 'files'} · {Math.ceil(results.milliseconds)} ms
      {:else if query && searching} · searching…{/if}
      {#if progress.errors} · {progress.errors} unreadable {progress.errors === 1 ? 'resource' : 'resources'} skipped; reconnect sources in app settings.{/if}
    </p>
    {#if !progress.done}<Action label="stop indexing" onSelect={stop} />{/if}
    <Action label="refresh index" onSelect={() => { rescan++; }} disabled={!progress.done} />
    {#if failure}<p class="notice" role="alert">{failure}</p>{/if}
    {#if results}
      {#each results.hits as hit (hit.id)}
        {@const node = index.nodes.get(hit.id)}
        {#if node}
          <section class="content-search-result" aria-label={workspace.label(node)}>
            <Action label={node.name} onSelect={() => { void open(node, hit.matches[0].position); }} disabled={busy}>
              <span class="resource-hint">{workspace.label(node)}</span>
            </Action>
            {#each hit.matches as match}
              <Control class="content-match" onclick={() => { void open(node, match.position); }} disabled={busy}>
                <span class="content-match-line">{match.line}:</span>
                <code>{match.before}<mark>{match.text}</mark>{match.after}</code>
              </Control>
            {/each}
          </section>
        {/if}
      {/each}
      {#if results.limited}
        <p class="muted">Showing {limit} matching files, with up to three previews per file. Narrow your search or show more.</p>
        <Action label="show more results" onSelect={() => { limit += 200; }} />
      {/if}
    {/if}
  </dialog>
</InputFrame>
