<script module lang="ts">
  import { vim, Vim } from '@replit/codemirror-vim';
  import type { EditorView as VimEditorView } from '@codemirror/view';

  const vimSaves = new WeakMap<VimEditorView, () => void>();
  Vim.defineEx('write', 'w', (cm) => vimSaves.get(cm.cm6)?.());
</script>

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { Compartment, EditorState, Prec, Text, Transaction } from '@codemirror/state';
  import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, completionStatus, pickedCompletion, type Completion, type CompletionContext } from '@codemirror/autocomplete';
  import { bracketMatching, indentUnit } from '@codemirror/language';
  import { openSearchPanel, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
  import type { Workspace, StateNode } from '../workspace';
  import { isMissing, type LocalFile } from '../filesystem';
  import { decodedChunks, encodedChunks, inspectText, type TextFormat } from '../text-resource';
  import { writeBrowserContent, storageError } from '../browser-documents';
  import { saveWorkspace } from '../persistence';
  import DrawingEditor from './DrawingEditor.svelte';
  import { svgPages, type SvgPage } from '../svg-pages';
  import { svgPageNames, type Drawing } from '../drawing';
  import { loadSiblingDrawing, prepareSvgPages, saveDrawing, saveSiblingDrawing, type DrawingResource } from '../drawing-files';
  import { wikiDisplay } from '../wiki-display';
  import { findWikiTarget, prepareWikiSave, validFilename, wikiCatalog, wikiScore, wikiToken, wikiTokens } from '../wiki';

  let { workspace, node, wrapLines, vimMode, onExit, onMissing, onRename, onOpenLink }: {
    workspace: Workspace; node: StateNode;
    wrapLines: boolean;
    vimMode: boolean;
    onExit: () => void;
    onOpenLink: (id: string) => Promise<void>;
    onMissing: () => void;
    onRename: (name: string, file: LocalFile) => Promise<void>;
  } = $props();
  let container: HTMLDivElement;
  let exitDialog: HTMLDialogElement;
  let renameDialog: HTMLDialogElement;
  let renameName = $state('');
  let renameError = $state('');
  let nextLink = $state<string>();
  let followingLink = false;
  const catalogController = new AbortController();
  let catalogRequest: Promise<StateNode[]> | undefined;
  let inlineDrawing = $state.raw<{ page: SvgPage; host: HTMLDivElement; resource?: DrawingResource }>();
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
  let writable = $state(false);
  let error = $state('');
  let loadedBytes = $state(0);
  let revision = 0;
  let savedRevision = 0;
  let active = true;

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

  function askRename() {
    error = '';
    if (dirty) { error = 'Save your edits before renaming this file.'; return; }
    renameName = node.name;
    renameError = '';
    renameDialog.showModal();
  }

  async function rename() {
    if (saving) return;
    saving = true; renameError = '';
    try {
      await onRename(renameName, handle);
      if (active) renameDialog.close();
    } catch (cause) { renameError = storageError(cause); }
    finally { saving = false; }
  }

  function insertDrawing() {
    if (!view || saving || inlineDrawing) return;
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
    view.focus();
  }

  function refreshDrawingPreviews() {
    if (!view || !active) return;
    for (const { name } of view.state.field(pageWidgets.field).pages) {
      if (newDrawings.has(name) || previews.has(name)) continue;
      const loading = loadSiblingDrawing(workspace, node, handle, name);
      previews.set(name, loading);
      void loading.then((resource) => {
        if (active && resource && previews.get(name) === loading) {
          view?.dispatch({ effects: pageWidgets.setPreview.of({ name, strokes: resource.strokes }) });
        }
      }).catch(() => { /* Opening the preview will report unavailable drawings. */ });
    }
  }

  async function openDrawing(page: SvgPage) {
    if (!view || saving || inlineDrawing || openingDrawing || followingLink) return;
    openingDrawing = true; error = '';
    try {
      const resource = newDrawings.has(page.name) ? undefined : await loadSiblingDrawing(workspace, node, handle, page.name);
      if (!active || !view.state.field(pageWidgets.field).pages.some((item) => item.from === page.from && item.name === page.name)) return;
      const host = document.createElement('div');
      host.className = 'inline-drawing-host';
      view.dispatch({ effects: [
        pageWidgets.setActive.of({ from: page.from, host }),
        textLock.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)])
      ] });
      inlineDrawing = { page, host, resource };
      await tick();
      view.requestMeasure();
    } catch (cause) { error = storageError(cause); }
    finally { openingDrawing = false; }
  }

  async function saveInlineDrawing(strokes: Drawing) {
    const drawing = inlineDrawing;
    if (!drawing) return;
    const { name } = drawing.page;
    drawing.resource = drawing.resource
      ? await saveDrawing(drawing.resource, strokes)
      : await saveSiblingDrawing(workspace, node, handle, name, strokes);
    newDrawings.delete(name);
    previews.set(name, Promise.resolve(drawing.resource));
    view?.dispatch({ effects: pageWidgets.setPreview.of({ name, strokes }) });
  }

  async function closeInlineDrawing() {
    inlineDrawing = undefined;
    await tick();
    view?.dispatch({ effects: [pageWidgets.setActive.of(undefined), textLock.reconfigure([])] });
    view?.focus();
  }

  async function save(leave = false) {
    if (!view || saving || inlineDrawing) return;
    if (!dirty) {
      if (leave) await finishExit();
      return;
    }
    saving = true; error = '';
    try {
      if (node.storage === 'local' && !writable) {
        writable = (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
        if (!writable) throw new Error('Write permission was not granted. Your edits are still open.');
      }
      const snapshot = view.state.doc;
      const version = revision;
      const tokens = wikiTokens(snapshot);
      const pages = svgPageNames(snapshot);
      if (tokens.size || pages.size || Object.keys(workspace.data.wiki?.[node.id] ?? {}).length) {
        const prepared = await prepareWikiSave(workspace, node, handle, tokens, tokens.size ? await catalog() : [],
          (token) => !savedTokens.has(token) || requestedCreates.has(token));
        let svg: Awaited<ReturnType<typeof prepareSvgPages>> | undefined;
        try {
          svg = await prepareSvgPages(workspace, node, handle, pages, (name) => !savedPages.has(name) || newDrawings.has(name));
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
      if (leave && !dirty) await finishExit();
    } catch (cause) {
      error = storageError(cause);
      if (exitDialog.open) exitDialog.close();
    } finally { saving = false; }
  }

  async function finishExit() {
    const token = nextLink;
    if (!token) { onExit(); return; }
    if (followingLink) return;
    followingLink = true; error = '';
    try {
      const references = workspace.data.wiki?.[node.id];
      const saved = references && Object.hasOwn(references, token) ? references[token] : undefined;
      const id = saved ?? findWikiTarget(workspace, node, token, await catalog())?.id;
      if (!id) throw new Error(`No file found for “${token}”. Save the link to create it.`);
      if (id === node.id) {
        if (exitDialog.open) exitDialog.close();
        return;
      }
      await onOpenLink(id);
    } catch (cause) {
      error = storageError(cause);
      if (exitDialog.open) exitDialog.close();
    } finally { followingLink = false; }
  }

  function leaveEditor(token?: string) {
    if (saving || followingLink || exitDialog.open || inlineDrawing) return;
    nextLink = token;
    if (dirty) exitDialog.showModal();
    else void finishExit();
  }

  function requestExit() { leaveEditor(); }

  function find() {
    if (view) openSearchPanel(view);
  }

  function shortcuts(event: KeyboardEvent) {
    if (inlineDrawing || event.isComposing || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'escape' && key !== 's' && key !== 'f' && !(key === 'b' && event.metaKey)) return;
    if (vimMode && key === 'f' && event.ctrlKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat || exitDialog.open || renameDialog.open) return;
    if (key === 'b') insertDrawing();
    else if (key === 'escape') requestExit();
    else if (key === 's') void save();
    else find();
  }

  async function exportText() {
    if (!view) return;
    // Export can rescue unsaved edits even when write permission or quota is unavailable.
    const blob = new Blob([...encodedChunks(chunks(view.state.doc), format)] as BlobPart[], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = node.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  onMount(() => {
    active = true;
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
        const detected = await inspectText(handle, workspace.format(node.id));
        if (!detected) throw new Error('This resource is not decodable text.');
        format = detected;
        const file = await handle.getFile();
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
        savedTokens = wikiTokens(doc);
        savedPages = svgPageNames(doc);
        writable = node.storage === 'browser' || (await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt')) === 'granted';
        if (!active) return;
        view = new EditorView({
          parent: container,
          state: EditorState.create({ doc, extensions: [
            autocompletion({ override: [completeWiki], activateOnTypingDelay: 60, interactionDelay: 0, defaultKeymap: false }),
            Prec.highest(keymap.of(completionKeymap.map((binding) => ({
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
            wikiDisplay(leaveEditor), pageWidgets.field, textLock.of([]),
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
              revision++; dirty = true;
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
        if (vimMode) vimSaves.set(view, () => { void save(); });
        loading = false;
        refreshDrawingPreviews();
        view.focus();
      } catch (cause) {
        if (!active) return;
        loading = false; error = storageError(cause);
        if (isMissing(cause)) onMissing();
      }
    })();
    return () => {
      active = false;
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
  {#if !inlineDrawing}
  <div class="editor-controls" role="group" aria-label="Editor toolbar">
    <button type="button" aria-keyshortcuts="Control+Escape" onclick={requestExit} disabled={saving}>Exit<span class="shortcut-hint" aria-hidden="true">Ctrl+Esc</span></button>
    <button type="button" aria-keyshortcuts="Control+S" onclick={() => save()} disabled={loading || saving}>Save<span class="shortcut-hint" aria-hidden="true">Ctrl+S</span></button>
    <button type="button" aria-keyshortcuts={vimMode ? undefined : 'Control+F'} aria-label="Find and replace" onclick={find} disabled={loading}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m14.5 14.5 5 5" /></svg>{#if !vimMode}<span class="shortcut-hint" aria-hidden="true">Ctrl+F</span>{/if}</button>
    <button type="button" onclick={insertDrawing} disabled={loading || saving} aria-keyshortcuts="Meta+B">Brush<span class="shortcut-hint" aria-hidden="true">Command+B</span></button>
    <button type="button" onclick={askRename} disabled={loading || saving}>Rename</button>
    <button type="button" onclick={exportText} disabled={loading}>Export</button>
  </div>
  {/if}
  {#if inlineDrawing}
    <DrawingEditor name={inlineDrawing.page.name} initial={inlineDrawing.resource?.strokes ?? []}
      surfaceTarget={inlineDrawing.host}
      onSave={saveInlineDrawing} onExit={closeInlineDrawing} />
  {/if}
  <h1>{node.name}</h1>
  <p class="muted" role="status" aria-live="polite">
    {#if loading}loading text…{loadedBytes ? ` ${Math.round(loadedBytes / 1024)} KB` : ''}
    {:else if saving}saving…
    {:else if dirty}unsaved changes
    {:else if !error}saved {node.storage === 'browser' ? 'in browser storage' : 'on your computer'}{/if}
  </p>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  <div class="editor-container" bind:this={container}></div>
</div>

<dialog class="local-picker editor-exit" bind:this={exitDialog} aria-labelledby="editor-exit-title"
  oncancel={(event) => { if (saving) event.preventDefault(); }}>
  <h2 id="editor-exit-title">{nextLink ? 'Save changes before opening the link?' : 'Save changes before exiting?'}</h2>
  <div class="editor-controls">
    <button type="button" onclick={() => save(true)} disabled={saving}>{nextLink ? 'Save and open' : 'Save and exit'}</button>
    <button type="button" onclick={finishExit} disabled={saving}>Don’t save</button>
    <button type="button" onclick={() => exitDialog.close()} disabled={saving}>Cancel</button>
  </div>
</dialog>


<dialog class="local-picker editor-exit" bind:this={renameDialog} aria-labelledby="rename-title"
  oncancel={(event) => { if (saving) event.preventDefault(); }}>
  <h2 id="rename-title">Rename file</h2>
  <form onsubmit={(event) => { event.preventDefault(); void rename(); }}>
    <label class="field">file name <input bind:value={renameName} required maxlength="255" /></label>
    {#if renameError}<p class="notice" role="alert">{renameError}</p>{/if}
    <div class="editor-controls">
      <button type="submit" disabled={saving}>Rename and update links</button>
      <button type="button" onclick={() => renameDialog.close()} disabled={saving}>Cancel</button>
    </div>
  </form>
</dialog>
