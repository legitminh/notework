<script lang="ts">
  import { onMount } from 'svelte';
  import { EditorState } from '@codemirror/state';
  import { EditorView, lineNumbers } from '@codemirror/view';
  import { indentUnit } from '@codemirror/language';
  import Control from './Control.svelte';
  import StorageNotice from './StorageNotice.svelte';
  import type { Workspace, StateNode } from '../workspace';
  import { decodedChunks, inspectTextFile } from '../text-resource';
  import { loadDrawing, loadDrawingReference } from '../drawing-files';
  import { serializeDrawing } from '../drawing';
  import { svgPages } from '../svg-pages';
  import { wikiDisplay } from '../wiki-display';
  import { prettyDisplay } from '../pretty-display';

  let { workspace, node, wrapLines, prettyFontSize, prettyMargin, showLineNumbers, onOpen, disabled }: {
    workspace: Workspace; node: StateNode; wrapLines: boolean; prettyFontSize: boolean; prettyMargin: boolean;
    showLineNumbers: boolean; onOpen: () => void; disabled: boolean;
  } = $props();
  let host: HTMLDivElement;
  let image = $state('');
  let error = $state.raw<unknown>();
  let loading = $state(true);
  onMount(() => {
    let active = true;
    let view: EditorView | undefined;
    let objectURL: string | undefined;
    void (async () => {
      try {
        const handle = await workspace.handle(node.id);
        if (handle.kind !== 'file') return;
        if (node.drawing) {
          const resource = await loadDrawing(handle, node.storage);
          if (!active) return;
          image = resource.preview ?? (objectURL = URL.createObjectURL(new Blob([serializeDrawing(resource.strokes)], { type: 'image/svg+xml' })));
        } else {
          const file = await handle.getFile();
          const format = await inspectTextFile(file, workspace.format(node.id));
          if (!format) throw new Error('This file cannot be previewed as text.');
          let text = '';
          for await (const chunk of decodedChunks(file, format)) text += chunk;
          if (!active) return;
          const pages = svgPages(() => {}, () => false, true);
          view = new EditorView({ parent: host, state: EditorState.create({
            doc: text.replace(/\r\n?/g, '\n'),
            extensions: [EditorState.readOnly.of(true), EditorView.editable.of(false),
              EditorView.contentAttributes.of({ role: 'document', 'aria-label': `Preview of ${node.name}`, tabindex: '-1' }), indentUnit.of('\t'),
              prettyDisplay(prettyFontSize, prettyMargin), wikiDisplay(() => {}, true), pages.field,
              showLineNumbers ? lineNumbers() : [], wrapLines ? EditorView.lineWrapping : [],
              EditorView.theme({
                '&': { color: 'var(--primary)', backgroundColor: 'var(--background)', fontSize: 'clamp(12px, calc(var(--min-box) * .4), 28px)' },
                '.cm-content': { fontFamily: 'var(--font-mono)', padding: '10px 0' },
                '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', overflow: 'hidden' },
                '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--tertiary)', borderColor: 'var(--tertiary)' }
              })]
          }) });
          for (const name of new Set(view.state.field(pages.field).pages.map((page) => page.name))) {
            try {
              const resource = await loadDrawingReference(workspace, node, handle, name);
              if (!active) return;
              if (resource) view.dispatch({ effects: pages.setPreview.of({ name, strokes: resource.strokes,
                image: resource.image && resource.preview ? { src: resource.preview, height: resource.image.height / resource.image.width * 1024 } : undefined }) });
            } catch { /* Keep the directive visible if its drawing is unavailable. */ }
          }
        }
      } catch (cause) { if (active) error = cause; }
      finally { if (active) loading = false; }
    })();
    return () => { active = false; view?.destroy(); if (objectURL) URL.revokeObjectURL(objectURL); };
  });
</script>

<div class="file-preview" data-action="open">
  <Control class="preview-open" aria-label={`Open ${node.name}`} onclick={onOpen} {disabled}>
    <span class="visually-hidden">Open {node.name}</span>
  </Control>
  <div class="preview-content">
    {#if loading}<p class="muted">loading preview…</p>{/if}
    {#if image}<img src={image} alt={`Preview of ${node.name}`} />{/if}
    <div bind:this={host}></div>
  </div>
</div>
{#if error}<StorageNotice {error} />{/if}

<style>
  .file-preview { position: relative; margin-top: .5em; min-height: 120px; border: 1px solid var(--tertiary); }
  .file-preview :global(.preview-open) { position: absolute; inset: 0; display: block; z-index: 1; }
  .file-preview :global(.preview-open > button) { display: block; width: 100%; height: 100%; background: transparent; }
  .preview-content { pointer-events: none; overflow: hidden; min-height: 120px; }
  img { display: block; width: 100%; height: auto; }
</style>
