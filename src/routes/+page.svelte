<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Keyflow, Document, ThemeToggle, min_box, state_viewport, lockstep_scrolling } from '@legitminh/keyflow';
  import Control from '../lib/components/Control.svelte';
  import { dialogShortcuts, shortcutScope } from '../lib/shortcut-scope.svelte';
  import Action from '../lib/components/Action.svelte';
  import SearchPanel from '../lib/components/SearchPanel.svelte';
  import CreateAsset from '../lib/components/CreateAsset.svelte';
  import GitHubSettings from '../lib/components/GitHubSettings.svelte';
  import GitHubConflictDialog from '../lib/components/GitHubConflictDialog.svelte';
  import { defaultPdfMargins, readPdfMargins, pdfMarginSides, PDF_MARGINS_KEY, type PdfMarginSide } from '../lib/export-preferences';
  import { AUTOSAVE_SECONDS_KEY, DEFAULT_AUTOSAVE_SECONDS, MIN_AUTOSAVE_SECONDS, normalizeAutosaveSeconds, readAutosaveSeconds } from '../lib/autosave-preferences';
  import { createAsset } from '../lib/create-asset';
  import type { AssetType } from '../lib/asset-types';
  import TextEditor from '../lib/components/TextEditor.svelte';
  import StandaloneDrawing from '../lib/components/StandaloneDrawing.svelte';
  import { renameResource } from '../lib/rename-resource';
  import { relocateResource } from '../lib/relocate-resource';
  import LocalPicker from '../lib/components/LocalPicker.svelte';
  import { Workspace, ROOT, nodeId, parentId, storageLabel, type StateNode } from '../lib/workspace';
  import { GitHubRepository, type GitHubConflict, type ResolveGitHubConflict } from '../lib/github/repository';
  import { clearRepository } from '../lib/github/storage';
  import { loadWorkspace, saveWorkspace } from '../lib/persistence';
  import { supportsBrowserDocuments, storageInfo, storageError } from '../lib/browser-documents';
  import { canDeleteResource, deleteResource } from '../lib/delete-resource';
  import { HiddenResource } from '../lib/text-resource';
  import { supportsFilesystem, explainError, isMissing, type LocalSelection } from '../lib/filesystem';

  let workspace = $state.raw(new Workspace());
  let current = $state.raw<StateNode | null>(null);
  let edges = $state.raw<StateNode[]>([]);
  let children = $state.raw<StateNode[]>([]);
  let rootIds = $state.raw<string[]>([]);
  let permissions = $state<Record<string, PermissionState>>({});
  let panel = $state<'search' | 'settings' | 'configure' | 'github' | null>(null);
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
  let autosaveSeconds = $state(DEFAULT_AUTOSAVE_SECONDS);
  let pdfMargins = $state(defaultPdfMargins());
  let graphRevision = $state(0);
  let message = $state('');
  let storageMessage = $state('');
  let githubError = $state('');
  let githubConflict = $state.raw<{ conflict: GitHubConflict; choose: (value?: Blob | null) => void }>();
  const resolveGitHubConflict: ResolveGitHubConflict = (conflict) => new Promise((choose) => {
    githubConflict = { conflict, choose };
  });
  function finishGitHubConflict(value?: Blob | null) {
    const current = githubConflict;
    githubConflict = undefined;
    current?.choose(value);
  }
  let panelElement = $state<HTMLDivElement>();
  let renameDialog: HTMLDialogElement;
  let renameName = $state('');
  let renameError = $state('');
  let renameTarget = $state.raw<StateNode | null>(null);
  let relocateTarget = $state.raw<StateNode | null>(null);
  let relocateDestination = $state.raw<StateNode | null>(null);
  let relocateDialog: HTMLDialogElement;
  let deleteDialog: HTMLDialogElement;
  let deleteTarget = $state.raw<StateNode | null>(null);
  const resourceType = $derived(current?.kind === 'directory' ? 'folder' : 'file');
  let displayElement = $state<HTMLElement>();
  let navigationVersion = 0;
  let pendingHistory: string | undefined;
  let refreshVersion = 0;
  const currentId = $derived(current?.id ?? ROOT);
  const canCreateHere = $derived(current?.storage === 'github' || (current?.storage === 'local' ? supported : browserDocuments));
  const source = $derived(workspace.data.sources.find((item) => item.id === current?.sourceId));
  const githubSources = $derived.by(() => { graphRevision; return workspace.data.sources.filter((item) => item.storage === 'github'); });
  const githubRoot = $derived(current?.storage === 'github' && !current.path.length);
  const needsPermission = $derived(source?.storage === 'local' && permissions[source.id] !== 'granted');
  const canDeleteCurrent = $derived(!!current && canDeleteResource(workspace, current));
  const directChildIds = $derived(new Set(current ? children.map((child) => child.id) : rootIds));

  onMount(() => {
    try { wrapLines = localStorage.getItem('notework:wrap-lines') !== 'false'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { vimMode = localStorage.getItem('notework:vim-mode') === 'true'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { stylusOnly = localStorage.getItem('notework:stylus-only') === 'true'; }
    catch { /* Finger drawing remains available when storage is unavailable. */ }
    autosaveSeconds = readAutosaveSeconds();
    pdfMargins = readPdfMargins();
    supported = supportsFilesystem();
    browserDocuments = supportsBrowserDocuments();
    if (browserDocuments) void updateStorage();
    void (async () => {
      try { workspace = new Workspace(await loadWorkspace()); }
      catch { storageMessage = 'Browser storage is unavailable. Connections and settings will last only for this tab.'; }
      const synced = await Promise.allSettled(workspace.data.sources.map((item) => workspace.github(item.id)?.sync()));
      const failed = synced.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') githubError = storageError(failed.reason);
      await workspace.pruneMissing();
      await Promise.all(workspace.data.sources.map(async (source) => {
        permissions[source.id] = source.storage !== 'local' ? 'granted' : await source.handle.queryPermission({ mode: 'read' }).catch(() => 'prompt' as const);
      }));
      await refresh();
      await goto(location.pathname, { state: { notework: ROOT }, shallow: true, replace: true, reset: false });
      loading = false;
    })();
    const poll = () => { if (!document.hidden && !loading && !picking && !busy) void refresh(); };
    const interval = setInterval(poll, 5000);
    window.addEventListener('focus', poll);
    document.addEventListener('visibilitychange', poll);
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || !relocateTarget || busy || document.querySelector('dialog[open]')) return;
      // Keyflow owns Escape outside editable fields; keep cancellation available
      // while typing, where the library intentionally leaves keys untouched.
      if (!(event.target instanceof HTMLElement) || !event.target.closest('input, textarea, select, [contenteditable]')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      void cancelRelocate();
    };
    window.addEventListener('keydown', cancelOnEscape, true);
    return () => { window.removeEventListener('keydown', cancelOnEscape, true); navigationVersion++; refreshVersion++; clearInterval(interval); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', poll); };
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
    if (current?.kind !== 'file' || busy || relocateTarget) return;
    const id = current.id;
    const repository = workspace.github(current.sourceId);
    if (repository) {
      busy = true;
      try { await repository.sync(); githubError = ''; }
      catch (error) { githubError = storageError(error); }
      finally { busy = false; }
      await refresh();
    }
    if (needsPermission && source) await reconnect(source.id);
    if (current?.id !== id || needsPermission) return;
    panel = null;
    editing = true;
    state_viewport.viewport?.scrollTo({ top: 0 });
  }

  async function openNode(node: StateNode) {
    if (node.kind !== 'file' || busy || relocateTarget) return;
    await navigate(node.id);
    if (current?.id === node.id) await openFile();
  }

  async function openLinkedFile(id: string) {
    await navigate(id);
    if (currentId !== id) throw new Error(message || 'The linked file could not be opened.');
  }

  function askRename() {
    if (!current || busy || githubRoot) return;
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
      if (relocateTarget) relocateTarget = await workspace.node(result.remap(relocateTarget.id));
      current = result.node;
      await goto(location.pathname, { state: { notework: current.id }, shallow: true, replace: true, reset: false });
      renameDialog.close();
      await refresh();
      message = result.warning;
    } catch (error) { renameError = storageError(error); }
    finally { busy = false; }
  }

  function startRelocate() {
    if (!current || busy || relocateTarget || githubRoot) return;
    relocateTarget = current;
    panel = null; message = '';
    state_viewport.viewport?.scrollTo({ top: 0 });
  }

  async function cancelRelocate() {
    if (!relocateTarget || busy) return;
    const origin = relocateTarget.id;
    relocateTarget = null; creating = false;
    await navigate(origin);
  }

  function chooseLocation(destination: StateNode | null) {
    if (!relocateTarget || busy || (destination && destination.kind !== 'directory')) return;
    relocateDestination = destination;
    if (relocateTarget.storage !== (destination?.storage ?? 'browser') ||
      (relocateTarget.storage === 'github' && relocateTarget.sourceId !== destination?.sourceId)) relocateDialog.showModal();
    else void finishRelocate();
  }

  async function finishRelocate() {
    if (!relocateTarget || busy) return;
    busy = true; message = ''; refreshVersion++;
    try {
      const result = await relocateResource(workspace, relocateTarget, relocateDestination);
      relocateDialog.close();
      relocateTarget = null; relocateDestination = null;
      permissions[result.node.sourceId] = 'granted';
      await navigate(result.node.id);
      message = result.warning;
      void updateStorage();
    } catch (error) {
      relocateDialog.close();
      message = storageError(error);
    } finally { busy = false; }
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

  async function add(selections: LocalSelection[]) {
    if (busy || loading) return;
    busy = true; message = '';
    try {
      for (const { handle, parent } of selections) {
        const node = await workspace.connect(handle, ROOT, undefined, parent);
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

  function updatePdfMargin(side: PdfMarginSide, input: HTMLInputElement) {
    const value = input.valueAsNumber;
    const valid = Number.isFinite(value) && value >= 0;
    input.setCustomValidity(valid ? '' : 'Enter zero or a positive number of min-boxes.');
    if (!valid) return;
    pdfMargins = { ...pdfMargins, [side]: value };
    try { localStorage.setItem(PDF_MARGINS_KEY, JSON.stringify(pdfMargins)); }
    catch { storageMessage = 'Export margins work in this tab but could not be saved in browser storage.'; }
  }

  function updateAutosaveInterval(input: HTMLInputElement) {
    const value = input.valueAsNumber;
    const valid = Number.isFinite(value) && value >= MIN_AUTOSAVE_SECONDS;
    input.setCustomValidity(valid ? '' : `Enter ${MIN_AUTOSAVE_SECONDS} second or longer.`);
    if (!valid) return;
    autosaveSeconds = normalizeAutosaveSeconds(value);
    try { localStorage.setItem(AUTOSAVE_SECONDS_KEY, String(autosaveSeconds)); }
    catch { storageMessage = 'The autosave interval works in this tab but could not be remembered.'; }
  }

  async function startCreating() {
    if ((current && current.kind !== 'directory') || busy) return;
    message = ''; panel = null; creating = true;
    await tick();
    state_viewport.viewport?.scrollTo({ top: 0 });
  }

  async function createAtFolder(name: string, type: AssetType) {
    if ((current && current.kind !== 'directory') || busy || !canCreateHere) return;
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
    if (!current || !canDeleteCurrent || busy) return;
    deleteTarget = current;
    deleteDialog.showModal();
  }

  async function deleteCurrent() {
    const node = deleteTarget;
    if (!node || busy) return;
    if (currentId !== node.id) { deleteDialog.close(); return; }
    busy = true;
    try {
      await deleteResource(workspace, node);
      workspace.forget(node.id);
      if (relocateTarget) {
        try { relocateTarget = await workspace.node(relocateTarget.id); }
        catch (error) { if (isMissing(error)) relocateTarget = null; }
      }
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

  async function connectGitHub(owner: string, repo: string, branch: string, token: string) {
    if (busy) return false;
    busy = true; githubError = '';
    const id = crypto.randomUUID();
    try {
      const repository = await GitHubRepository.connect(id, owner, repo, branch, token);
      if (githubSources.some(({ github }) => github && github.owner.toLowerCase() === owner.toLowerCase() &&
        github.repo.toLowerCase() === repo.toLowerCase() && github.branch === repository.connection.branch)) {
        throw new Error('This repository branch is already connected. Use Update token to change its credentials.');
      }
      const node = workspace.connectGitHub(repository);
      try { await saveWorkspace(workspace.data); }
      catch (error) { workspace.forget(node); throw error; }
      await refresh();
      return true;
    } catch (error) {
      await clearRepository(id).catch(() => {});
      githubError = storageError(error);
      return false;
    } finally { busy = false; }
  }

  async function updateGitHubToken(id: string, token: string) {
    if (busy) return false;
    busy = true; githubError = '';
    try { await workspace.github(id)?.replaceToken(token); await refresh(); return true; }
    catch (error) { githubError = storageError(error); return false; }
    finally { busy = false; }
  }

  async function disconnectGitHub(id: string) {
    if (busy || !confirm('Disconnect this repository? Notework will remove its token, cached files, and any unpublished drafts from this browser. Files on GitHub will stay as they are.')) return;
    busy = true; githubError = '';
    try {
      await clearRepository(id);
      workspace.forget(nodeId(id));
      await saveWorkspace(workspace.data);
      await refresh();
    } catch (error) { githubError = storageError(error); }
    finally { busy = false; }
  }

  async function refreshFolder() {
    if (busy) return;
    message = '';
    const repository = current && workspace.github(current.sourceId);
    if (repository) {
      busy = true;
      try { await repository.sync(); githubError = ''; }
      catch (error) { githubError = storageError(error); }
      finally { busy = false; }
    }
    await refresh();
  }
</script>

<svelte:head>
  <title>{current ? `${current.name} · ` : ''}notework</title>
  <meta name="description" content="A local-first network of files, folders, and notes. Navigate your information with Keyflow." />
</svelte:head>

<Keyflow options={{ storagePrefix: 'notework:keyflow:', minBox: 40, lockstep: false }}>
  <Document>
    <main class="app" class:editing-view={editing && !!current} aria-label="notework" aria-busy={loading}>
      {#if relocateTarget}
        <aside class="relocate-banner" aria-label="relocate" aria-live="polite">
          <p>choose location for {relocateTarget.name}</p>
          <Control class="cancel-relocate" onclick={cancelRelocate} disabled={busy} keys="esc">cancel relocate</Control>
        </aside>
      {/if}
      {#if creating && (!current || current.kind === 'directory')}
        <CreateAsset path={current ? workspace.label(current) : 'home'} machineFolder={current?.storage === 'local'} githubFolder={current?.storage === 'github'}
          {busy} supported={canCreateHere} error={message} onCreate={createAtFolder}
          onCancel={() => { creating = false; message = ''; }} />
      {:else if editing && current}
        {#key current.uri}
          {#if current.drawing}
            <StandaloneDrawing {pdfMargins} {stylusOnly} {resolveGitHubConflict} autosaveMs={autosaveSeconds * 1000} {workspace} node={current} onExit={exitEditor} onMissing={() => { void missingCurrent(); }} />
          {:else}
            <TextEditor {workspace} node={current} {wrapLines} {vimMode} {stylusOnly} {pdfMargins} {resolveGitHubConflict} autosaveMs={autosaveSeconds * 1000} onExit={exitEditor}
              onMissing={() => { void missingCurrent(); }} onOpenLink={openLinkedFile} />
          {/if}
        {/key}
      {:else}
      <nav aria-label="state navigation">
        <Action label="search" onSelect={() => togglePanel('search')} disabled={loading || busy} />
        {#if current}
          <Action label={`configure ${resourceType}`} onSelect={() => togglePanel('configure')} disabled={busy} />
          {#if current.kind === 'directory'}
            <Action label="create new file/folder" onSelect={startCreating} disabled={loading || busy || !canCreateHere} />
          {/if}
        {:else}
          <Action label="app settings" onSelect={() => togglePanel('settings')} disabled={loading || busy} />
        {/if}
        <hr />
        {#if current}
          <Action label="home" iconOnly onSelect={() => navigate(ROOT)} disabled={busy}>
            <svg class="action-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="m3 11 9-8 9 8" /><path d="M5 10v11h14V10" /><path d="M9 21v-7h6v7" />
            </svg>
          </Action>
          <Action label=".." onSelect={() => navigate(parentId(current!))} disabled={busy} />
        {/if}
        {#each edges as node (node.id)}
          {#if relocateTarget && node.kind === 'directory'}
            <div class="file-navigation-row">
              <Action label="choose" onSelect={() => chooseLocation(node)} disabled={busy} />
              <Action label={node.name + '/'} onSelect={() => navigate(node.id)} disabled={busy} />
            </div>
          {:else if !relocateTarget && node.kind === 'file' && directChildIds.has(node.id) && (!current || current.kind === 'directory')}
            <div class="file-navigation-row">
              <Action label="open" onSelect={() => { void openNode(node); }} disabled={busy} />
              <Action label={node.name} onSelect={() => navigate(node.id)} disabled={busy} />
            </div>
          {:else}
            <Action label={node.name + (node.kind === 'directory' ? '/' : '')} onSelect={() => navigate(node.id)} disabled={busy} />
          {/if}
        {/each}
      </nav>

      {#if loading}<p class="muted" role="status">opening workspace…</p>{/if}
      {#if !supported}
        <p class="notice" role="status">Local filesystem access needs Chrome or Edge on HTTPS or localhost. Open Notework there to select files and folders from your computer.</p>
      {/if}
      {#if storageMessage}<p class="notice" role="status">{storageMessage}</p>{/if}
      {#if githubError && panel !== 'github'}<p class="notice" role="status">{githubError}</p>{/if}
      {#if message}<p class="notice" role="alert">{message}</p>{/if}
      <div bind:this={panelElement}>
        {#if panel}
          <div class="panel-controls"><Action label={`close ${panel === 'settings' ? 'app settings' : panel === 'configure' ? `configure ${resourceType}` : panel}`} onSelect={() => { panel = null; state_viewport.viewport?.scrollTo({ top: 0 }); }} /></div>
        {/if}
        {#if panel === 'search'}
          <SearchPanel {workspace} from={currentId} onNavigate={navigate} onOpen={openNode} {graphRevision}
            relocating={!!relocateTarget} onChoose={chooseLocation} {busy} />
        {:else if panel === 'configure' && current}
          <section class="panel" aria-labelledby="configure-heading">
            <h2 id="configure-heading">configure {resourceType}</h2>
            {#if current.kind === 'directory'}
              <Action label="refresh folder" onSelect={refreshFolder} disabled={busy} />
            {/if}
            {#if needsPermission}
              <Action label={`reconnect ${source!.handle.name}`} onSelect={() => reconnect(source!.id)} disabled={busy} />
            {/if}
            {#if githubRoot}
              <Action label="GitHub repositories" onSelect={() => togglePanel('github')} disabled={busy} />
            {:else}
              <Action label="rename" onSelect={askRename} disabled={busy} />
              <Action label={`relocate this ${resourceType}`} onSelect={startRelocate} disabled={busy || !!relocateTarget} />
              <Action label={`delete this ${resourceType}`} onSelect={confirmDelete} disabled={busy || !canDeleteCurrent} />
            {/if}
            {#if !githubRoot && !canDeleteCurrent}
              <p class="muted">Reconnect this {resourceType} through its containing folder to delete it from Notework.</p>
            {/if}
          </section>
        {:else if panel === 'settings'}
          <section class="panel" aria-labelledby="settings-heading">
            <h2 id="settings-heading">app settings</h2>
            <p class="muted">Choose which files and folders are directly reachable from home.</p>
            <Action label="create new file/folder" onSelect={startCreating} disabled={loading || busy || !canCreateHere} />
            <Action label="add existing folder/file" onSelect={() => { picking = true; }} disabled={!supported || busy} />
            <Action label="GitHub repositories" onSelect={() => togglePanel('github')} disabled={loading || busy} />

            {#if capacity}
              <p class="muted">{(capacity.usage / 1048576).toFixed(1)} MB used · {(capacity.quota / 1073741824).toFixed(1)} GB estimated quota · {capacity.persistent ? 'persistent storage' : 'best-effort storage'}</p>
              <Action label="keep browser storage" onSelect={retainStorage} />
            {/if}
            {#if storageStatus}<p class="muted" role="status">{storageStatus}</p>{/if}

            <h3>root transitions</h3>
            {#if !rootIds.length}<p class="muted">Home has no items. Connect a source here or create an item from home.</p>{/if}
            {#each rootIds as id (id)}
              <div class="config-row"><span>{label(id)}</span><Control class="small-button" onclick={() => remove(ROOT, id)} aria-label={`Remove ${label(id)} from root`}>remove from root</Control></div>
            {/each}
            <p class="muted">Removing a transition never deletes the original file or folder.</p>

            {#if workspace.data.sources.length}
              <h3>connected sources</h3>
              <div class="source-list">
                {#each workspace.data.sources as grant (grant.id)}
                  <div class="config-row"><span>{grant.handle.name} · {grant.storage !== 'local' ? storageLabel(grant.storage ?? 'local') : permissions[grant.id] === 'granted' ? 'read access granted' : 'needs permission'}</span></div>
                  {#if grant.storage === 'local' && permissions[grant.id] !== 'granted'}
                    <Action label={`reconnect ${grant.handle.name}`} onSelect={() => reconnect(grant.id)} disabled={busy} />
                  {/if}
                  {#if !rootIds.includes(nodeId(grant.id))}
                    <Control class="small-button config-row" onclick={() => { workspace.link(ROOT, nodeId(grant.id)); void persist(); }}>add {grant.handle.name} to root</Control>
                  {/if}
                {/each}
              </div>
            {/if}

            <h3>appearance</h3>
            <div class="action">{#if !shortcutScope.dialog}<ThemeToggle />{/if}</div>
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
            <h3>autosave</h3>
            <label class="field"><span>autosave at most every (seconds)</span>
              <input type="number" min={MIN_AUTOSAVE_SECONDS} step="1" value={autosaveSeconds}
                oninput={(event) => updateAutosaveInterval(event.currentTarget)} />
            </label>
            <p class="muted">Default: {DEFAULT_AUTOSAVE_SECONDS} seconds. Exit always saves first. Local files may ask for write access when you exit.</p>
            <h3>export margins</h3>
            <p class="muted" id="pdf-margin-units">Each side defaults to 1 min-box. Set 0 for no margin; fractions are allowed.</p>
            {#each pdfMarginSides as side}
              <label class="field"><span>{side} margin (min-box)</span>
                <input type="number" min="0" step="any" value={pdfMargins[side]} aria-describedby="pdf-margin-units"
                  oninput={(event) => updatePdfMargin(side, event.currentTarget)} />
              </label>
            {/each}
          </section>
        {:else if panel === 'github'}
          <Action label="back to app settings" onSelect={() => togglePanel('settings')} disabled={busy} />
          <GitHubSettings sources={githubSources} {busy} error={githubError}
            onConnect={connectGitHub} onUpdate={updateGitHubToken} onDisconnect={disconnectGitHub} />
        {/if}
      </div>

      <section class="state-display" aria-label="current state" tabindex="-1" bind:this={displayElement}>
        {#if current}
          <h1>{current.name}{current.kind === 'directory' ? '/' : ''}</h1>
          <p class="path">{workspace.label(current)} · {current.storage === 'local' ? 'computer' : storageLabel(current.storage)} · {current.kind === 'directory' ? 'folder' : 'file'}</p>
          {#if relocateTarget && current.kind === 'directory'}
            <Action label="choose" onSelect={() => chooseLocation(current)} disabled={busy} />
          {/if}
          {#if current.kind === 'file' && !relocateTarget}
            <Action label="open" onSelect={openFile} disabled={busy} />
          {:else if current.kind === 'directory'}
            <p class="muted">{children.length} direct {children.length === 1 ? 'child' : 'children'} · {edges.length} reachable {edges.length === 1 ? 'state' : 'states'}</p>
          {/if}
        {:else}
          <h1>home</h1>
          {#if relocateTarget}<Action label="choose" onSelect={() => chooseLocation(null)} disabled={busy} />{/if}
          <p class="path">virtual folder · {edges.length} {edges.length === 1 ? 'item' : 'items'} from connected sources</p>
        {/if}
      </section>
      {/if}
    </main>
  </Document>
  <dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={renameDialog} aria-labelledby="rename-title"
    oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="rename-title">Rename {renameTarget?.kind === 'directory' ? 'folder' : 'file'}</h2>
    <form onsubmit={(event) => { event.preventDefault(); void renameCurrent(); }}>
      <label class="field">new name <input bind:value={renameName} required maxlength="255" disabled={busy} /></label>
      {#if renameError}<p class="notice" role="alert">{renameError}</p>{/if}
      <div class="editor-controls">
        <button type="submit" disabled={busy}>Rename and update links</button>
        <Control onclick={() => renameDialog.close()} disabled={busy}>Cancel</Control>
      </div>
    </form>
  </dialog>
  <dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={relocateDialog} aria-labelledby="relocate-heading"
    oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="relocate-heading">Relocate {relocateTarget?.kind === 'directory' ? 'folder' : 'file'} to {storageLabel(relocateDestination?.storage ?? 'browser')}?</h2>
    <p class="muted">This creates “{relocateTarget?.name}”{relocateTarget?.kind === 'directory' ? ' and all its contents' : ''} in {storageLabel(relocateDestination?.storage ?? 'browser')} at {relocateDestination ? workspace.label(relocateDestination) : 'home'}, then deletes the original from {storageLabel(relocateTarget?.storage ?? 'browser')}.</p>
    <div class="editor-controls">
      <Control onclick={() => relocateDialog.close()} disabled={busy}>No</Control>
      <Control onclick={finishRelocate} disabled={busy}>Yes</Control>
    </div>
  </dialog>
  <dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={deleteDialog} aria-labelledby="delete-heading"
    onclose={() => { deleteTarget = null; }} oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="delete-heading">Delete {deleteTarget?.name}?</h2>
    <p class="muted">{deleteTarget?.kind === 'directory' ? 'This permanently deletes the folder and everything inside it.' : 'This permanently deletes the file.'}</p>
    <div class="editor-controls">
      <Control onclick={() => deleteDialog.close()} disabled={busy}>Cancel</Control>
      <Control onclick={deleteCurrent} disabled={busy}>Delete {deleteTarget?.kind === 'directory' ? 'folder' : 'file'}</Control>
    </div>
  </dialog>
  {#if picking}
    <LocalPicker onSelect={add} onCancel={() => { picking = false; }} />
  {/if}
  {#if githubConflict}
    <GitHubConflictDialog conflict={githubConflict.conflict} onChoose={finishGitHubConflict} />
  {/if}
</Keyflow>
