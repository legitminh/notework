<script module lang="ts">
  import { getCM, vim, Vim } from '@replit/codemirror-vim';
  import type { EditorView as VimEditorView } from '@codemirror/view';

  const vimSaves = new WeakMap<VimEditorView, () => void>();
  Vim.defineEx('write', 'w', (cm) => vimSaves.get(cm.cm6)?.());
</script>

<script lang="ts">
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import EditorTitle from './EditorTitle.svelte';
  import { preserveContentFocus } from '../editor-focus';
  import { onMount, tick } from 'svelte';
  import { Compartment, EditorState, Prec, Text, Transaction, type EditorSelection } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionKeymap, completionStatus, pickedCompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete';
  import { bracketMatching, indentUnit } from '@codemirror/language';
  import { closeSearchPanel, openSearchPanel, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import { parentId, ROOT, type Workspace, type StateNode } from '../workspace';
  import { isMissing, type LocalFile } from '../filesystem';
  import { decodedChunks, encodedChunks, inspectTextFile, type TextFormat } from '../text-resource';
  import { writeBrowserContent } from '../browser-documents';
  import { saveWorkspace } from '../persistence';
  import ExportDialog from './ExportDialog.svelte';
  import type { PdfMargins } from '../export-preferences';
  import { exportStyle } from '../export-style';
  import type { PdfSource } from '../pdf-export';
  import DrawingEditor from './DrawingEditor.svelte';
  import { svgPages, type SvgPage } from '../svg-pages';
  import { svgPageNames, type Drawing } from '../drawing';
  import { canCreateSiblingDrawing, commitDrawing, hasDrawingDraft, loadDrawingReference, prepareSvgPages, saveDrawing, saveSiblingDrawing, type DrawingResource } from '../drawing-files';
  import { wikiDisplay } from '../wiki-display';
  import { containingFolder, findWikiTarget, prepareWikiSave, requireWrite, validFilename, wikiCatalog, wikiScore, wikiToken, wikiTokens, WritePermissionRequired } from '../wiki';
  import { commandCompletion, opensCommandArguments } from '../command-completion';
  import { prettyDisplay } from '../pretty-display';
  import { GitHubChanged, GitHubEditCancelled, GitHubFile, type ResolveGitHubConflict } from '../github/repository';
  import { draftQueue, type DraftQueue } from '../github/storage';

  let { workspace, node, wrapLines, prettyFontSize, vimMode, stylusOnly, pdfMargins, autosaveMs, resolveGitHubConflict, onExit, onMissing, onOpenLink }: {
    workspace: Workspace; node: StateNode;
    wrapLines: boolean;
    prettyFontSize: boolean;
    vimMode: boolean;
    stylusOnly: boolean;
    autosaveMs: number;
    resolveGitHubConflict: ResolveGitHubConflict;
    pdfMargins: PdfMargins;
    onExit: () => void | Promise<void>;
    onOpenLink: (id: string) => Promise<void>;
    onMissing: () => void;
  } = $props();
  let container: HTMLDivElement;
  let toolbar = $state<HTMLDivElement>();
  let usingTools = $state(false);
  let drawingEditor = $state<{ resumeEditing: () => void }>();
  let nextLink = $state<string>();
  let followingLink = false;
  const catalogController = new AbortController();
  let catalogRequest: Promise<StateNode[]> | undefined;
  let inlineDrawing = $state.raw<{ page: SvgPage; host: HTMLDivElement; resource?: DrawingResource }>();
  let exportSource = $state.raw<PdfSource>();
  let exportSelection: EditorSelection | undefined;
  let openingDrawing = false;
  const textLock = new Compartment();
  const pageWidgets = svgPages((page) => { void openDrawing(page); }, () => vimMode);
  const newDrawings = new Set<string>();
  const previews = new Map<string, Promise<DrawingResource | undefined>>();
  let savedPages = new Set<string>();
  let savedTokens = new Set<string>();
  const requestedCreates = new Set<string>();
  let view: EditorView | undefined;
  let handle: LocalFile;
  let format: TextFormat;
  let loading = $state(true);
  let dirty = $state(false);
  let saving = $state(false);
  let error = $state.raw<unknown>();
  let waitingForPermission = $state(false);
  let loadedBytes = $state(0);
  let revision = 0;
  let savedRevision = 0;
  let active = false;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSaveAt = 0;
  let githubBase: string | null = null;
  let githubPending = $state(false);
  let githubPublishing = $state(false);
  let githubSaveRequested = false;
  let githubExitRequested = false;
  const withGitHubDraft = draftQueue();
  const newerGitHubEdit = Symbol();

  function* chunks(doc: Text) {
    let buffer = '';
    for (const part of doc) {
      buffer += part;
      if (buffer.length >= 65536) { yield buffer; buffer = ''; }
    }
    if (buffer) yield buffer;
  }

  async function write(snapshot: Text) {
    const current = await handle.getFile();
    if (current.size !== format.size || current.lastModified !== format.modified) throw new Error('The file changed outside this editor. Export your edits before reopening it.');
    const content = encodedChunks(chunks(snapshot), format);
    if (node.storage === 'browser') await writeBrowserContent(handle, content);
    else {
      // Local machine writes happen only after an explicit Save grants write permission.
      const stream = await (handle as unknown as FileSystemFileHandle).createWritable();
      try { for (const chunk of content) await stream.write(chunk); await stream.close(); }
      catch (cause) { await stream.abort().catch(() => {}); throw cause; }
    }
    const saved = await handle.getFile();
    format = { ...format, size: saved.size, modified: saved.lastModified };
    workspace.setFormat(node.id, format);
  }

  function catalog() {
    return catalogRequest ??= wikiCatalog(workspace, catalogController.signal).catch((cause) => {
      catalogRequest = undefined;
      throw cause;
    });
  }

  async function completeWiki(context: CompletionContext) {
    const match = context.matchBefore(/\[\[[^\[\]\n]*$/);
    if (!match) return null;
    const query = match.text.slice(2).trim();
    let files: StateNode[];
    try { files = await catalog(); }
    catch { return null; }
    if (context.aborted) return null;
    const option = (label: string, token: string, detail?: string, create = false): Completion => ({
      label, detail,
      apply(editor, completion, from, to) {
        if (create) requestedCreates.add(token);
        const suffix = editor.state.sliceDoc(to, editor.state.doc.lineAt(to).to);
        const existing = /^[^\[\]]*\]\]/.exec(suffix);
        editor.dispatch({
          changes: { from, to: to + (existing?.[0].length ?? 0), insert: token + ']]' },
          selection: { anchor: from + token.length + 2 },
          annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')]
        });
      }
    });
    const options = files.filter((file) => file.id !== node.id && !/[\[\]\n]/.test(file.name))
      .map((file) => ({ file, score: Math.min(wikiScore(query, file.name), wikiScore(query, workspace.label(file))) }))
      .filter(({ score }) => Number.isFinite(score))
      .sort((a, b) => a.score - b.score || a.file.name.localeCompare(b.file.name))
      .slice(0, 8)
      .map(({ file }) => option(file.name, wikiToken(workspace, node, file, files), workspace.label(file)));
    let matches = false;
    try { matches = !!findWikiTarget(workspace, node, query, files); }
    catch { matches = true; }
    if (validFilename(query) && !matches) options.push(option(`create: ${query}`, query, undefined, true));
    return options.length ? { from: match.from + 2, options, filter: false } : null;
  }

  async function insertDrawing() {
    if (!view || saving || inlineDrawing) return;
    error = '';
    try {
      // Brush explicitly creates a sibling SVG, so acquire directory write access
      // while this click or keyboard gesture is still active.
      if (node.storage === 'local') {
        const parent = parentId(node);
        const cached = parent === ROOT ? undefined : workspace.cachedHandle(parent);
        const folder = cached?.kind === 'directory' ? cached : await containingFolder(workspace, node, handle);
        await requireWrite(folder, true);
      }
      const name = `drawing-${crypto.randomUUID().slice(0, 8)}.svg`;
      const { from, to } = view.state.selection.main;
      const before = from === view.state.doc.lineAt(from).from ? '' : '\n';
      const after = to < view.state.doc.length && view.state.sliceDoc(to, to + 1) === '\n' ? '' : '\n';
      const insert = `${before}\\svgpage[${name}]${after}`;
      newDrawings.add(name);
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length + (after ? 0 : 1) },
        annotations: Transaction.userEvent.of('input'),
        scrollIntoView: true
      });
      if (!usingTools) view.focus();
    } catch (cause) { error = cause; }
  }

  function refreshDrawingPreviews() {
    if (!view || !active) return;
    for (const { name } of view.state.field(pageWidgets.field).pages) {
      if (newDrawings.has(name) || previews.has(name)) continue;
      const loading = catalog().then((files) => loadDrawingReference(workspace, node, handle, name, files));
      previews.set(name, loading);
      void loading.then((resource) => {
        if (active && resource && previews.get(name) === loading) {
          view?.dispatch({ effects: pageWidgets.setPreview.of({ name, strokes: resource.strokes }) });
        }
      }).catch(() => { /* Opening the preview will report unavailable drawings. */ });
    }
  }

  async function openDrawing(page: SvgPage) {
    if (!view || saving || githubPublishing || inlineDrawing || openingDrawing || followingLink) return;
    openingDrawing = true; error = '';
    try {
      const resource = newDrawings.has(page.name) ? undefined : await loadDrawingReference(workspace, node, handle, page.name, await catalog());
      if (!resource && !canCreateSiblingDrawing(page.name)) throw new Error(`Drawing resource “${page.name}” could not be found.`);
      if (!active || githubPublishing || !view.state.field(pageWidgets.field).pages.some((item) => item.from === page.from && item.name === page.name)) return;
      const host = document.createElement('div');
      host.className = 'inline-drawing-host';
      view.dispatch({ effects: [
        pageWidgets.setActive.of({ from: page.from, host }),
        textLock.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)])
      ] });
      usingTools = false;
      inlineDrawing = { page, host, resource };
      await tick();
      view.requestMeasure();
    } catch (cause) { error = cause; }
    finally { openingDrawing = false; }
  }

  async function saveInlineDrawing(strokes: Drawing, requestWrite: boolean) {
    const drawing = inlineDrawing;
    if (!drawing) return;
    const { name } = drawing.page;
    drawing.resource = drawing.resource
      ? await saveDrawing(drawing.resource, strokes, requestWrite)
      : await saveSiblingDrawing(workspace, node, handle, name, strokes, requestWrite);
    newDrawings.delete(name);
    previews.set(name, Promise.resolve(drawing.resource));
    view?.dispatch({ effects: pageWidgets.setPreview.of({ name, strokes }) });
  }

  async function closeInlineDrawing() {
    view?.dispatch({ effects: [pageWidgets.setActive.of(undefined), textLock.reconfigure([])] });
    inlineDrawing = undefined;
    await tick();
    resumeEditing();
    scheduleAutosave();
  }

  async function commitInlineDrawing(beforeConflict: () => void, withDraft: DraftQueue) {
    const drawing = inlineDrawing;
    if (!drawing?.resource) return;
    const finish = await commitDrawing(drawing.resource, (conflict) => {
      beforeConflict();
      return resolveGitHubConflict(conflict);
    }, withDraft);
    return withDraft(async () => {
      drawing.resource = await finish();
      const { name } = drawing.page;
      previews.set(name, Promise.resolve(drawing.resource));
      view?.dispatch({ effects: pageWidgets.setPreview.of({ name, strokes: drawing.resource?.strokes ?? [] }) });
      return drawing.resource?.strokes;
    });
  }

  function clearAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = undefined;
  }

  function scheduleAutosave() {
    clearAutosave();
    if (!active || !dirty || saving || inlineDrawing || waitingForPermission) return;
    const delay = Math.max(0, lastSaveAt + autosaveMs - Date.now());
    autosaveTimer = setTimeout(() => {
      autosaveTimer = undefined;
      void save(false, false);
    }, delay);
  }

  async function save(leave = false, requestWrite = true) {
    if (!view || inlineDrawing) return;
    const file = handle;
    if (file instanceof GitHubFile) {
      if (requestWrite) {
        githubSaveRequested = true;
        githubExitRequested ||= leave;
        if (!githubPublishing) await publishGitHub(file);
        else if (dirty) void save(false, false);
      } else if (dirty && !saving) {
        saving = true;
        try { await withGitHubDraft(() => writeGitHubDraft(file)); }
        catch (cause) { error = cause; lastSaveAt = Date.now(); }
        finally { saving = false; if (dirty) scheduleAutosave(); }
      }
      return;
    }
    if (saving) return;
    if (!dirty) {
      if (leave) await finishExit();
      return;
    }
    clearAutosave();
    saving = true; error = '';
    let succeeded = false;
    try {
      const snapshot = view.state.doc;
      const version = revision;
      const tokens = wikiTokens(snapshot);
      const pages = svgPageNames(snapshot);
      if (node.storage === 'local') {
        // Start every permission request before the first await so an explicit
        // Exit/Ctrl+S gesture remains eligible to open the browser prompt.
        const permissions = [requireWrite(handle, requestWrite)];
        const mayCreateSibling = [...tokens].some((token) => !savedTokens.has(token) || requestedCreates.has(token)) ||
          [...pages].some((name) => canCreateSiblingDrawing(name) && (!savedPages.has(name) || newDrawings.has(name)));
        const parent = parentId(node);
        const cached = parent === ROOT ? undefined : workspace.cachedHandle(parent);
        if (mayCreateSibling && cached?.kind === 'directory') permissions.push(requireWrite(cached, requestWrite));
        await Promise.all(permissions);
      }
      if (tokens.size || pages.size || Object.keys(workspace.data.wiki?.[node.id] ?? {}).length) {
        const prepared = await prepareWikiSave(workspace, node, handle, tokens, tokens.size ? await catalog() : [],
          (token) => !savedTokens.has(token) || requestedCreates.has(token), requestWrite);
        let svg: Awaited<ReturnType<typeof prepareSvgPages>> | undefined;
        try {
          svg = await prepareSvgPages(workspace, node, handle, pages,
            (name) => !savedPages.has(name) || newDrawings.has(name), requestWrite, await catalog());
          await write(snapshot);
        } catch (cause) {
          await svg?.rollback(); await prepared.rollback(); throw cause;
        }
        workspace.replaceWikiLinks(node.id, { ...prepared.targets, ...svg.targets });
        await saveWorkspace(workspace.data);
        for (const name of pages) {
          newDrawings.delete(name);
          previews.delete(name);
        }
        catalogRequest = undefined;
        refreshDrawingPreviews();
      } else await write(snapshot);
      savedPages = pages;
      savedTokens = tokens;
      requestedCreates.clear();
      savedRevision = version;
      dirty = revision !== savedRevision;
      waitingForPermission = false;
      succeeded = true;
      lastSaveAt = Date.now();
      if (leave && !dirty) await finishExit();
    } catch (cause) {
      lastSaveAt = Date.now();
      if (cause instanceof WritePermissionRequired) waitingForPermission = true;
      else error = cause;
    } finally {
      saving = false;
      if (leave && succeeded && dirty) void save(true, true);
      else if (dirty && !waitingForPermission) scheduleAutosave();
    }
  }

  async function writeGitHubDraft(file: GitHubFile, replacement?: Blob) {
    const { repository, path } = file;
    const version = revision, snapshot = view!.state.doc;
    if (dirty || replacement) {
      const content = replacement ?? new Blob([...encodedChunks(chunks(snapshot), format)]);
      await repository.saveDraft(path, { base: githubBase, content, modified: Date.now() });
      githubPending = true;
      savedRevision = version;
      dirty = revision !== version;
      lastSaveAt = Date.now();
    }
    return { version, snapshot, draft: repository.draft(path) };
  }

  async function publishGitHub(file: GitHubFile) {
    githubPublishing = true; error = '';
    try {
      do {
        githubSaveRequested = false;
        try { await publishGitHubDraft(file); }
        catch (cause) { if (cause !== newerGitHubEdit) throw cause; githubSaveRequested = true; }
      } while (active && (githubSaveRequested || (githubExitRequested && (dirty || githubPending))));
      if (active && githubExitRequested) {
        view?.dispatch({ effects: textLock.reconfigure(EditorState.readOnly.of(true)) });
        await finishExit();
      }
    } catch (cause) {
      if (!(cause instanceof GitHubEditCancelled)) error = cause;
    } finally {
      if (active && githubExitRequested) view?.dispatch({ effects: textLock.reconfigure([]) });
      githubPublishing = githubSaveRequested = githubExitRequested = false;
      if (dirty) scheduleAutosave();
    }
  }

  async function publishGitHubDraft(file: GitHubFile) {
    const editor = view!;
    const { repository, path } = file;
    let { version, snapshot, draft } = await withGitHubDraft(() => writeGitHubDraft(file));
    if (!draft) return;
    let conflict = false;
    try {
      for (let attempt = 0; ; attempt++) {
        const chosen = await repository.reconcile(path, draft, async (versions) => {
          // Compare the latest local text, even if it changed while GitHub was responding.
          if (revision !== version) throw newerGitHubEdit;
          conflict = true;
          editor.dispatch({ effects: textLock.reconfigure(EditorState.readOnly.of(true)) });
          return resolveGitHubConflict(versions);
        });
        if (chosen.content !== draft.content) {
          const selected = chosen.content && new File([chosen.content], node.name);
          const selectedFormat = selected && await inspectTextFile(selected);
          if (!selected || !selectedFormat) {
            await withGitHubDraft(() => repository.saveDraft(path));
            githubPending = false;
            onMissing();
            return;
          }
          let text = '';
          for await (const chunk of decodedChunks(selected, selectedFormat)) text += chunk;
          snapshot = Text.of(text.replace(/\r\n?/g, '\n').split('\n'));
          editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: snapshot } });
          format = selectedFormat;
        }
        if (conflict) {
          githubBase = chosen.base;
          ({ version, snapshot, draft } = await withGitHubDraft(() => writeGitHubDraft(file, chosen.content!)));
          if (!draft) return;
        }
        const checkpoint = repository.checkpoint();
        const tokens = wikiTokens(snapshot), pages = svgPageNames(snapshot);
        let wiki: Awaited<ReturnType<typeof prepareWikiSave>> | undefined;
        let svg: Awaited<ReturnType<typeof prepareSvgPages>> | undefined;
        try {
          if (!chosen.unchanged) repository.stage(path, draft.content);
          if (tokens.size || pages.size) {
            catalogRequest = undefined;
            const files = await catalog();
            wiki = await prepareWikiSave(workspace, node, file, tokens, files,
              (token) => !chosen.unchanged && (!savedTokens.has(token) || requestedCreates.has(token)), true, chosen.unchanged);
            svg = await prepareSvgPages(workspace, node, file, pages,
              (name) => !chosen.unchanged && (!savedPages.has(name) || newDrawings.has(name)), true, files, chosen.unchanged);
          }
          await repository.commit(checkpoint, `edit: ${node.name}`, chosen.head);
        } catch (cause) {
          await svg?.rollback(); await wiki?.rollback(); repository.restore(checkpoint);
          if (cause instanceof GitHubChanged && cause.path === path && attempt < 2) continue;
          throw cause;
        }
        workspace.replaceWikiLinks(node.id, { ...wiki?.targets, ...svg?.targets });
        await withGitHubDraft(async () => {
          githubBase = repository.editBase(path);
          if (revision === version) {
            await repository.saveDraft(path);
            githubPending = false;
          } else if (dirty) await writeGitHubDraft(file);
          else await repository.rebaseDraft(path, githubBase);
        });
        savedTokens = tokens; savedPages = pages;
        for (const token of tokens) requestedCreates.delete(token);
        for (const name of pages) { newDrawings.delete(name); previews.delete(name); }
        catalogRequest = undefined;
        refreshDrawingPreviews();
        await saveWorkspace(workspace.data);
        return;
      }
    } finally {
      if (conflict && active) editor.dispatch({ effects: textLock.reconfigure([]) });
    }
  }

  async function finishExit() {
    const token = nextLink;
    if (!token) { await onExit(); return; }
    if (followingLink) return;
    followingLink = true; error = '';
    try {
      const references = workspace.data.wiki?.[node.id];
      const saved = references && Object.hasOwn(references, token) ? references[token] : undefined;
      const id = saved ?? findWikiTarget(workspace, node, token, await catalog())?.id;
      if (!id) throw new Error(`No file found for “${token}”. Save the link to create it.`);
      if (id === node.id) {
        return;
      }
      await onOpenLink(id);
    } catch (cause) {
      error = cause;
    } finally { followingLink = false; }
  }

  function leaveEditor(token?: string) {
    if ((saving && !(handle instanceof GitHubFile)) || followingLink || inlineDrawing) return;
    nextLink = token;
    if (dirty || githubPending || githubPublishing) void save(true, true);
    else void finishExit();
  }

  function requestExit() { leaveEditor(); }

  function find() {
    if (view) openSearchPanel(view);
  }

  function focusTools(editor: EditorView) {
    closeCompletion(editor);
    closeSearchPanel(editor);
    usingTools = true;
    toolbar?.focus({ preventScroll: true });
  }

  function resumeEditing() {
    usingTools = false;
    view?.focus();
  }

  function resumePageEditing() {
    if (inlineDrawing) drawingEditor?.resumeEditing();
    else resumeEditing();
  }

  function escapeToTools(event: KeyboardEvent, editor: EditorView) {
    if (event.key !== 'Escape' || event.isComposing || editor.composing || event.repeat ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        usingTools || !editor.hasFocus || inlineDrawing || exportSource) return false;
    if (vimMode) {
      const mode = getCM(editor)?.state.vim;
      if (mode && !mode.insertMode && !mode.visualMode && !mode.exMode) {
        // Let Normal-mode Escape clear any pending Vim command before moving focus.
        queueMicrotask(() => {
          if (active && editor.hasFocus) focusTools(editor);
        });
      }
      return false;
    }
    focusTools(editor);
    return true;
  }

  function shortcuts(event: KeyboardEvent) {
    if (inlineDrawing || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey) || document.querySelector('.github-conflict[open], .github-reconnect[open]')) return;
    const key = event.key.toLowerCase();
    if (key !== 'escape' && key !== 's' && key !== 'f' && !(key === 'b' && event.metaKey)) return;
    if (vimMode && key === 'f' && event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || exportSource) return;
    if (key === 'b') void insertDrawing();
    else if (key === 'escape') requestExit();
    else if (key === 's') void save(false, true);
    else find();
  }

  function openExport(drawing?: Drawing) {
    if (!view || loading) return;
    // Return through the toolbar when the modal closes so CodeMirror can
    // regain focus and restore its caret itself.
    if (!usingTools && !inlineDrawing) {
      exportSelection = view.state.selection;
      toolbar?.focus({ preventScroll: true });
    }
    const snapshot = view.state.doc;
    const override = inlineDrawing && drawing ? { name: inlineDrawing.page.name, strokes: drawing } : undefined;
    const content = view.contentDOM;
    const width = parseFloat(view.dom.style.getPropertyValue('--drawing-page-width')) || content.clientWidth;
    const style = exportStyle(content, width, wrapLines, pdfMargins);
    style.background = getComputedStyle(view.dom).backgroundColor;
    exportSource = {
      kind: 'text', name: node.name, lines: () => snapshot.iterLines(), style,
      drawing: async (name) => {
        if (override?.name === name) return override.strokes;
        const resource = await loadDrawingReference(workspace, node, handle, name, await catalog());
        if (resource) return resource.strokes;
        if (newDrawings.has(name) || !savedPages.has(name)) return [];
        throw new Error(`Drawing “${name}” is unavailable. Restore it before exporting.`);
      }
    };
  }

  async function closeExport() {
    const selection = exportSelection;
    exportSelection = undefined;
    exportSource = undefined;
    // Restore CodeMirror's selection after the dialog has left the DOM.
    await tick();
    const editor = view;
    if (!active || !editor || !selection || usingTools || inlineDrawing) return;
    editor.focus();
    editor.dispatch({ selection });
    const { anchor, head } = selection.main;
    const rendered = (pos: number) => editor.visibleRanges.some(({ from, to }) => from <= pos && pos <= to);
    if (rendered(anchor) && rendered(head)) {
      // Chromium can reset the native caret even when CodeMirror's selection is unchanged.
      const start = editor.domAtPos(anchor), end = editor.domAtPos(head);
      editor.dom.ownerDocument.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    }
  }

  $effect(() => {
    autosaveMs;
    dirty;
    if (dirty && !waitingForPermission) scheduleAutosave();
    else if (!dirty) clearAutosave();
  });

  onMount(() => {
    active = true;
    lastSaveAt = Date.now();
    let pageResize: ResizeObserver | undefined;
    window.addEventListener('keydown', shortcuts, true);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (revision !== savedRevision) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    void (async () => {
      try {
        const resource = await workspace.handle(node.id);
        if (resource.kind !== 'file') return;
        handle = resource;
        const file = await handle.getFile();
        const detected = await inspectTextFile(file, workspace.format(node.id));
        if (!detected) throw new Error('This resource is not decodable text.');
        format = detected;
        if (handle instanceof GitHubFile) {
          const draft = handle.repository.draft(handle.path);
          githubBase = draft ? draft.base : handle.repository.editBase(handle.path);
          githubPending = !!draft;
        }
        let doc = Text.empty;
        let pendingCR = '';
        for await (const part of decodedChunks(file, format)) {
          if (!active) return;
          let chunk = pendingCR + part;
          pendingCR = chunk.endsWith('\r') ? '\r' : '';
          if (pendingCR) chunk = chunk.slice(0, -1);
          doc = doc.append(Text.of(chunk.replace(/\r\n?/g, '\n').split('\n')));
          loadedBytes += part.length;
        }
        if (pendingCR) doc = doc.append(Text.of(['', '']));
        if (!active) return;
        if (!githubPending) { savedTokens = wikiTokens(doc); savedPages = svgPageNames(doc); }
        if (!active) return;
        const completeCommand = commandCompletion(workspace, node, catalog);
        view = new EditorView({
          parent: container,
          state: EditorState.create({ doc, extensions: [
            Prec.highest(EditorView.domEventHandlers({
              keydown: escapeToTools,
              mousedown: (event) => { if (event.button === 0 && !inlineDrawing) usingTools = false; },
              focus: (_event, editor) => {
                // Find can return focus to the content when its panel closes.
                // Keep tool mode until the user explicitly resumes editing.
                if (usingTools && !inlineDrawing) queueMicrotask(() => {
                  if (active && usingTools && editor.hasFocus) toolbar?.focus({ preventScroll: true });
                });
              }
            })),
            autocompletion({ override: [(context) => completeCommand(context) ?? completeWiki(context)],
              activateOnCompletion: opensCommandArguments, activateOnTypingDelay: 60, interactionDelay: 0, defaultKeymap: false }),
            Prec.highest(keymap.of([...completionKeymap, { key: 'Tab', run: acceptCompletion }].map((binding) => ({
              ...binding,
              run: (editor) => {
                if (binding.key === 'Escape' && vimMode) {
                  // Dismiss completion without swallowing Vim's return to Normal mode.
                  binding.run?.(editor);
                  return false;
                }
                return completionStatus(editor.state) === 'active' && (binding.run?.(editor) ?? false);
              }
            })))),
            vimMode ? vim() : [],
            wikiDisplay(leaveEditor), pageWidgets.field, prettyDisplay(prettyFontSize), textLock.of([]),
            wrapLines ? EditorView.lineWrapping : [],
            lineNumbers(), drawSelection(), highlightActiveLine(), history(),
            bracketMatching(), closeBrackets(), highlightSelectionMatches(),
            indentUnit.of('  '), EditorState.tabSize.of(2),
            EditorView.contentAttributes.of({ 'aria-label': `Edit ${node.name}`, spellcheck: 'false' }),
            keymap.of([
              indentWithTab, ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap
            ]),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged) return;
              revision++; dirty = true; waitingForPermission = false;
              queueMicrotask(refreshDrawingPreviews);
            }),
            EditorView.theme({
              '&': { color: 'var(--primary)', backgroundColor: 'var(--background)', fontSize: 'clamp(12px, calc(var(--min-box) * .4), 28px)' },
              '.cm-content': { fontFamily: 'var(--font-mono)', caretColor: 'var(--primary)', padding: '10px 0' },
              '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'auto', minHeight: '320px' },
              '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--tertiary)', borderColor: 'var(--tertiary)' },
              '.cm-activeLine': { backgroundColor: 'rgba(128,128,128,.08)' },
              '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(128,128,128,.3)' },
              '.cm-cursor': { borderLeftColor: 'var(--primary)' }
            })
          ] })
        });
        const measurePage = () => {
          if (!view) return;
          const gutter = view.dom.querySelector<HTMLElement>('.cm-gutters');
          const width = Math.max(1, view.scrollDOM.clientWidth - (gutter?.offsetWidth ?? 0));
          view.dom.style.setProperty('--drawing-page-width', `${width}px`);
        };
        pageResize = new ResizeObserver(measurePage);
        pageResize.observe(view.scrollDOM);
        const gutter = view.dom.querySelector('.cm-gutters');
        if (gutter) pageResize.observe(gutter);
        measurePage();
        if (vimMode) vimSaves.set(view, () => { void save(false, true); });
        loading = false;
        refreshDrawingPreviews();
        view.focus();
      } catch (cause) {
        if (!active) return;
        loading = false; error = cause;
        if (isMissing(cause)) onMissing();
      }
    })();
    return () => {
      active = false;
      clearAutosave();
      pageResize?.disconnect();
      catalogController.abort();
      window.removeEventListener('keydown', shortcuts, true);
      window.removeEventListener('beforeunload', beforeUnload);
      if (view) {
        vimSaves.delete(view);
        view.destroy();
      }
    };
  });
</script>

<div class="document-editor">
  <div class="editor-toolbar-slot">
    {#if !inlineDrawing}
    <div class="editor-controls" role="group" aria-label="Editor toolbar" tabindex="-1" bind:this={toolbar}
      use:preserveContentFocus={() => !usingTools && !!view?.hasFocus}>
      <Control aria-keyshortcuts="Control+Escape" onclick={requestExit} disabled={saving}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></Control>
      <Control aria-keyshortcuts={vimMode ? undefined : 'Control+F'} onclick={find} disabled={loading}><span class="visually-hidden">Find and replace</span><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m14.5 14.5 5 5" /></svg>{#if !vimMode}<span class="shortcut-hint" aria-hidden="true">Ctrl+F</span>{/if}</Control>
      <Control onclick={() => { void insertDrawing(); }} disabled={loading || saving} aria-keyshortcuts="Meta+B">Brush<span class="shortcut-hint" aria-hidden="true">Command+B</span></Control>
      <Control onclick={() => openExport()} disabled={loading}>Export</Control>
    </div>
    {/if}
    {#if inlineDrawing}
      <div class="inline-drawing-controller">
        <DrawingEditor bind:this={drawingEditor} bind:usingTools {stylusOnly} {autosaveMs} name={inlineDrawing.page.name} initial={inlineDrawing.resource?.strokes ?? []}
          initialDraft={hasDrawingDraft(inlineDrawing.resource)} surfaceTarget={inlineDrawing.host}
          onExport={(strokes) => openExport(strokes)} onSave={saveInlineDrawing} onExit={closeInlineDrawing}
          onCommit={inlineDrawing.resource?.storage === 'github' || node.storage === 'github' ? commitInlineDrawing : undefined} />
      </div>
    {/if}
  </div>
  <div class="editor-scroll">
    <EditorTitle name={inlineDrawing?.page.name ?? node.name} onEdit={usingTools ? resumePageEditing : undefined} />
    <p class="muted" role="status" aria-live="polite">
      {#if loading}loading text…{loadedBytes ? ` ${Math.round(loadedBytes / 1024)} KB` : ''}
      {:else if githubPublishing}syncing to GitHub…
      {:else if saving}saving…
      {:else if waitingForPermission}autosave is waiting for write permission; exit to save
      {:else if dirty}unsaved changes
      {:else if githubPending}draft saved in this browser · Save or Exit to sync to GitHub
      {:else if !error && node.storage === 'github'}saved on GitHub
      {:else if !error}saved {node.storage === 'browser' ? 'in browser storage' : 'on your computer'}{/if}
    </p>
    {#if error}<StorageNotice {error} />{/if}
    <div class="editor-container" bind:this={container}></div>
  </div>
</div>

{#if exportSource}
  <ExportDialog source={exportSource} onClose={closeExport} />
{/if}
