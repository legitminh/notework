<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { Keyflow, Document, set_theme_id, min_box, state_viewport, lockstep_scrolling, key_presets, set_available_keys, keypath_visibility } from '@legitminh/keyflow';
  import { NavigationHistory } from '../lib/navigation-history';
  import FilePreview from '../lib/components/FilePreview.svelte';
  import type { PreviewLocation } from '../lib/preview-location';
  import AppKeyboard from '../lib/components/AppKeyboard.svelte';
  import GlobalSearch from '../lib/components/GlobalSearch.svelte';
  import SearchMenu, { type SearchMode } from '../lib/components/SearchMenu.svelte';
  import ContentSearchDialog from '../lib/components/ContentSearch.svelte';
  import { ContentSearch } from '../lib/content-search';
  import GitHubSyncProgress from '../lib/components/GitHubSyncProgress.svelte';
  import { DEFAULT_GITHUB_POLL_SECONDS, GITHUB_POLL_SECONDS_KEY, readGitHubPollSeconds } from '../lib/github/poll-preferences';
  import { BackgroundSync, setBackgroundSync } from '../lib/github/background.svelte';
  import { keyboardChoices, isKeyboardChoice, type KeyboardChoice } from '../lib/keyboard';
  import Control from '../lib/components/Control.svelte';
  import Menu from '../lib/components/Menu.svelte';
  import ChoiceMenu from '../lib/components/ChoiceMenu.svelte';
  import { dialogShortcuts, shortcutScope } from '../lib/shortcut-scope.svelte';
  import Action from '../lib/components/Action.svelte';
  import CreateAsset from '../lib/components/CreateAsset.svelte';
  import GitHubSettings from '../lib/components/GitHubSettings.svelte';
  import GitHubConflictDialog from '../lib/components/GitHubConflictDialog.svelte';
  import GitHubReconnectDialog from '../lib/components/GitHubReconnectDialog.svelte';
  import StorageNotice from '../lib/components/StorageNotice.svelte';
  import { submitOnEnter } from '../lib/form-shortcuts';
  import { defaultPdfMargins, readPdfMargins, pdfMarginSides, PDF_MARGINS_KEY, type PdfMarginSide } from '../lib/export-preferences';
  import { AUTOSAVE_SECONDS_KEY, DEFAULT_AUTOSAVE_SECONDS, MIN_AUTOSAVE_SECONDS, normalizeAutosaveSeconds, readAutosaveSeconds } from '../lib/autosave-preferences';
  import { createAsset } from '../lib/create-asset';
  import type { AssetType } from '../lib/asset-types';
  import TextEditor from '../lib/components/TextEditor.svelte';
  import StandaloneDrawing from '../lib/components/StandaloneDrawing.svelte';
  import { isVisualName } from '../lib/visual-documents';
  import { renameResource } from '../lib/rename-resource';
  import { stripFilenameEditingArtifacts } from '../lib/filenames';
  import { relocateResource } from '../lib/relocate-resource';
  import LocalPicker from '../lib/components/LocalPicker.svelte';
  import { Workspace, ROOT, nodeId, parentId, storageLabel, type StateNode } from '../lib/workspace';
  import { GitHubDirectory, GitHubRepository, type GitHubConflict, type ResolveGitHubConflict } from '../lib/github/repository';
  import { GitHubApiError, type GitHubConnection } from '../lib/github/api';
  import { setGitHubRecovery } from '../lib/github/recovery';
  import { clearRepository } from '../lib/github/storage';
  import { loadWorkspace, saveWorkspace } from '../lib/persistence';
  import { supportsBrowserDocuments, storageInfo, storageError } from '../lib/browser-documents';
  import { canDeleteResource, deleteResource } from '../lib/delete-resource';
  import { HiddenResource } from '../lib/text-resource';
  import { supportsFilesystem, explainError, isMissing, type LocalSelection } from '../lib/filesystem';

  let workspace = $state.raw(new Workspace());
  let current = $state.raw<StateNode | null>(null);
  const navigationHistory = new NavigationHistory(ROOT);
  const editorHistory = new NavigationHistory();
  let traversingHistory = false;
  let historyQueue = Promise.resolve();
  let pendingNavigation: Promise<void> | undefined;
  let edges = $state.raw<StateNode[]>([]);
  let children = $state.raw<StateNode[]>([]);
  let rootIds = $state.raw<string[]>([]);
  let permissions = $state<Record<string, PermissionState>>({});
  let panel = $state<'settings' | 'configure' | 'github' | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let picking = $state(false);
  let supported = $state(true);
  let browserDocuments = $state(false);
  let capacity = $state<{ usage: number; quota: number; persistent: boolean }>();
  let storageStatus = $state('');
  let editing = $state(false);
  /** A visual document opened as its plaintext main file instead of the visual editor. */
  let rawTextId = $state<string>();
  $effect(() => { if (!editing) rawTextId = undefined; });
  let previewLocation = $state.raw<{ id: string; location: PreviewLocation }>();
  let creating = $state(false);
  let virtualKeyboard = $state(false);
  let keyboardChoice = $state<KeyboardChoice>('ascii');
  let shortcutAlphabet = $state('alphanumeric');
  let showLineNumbers = $state(true);
  let showLineIndex = $state(false);
  let globalSearch = $state(false);
  let heldModifier = $state(false);
  let activeEditor = $state<{ saveForNavigation: () => Promise<boolean>; resumeEditing?: () => void; focusToolbar?: () => void | Promise<void> }>();
  let wrapLines = $state(true);
  type ThemeChoice = 'dark' | 'light' | 'system';
  let themeChoice = $state<ThemeChoice>('system');
  let systemDark = $state(false);
  let githubPollSeconds = $state(DEFAULT_GITHUB_POLL_SECONDS);
  let githubPullRevision = $state(0);
  let checkingGitHub = false;
  let githubPausedUntil = 0;
  const githubPollFailures = new Map<string, { count: number; next: number }>();
  $effect(() => {
    const timer = setInterval(() => { void checkGitHubUpdates(); }, Math.min(2_147_483_647, githubPollSeconds * 1000));
    return () => clearInterval(timer);
  });
  async function checkGitHubUpdates() {
    if (checkingGitHub || Date.now() < githubPausedUntil || loading || busy || picking || document.hidden || !navigator.onLine) return;
    checkingGitHub = true;
    let changed = false;
    try {
      for (const source of workspace.data.sources) {
        const repository = workspace.github(source.id);
        if (!repository || Date.now() < (githubPollFailures.get(source.id)?.next ?? 0)) continue;
        try {
          changed = await repository.exclusive(() => workspace.github(source.id) === repository ? repository.sync(true) : Promise.resolve(false)) || changed;
          githubPollFailures.delete(source.id);
          clearGitHubError(source.id);
        } catch (error) {
          if (workspace.github(source.id) !== repository) continue;
          const count = (githubPollFailures.get(source.id)?.count ?? 0) + 1;
          const required = error instanceof GitHubApiError ? error.retryAt : 0;
          githubPollFailures.set(source.id, { count, next: Math.max(required, Date.now() + Math.min(900_000, 60_000 * 2 ** Math.min(4, count - 1))) });
          githubError = error;
          if (required) { githubPausedUntil = required; break; }
        }
      }
      if (changed) { githubPullRevision++; await refresh(); }
    } finally { checkingGitHub = false; }
  }
  function updateGitHubInterval(input: HTMLInputElement) {
    if (!input.checkValidity() || !Number.isFinite(input.valueAsNumber)) return;
    githubPollSeconds = input.valueAsNumber;
    try { localStorage.setItem(GITHUB_POLL_SECONDS_KEY, String(githubPollSeconds)); } catch { /* Applies in this tab. */ }
  }
  const themeChoices: ThemeChoice[] = ['dark', 'light', 'system'];
  function chooseTheme(choice: ThemeChoice) {
    themeChoice = choice;
    try { localStorage.setItem('notework:theme', choice); } catch { /* Still applies in this tab. */ }
  }
  $effect(() => {
    // Keyflow's original names describe ink; Notework labels the background.
    const dark = themeChoice === 'dark' || (themeChoice === 'system' && systemDark);
    set_theme_id(dark ? 1 : 0);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--pretty-lightness', dark ? '75%' : '25%');
  });
  let prettyFontSize = $state(true);
  let prettyMargin = $state(true);
  let vimMode = $state(false);
  let stylusOnly = $state(false);
  let autosaveSeconds = $state(DEFAULT_AUTOSAVE_SECONDS);
  let pdfMargins = $state(defaultPdfMargins());
  let graphRevision = $state(0);
  let message = $state.raw<unknown>();
  let storageMessage = $state('');
  let githubError = $state.raw<unknown>();
  let githubReconnect = $state.raw<{ id: string; connection: GitHubConnection; close: (reconnected: boolean) => void }>();
  let githubConflict = $state.raw<{ conflict: GitHubConflict; choose: (value?: Blob | null) => void }>();
  const resolveGitHubConflict: ResolveGitHubConflict = (conflict) => new Promise((choose) => {
    githubConflict = { conflict, choose };
  });
  const sync = new BackgroundSync(() => workspace, resolveGitHubConflict, () => { void refresh(); });
  setBackgroundSync(sync);
  function finishGitHubConflict(value?: Blob | null) {
    const current = githubConflict;
    githubConflict = undefined;
    current?.choose(value);
  }
  let panelElement = $state<HTMLDivElement>();
  let renameDialog: HTMLDialogElement;
  let renameForm: HTMLFormElement;
  let renameName = $state('');
  let renameError = $state.raw<unknown>();
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
  let contentSearch = $state(false);
  let contentIndex = $state.raw<ContentSearch>();
  let searchMenu = $state(false);
  function closeSearchMenu() {
    if (!searchMenu) return;
    searchMenu = false;
    // Native dialog closure precedes shortcut re-enabling. Restore the opener
    // once the parent frame's controls can receive focus again.
    void tick().then(() => document.querySelector<HTMLButtonElement>('nav [data-action="search"] button')?.focus({ preventScroll: true }));
  }
  let searchFrom = $state(ROOT);
  let searchLabel = $state('home');
  let searchEverywhere = $state(true);
  async function beginSearch(mode: SearchMode) {
    searchMenu = false;
    contentSearch = false; globalSearch = false;
    panel = null;
    // Unwind the menu frame before activating the search dialog's own frame.
    await tick();
    // A shortcut immediately after selecting a folder belongs to that destination.
    if (pendingNavigation) await pendingNavigation;
    searchEverywhere = mode.startsWith('all-');
    const folder = current?.kind === 'file' ? parentId(current) : currentId;
    searchFrom = searchEverywhere ? ROOT : folder;
    searchLabel = searchFrom === ROOT ? 'home' : current
      ? workspace.label(current.kind === 'directory' ? current : { ...current, path: current.path.slice(0, -1) }) : 'home';
    if (mode.endsWith('-text')) {
      contentIndex ??= new ContentSearch();
      contentSearch = true;
    } else globalSearch = true;
  }
  const canCreateHere = $derived(current?.storage === 'github' || (current?.storage === 'local' ? supported : browserDocuments));
  const source = $derived(workspace.data.sources.find((item) => item.id === current?.sourceId));
  const connectedSources = $derived.by(() => { graphRevision; return [...workspace.data.sources]; });
  const githubSources = $derived(connectedSources.filter((item) => item.storage === 'github'));
  const githubRoot = $derived(current?.storage === 'github' && !current.path.length);
  const needsPermission = $derived(source?.storage === 'local' && permissions[source.id] !== 'granted');
  const canDeleteCurrent = $derived(!!current && canDeleteResource(workspace, current));
  const directChildIds = $derived(new Set(current ? children.map((child) => child.id) : rootIds));
  setGitHubRecovery({
    available: (id) => githubSources.some((source) => source.id === id),
    reconnect: reconnectGitHub
  });

  onMount(() => {
    const appearance = matchMedia('(prefers-color-scheme: dark)');
    const followSystem = () => { systemDark = appearance.matches; };
    followSystem();
    appearance.addEventListener('change', followSystem);
    try {
      const saved = localStorage.getItem('notework:theme');
      if (saved === 'dark' || saved === 'light' || saved === 'system') themeChoice = saved;
    } catch { /* Follow the system without preference storage. */ }
    try { wrapLines = localStorage.getItem('notework:wrap-lines') !== 'false'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { prettyFontSize = localStorage.getItem('notework:pretty-font-size') !== 'false'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { prettyMargin = localStorage.getItem('notework:pretty-margin') !== 'false'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { vimMode = localStorage.getItem('notework:vim-mode') === 'true'; }
    catch { /* Use the default when storage is unavailable. */ }
    try { stylusOnly = localStorage.getItem('notework:stylus-only') === 'true'; }
    catch { /* Finger drawing remains available when storage is unavailable. */ }
    try {
      virtualKeyboard = localStorage.getItem('notework:virtual-keyboard') === 'true';
      const choice = localStorage.getItem('notework:keyboard-layout');
      if (isKeyboardChoice(choice)) keyboardChoice = choice;
      showLineNumbers = localStorage.getItem('notework:line-numbers') !== 'false';
      showLineIndex = localStorage.getItem('notework:line-index') === 'true';
      shortcutAlphabet = localStorage.getItem('notework:shortcut-alphabet') === 'letters' ? 'letters' : 'alphanumeric';
      set_available_keys(shortcutAlphabet === 'letters' ? key_presets.letters : key_presets.alphanumeric);
    } catch { /* Defaults work without preference storage. */ }
    githubPollSeconds = readGitHubPollSeconds();
    autosaveSeconds = readAutosaveSeconds();
    pdfMargins = readPdfMargins();
    supported = supportsFilesystem();
    browserDocuments = supportsBrowserDocuments();
    if (browserDocuments) void updateStorage();
    void (async () => {
      try { workspace = new Workspace(await loadWorkspace()); }
      catch { storageMessage = 'Browser storage is unavailable. Connections and settings will last only for this tab.'; }
      const synced = await Promise.allSettled(workspace.data.sources.map((item) => workspace.github(item.id)?.sync()));
      const failed = synced.find((result) => result.status === 'rejected' && result.reason instanceof GitHubApiError && result.reason.canReconnect)
        ?? synced.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') githubError = failed.reason;
      await workspace.pruneMissing();
      await Promise.all(workspace.data.sources.map(async (source) => {
        permissions[source.id] = source.storage !== 'local' ? 'granted' : await source.handle.queryPermission({ mode: 'read' }).catch(() => 'prompt' as const);
      }));
      await refresh();
      await goto(location.pathname, { state: { notework: ROOT }, shallow: true, replace: true, reset: false });
      loading = false;
      await sync.restore();
    })();
    const poll = () => { if (!document.hidden && !loading && !picking && !busy) void refresh(); };
    const interval = setInterval(() => { poll(); if (!loading) sync.retry(); }, 30_000);
    const pruneInterval = setInterval(poll, 5000);
    const online = () => { sync.retry(); };
    window.addEventListener('online', online);
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
    const modifierDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey) return;
      if (event.key === 'Meta' || event.key === 'Control') heldModifier = true;
      const searchKey = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && (searchKey === 'p' || (searchKey === 'f' && !editing))) {
        const mode: SearchMode = `${event.shiftKey ? 'all' : 'folder'}-${searchKey === 'f' ? 'text' : 'files'}`;
        if (contentSearch || globalSearch) {
          event.preventDefault(); event.stopImmediatePropagation(); heldModifier = false;
          if (searchEverywhere === event.shiftKey && (searchKey === 'f' ? contentSearch : globalSearch))
            document.querySelector<HTMLInputElement>('dialog[open] input[type=search]')?.focus();
          else if (!event.repeat && !busy) beginSearch(mode);
          return;
        }
        if (!loading && !busy && !creating && (!document.querySelector('dialog[open]') || searchMenu)) {
          event.preventDefault(); event.stopImmediatePropagation(); heldModifier = false;
          if (!event.repeat) beginSearch(mode);
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && ['[', ']'].includes(event.key) &&
          !document.querySelector('dialog[open]') && (!editing || document.activeElement?.closest('.editor-controls'))) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!event.repeat) queueHistory(event.key === '[' ? -1 : 1);
        return;
      }
    };
    const modifierUp = (event: KeyboardEvent) => { if (event.key === 'Meta' || event.key === 'Control' || !(event.metaKey || event.ctrlKey)) heldModifier = false; };
    const resetModifier = () => { heldModifier = false; };
    window.addEventListener('keydown', modifierDown, true);
    window.addEventListener('keyup', modifierUp, true);
    window.addEventListener('blur', resetModifier);
    window.addEventListener('keydown', cancelOnEscape, true);
    return () => { appearance.removeEventListener('change', followSystem); sync.stop(); contentIndex?.destroy(); clearInterval(pruneInterval); window.removeEventListener('online', online); window.removeEventListener('keydown', modifierDown, true); window.removeEventListener('keyup', modifierUp, true); window.removeEventListener('blur', resetModifier); window.removeEventListener('keydown', cancelOnEscape, true); navigationVersion++; refreshVersion++; clearInterval(interval); window.removeEventListener('focus', poll); document.removeEventListener('visibilitychange', poll); };
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

  async function refresh(leavingEditor = false) {
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
        if (isMissing(error)) { await unavailableCurrent(current.id, 'missing'); return; }
        if (error instanceof HiddenResource && (!editing || leavingEditor)) {
          await unavailableCurrent(current.id, 'unreadable'); return;
        }
      }
    }
    const id = currentId;
    const reachable = await workspace.reachable(id);
    let direct: StateNode[] = [];
    if (current?.kind === 'directory') {
      try { direct = await workspace.children(id); }
      catch (error) { if (version === refreshVersion) message = error instanceof GitHubApiError ? error : explainError(error); }
    }
    if (version !== refreshVersion || id !== currentId) return;
    edges = reachable.nodes;
    children = direct;
    rootIds = [...workspace.data.rootIds];
    // Persist pruning so missing nodes/edges do not reappear after reload.
    try { await saveWorkspace(workspace.data); } catch { /* Explicit saves report storage failures. */ }
    if (reachable.errors.length && !(message instanceof GitHubApiError)) message = `${reachable.errors.length} connection(s) could not be read. Reconnect the source in app settings, or remove its shortcut. ${reachable.errors[0]}`;
  }

  async function persist() {
    try { await saveWorkspace(workspace.data); storageMessage = ''; }
    catch { storageMessage = 'Changes work in this tab but could not be saved. Allow browser storage to remember your connections.'; }
    await refresh();
  }

  function queueHistory(delta: number) {
    historyQueue = historyQueue.then(() => traverseHistory(delta)).catch((error) => { message = explainError(error); });
  }

  async function traverseHistory(delta: number) {
    while (pendingNavigation) await pendingNavigation;
    if (traversingHistory || busy || loading || creating || relocateTarget) return;
    const history = editing ? editorHistory : navigationHistory;
    const target = history.target(delta);
    if (!target) return;
    traversingHistory = true;
    try {
      const wasEditing = editing;
      if (wasEditing && !await activeEditor?.saveForNavigation()) return;
      await navigate(target, true, false);
      if (currentId !== target) return;
      history.move(delta);
      if (wasEditing) {
        await tick();
        await activeEditor?.focusToolbar?.();
      }
    } finally { traversingHistory = false; }
  }

  async function navigate(id: string, updateHistory = true, recordVisit = true, openLocation?: PreviewLocation) {
    const operation = performNavigate(id, updateHistory, recordVisit, openLocation);
    pendingNavigation = operation;
    try { await operation; }
    finally { if (pendingNavigation === operation) pendingNavigation = undefined; }
  }

  async function performNavigate(id: string, updateHistory: boolean, recordVisit: boolean, openLocation?: PreviewLocation) {
    previewLocation = undefined;
    const version = ++navigationVersion;
    refreshVersion++;
    try {
      if (version !== navigationVersion) return;
      panel = null; message = ''; edges = []; children = [];
      if (id !== ROOT && workspace.cachedHandle(id)?.kind !== 'file') {
        const [sourceId] = JSON.parse(id) as string[];
        const repository = workspace.github(sourceId);
        if (repository) {
          // Refresh the branch before listing a folder, even if the tab stayed open.
          try {
            await repository.sync();
            if (version === navigationVersion) clearGitHubError(repository.id);
          } catch (error) {
            if (version === navigationVersion) githubError = error;
          }
        }
      }
      if (version !== navigationVersion) return;
      const node = id === ROOT ? null : await workspace.node(id);
      if (version !== navigationVersion) return;
      if (updateHistory) {
        pendingHistory = id;
        try { await goto(location.pathname, { state: { notework: id }, shallow: true, reset: false }); }
        finally { if (pendingHistory === id) pendingHistory = undefined; }
      }
      if (version !== navigationVersion) return;
      previewLocation = openLocation ? { id, location: openLocation } : undefined;
      current = node; creating = false;
      if (recordVisit) (editing ? editorHistory : navigationHistory).visit(id);
      await refresh();
      if (version !== navigationVersion) return;
      await tick();
      state_viewport.viewport?.scrollTo({ top: 0 });
      displayElement?.focus({ preventScroll: true });
    } catch (error) {
      if (version !== navigationVersion) return;
      if (isMissing(error)) { workspace.forget(id); message = 'Missing resource removed from the graph.'; await refresh(); }
      else message = error instanceof GitHubApiError ? error : explainError(error);
    }
  }

  async function openFile(location?: PreviewLocation) {
    if (current?.kind !== 'file' || busy || relocateTarget) return;
    const id = current.id;
    const repository = workspace.github(current.sourceId);
    if (repository) {
      busy = true;
      try { await repository.sync(); clearGitHubError(repository.id); }
      catch (error) {
        githubError = error;
        if (error instanceof GitHubApiError && error.canReconnect) return;
      }
      finally { busy = false; }
      await refresh();
    }
    if (needsPermission && source) await reconnect(source.id);
    if (current?.id !== id || needsPermission) return;
    panel = null;
    previewLocation = location ? { id, location } : undefined;
    editing = true;
    editorHistory.visit(id);
    state_viewport.viewport?.scrollTo({ top: 0 });
  }

  async function openNode(node: StateNode, location?: PreviewLocation) {
    if (node.kind !== 'file' || busy || relocateTarget) return;
    await navigate(node.id);
    if (current?.id === node.id) await openFile(location);
  }

  async function openLinkedFile(id: string, location?: PreviewLocation) {
    await navigate(id, true, true, location);
    if (currentId !== id) throw message instanceof Error ? message : new Error(typeof message === 'string' && message || 'The linked file could not be opened.');
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
    } catch (error) { renameError = error; }
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
      message = error;
    } finally { busy = false; }
  }

  async function selectGlobalResult(id: string, open: boolean) {
    if (id === currentId && open && editing) { globalSearch = false; return true; }
    if (editing && !await activeEditor?.saveForNavigation()) return false;
    editing = false;
    await navigate(id);
    if (currentId !== id) return false;
    if (open && current?.kind === 'file') await openFile();
    globalSearch = false;
    return true;
  }

  async function chooseGlobalLocation(node: StateNode) {
    globalSearch = false;
    await tick();
    chooseLocation(node);
  }

  async function exitEditor() {
    // Keep this file selected if browser history moved during editing.
    if (page.state.notework !== currentId) {
      await goto(location.pathname, { state: { notework: currentId }, shallow: true, reset: false });
    }
    await refresh(true);
    editing = false;
    navigationHistory.visit(currentId);
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

  async function unavailableCurrent(id: string, reason: 'missing' | 'unreadable') {
    if (current?.id !== id) return;
    if (reason === 'missing') workspace.forget(id);
    editing = false; creating = false;
    current = null; panel = null; edges = []; children = [];
    await goto(location.pathname, { state: { notework: ROOT }, shallow: true, replace: true, reset: false });
    await persist();
    message = reason === 'missing' ? 'Missing resource removed from the graph.' : 'This file is no longer readable as text. Its connections were kept.';
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
    } catch (error) { message = error; }
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
      message = error;
    } finally { busy = false; }
  }

  async function remove(from: string, to: string) {
    const sources = [...workspace.data.sources];
    workspace.unlink(from, to);
    const removed = sources.filter((source) => !workspace.data.sources.includes(source));
    const repositories = removed.flatMap((source) => source.handle instanceof GitHubDirectory ? [source.handle.repository] : []);
    const disconnecting = repositories.map((repository) => repository.disconnect());
    if (from === ROOT) {
      const prefix = JSON.parse(to) as string[];
      const forgotten = (id: string) => {
        if (id === ROOT) return false;
        const parts = JSON.parse(id) as string[];
        return prefix.every((part, index) => parts[index] === part) || removed.some((source) => source.id === parts[0]);
      };
      navigationHistory.forget(forgotten); editorHistory.forget(forgotten);
    }
    await sync.forget(removed.map((source) => source.id));
    await Promise.all(disconnecting);
    for (const source of removed) {
      delete permissions[source.id];
      githubPollFailures.delete(source.id);
      clearGitHubError(source.id);
      if (source.storage === 'github') await clearRepository(source.id);
    }
    await persist();
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
      panel = null;
      return true;
    } catch (error) {
      await clearRepository(id).catch(() => {});
      githubError = error;
      return false;
    } finally { busy = false; }
  }

  function clearGitHubError(id: string) {
    if (!(githubError instanceof GitHubApiError) || githubError.repositoryId === id) githubError = undefined;
  }

  function reconnectGitHub(id: string) {
    const repository = workspace.github(id);
    if (!repository || busy || githubReconnect) return Promise.resolve(false);
    return new Promise<boolean>((close) => { githubReconnect = { id, connection: repository.connection, close }; });
  }

  async function updateGitHubToken(id: string, token: string) {
    const repository = workspace.github(id);
    if (!repository) throw new Error('This GitHub repository is no longer connected.');
    await repository.replaceToken(token);
    clearGitHubError(id);
    await refresh();
  }

  function finishGitHubReconnect(reconnected: boolean) {
    const dialog = githubReconnect;
    githubReconnect = undefined;
    dialog?.close(reconnected);
  }

  async function disconnectGitHub(id: string) {
    if (busy || !confirm('Disconnect this repository? Notework will remove its token, cached files, and any unpublished drafts from this browser. Files on GitHub will stay as they are.')) return;
    busy = true; githubError = '';
    try {
      workspace.github(id)?.assertNoQueuedSync('');
      await clearRepository(id);
      workspace.forget(nodeId(id));
      await saveWorkspace(workspace.data);
      await refresh();
    } catch (error) { githubError = error; }
    finally { busy = false; }
  }

  async function refreshFolder() {
    if (busy) return;
    message = '';
    const repository = current && workspace.github(current.sourceId);
    if (repository) {
      busy = true;
      try { await repository.sync(); clearGitHubError(repository.id); }
      catch (error) { githubError = error; }
      finally { busy = false; }
    }
    await refresh();
  }
</script>

<svelte:head>
  <title>{current ? `${current.name} · ` : ''}notework</title>
  <meta name="description" content="A local-first network of files, folders, and notes. Navigate your information with Keyflow." />
</svelte:head>

<Keyflow options={{ storagePrefix: 'notework:keyflow:', minBox: 40, lockstep: false, keys: key_presets.alphanumeric, keypathVisible: 'auto' }}>
  <Document scrollKeys={editing && current ? false : {}}>
    <main class="app" class:editing-view={editing && !!current} aria-label="notework" aria-busy={loading}>
      {#if relocateTarget}
        <aside class="relocate-banner" aria-label="relocate" aria-live="polite">
          <p>choose location for {relocateTarget.name}</p>
          <Control class="cancel-relocate" onclick={cancelRelocate} disabled={busy || loading} keys="esc">cancel relocate</Control>
        </aside>
      {/if}
      {#if creating && (!current || current.kind === 'directory')}
        <CreateAsset path={current ? workspace.label(current) : 'home'} machineFolder={current?.storage === 'local'} githubFolder={current?.storage === 'github'}
          {busy} supported={canCreateHere} error={message} onCreate={createAtFolder}
          onCancel={() => { creating = false; message = ''; }} />
      {:else if editing && current}
        {@const id = current.id}
        {#key current.uri}
          {#if current.drawing && rawTextId !== id}
            <StandaloneDrawing initialPoint={previewLocation?.id === id && previewLocation.location.kind === 'drawing' ? previewLocation.location.point : undefined} bind:this={activeEditor} {pdfMargins} {stylusOnly} autosaveMs={autosaveSeconds * 1000} {workspace} node={current} onExit={exitEditor} onMissing={() => { void unavailableCurrent(id, 'missing'); }}
              onRawText={isVisualName(current.name) ? () => { rawTextId = id; } : undefined} />
          {:else}
            <TextEditor initialLocation={previewLocation?.id === id ? previewLocation.location : undefined} bind:this={activeEditor} {showLineNumbers} {showLineIndex} {workspace} node={current} {wrapLines} {prettyFontSize} {prettyMargin} {vimMode} {stylusOnly} {pdfMargins} autosaveMs={autosaveSeconds * 1000} onExit={exitEditor}
              onMissing={() => { void unavailableCurrent(id, 'missing'); }} onOpenLink={openLinkedFile}
              onVisualEditor={rawTextId === id ? () => { rawTextId = undefined; } : undefined} />
          {/if}
        {/key}
      {:else}
      {#snippet panelContents()}
      <div bind:this={panelElement}>
        {#if panel}
          <div class="panel-controls"><Action label={`close ${panel === 'settings' ? 'app settings' : panel === 'configure' ? `configure ${resourceType}` : panel}`} onSelect={() => { panel = null; }} /></div>
        {/if}
        {#if panel === 'configure' && current}
          <section class="panel" aria-labelledby="configure-heading">
            <h2 id="configure-heading">configure {resourceType}</h2>
            {#if current.kind === 'directory'}
              <Action label="refresh folder" onSelect={refreshFolder} disabled={busy || loading} />
            {/if}
            {#if needsPermission}
              <Action label={`reconnect ${source!.handle.name}`} onSelect={() => reconnect(source!.id)} disabled={busy || loading} />
            {/if}
            {#if githubRoot}
              <Action label="GitHub repositories" onSelect={() => togglePanel('github')} disabled={busy || loading} />
            {:else}
              <Action label="rename" onSelect={askRename} disabled={busy || loading} />
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

            {#if connectedSources.length}
              <h3>connected sources</h3>
              <div class="source-list">
                {#each connectedSources as grant (grant.id)}
                  <div class="config-row"><span>{grant.handle.name} · {grant.storage !== 'local' ? storageLabel(grant.storage ?? 'local') : permissions[grant.id] === 'granted' ? 'read access granted' : 'needs permission'}</span></div>
                  {#if grant.storage === 'local' && permissions[grant.id] !== 'granted'}
                    <Action label={`reconnect ${grant.handle.name}`} onSelect={() => reconnect(grant.id)} disabled={busy || loading} />
                  {/if}
                  {#if !rootIds.includes(nodeId(grant.id))}
                    <Control class="small-button config-row" onclick={() => { workspace.link(ROOT, nodeId(grant.id)); void persist(); }}>add {grant.handle.name} to root</Control>
                  {/if}
                {/each}
              </div>
            {/if}

            <h3>appearance</h3>
            <ChoiceMenu label="color theme" value={themeChoice} choices={themeChoices.map((id) => ({ id, label: id }))}
              onchange={(value) => chooseTheme(value as ThemeChoice)} />
            <Action label={`line numbers: ${showLineNumbers ? 'on' : 'off'}`} onSelect={() => {
              showLineNumbers = !showLineNumbers; saveAppearancePreference('notework:line-numbers', showLineNumbers);
            }} />
            <Action label={`line index mod 4: ${showLineIndex ? 'on' : 'off'}`} onSelect={() => {
              showLineIndex = !showLineIndex; saveAppearancePreference('notework:line-index', showLineIndex);
            }} />
            <p class="muted">Zero-based line index in spare margins: gray/gray = 0, transparent/gray = 1, gray/transparent = 2, transparent/transparent = 3.</p>
            <h3>keyboard</h3>
            <Action label={`key labels: ${keypath_visibility.visible ? 'shown' : 'hidden'}`} onSelect={() => keypath_visibility.toggle()} />
            <p class="muted">Shown by default on computers and hidden on phones and tablets. Key colors stay, and shortcuts keep working while labels are hidden.</p>
            <ChoiceMenu label="shortcut input space" value={shortcutAlphabet}
              choices={[{ id: 'alphanumeric', label: 'Alphanumeric (A–Z, 0–9)' }, { id: 'letters', label: 'Letters (A–Z)' }]}
              onchange={(value) => {
                shortcutAlphabet = value;
                set_available_keys(value === 'letters' ? key_presets.letters : key_presets.alphanumeric);
                try { localStorage.setItem('notework:shortcut-alphabet', value); } catch { /* Session only. */ }
              }} />
            <Action label={`virtual keyboard: ${virtualKeyboard ? 'on' : 'off'}`} onSelect={() => {
              virtualKeyboard = !virtualKeyboard; saveAppearancePreference('notework:virtual-keyboard', virtualKeyboard);
            }} />
            <ChoiceMenu label="virtual keyboard layout" value={keyboardChoice} choices={keyboardChoices}
              onchange={(value) => {
                if (!isKeyboardChoice(value)) return;
                keyboardChoice = value;
                try { localStorage.setItem('notework:keyboard-layout', value); } catch { /* Session only. */ }
              }} />
            <p class="muted">Off by default. When enabled, use the selected Keyflow keyboard instead of the system text keyboard. Flick alpha supports directional gestures during text editing.</p>
            <Action label={`Vim mode: ${vimMode ? 'on' : 'off'}`} onSelect={() => {
              vimMode = !vimMode;
              saveAppearancePreference('notework:vim-mode', vimMode);
            }} />
            <Action label={`wrap long lines: ${wrapLines ? 'on' : 'off'}`} onSelect={() => {
              wrapLines = !wrapLines;
              saveAppearancePreference('notework:wrap-lines', wrapLines);
            }} />
            <Action label={`pretty font sizing: ${prettyFontSize ? 'on' : 'off'}`} onSelect={() => {
              prettyFontSize = !prettyFontSize;
              saveAppearancePreference('notework:pretty-font-size', prettyFontSize);
            }} />
            <Action label={`pretty margin: ${prettyMargin ? 'on' : 'off'}`} onSelect={() => {
              prettyMargin = !prettyMargin;
              saveAppearancePreference('notework:pretty-margin', prettyMargin);
            }} />
            <Action label={`draw with only physical stylus: ${stylusOnly ? 'enabled' : 'disabled'}`} onSelect={() => {
              stylusOnly = !stylusOnly;
              saveAppearancePreference('notework:stylus-only', stylusOnly);
            }} />
            <Action label="smaller type" onSelect={() => min_box.set(Math.max(24, min_box.value - 4))} />
            <Action label="larger type" onSelect={() => min_box.set(Math.min(72, min_box.value + 4))} />
            <p class="muted">Use the colored key labels (when shown) or click a button. Tab and Enter also work. Scrolling is native.</p>
            <h3>GitHub updates</h3>
            <label class="field"><span>GitHub check interval (seconds)</span>
              <input type="number" min="1" step="any" value={githubPollSeconds} oninput={(event) => updateGitHubInterval(event.currentTarget)} />
            </label>
            <p class="muted">Default: 4 seconds. Checks pause while offline or the app is hidden. Unchanged repositories use conditional requests; rate limits pause checks automatically. Open drafts are preserved.</p>
            <h3>autosave</h3>
            <label class="field"><span>autosave at most every (seconds)</span>
              <input type="number" min={MIN_AUTOSAVE_SECONDS} step="1" value={autosaveSeconds}
                oninput={(event) => updateAutosaveInterval(event.currentTarget)} />
            </label>
            <p class="muted">Default: {DEFAULT_AUTOSAVE_SECONDS} seconds. Exit saves first and queues GitHub sync in the background. Local files may ask for write access when you exit.</p>
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
          <Action label="back to app settings" onSelect={() => togglePanel('settings')} disabled={busy || loading} />
          <GitHubSettings sources={githubSources} {busy} error={githubError}
            onConnect={connectGitHub} onUpdate={reconnectGitHub} onDisconnect={disconnectGitHub} />
        {/if}
      </div>
      {/snippet}
      <nav aria-label="state navigation">
        <Action label="search" onSelect={() => { searchMenu = true; }} disabled={loading || busy} />
        {#if current}
          <Menu label={`configure ${resourceType}`} open={panel !== null} disabled={(busy || loading) && panel === null}
            onopen={() => { void togglePanel('configure'); }} onclose={() => { panel = null; }}>
            {#snippet children()}{@render panelContents()}{/snippet}
          </Menu>
          {#if current.kind === 'directory'}
            <Action label="create new file/folder" onSelect={startCreating} disabled={loading || busy || !canCreateHere} />
          {/if}
        {:else}
          <Menu label="app settings" open={panel !== null} disabled={(busy || loading) && panel === null}
            onopen={() => { void togglePanel('settings'); }} onclose={() => { panel = null; }}>
            {#snippet children()}{@render panelContents()}{/snippet}
          </Menu>
        {/if}
        <hr />
        {#if current}
          <Action label="home" iconOnly onSelect={() => navigate(ROOT)} disabled={busy || loading}>
            <svg class="action-icon" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="m3 11 9-8 9 8" /><path d="M5 10v11h14V10" /><path d="M9 21v-7h6v7" />
            </svg>
          </Action>
          <Action label=".." onSelect={() => navigate(parentId(current!))} disabled={busy || loading} />
        {/if}
        {#each edges as node (node.id)}
          {#if relocateTarget && node.kind === 'directory'}
            <div class="file-navigation-row">
              <Action label="choose" onSelect={() => chooseLocation(node)} disabled={busy || loading} />
              <Action label={node.name + '/'} onSelect={() => navigate(node.id)} disabled={busy || loading} />
            </div>
          {:else if !relocateTarget && node.kind === 'file' && directChildIds.has(node.id) && (!current || current.kind === 'directory')}
            <div class="file-navigation-row">
              <Action label="open" onSelect={() => { void openNode(node); }} disabled={busy || loading} />
              <Action label={node.name} onSelect={() => navigate(node.id)} disabled={busy || loading} />
            </div>
          {:else}
            <Action label={node.name + (node.kind === 'directory' ? '/' : '')} onSelect={() => navigate(node.id)} disabled={busy || loading} />
          {/if}
        {/each}
      </nav>

      {#if loading}<p class="muted" role="status">opening workspace…</p>{/if}
      {#if !supported}
        <p class="notice" role="status">Local filesystem access needs Chrome or Edge on HTTPS or localhost. Open Notework there to select files and folders from your computer.</p>
      {/if}
      {#if storageMessage}<p class="notice" role="status">{storageMessage}</p>{/if}
      {#if githubError && panel !== 'github'}<StorageNotice error={githubError} role="status" />{/if}
      {#if message}<StorageNotice error={message} />{/if}

      <section class="state-display" aria-label="current state" tabindex="-1" bind:this={displayElement}>
        {#if current}
          <h1 aria-label={current.name + (current.kind === 'directory' ? '/' : '')}>
            {#if current.kind === 'file' && !relocateTarget}
              <span data-action="open"><Control onclick={() => openFile()} disabled={busy || loading}>open: {current.name}</Control></span>
            {:else}{current.name}{current.kind === 'directory' ? '/' : ''}{/if}
          </h1>
          <p class="path">{workspace.label(current)} · {current.storage === 'local' ? 'computer' : storageLabel(current.storage)} · {current.kind === 'directory' ? 'folder' : 'file'}</p>
          {#if relocateTarget && current.kind === 'directory'}
            <Action label="choose" onSelect={() => chooseLocation(current)} disabled={busy || loading} />
          {/if}
          {#if current.kind === 'file' && !relocateTarget}
            {#key `${current.uri}:${githubPullRevision}`}
              <FilePreview {workspace} node={current} {wrapLines} {prettyFontSize} {prettyMargin} {showLineNumbers}
                onOpen={openFile} onOpenReference={(id, location) => { void workspace.node(id).then((node) => openNode(node, location)).catch((error) => { message = error; }); }} disabled={busy || loading} />
            {/key}
          {:else if current.kind === 'directory'}
            <p class="muted">{children.length} direct {children.length === 1 ? 'child' : 'children'} · {edges.length} reachable {edges.length === 1 ? 'state' : 'states'}</p>
          {/if}
        {:else}
          <h1>home</h1>
          {#if relocateTarget}<Action label="choose" onSelect={() => chooseLocation(null)} disabled={busy || loading} />{/if}
          <p class="path">virtual folder · {edges.length} {edges.length === 1 ? 'item' : 'items'} from connected sources</p>
        {/if}
      </section>
      {/if}
    </main>
  </Document>
  <dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={renameDialog} aria-labelledby="rename-title"
    oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="rename-title">Rename {renameTarget?.kind === 'directory' ? 'folder' : 'file'}</h2>
    <form bind:this={renameForm} use:submitOnEnter onsubmit={(event) => { event.preventDefault(); void renameCurrent(); }}>
      <label class="field">new name <input bind:value={() => renameName, (value) => {
        renameName = stripFilenameEditingArtifacts(value); renameError = '';
      }} required maxlength="255" disabled={busy || loading} /></label>
      {#if renameError}<StorageNotice error={renameError} />{/if}
      <div class="editor-controls">
        <Control onclick={() => renameForm.requestSubmit()} disabled={busy || loading}>Rename and update links</Control>
        <Control onclick={() => renameDialog.close()} disabled={busy || loading}>Cancel</Control>
      </div>
    </form>
  </dialog>
  <dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={relocateDialog} aria-labelledby="relocate-heading"
    oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="relocate-heading">Relocate {relocateTarget?.kind === 'directory' ? 'folder' : 'file'} to {storageLabel(relocateDestination?.storage ?? 'browser')}?</h2>
    <p class="muted">This creates “{relocateTarget?.name}”{relocateTarget?.kind === 'directory' ? ' and all its contents' : ''} in {storageLabel(relocateDestination?.storage ?? 'browser')} at {relocateDestination ? workspace.label(relocateDestination) : 'home'}, then deletes the original from {storageLabel(relocateTarget?.storage ?? 'browser')}.</p>
    <div class="editor-controls">
      <Control onclick={() => relocateDialog.close()} disabled={busy || loading}>No</Control>
      <Control onclick={finishRelocate} disabled={busy || loading}>Yes</Control>
    </div>
  </dialog>
  <dialog use:dialogShortcuts class="local-picker editor-exit" bind:this={deleteDialog} aria-labelledby="delete-heading"
    onclose={() => { deleteTarget = null; }} oncancel={(event) => { if (busy) event.preventDefault(); }}>
    <h2 id="delete-heading">Delete {deleteTarget?.name}?</h2>
    <p class="muted">{deleteTarget?.kind === 'directory' ? 'This permanently deletes the folder and everything inside it.' : 'This permanently deletes the file.'}</p>
    <div class="editor-controls">
      <Control onclick={() => deleteDialog.close()} disabled={busy || loading}>Cancel</Control>
      <Control onclick={deleteCurrent} disabled={busy || loading}>Delete {deleteTarget?.kind === 'directory' ? 'folder' : 'file'}</Control>
    </div>
  </dialog>
  <AppKeyboard enabled={virtualKeyboard} choice={keyboardChoice} />
  <GitHubSyncProgress />
  {#if heldModifier && !globalSearch && !contentSearch && !searchMenu}<aside class="modifier-hints" aria-label="Command and Control shortcuts">C · Copy &nbsp; V · Paste &nbsp; F · Search text in folder children &nbsp; P · Search file in folder children &nbsp; Shift+F · Search text in all files &nbsp; Shift+P · Search file in all files &nbsp; S · Save</aside>{/if}
  {#if searchMenu}<SearchMenu onChoose={beginSearch} onClose={closeSearchMenu} />{/if}
  {#if contentSearch && contentIndex}<ContentSearchDialog {workspace} index={contentIndex} from={searchFrom}
    label={searchLabel} {graphRevision}
    onOpen={async (node, position) => {
      if (editing && !await activeEditor?.saveForNavigation()) throw new Error('Save could not finish. Exit search to resolve the editor’s save message.');
      editing = false;
      await navigate(node.id);
      if (currentId === node.id) {
        contentSearch = false;
        if (!relocateTarget) await openFile({ kind: 'text', position });
      }
    }} onClose={() => { contentSearch = false; }} />{/if}
  {#if globalSearch}<GlobalSearch {workspace} from={searchFrom} everywhere={searchEverywhere} scopeLabel={searchLabel} {graphRevision} relocating={!!relocateTarget}
    onChoose={chooseGlobalLocation} onSelect={selectGlobalResult} onClose={() => { globalSearch = false; }} />{/if}
  {#if picking}
    <LocalPicker onSelect={add} onCancel={() => { picking = false; }} />
  {/if}
  {#if githubConflict}
    <GitHubConflictDialog conflict={githubConflict.conflict} onChoose={finishGitHubConflict} {stylusOnly} autosaveMs={autosaveSeconds * 1000} />
  {/if}
  {#if githubReconnect}
    {@const { id, connection } = githubReconnect}
    <GitHubReconnectDialog {connection} onSave={(token) => updateGitHubToken(id, token)} onClose={finishGitHubReconnect} />
  {/if}
</Keyflow>
