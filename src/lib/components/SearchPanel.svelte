<script lang="ts">
  import { onMount } from 'svelte';
  import { searchReachable, type Workspace, type StateNode, type SearchProgress } from '../workspace';
  import Action from './Action.svelte';
  let { workspace, from, onNavigate, graphRevision = 0 }: { workspace: Workspace; from: string; onNavigate: (id: string) => void; graphRevision?: number } = $props();
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
      void searchReachable(currentWorkspace, origin, term, abort.signal, (found, status) => {
        results = found; progress = status;
      }).then(() => { if (!abort.signal.aborted) searched = true; })
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
  <h2 id="search-heading" tabindex="-1" bind:this={heading}>search reachable files</h2>
  <p class="muted">Search names and paths through this state's outgoing links and folders.</p>
  <label class="field">
    <span>file name or path</span>
    <input bind:this={input} bind:value={query} placeholder="start typing…" type="search" autocomplete="off"
      onkeydown={handleFieldKeydown} />
  </label>
  <button type="button" class="search-field-exit" aria-keyshortcuts="Escape" onclick={leaveField}>
    <kbd>esc</kbd><span>search results</span>
  </button>
  <Action label="edit search" onSelect={() => input.focus()} />
  <div aria-live="polite" class="search-status muted">
    {#if searching}searching… {progress.visited} states visited
    {:else if searched}{results.length} {results.length === 1 ? 'file' : 'files'} found{/if}
    {#if progress.errors} · {progress.errors} unreadable {progress.errors === 1 ? 'branch' : 'branches'} skipped; reconnect sources in app settings.{/if}
    {#if progress.limited} · Search limit reached. Narrow your starting folder or search term.{/if}
  </div>
  {#if searching}<Action label="stop search" onSelect={stop} />{/if}
  {#if failure}<p role="status" class="notice">{failure}</p>{/if}
  {#each results as node (node.id)}
    <Action label={node.name} onSelect={() => onNavigate(node.id)}>
      <span class="hint">{workspace.label(node)}</span>
    </Action>
  {/each}
</section>
