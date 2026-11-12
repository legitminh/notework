<script lang="ts">
  import { onMount } from 'svelte';
  import Control from './Control.svelte';
  import DrawingEditor from './DrawingEditor.svelte';
  import ImageCanvasEditor from './ImageCanvasEditor.svelte';
  import { imageFormat, readImage, encodeImage, type ImageDocument } from '../images';
  import { isDrawingFile, readDrawing, serializeDrawing, type Drawing } from '../drawing';
  import { decodedChunks, encodedChunks, inspectTextFile, type TextFormat } from '../text-resource';

  let { blob, path, label, stylusOnly, autosaveMs, disabled, onChoose }: {
    blob: Blob | null; path: string; label: string; stylusOnly: boolean; autosaveMs: number;
    disabled: boolean; onChoose: () => void;
  } = $props();
  type Version = { kind: 'image'; image: ImageDocument } | { kind: 'drawing'; strokes: Drawing } |
    { kind: 'text'; text: string; format: TextFormat } | { kind: 'unreadable' };
  const name = $derived(path.split('/').at(-1)!);
  let version = $state.raw<Version>();
  let text = $state('');
  let edited: Blob | undefined;
  let ready = $state(false);
  let error = $state('');
  let editor = $state<{ saveForNavigation: () => Promise<boolean> }>();

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        if (!blob) return;
        const file = new File([blob], name);
        let loaded: Version;
        if (imageFormat(name)) loaded = { kind: 'image', image: await readImage(file) };
        else if (await isDrawingFile(file)) loaded = { kind: 'drawing', strokes: await readDrawing(file) };
        else {
          const format = await inspectTextFile(file);
          if (format) {
            let value = '';
            for await (const chunk of decodedChunks(file, format)) value += chunk;
            loaded = { kind: 'text', text: value.replace(/\r\n?/g, '\n'), format };
          } else loaded = { kind: 'unreadable' };
        }
        if (!active) return;
        version = loaded;
        if (loaded.kind === 'text') text = loaded.text;
      } catch (cause) {
        if (active) error = `Could not open this version: ${cause instanceof Error ? cause.message : 'Unknown file error'}`;
      } finally { if (active) ready = true; }
    })();
    return () => { active = false; };
  });

  export async function value() {
    if (!ready || (editor && !await editor.saveForNavigation())) throw new Error('Finish editing this version before keeping it.');
    if (version?.kind === 'text' && version.text !== text) return new Blob([...encodedChunks([text], version.format)]);
    return edited ?? blob;
  }
</script>

<section aria-label={label} class="conflict-version">
  <h3>{label}</h3>
  {#if !ready}
    <p role="status">Opening version…</p>
  {:else if error}
    <p class="notice" role="alert">{error}</p>
  {:else if !blob}
    <p>This file was deleted on GitHub.</p>
  {:else if version?.kind === 'image'}
    <div class="visual-editor" inert={disabled}>
      <ImageCanvasEditor bind:this={editor} {name} initial={version.image} {stylusOnly} {autosaveMs}
        onSave={async (image) => { edited = await encodeImage(image, imageFormat(name)!); }} />
    </div>
  {:else if version?.kind === 'drawing'}
    <div class="visual-editor standalone-drawing-editor" inert={disabled}>
      <DrawingEditor bind:this={editor} {name} initial={version.strokes} {stylusOnly} {autosaveMs}
        onSave={async (strokes) => { edited = new Blob([serializeDrawing(strokes)], { type: 'image/svg+xml' }); }} />
    </div>
  {:else if version?.kind === 'text'}
    <label><span class="visually-hidden">{label}</span><textarea bind:value={text} spellcheck="false" {disabled}></textarea></label>
  {:else}
    <p>{label === 'Your version' ? 'Your version cannot be edited as text.' : 'The GitHub version cannot be edited as text.'}</p>
  {/if}
  <Control onclick={onChoose} disabled={!ready || disabled}>{label === 'Your version' ? 'Keep your version' : blob ? 'Keep GitHub version' : 'Keep GitHub deletion'}</Control>
</section>

<style>
  .conflict-version { min-width: 0; }
  h3 { font-size: 1rem; margin-block: 0 .5rem; }
  .visual-editor { height: 52dvh; min-height: 18rem; margin-block: .35rem; }
  textarea {
    display: block; box-sizing: border-box; width: 100%; height: 52dvh; resize: vertical;
    font: .95rem/1.5 var(--font-mono); color: var(--primary); background: var(--background);
    border: 1px solid var(--tertiary); padding: .45rem; margin-block: .35rem;
  }
</style>
