<script lang="ts">
  import { onMount } from 'svelte';
  import { inspectText } from '../text-resource';
  import { pickLocation, droppedHandles, explainError, type LocalDirectory, type LocalHandle, type LocalSelection } from '../filesystem';

  let { onSelect, onCancel }: {
    onSelect: (selections: LocalSelection[]) => Promise<void>;
    onCancel: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let trail = $state.raw<LocalDirectory[]>([]);
  let entries = $state.raw<{ key: string; handle: LocalHandle }[]>([]);
  let selection = $state.raw<Record<string, LocalSelection>>({});
  let busy = $state(false);
  let error = $state('');
  let locationId = '';
  let generation = 0;
  const location = $derived(trail.at(-1));
  const selected = $derived(Object.values(selection));
  const locationKey = $derived(JSON.stringify([locationId, ...trail.map((item) => item.name)]));

  onMount(() => {
    dialog.showModal();
    // Native modal inertness doesn't disable window-level library shortcuts.
    // Capture keys before Keyflow; native Tab/Enter/Escape defaults still work.
    const isolateKeys = (event: KeyboardEvent) => event.stopImmediatePropagation();
    window.addEventListener('keydown', isolateKeys, true);
    window.addEventListener('keyup', isolateKeys, true);
    return () => {
      generation++;
      window.removeEventListener('keydown', isolateKeys, true);
      window.removeEventListener('keyup', isolateKeys, true);
      dialog.close();
    };
  });

  async function readLocation(path: LocalDirectory[]) {
    const version = ++generation;
    const handles: LocalHandle[] = [];
    for await (const handle of path.at(-1)!.values()) {
      if (handle.kind === 'directory' && handle.name !== '.git') handles.push(handle);
      else if (handle.kind === 'file' && await inspectText(handle)) handles.push(handle);
    }
    if (version !== generation) return;
    trail = path;
    const prefix = [locationId, ...path.map((item) => item.name)];
    entries = handles.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map((handle) => ({ key: JSON.stringify([...prefix, handle.name]), handle }));
  }

  async function browse() {
    busy = true; error = '';
    try {
      const folder = await pickLocation();
      locationId = crypto.randomUUID();
      await readLocation([folder]);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) error = explainError(cause);
    } finally { busy = false; }
  }

  async function open(path: LocalDirectory[]) {
    busy = true; error = '';
    try { await readLocation(path); }
    catch (cause) { error = explainError(cause); }
    finally { busy = false; }
  }

  function toggle(key: string, handle: LocalHandle, parent?: LocalDirectory) {
    const next = { ...selection };
    if (next[key]) delete next[key]; else next[key] = { handle, parent };
    selection = next;
  }

  function dragOver(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'link';
  }

  async function drop(event: DragEvent) {
    event.preventDefault();
    if (!event.dataTransfer || busy) return;
    // droppedHandles calls the browser APIs synchronously, before its first await.
    const pending = droppedHandles(event.dataTransfer.items);
    busy = true; error = '';
    try {
      const next = { ...selection };
      for (const handle of await pending) {
        if (handle.kind === 'directory' && handle.name === '.git') continue;
        if (handle.kind === 'file' && !(await inspectText(handle))) continue;
        next[crypto.randomUUID()] = { handle };
      }
      selection = next;
    } catch (cause) { error = explainError(cause); }
    finally { busy = false; }
  }

  async function confirm() {
    if (busy || !selected.length) return;
    busy = true; error = '';
    try {
      // Request read-only access from this explicit gesture. Do not read file contents.
      const grants = await Promise.all(selected.map(({ handle }) => handle.requestPermission({ mode: 'read' })));
      if (grants.some((grant) => grant !== 'granted')) throw new Error('Read access was not granted. No items were added.');
      await onSelect(selected);
    } catch (cause) { error = explainError(cause); }
    finally { busy = false; }
  }
</script>

<dialog bind:this={dialog} class="local-picker" aria-labelledby="picker-title"
  oncancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
  <h2 id="picker-title">add existing folder/file</h2>
  <p class="muted">Select items to observe. Only their handles are remembered on this device; nothing is uploaded.</p>
  <section class="drop-zone" aria-label="drop files or folders" ondragover={dragOver} ondrop={drop}>
    <p>drop files or folders here</p>
    <p class="muted">Both are recognized automatically. Or browse a location and select either kind below.</p>
  </section>
  <button type="button" class="picker-button" onclick={browse} disabled={busy}>browse location…</button>
  <p class="muted">Your browser asks for a folder to browse. Only items you select below are remembered.</p>
  {#if error}<p role="alert" class="notice">{error}</p>{/if}
  {#if busy}<p role="status" class="muted">working…</p>{/if}
  {#if location}
    <p class="path">{trail.map((item) => item.name).join('/')}/</p>
    {#if trail.length > 1}<button type="button" class="picker-button" onclick={() => open(trail.slice(0, -1))} disabled={busy}>..</button>{/if}
    <label class="picker-row"><input type="checkbox" aria-label={`Select ${location.name} folder`} checked={!!selection[locationKey]} onchange={() => toggle(locationKey, location!, trail.at(-2))} disabled={busy} /><span>this folder: {location.name}/</span></label>
    <div class="picker-entries" aria-label="location contents">
      {#each entries as entry (entry.key)}
        <div class="picker-row">
          <input type="checkbox" aria-label={`Select ${entry.handle.name} ${entry.handle.kind === 'directory' ? 'folder' : 'file'}`} checked={!!selection[entry.key]} onchange={() => toggle(entry.key, entry.handle, location)} disabled={busy} />
          {#if entry.handle.kind === 'directory'}
            <button type="button" class="picker-name" onclick={() => open([...trail, entry.handle as LocalDirectory])} disabled={busy}>{entry.handle.name}/</button>
          {:else}
            <button type="button" class="picker-name" onclick={() => toggle(entry.key, entry.handle, location)} disabled={busy}>{entry.handle.name}</button>
          {/if}
          <span class="picker-kind">{entry.handle.kind === 'directory' ? 'folder' : 'file'}</span>
        </div>
      {/each}
      {#if !entries.length}<p class="muted">This folder is empty. You can still select the folder itself.</p>{/if}
    </div>
  {/if}
  {#if selected.length}
    <h3>selected to observe</h3>
    {#each Object.entries(selection) as [key, item] (key)}
      <div class="picker-row"><span>{item.handle.name}{item.handle.kind === 'directory' ? '/' : ''}</span><button type="button" class="small-button" onclick={() => toggle(key, item.handle, item.parent)} disabled={busy}>remove</button></div>
    {/each}
  {/if}
  <div class="picker-footer">
    <button type="button" class="picker-button" onclick={confirm} disabled={busy || !selected.length}>observe selection{selected.length ? ` (${selected.length})` : ''}</button>
    <button type="button" class="picker-button" onclick={onCancel} disabled={busy}>cancel</button>
  </div>
</dialog>
