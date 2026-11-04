<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Keyflow, Document, ThemeToggle, min_box, state_viewport, lockstep_scrolling } from '@legitminh/keyflow';
  import Action from '../lib/components/Action.svelte';
  import SearchPanel from '../lib/components/SearchPanel.svelte';
  import CreateAsset from '../lib/components/CreateAsset.svelte';
  import { createAsset } from '../lib/create-asset';
  import type { AssetType } from '../lib/asset-types';
  import TextEditor from '../lib/components/TextEditor.svelte';
  import StandaloneDrawing from '../lib/components/StandaloneDrawing.svelte';
  import { renameResource } from '../lib/rename-resource';
  import LocalPicker from '../lib/components/LocalPicker.svelte';
  import { Workspace, ROOT, nodeId, parentId, type StateNode } from '../lib/workspace';
  import { loadWorkspace, saveWorkspace } from '../lib/persistence';
  import { deleteBrowserResource, supportsBrowserDocuments, storageInfo, storageError } from '../lib/browser-documents';
  import { HiddenResource } from '../lib/text-resource';
  import { supportsFilesystem, explainError, isMissing, type LocalHandle } from '../lib/filesystem';

  let workspace = $state.raw(new Workspace());
  let current = $state.raw<StateNode | null>(null);
  let edges = $state.raw<StateNode[]>([]);
  let children = $state.raw<StateNode[]>([]);
  let rootIds = $state.raw<string[]>([]);
  let permissions = $state<Record<string, PermissionState>>({});
  let panel = $state<'search' | 'settings' | 'configure' | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let picking = $state(false);
  let supported = $state(true);
  let browserDocuments = $state(false);
  let capacity = $state<{ usage: number; quota: number; persistent: boolean }>();
  let storageStatus = $state('');
  let editing = $state(false);
  let creating = $state(false);
  let wrapLines = $state(true);
  let vimMode = $state(false);
  let stylusOnly = $state(false);
  let graphRevision = $state(0);
  let message = $state('');
  let storageMessage = $state('');
  let panelElement = $state<HTMLDivElement>();
  let renameDialog: HTMLDialogElement;
  let renameName = $state('');
  let renameError = $state('');
  let renameTarget = $state.raw<StateNode | null>(null);
  let deleteDialog: HTMLDialogElement;
  let deleteTarget = $state.raw<StateNode | null>(null);
  const resourceType = $derived(current?.kind === 'directory' ? 'folder' : 'file');
  let displayElement = $state<HTMLElement>();
  let navigationVersion = 0;
  let pendingHistory: string | undefined;
  let refreshVersion = 0;
  const currentId = $derived(current?.id ?? ROOT);
  const source = $derived(workspace.data.sources.find((item) => item.id === current?.sourceId));
  const needsPermission = $derived(source && source.storage !== 'browser' && permissions[source.id] !== 'granted');

  onMount(() => {
    try { wrapLines = localStorage.getItem('notework:wrap-lines') !== 'false'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { vimMode = localStorage.getItem('notework:vim-mode') === 'true'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { stylusOnly = localStorage.getItem('notework:stylus-only') === 'true'; }
    catch { /* Finger drawing remains available when storage is unavailable. */ }
    supported = supportsFilesystem();
    browserDocuments = supportsBrowserDocuments();
    if (browserDocuments) void updateStorage();
    void (async () => {
      try { workspace = new Workspace(await loadWorkspace()); }
      catch { storageMessage = 'Browser storage is unavailable. Connections and settings will last only for this tab.'; }
      await workspace.pruneMissing();
      await Promise.all(workspace.data.sources.map(async (source) => {
        permissions[source.id] = source.storage === 'browser' ? 'granted' : await source.handle.queryPermission({ mode: 'read' }).catch(() => 'prompt' as const);
      }));
      await refresh();
      await goto(location.pathname, { state: { notework: ROOT }, shallow: true, replace: true, reset: false });
      loading = false;
    })();
    const poll = () => { if (!document.hidden && !loading && !picking && !busy) void refresh(); };
    const interval = setInterval(poll, 5000);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', poll);
    return () => { navigationVersion++; refreshVersion++; clearInterval(interval); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', poll); };
  });

  $effect(() => {
    const routeId = page.state.notework ?? ROOT;
    if (loading) return;
    untrack(() => { if (!editing && routeId !== currentId && routeId !== pendingHistory) void navigate(routeId, false); });
  });

  // Keep the product's native scrolling policy outside the Keyflow library.
  $effect(() => {
    if (lockstep_scrolling.enabled) lockstep_scrolling.set(false);
  });

  async function refresh() {
    const version = ++refreshVersion;
    await workspace.pruneMissing();
    if (version !== refreshVersion) return;
    graphRevision = workspace.revision;
    if (current) {
      try {
        const live = await workspace.node(current.id);
        if (live.kind !== current.kind || live.drawing !== current.drawing) current = live;
      }
      catch (error) {
        if (version !== refreshVersion) return;
        if (isMissing(error) || error instanceof HiddenResource) { await missingCurrent(); return; }
      }
    }
    const id = currentId;
    const reachable = await workspace.reachable(id);
    let direct: StateNode[] = [];
    if (current?.kind === 'directory') {
      try { direct = await workspace.children(id); }
      catch (error) { if (version === refreshVersion) message = explainError(error); }
    }
    if (version !== refreshVersion || id !== currentId) return;
    edges = reachable.nodes;
    children = direct;
    rootIds = [...workspace.data.rootIds];
    // Persist pruning so missing nodes/edges do not reappear after reload.
    try { await saveWorkspace(workspace.data); } catch { /* Explicit saves report storage failures. */ }
    if (reachable.errors.length) message = `${reachable.errors.length} connection(s) could not be read. Reconnect the source in app settings, or remove its shortcut. ${reachable.errors[0]}`;
  }

  async function persist() {
    try { await saveWorkspace(workspace.data); storageMessage = ''; }
    catch { storageMessage = 'Changes work in this tab but could not be saved. Allow browser storage to remember your connections.'; }
    await refresh();
  }

  async function navigate(id: string, updateHistory = true) {
    const version = ++navigationVersion;
    refreshVersion++;
    try {
      if (version !== navigationVersion) return;
      panel = null; message = ''; edges = []; children = [];
      const node = id === ROOT ? null : await workspace.node(id);
      if (version !== navigationVersion) return;
      if (updateHistory) {
        pendingHistory = id;
        try { await goto(location.pathname, { state: { notework: id }, shallow: true, reset: false }); }
        finally { if (pendingHistory === id) pendingHistory = undefined; }
      }
      if (version !== navigationVersion) return;
      current = node; creating = false;
      await refresh();
      if (version !== navigationVersion) return;
      await tick();
      state_viewport.viewport?.scrollTo({ top: 0 });
      displayElement?.focus({ preventScroll: true });
    } catch (error) {
      if (version !== navigationVersion) return;
      if (isMissing(error)) { workspace.forget(id); message = 'Missing resource removed from the graph.'; await refresh(); }
      else message = explainError(error);
    }
  }

  async function openFile() {
    if (current?.kind !== 'file' || busy) return;
    const id = current.id;
    if (needsPermission && source) await reconnect(source.id);
    if (current?.id !== id || needsPermission) return;
    panel = null;
    editing = true;
    state_viewport.viewport?.scrollTo({ top: 0 });
  }

  async function openLinkedFile(id: string) {
    await navigate(id);
    if (currentId !== id) throw new Error(message || 'The linked file could not be opened.');
  }

  function askRename() {
    if (!current || busy) return;
    renameTarget = current;
    renameName = current.name;
    renameError = '';
    renameDialog.showModal();
  }

  async function renameCurrent() {
    if (!current || !renameTarget || current.id !== renameTarget.id || busy) return;
    busy = true; renameError = '';
    refreshVersion++;
    try {
      const result = await renameResource(workspace, renameTarget, renameName);
      current = result.node;
      await goto(location.pathname, { state: { notework: current.id }, shallow: true, replace: true, reset: false });
      renameDialog.close();
      await refresh();
      message = result.warning;
    } catch (error) { renameError = storageError(error); }
    finally { busy = false; }
  }

  async function exitEditor() {
    // Keep this file selected if browser history moved during editing.
    if (page.state.notework !== currentId) {
      await goto(location.pathname, { state: { notework: currentId }, shallow: true, reset: false });
    }
    await refresh();
    editing = false;
    await tick();
    state_viewport.viewport?.scrollTo({ top: 0 });
    displayElement?.focus({ preventScroll: true });
  }

  function saveAppearancePreference(key: string, enabled: boolean) {
    try { localStorage.setItem(key, String(enabled)); }
    catch { /* The preference still works in this session. */ }
  }

  async function togglePanel(next: typeof panel) {
    panel = panel === next ? null : next;
    if (panel === 'settings') await refresh();
    await tick();
    if (panel) panelElement?.scrollIntoView({ block: 'start' });
  }

  async function add(handles: LocalHandle[]) {
    if (busy || loading) return;
    busy = true; message = '';
    try {
      for (const handle of handles) {
        const node = await workspace.connect(handle, ROOT);
        const source = workspace.data.sources.find((source) => source.id === node.sourceId)!;
        permissions[node.sourceId] = await source.handle.queryPermission({ mode: 'read' });
      }
      await persist();
      picking = false;
    } finally { busy = false; }
  }

  async function missingCurrent() {
    if (current) workspace.forget(current.id);
    editing = false; creating = false;
    current = null; panel = null; edges = []; children = [];
    await goto(location.pathname, { state: { notework: ROOT }, shallow: true, replace: true, reset: false });
    await persist();
    message = 'Missing or unreadable-text resource removed from this view.';
  }

  async function updateStorage() {
    try { capacity = await storageInfo(); }
    catch (error) { storageStatus = storageError(error); }
  }

  async function retainStorage() {
    try {
      const granted = await navigator.storage.persist();
      storageStatus = granted ? 'Persistent storage granted. Keep exported backups as well.' : 'The browser did not grant persistence. Export backups of your notes.';
      await updateStorage();
    } catch (error) { storageStatus = storageError(error); }
  }

  async function startCreating() {
    if ((current && current.kind !== 'directory') || busy) return;
    message = ''; panel = null; creating = true;
    await tick();
    state_viewport.viewport?.scrollTo({ top: 0 });
  }

  async function createAtFolder(name: string, type: AssetType) {
    if ((current && current.kind !== 'directory') || busy || !browserDocuments) return;
    const parent = current;
    busy = true; message = '';
    try {
      const node = await createAsset(workspace, parent, name, type);
      permissions[node.sourceId] = 'granted';
      await navigate(node.id);
      void updateStorage();
    } catch (error) { message = storageError(error); }
    finally { busy = false; }
  }

  async function reconnect(sourceId: string) {
    const grant = workspace.data.sources.find((item) => item.id === sourceId);
    if (!grant || busy) return;
    busy = true; message = '';
    try {
      // requestPermission is called from the user's action, never during page load.
      permissions[sourceId] = await grant.handle.requestPermission({ mode: 'read' });
      if (permissions[sourceId] !== 'granted') message = `Read access to ${grant.handle.name} was not granted. You can try reconnecting again.`;
      await refresh();
    } catch (error) { message = explainError(error); }
    finally { busy = false; }
  }

  function label(id: string) {
    const known = workspace.known.get(id);
    if (known) return workspace.label(known);
    try {
      const [sourceId, ...path] = JSON.parse(id) as string[];
      return [workspace.data.sources.find((item) => item.id === sourceId)?.handle.name ?? 'unavailable source', ...path].join('/');
    } catch { return 'unavailable state'; }
  }

  function confirmDelete() {
    if (!current || current.storage !== 'browser' || busy) return;
    deleteTarget = current;
    deleteDialog.showModal();
  }

  async function deleteCurrent() {
    const node = deleteTarget;
    if (!node || node.storage !== 'browser' || busy) return;
    if (currentId !== node.id) { deleteDialog.close(); return; }
    busy = true;
    try {
      await deleteBrowserResource(await workspace.handle(node.id));
      workspace.forget(node.id);
      deleteDialog.close();
      const parent = parentId(node);
      let destination = ROOT;
      if (parent !== ROOT) {
        try { await workspace.node(parent); destination = parent; } catch { /* The parent may no longer exist. */ }
      }
      if (currentId === node.id) await navigate(destination);
      await persist();
    } catch (error) {
      deleteDialog.close();
      message = storageError(error);
    } finally { busy = false; }
  }

  async function remove(from: string, to: string) {
    workspace.unlink(from, to); await persist();
  }
</script>

<svelte:head>
  <title>{current ? `${current.name} · ` : ''}notework</title>
  <meta name="description" content="A local-first network of files, folders, and notes. Navigate your information with Keyflow." />
</svelte:head>

<Keyflow options={{ storagePrefix: 'notework:keyflow:', minBox: 40, lockstep: false }}>
  <Document>
    <main class="app" aria-label="notework" aria-busy={loading}>
      {#if creating && (!current || current.kind === 'directory')}
        <CreateAsset path={current ? workspace.label(current) : 'home'} machineFolder={current?.storage === 'local'}
          {busy} supported={browserDocuments} error={message} onCreate={createAtFolder}
          onCancel={() => { creating = false; message = ''; }} />
      {:else if editing && current}
        {#key current.uri}
          {#if current.drawing}
            <StandaloneDrawing {stylusOnly} {workspace} node={current} onExit={exitEditor} onMissing={() => { void missingCurrent(); }} />
          {:else}
            <TextEditor {workspace} node={current} {wrapLines} {vimMode} {stylusOnly} onExit={exitEditor}
              onMissing={() => { void missingCurrent(); }} onOpenLink={openLinkedFile} />
          {/if}
        {/key}
      {:else}
      <nav aria-label="state navigation">
        <Action label="search" onSelect={() => togglePanel('search')} disabled={loading} />
        <hr />
        {#if current}
          <Action label={`configure ${resourceType}`} onSelect={() => togglePanel('configure')} />
          <Action label=".." onSelect={() => navigate(parentId(current!))} />
        {:else}
          <Action label="app settings" onSelect={() => togglePanel('settings')} disabled={loading} />
        {/if}
        {#each edges as node (node.id)}
          <Action label={node.name + (node.kind === 'directory' ? '/' : '')} onSelect={() => navigate(node.id)} />
        {/each}
      </nav>

      {#if loading}<p class="muted" role="status">opening workspace…</p>{/if}
      {#if !supported}
        <p class="notice" role="status">Local filesystem access needs Chrome or Edge on HTTPS or localhost. Open Notework there to select files and folders from your computer.</p>
      {/if}
      {#if storageMessage}<p class="notice" role="status">{storageMessage}</p>{/if}
      {#if message}<p class="notice" role="alert">{message}</p>{/if}
      {#if needsPermission && current?.kind !== 'file'}
        <Action label={`reconnect ${source!.handle.name}`} onSelect={() => reconnect(source!.id)} disabled={busy} />
      {/if}

      <div bind:this={panelElement}>
        {#if panel}
          <div class="panel-controls"><Action label={`close ${panel === 'settings' ? 'app settings' : panel === 'configure' ? `configure ${resourceType}` : panel}`} onSelect={() => { panel = null; state_viewport.viewport?.scrollTo({ top: 0 }); }} /></div>
        {/if}
        {#if panel === 'search'}
          <SearchPanel {workspace} from={currentId} onNavigate={navigate} {graphRevision} />
        {:else if panel === 'configure' && current}
          <section class="panel" aria-labelledby="configure-heading">
            <h2 id="configure-heading">configure {resourceType}</h2>
            <Action label="rename" onSelect={askRename} disabled={busy} />
            <Action label={`delete this ${resourceType}`} onSelect={confirmDelete}
              disabled={busy || current.storage !== 'browser'} />
            {#if current.storage !== 'browser'}
              <p class="muted">Machine resources are read-only here. Delete this {resourceType} using your system file manager.</p>
            {/if}
          </section>
        {:else if panel === 'settings'}
          <section class="panel" aria-labelledby="settings-heading">
            <h2 id="settings-heading">app settings</h2>
            <p class="muted">Choose which files and folders are directly reachable from home. Files stay on your computer.</p>
            <Action label="add existing folder/file" onSelect={() => { picking = true; }} disabled={!supported || busy} />

            {#if capacity}
              <p class="muted">{(capacity.usage / 1048576).toFixed(1)} MB used · {(capacity.quota / 1073741824).toFixed(1)} GB estimated quota · {capacity.persistent ? 'persistent storage' : 'best-effort storage'}</p>
              <Action label="keep browser storage" onSelect={retainStorage} />
            {/if}
            {#if storageStatus}<p class="muted" role="status">{storageStatus}</p>{/if}

            <h3>root transitions</h3>
            {#if !rootIds.length}<p class="muted">Home has no items. Connect a source here or create an item from home.</p>{/if}
            {#each rootIds as id (id)}
              <div class="config-row"><span>{label(id)}</span><button class="small-button" onclick={() => remove(ROOT, id)} aria-label={`Remove ${label(id)} from root`}>remove from root</button></div>
            {/each}
            <p class="muted">Removing a transition never deletes the original file or folder.</p>

            {#if workspace.data.sources.length}
              <h3>connected sources</h3>
              <div class="source-list">
                {#each workspace.data.sources as grant (grant.id)}
                  <div class="config-row"><span>{grant.handle.name} · {grant.storage === 'browser' ? 'browser storage' : permissions[grant.id] === 'granted' ? 'read access granted' : 'needs permission'}</span></div>
                  {#if grant.storage !== 'browser' && permissions[grant.id] !== 'granted'}
                    <Action label={`reconnect ${grant.handle.name}`} onSelect={() => reconnect(grant.id)} disabled={busy} />
                  {/if}
                  {#if !rootIds.includes(nodeId(grant.id))}
                    <button class="small-button config-row" onclick={() => { workspace.link(ROOT, nodeId(grant.id)); void persist(); }}>add {grant.handle.name} to root</button>
                  {/if}
                {/each}
              </div>
            {/if}

            <h3>appearance</h3>
            <div class="action"><ThemeToggle /></div>
            <Action label={`Vim mode: ${vimMode ? 'on' : 'off'}`} onSelect={() => {
              vimMode = !vimMode;
              saveAppearancePreference('notework:vim-mode', vimMode);
            }} />
            <Action label={`wrap long lines: ${wrapLines ? 'on' : 'off'}`} onSelect={() => {
              wrapLines = !wrapLines;
              saveAppearancePreference('notework:wrap-lines', wrapLines);
            }} />
            <Action label={`draw with only physical stylus: ${stylusOnly ? 'enabled' : 'disabled'}`} onSelect={() => {
              stylusOnly = !stylusOnly;
              saveAppearancePreference('notework:stylus-only', stylusOnly);
            }} />
            <Action label="smaller type" onSelect={() => min_box.set(Math.max(24, min_box.value - 4))} />
            <Action label="larger type" onSelect={() => min_box.set(Math.min(72, min_box.value + 4))} />
            <p class="muted">Use the colored key labels or click a button. Tab and Enter also work. Scrolling is native.</p>
          </section>
        {/if}
      </div>

      <section class="state-display" aria-label="current state" tabindex="-1" bind:this={displayElement}>
        {#if current}
          <h1>{current.name}{current.kind === 'directory' ? '/' : ''}</h1>
          <p class="path">{workspace.label(current)} · {current.storage === 'browser' ? 'browser storage' : 'computer'} · {current.kind === 'directory' ? 'folder' : 'file'}</p>
          {#if current.kind === 'file'}
            <Action label="open" onSelect={openFile} disabled={busy} />
          {:else if current.kind === 'directory'}
            <p class="muted">{children.length} direct {children.length === 1 ? 'child' : 'children'} · {edges.length} reachable {edges.length === 1 ? 'state' : 'states'}</p>
          {/if}
        {:else}
          <h1>home</h1>
          <p class="path">virtual folder · {edges.length} {edges.length === 1 ? 'item' : 'items'} from connected sources</p>
        {/if}
        {#if !current || current.kind === 'directory'}
          <Action label="create new file/folder" onSelect={startCreating} disabled={loading || busy || !browserDocuments} />
        {/if}
        {#if current?.kind === 'directory'}
          <Action label="refresh folder" onSelect={() => { message = ''; void refresh(); }} />
        {/if}
      </section>
      {/if}
    </main>
  </Document>
  <dialog class="local-picker editor-exit" bind:this={renameDialog} aria-labelledby="rename-title"
    oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="rename-title">Rename {renameTarget?.kind === 'directory' ? 'folder' : 'file'}</h2>
    <form onsubmit={(event) => { event.preventDefault(); void renameCurrent(); }}>
      <label class="field">new name <input bind:value={renameName} required maxlength="255" disabled={busy} /></label>
      {#if renameError}<p class="notice" role="alert">{renameError}</p>{/if}
      <div class="editor-controls">
        <button type="submit" disabled={busy}>Rename and update links</button>
        <button type="button" onclick={() => renameDialog.close()} disabled={busy}>Cancel</button>
      </div>
    </form>
  </dialog>
  <dialog class="local-picker editor-exit" bind:this={deleteDialog} aria-labelledby="delete-heading"
    onclose={() => { deleteTarget = null; }} oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="delete-heading">Delete {deleteTarget?.name}?</h2>
    <p class="muted">{deleteTarget?.kind === 'directory' ? 'This permanently deletes the folder and everything inside it.' : 'This permanently deletes the file.'}</p>
    <div class="editor-controls">
      <button type="button" onclick={() => deleteDialog.close()} disabled={busy}>Cancel</button>
      <button type="button" onclick={deleteCurrent} disabled={busy}>Delete {deleteTarget?.kind === 'directory' ? 'folder' : 'file'}</button>
    </div>
  </dialog>
  {#if picking}
    <LocalPicker onSelect={add} onCancel={() => { picking = false; }} />
  {/if}
</Keyflow>
