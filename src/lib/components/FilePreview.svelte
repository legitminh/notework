<script module lang="ts">
  const previewClicks = new WeakMap<HTMLElement, (event: MouseEvent) => void>();
</script>

<script lang="ts">
  import { getAllContexts, onMount } from 'svelte';
  import { countColumn, EditorState } from '@codemirror/state';
  import { EditorView, lineNumbers } from '@codemirror/view';
  import { indentUnit } from '@codemirror/language';
  import { Interactable } from '@legitminh/keyflow';
  import { shortcutScope } from '../shortcut-scope.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import ImageLoading from './ImageLoading.svelte';
  import type { Workspace, StateNode } from '../workspace';
  import { decodedChunks, inspectTextFile } from '../text-resource';
  import { loadDrawing, loadDrawingReference } from '../drawing-files';
  import { DRAWING_WIDTH, serializeDrawing, type Point } from '../drawing';
  import type { PreviewLocation } from '../preview-location';
  import { svgPages } from '../svg-pages';
  import { wikiDisplay } from '../wiki-display';
  import { symbolDisplay } from '../symbol-display';
  import { prettyDisplay, type PrettyContext } from '../pretty-display';
  import { wikiCatalog } from '../wiki';
  import { pageReferences } from '../page-references';

  let { workspace, node, wrapLines, prettyFontSize, prettyMargin, showLineNumbers, onOpen, disabled, indent = '', inheritedPretty, ancestors, onOpenReference, catalog: suppliedCatalog }: {
    catalog?: () => Promise<StateNode[]>;
    workspace: Workspace; node: StateNode; indent?: string; inheritedPretty?: PrettyContext; ancestors?: string[]; onOpenReference?: (id: string, location?: PreviewLocation) => void; wrapLines: boolean; prettyFontSize: boolean; prettyMargin: boolean;
    showLineNumbers: boolean; onOpen: (location?: PreviewLocation) => void; disabled: boolean;
  } = $props();
  const context = getAllContexts();
  const catalogAbort = new AbortController();
  let catalogRequest: Promise<StateNode[]> | undefined;
  const catalog = () => suppliedCatalog?.() ?? (catalogRequest ??= wikiCatalog(workspace, catalogAbort.signal));
  let host: HTMLDivElement;
  let image = $state('');
  let error = $state.raw<unknown>();
  let loading = $state(true);
  let imageReady = $state(false);
  let imageFailed = $state(false);
  let view: EditorView | undefined;
  const isSvg = $derived(node.name.toLowerCase().endsWith('.svg'));

  function drawingPoint(rect: DOMRect, event: MouseEvent): Point {
    const scale = DRAWING_WIDTH / Math.max(1, rect.width);
    return [Math.max(0, Math.min(rect.width, event.clientX - rect.left)) * scale,
      Math.max(0, Math.min(rect.height, event.clientY - rect.top)) * scale];
  }

  function openAtClick(element: HTMLElement) {
    const click = (event: MouseEvent) => {
      // Keyboard and assistive activation use the ordinary Keyflow action.
      if (!event.detail || event.button !== 0 || disabled || loading || shortcutScope.dialog) return;
      event.preventDefault(); event.stopPropagation();
      const reference = [...host.querySelectorAll<HTMLElement>('[data-reference-target]')].reverse().find((widget) => {
        const rect = widget.getBoundingClientRect();
        return event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (reference && onOpenReference) {
        const nested = reference.querySelector<HTMLElement>('.file-preview');
        const open = nested && previewClicks.get(nested);
        if (open) open(event); else onOpenReference(reference.dataset.referenceTarget!);
        return;
      }
      if (node.drawing) {
        const image = element.querySelector('img');
        onOpen(image ? { kind: 'drawing', point: drawingPoint(image.getBoundingClientRect(), event) } : undefined);
        return;
      }
      const drawing = [...host.querySelectorAll<HTMLElement>('[data-page-from]')].find((widget) => {
        if (widget.closest('.file-preview') !== element) return false;
        const rect = widget.getBoundingClientRect();
        return event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (drawing) {
        const from = Number(drawing.dataset.pageFrom);
        const number = view?.state.doc.lineAt(from).number ?? 1;
        onOpen({ kind: 'inline-drawing', from: from - indent.length * (number - 1),
          point: drawingPoint(drawing.getBoundingClientRect(), event) });
      }
      else if (view) {
        const position = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
        const line = view.state.doc.lineAt(position);
        onOpen({ kind: 'text', position: line.from - indent.length * (line.number - 1) + Math.max(0, position - line.from - indent.length) });
      }
      else onOpen();
    };
    const keepScroll = (event: MouseEvent) => { if (event.button === 0) event.preventDefault(); };
    previewClicks.set(element, click);
    element.addEventListener('mousedown', keepScroll, true);
    element.addEventListener('click', click, true);
    return { destroy() {
      previewClicks.delete(element);
      element.removeEventListener('mousedown', keepScroll, true);
      element.removeEventListener('click', click, true);
    } };
  }

  onMount(() => {
    let active = true;
    let objectURL: string | undefined;
    void (async () => {
      try {
        const handle = await workspace.handle(node.id);
        if (handle.kind !== 'file') return;
        if (node.drawing) {
          const resource = await loadDrawing(handle, node.storage, { workspace, node });
          if (!active) return;
          image = resource.preview ?? (objectURL = URL.createObjectURL(new Blob([serializeDrawing(resource.strokes)], { type: 'image/svg+xml' })));
        } else if (node.name.toLowerCase().endsWith('.svg')) {
          // Show SVG files (e.g. visual-document vector layers) as pictures; <img> never runs embedded scripts.
          const file = await handle.getFile();
          if (!active) return;
          image = objectURL = URL.createObjectURL(new Blob([await file.arrayBuffer()], { type: 'image/svg+xml' }));
        } else {
          const file = await handle.getFile();
          const format = await inspectTextFile(file, workspace.format(node.id));
          if (!format) throw new Error('this file cannot be previewed as text.');
          let text = '';
          for await (const chunk of decodedChunks(file, format)) text += chunk;
          if (!active) return;
          const pages = svgPages(() => {}, () => false, true);
          view = new EditorView({ parent: host, state: EditorState.create({
            doc: text.replace(/\r\n?/g, '\n').split('\n').map((line) => indent + line).join('\n'),
            extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false),
              EditorView.contentAttributes.of({ role: 'document', 'aria-label': `preview of ${node.name}`, tabindex: '-1' }),
              indentUnit.of('  '), EditorState.tabSize.of(2),
              prettyDisplay(prettyFontSize, prettyMargin, inheritedPretty),
              pageReferences({ workspace, source: node, wrapLines, prettyFontSize, prettyMargin, readOnly: true, catalog, ancestors: ancestors ?? [node.id], context, onOpen: (id, location) => onOpenReference?.(id, location) }),
              wikiDisplay(() => {}, true), symbolDisplay(), pages.field,
              showLineNumbers ? lineNumbers() : [], wrapLines ? EditorView.lineWrapping : [],
              EditorView.theme({
                '&': { color: 'var(--primary)', backgroundColor: 'var(--background)', fontSize: 'clamp(12px, calc(var(--min-box) * .4), 28px)' },
                '.cm-content': { fontFamily: 'var(--font-mono)', padding: '10px 0' },
                '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'hidden' },
                '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--tertiary)', borderColor: 'var(--tertiary)' }
              })]
          }) });
          for (const name of new Set(view.state.field(pages.field).pages.map((page) => page.name))) {
            view.dispatch({ effects: pages.setLoading.of({ name, loading: true }) });
            try {
              const resource = await loadDrawingReference(workspace, node, handle, name);
              if (!active) return;
              if (resource) view.dispatch({ effects: pages.setPreview.of({ name, strokes: resource.strokes,
                image: resource.image && resource.preview ? { src: resource.preview, height: resource.image.height / resource.image.width * 1024 } : undefined }) });
            } catch { /* Keep the directive visible if its drawing is unavailable. */ }
            finally { if (active) view?.dispatch({ effects: pages.setLoading.of({ name, loading: false }) }); }
          }
        }
      } catch (cause) { if (active) error = cause; }
      finally { if (active) loading = false; }
    })();
    return () => { active = false; catalogAbort.abort(); view?.destroy(); if (objectURL) URL.revokeObjectURL(objectURL); };
  });
</script>

<div class="file-preview" class:embedded={!!inheritedPretty} style:--page-indent={`${countColumn(indent, 2)}ch`} use:openAtClick>
  <span class="preview-open">
    <Interactable registered={false} on_close={() => onOpen()} disabled={disabled || loading || !!shortcutScope.dialog}>
      <span class="visually-hidden">open {node.name} from preview</span>
    </Interactable>
  </span>
  <div class="preview-open-hint" aria-hidden="true"><span>open</span></div>
  <div class="preview-content">
    {#if (node.drawing || isSvg) && !error && !imageFailed && (loading || !imageReady)}<ImageLoading />
    {:else if loading}<p class="muted">loading preview…</p>{/if}
    {#if image}<img class:svg-image={isSvg && !node.drawing} src={image} alt={`preview of ${node.name}`} onload={() => { imageReady = true; }} onerror={() => { imageFailed = true; error = new Error('could not display this image.'); }} />{/if}
    <div bind:this={host}></div>
  </div>
</div>
{#if error}<StorageNotice {error} />{/if}

<style>
  .file-preview { position: relative; margin-top: .5em; min-height: 120px; border-block: 1px solid var(--tertiary); }
  .file-preview .preview-open { position: absolute; inset: 0; display: block; z-index: 1; opacity: 0; }
  .file-preview .preview-open :global(button) { display: block; width: 100%; height: 100%; cursor: pointer; }
  .file-preview:focus-within { outline: 2px solid var(--primary); outline-offset: 3px; }
  .preview-open-hint { position: sticky; top: 0; height: 0; z-index: 2; pointer-events: none; opacity: 0; }
  .preview-open-hint span { display: block; text-align: center; font-size: clamp(12px, .5em, 20px); line-height: 1.7; border-bottom: 1px solid var(--tertiary); background: color-mix(in srgb, var(--background) 90%, transparent); }
  .file-preview:is(:hover, :focus-within) > .preview-open-hint { opacity: 1; }
  .preview-content { position: relative; pointer-events: none; overflow: hidden; min-height: 120px; }
  .preview-content :global(.image-loading-surface) { position: absolute; inset: 0; min-height: 0; }
  .embedded { margin: 0; min-height: 0; border: 0; }
  .embedded .preview-content { min-height: 0; }
  .embedded img { padding-left: var(--page-indent); }
  img { display: block; width: 100%; height: auto; }
  /* Transparent SVG layers read better on a light checkerboard in either theme. */
  img.svg-image { background: repeating-conic-gradient(#e8e8e8 0 25%, #fff 0 50%) 0 0 / 16px 16px; }
</style>
