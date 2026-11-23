<script lang="ts">
  // Folder browser for the native app: chooses machine folders and files without the
  // system dialog, navigated like Notework itself (Keyflow actions, .., search).
  import { onMount, tick } from 'svelte';
  import { InputFrame } from '@legitminh/keyflow';
  import Action from './Action.svelte';
  import Control from './Control.svelte';
  import { dialogShortcuts } from '../shortcut-scope.svelte';
  import { imageFormat } from '../images';
  import { explainError, type LocalSelection } from '../filesystem';
  import { browseNative, nativeHandle, nativePlaces, NativeDirectory, parentPath, searchNative, type NativeEntry, type NativePlace } from '../native-fs';

  let { onSelect, onCancel }: {
    onSelect: (selections: LocalSelection[]) => Promise<void>;
    onCancel: () => void;
  } = $props();

  interface Chosen { entry: NativeEntry; parent: string | null }
  let dialog: HTMLDialogElement;
  let heading: HTMLHeadingElement;
  let input = $state<HTMLInputElement>();
  let places = $state.raw<NativePlace[]>([]);
  let location = $state<NativeEntry | null>(null);
  let entries = $state.raw<NativeEntry[]>([]);
  let query = $state('');
  let results = $state.raw<NativeEntry[]>([]);
  let searching = $state(false);
  let searched = $state(false);
  let chosen = $state.raw<Record<string, Chosen>>({});
  let busy = $state(false);
  let error = $state('');
  let generation = 0;
  const selected = $derived(Object.values(chosen));
  const shown = $derived(query.trim() ? results : entries);
  // Same rule as the browser picker: folders, images and text files; nothing hidden.
  const visible = (entry: NativeEntry) => entry.name !== '.git' && (entry.kind === 'directory' || entry.text || !!imageFormat(entry.name));

  onMount(() => {
    const element = dialog;
    element.showModal();
    void (async () => {
      try { places = await nativePlaces(); }
      catch (cause) { error = explainError(cause); }
      await tick();
      heading.focus({ preventScroll: true });
    })();
    return () => { generation++; element.close(); };
  });

  async function open(folder: NativeEntry | null) {
    const version = ++generation;
    busy = true; error = '';
    try {
      const listed = folder ? (await browseNative(folder.path)).filter(visible) : [];
      if (version !== generation) return;
      location = folder; entries = listed; query = ''; results = [];
      await tick();
      heading.focus({ preventScroll: true });
    } catch (cause) { if (version === generation) error = explainError(cause); }
    finally { if (version === generation) busy = false; }
  }

  async function up() {
    if (!location) return;
    if (places.some((place) => place.path === location!.path)) return open(null);
    const parent = await parentPath(location.path).catch(() => null);
    if (!parent || parent === location.path) return open(null);
    const place = places.find((item) => item.path === parent);
    await open(place ? placeFolder(place) : { name: parent.split(/[/\\]/).filter(Boolean).at(-1) ?? parent, path: parent, kind: 'directory', text: false });
  }

  const placeFolder = (place: NativePlace): NativeEntry => ({ name: place.name, path: place.path, kind: 'directory', text: false });
  const parentOf = (entry: NativeEntry) => {
    const cut = entry.path.length - entry.name.length - 1;
    return cut > 0 ? entry.path.slice(0, cut) : null;
  };
  const relative = (entry: NativeEntry) => location && entry.path.startsWith(location.path)
    ? entry.path.slice(location.path.length).replace(/^[/\\]/, '') : entry.path;

  function toggle(entry: NativeEntry, parent = parentOf(entry)) {
    const next = { ...chosen };
    if (next[entry.path]) delete next[entry.path];
    else next[entry.path] = { entry, parent };
    chosen = next;
  }

  $effect(() => {
    const term = query.trim();
    const folder = location;
    results = []; searched = false; searching = false;
    if (!term || !folder) return;
    let active = true;
    const timer = setTimeout(() => {
      searching = true;
      void searchNative(folder.path, term)
        .then((found) => { if (active) { results = found.filter(visible); searched = true; } })
        .catch((cause) => { if (active) error = explainError(cause); })
        .finally(() => { if (active) searching = false; });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  });

  function leaveField() { heading.focus({ preventScroll: true }); }
  function fieldKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.isComposing) return;
    // Keep the query and results; Escape only leaves the field, as in search.
    event.preventDefault();
    event.stopPropagation();
    leaveField();
  }

  async function confirm() {
    if (busy || !selected.length) return;
    busy = true; error = '';
    try {
      const selections: LocalSelection[] = selected.map(({ entry, parent }) => ({
        handle: nativeHandle(entry), ...(parent ? { parent: new NativeDirectory(parent) } : {})
      }));
      // Choosing here is the explicit grant: Notework may read these from now on.
      for (const { handle } of selections) await handle.requestPermission({ mode: 'read' });
      await onSelect(selections);
    } catch (cause) { error = explainError(cause); }
    finally { busy = false; }
  }
</script>

<InputFrame active name="folder browser">
  <dialog use:dialogShortcuts bind:this={dialog} class="local-picker folder-browser" aria-label="link from local filesystem"
    oncancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="folder-browser-title" tabindex="-1" bind:this={heading}>{location ? `${location.name}/` : 'link from local filesystem'}</h2>
    <p class="path">{location ? `${location.path} · computer · folder` : 'computer · choose a place to browse'}</p>
    <p class="muted">select folders or files to observe. Notework reads and saves only what you select; nothing is uploaded.</p>

    <nav aria-label="folder navigation">
      {#if location}
        <Action label="search" onSelect={() => input?.focus()} disabled={busy} />
        <Action label="places" onSelect={() => open(null)} disabled={busy} />
        <Action label=".." onSelect={up} disabled={busy} />
        <hr />
        <div class="file-navigation-row">
          <Action label={chosen[location.path] ? 'deselect' : 'select'} onSelect={() => toggle(location!)} disabled={busy} />
          <span class="folder-browser-current">this folder: {location.name}/</span>
        </div>
      {:else}
        {#each places as place (place.path)}
          <div class="file-navigation-row">
            <Action label={chosen[place.path] ? 'deselect' : 'select'} onSelect={() => toggle(placeFolder(place), null)} disabled={busy} />
            <Action label={`${place.name}/`} onSelect={() => open(placeFolder(place))} disabled={busy}>
              <span class="resource-hint">{place.path}</span>
            </Action>
          </div>
        {/each}
        {#if !places.length && !busy && !error}<p class="muted">no places are available on this device.</p>{/if}
      {/if}
    </nav>

    {#if location}
      <label class="field">
        <span>search file/folder name in {location.name}/</span>
        <input bind:this={input} bind:value={query} placeholder="start typing…" type="search" autocomplete="off"
          onkeydown={fieldKeydown} disabled={busy} />
      </label>
      {#if query.trim()}
        <div aria-live="polite" class="search-status muted">
          {#if searching}searching…{:else if searched}{results.length} {results.length === 1 ? 'result' : 'results'} found{#if results.length >= 200} · narrow your search term.{/if}{/if}
        </div>
      {/if}
      <nav aria-label={query.trim() ? 'search results' : 'folder contents'}>
        {#each shown as entry (entry.path)}
          <div class="file-navigation-row">
            <Action label={chosen[entry.path] ? 'deselect' : 'select'} onSelect={() => toggle(entry)} disabled={busy} />
            {#if entry.kind === 'directory'}
              <Action label={`${entry.name}/`} onSelect={() => open(entry)} disabled={busy}>
                {#if query.trim()}<span class="resource-hint">{relative(entry)}</span>{/if}
              </Action>
            {:else}
              <Action label={entry.name} onSelect={() => toggle(entry)} disabled={busy}>
                {#if query.trim()}<span class="resource-hint">{relative(entry)}</span>{/if}
              </Action>
            {/if}
          </div>
        {/each}
        {#if !query.trim() && !entries.length && !busy}<p class="muted">this folder is empty. you can still select the folder itself.</p>{/if}
      </nav>
    {/if}

    {#if error}<p role="alert" class="notice">{error}</p>{/if}
    {#if busy}<p role="status" class="muted">working…</p>{/if}
    {#if selected.length}
      <h3>selected to observe</h3>
      {#each selected as item (item.entry.path)}
        <div class="picker-row">
          <span>{item.entry.name}{item.entry.kind === 'directory' ? '/' : ''} <span class="resource-hint">{item.entry.path}</span></span>
          <Control class="small-button" onclick={() => toggle(item.entry)} disabled={busy}>remove</Control>
        </div>
      {/each}
    {/if}
    <div class="picker-footer">
      <Control class="picker-button" onclick={confirm} disabled={busy || !selected.length}>observe selection{selected.length ? ` (${selected.length})` : ''}</Control>
      <Control class="picker-button" onclick={onCancel} disabled={busy}>cancel</Control>
    </div>
  </dialog>
</InputFrame>

<style>
  .folder-browser-current { align-self: center; }
</style>
