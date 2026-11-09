<script lang="ts">
  import Control from './Control.svelte';
  import { onMount } from 'svelte';
  import type { Workspace, StateNode, SearchProgress } from '../workspace';
  import Action from './Action.svelte';
  let { workspace, from, onNavigate, onOpen, graphRevision = 0, relocating = false, onChoose, busy = false }: {
    workspace: Workspace;
    from: string;
    onNavigate: (id: string) => void;
    onOpen: (node: StateNode) => void;
    graphRevision?: number;
    relocating?: boolean;
    onChoose?: (node: StateNode) => void;
    busy?: boolean;
  } = $props();
  let input: HTMLInputElement;
  let heading: HTMLHeadingElement;
  let query = $state('');
  let searching = $state(false);
  let searched = $state(false);
  let results = $state.raw<StateNode[]>([]);
  let progress = $state<SearchProgress>({ visited: 0, errors: 0, limited: false });
  let failure = $state('');
  let controller: AbortController | undefined;

  onMount(() => input.focus());
  $effect(() => {
    void graphRevision;
    const term = query.trim();
    const currentWorkspace = workspace;
    const origin = from;
    results = []; searched = false; failure = '';
    progress = { visited: 0, errors: 0, limited: false };
    searching = false;
    if (!term) return;
    const abort = new AbortController();
    controller = abort;
    const timer = setTimeout(() => {
      searching = true;
      void currentWorkspace.searchReachable(origin, term, abort.signal, (found, status) => {
        results = found; progress = status;
      }, 1000, true).then(() => { if (!abort.signal.aborted) searched = true; })
        .catch((error) => { if (!abort.signal.aborted) failure = String(error); })
        .finally(() => { if (!abort.signal.aborted) searching = false; });
    }, 180);
    return () => { clearTimeout(timer); abort.abort(); };
  });

  function stop() {
    controller?.abort(); searching = false; searched = true;
    failure = 'Search stopped. These are the results found so far.';
  }

  function leaveField() {
    heading.focus({ preventScroll: true });
  }

  function handleFieldKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.isComposing) return;
    // Native search inputs can clear their value on Escape. Keep the query/results.
    event.preventDefault();
    event.stopPropagation();
    leaveField();
  }
</script>

<section class="panel" aria-labelledby="search-heading">
  <h2 id="search-heading" tabindex="-1" bind:this={heading}>search reachable files and folders</h2>
  <p class="muted">Search names and paths through this state's outgoing links and folders.</p>
  <label class="field">
    <span>file/folder name or path</span>
    <input bind:this={input} bind:value={query} placeholder="start typing…" type="search" autocomplete="off"
      onkeydown={handleFieldKeydown} />
  </label>
  <Control class="search-field-exit" keys={relocating ? undefined : 'esc'} onclick={leaveField}>
    <span class="visually-hidden">esc </span>search results
  </Control>
  <Action label="edit search" onSelect={() => input.focus()} />
  <div aria-live="polite" class="search-status muted">
    {#if searching}searching… {progress.visited} states visited
    {:else if searched}{results.length} {results.length === 1 ? 'result' : 'results'} found{/if}
    {#if progress.errors} · {progress.errors} unreadable {progress.errors === 1 ? 'branch' : 'branches'} skipped; reconnect sources in app settings.{/if}
    {#if progress.limited} · Search limit reached. Narrow your starting folder or search term.{/if}
  </div>
  {#if searching}<Action label="stop search" onSelect={stop} />{/if}
  {#if failure}<p role="status" class="notice">{failure}</p>{/if}
  {#each results as node (node.id)}
    {#if node.kind === 'file'}
      <div class="file-navigation-row search-result-row">
        {#if !relocating}<Action label="open" onSelect={() => onOpen(node)} disabled={busy} />{/if}
        <Action label={node.name} onSelect={() => onNavigate(node.id)} disabled={busy}>
          <span class="hint">{workspace.label(node)}</span>
        </Action>
      </div>
    {:else}
      <div class="file-navigation-row search-result-row">
        {#if relocating}<Action label="choose" onSelect={() => onChoose?.(node)} disabled={busy} />{/if}
        <Action label={`${node.name}/`} onSelect={() => onNavigate(node.id)} disabled={busy}>
          <span class="hint">{workspace.label(node)}</span>
        </Action>
      </div>
    {/if}
  {/each}
</section>
