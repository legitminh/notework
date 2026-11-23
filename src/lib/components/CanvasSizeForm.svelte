<script lang="ts">
  import { onMount } from 'svelte';
  import Control from './Control.svelte';
  import { canvasSize, validCanvasSize, rememberCanvasSize, type CanvasSize } from '../canvas-size';
  let { onCreate, onCancel, busy = false }: { onCreate: (size: CanvasSize) => void; onCancel: () => void; busy?: boolean } = $props();
  let width = $state(1), height = $state(1), form: HTMLFormElement, input: HTMLInputElement;
  onMount(() => { ({width,height} = canvasSize()); input.focus(); input.select(); });
  function create(event: SubmitEvent) { event.preventDefault(); const size = { width,height }; if (busy || !validCanvasSize(size)) return; rememberCanvasSize(size); onCreate(size); }
  function enter(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); if (!busy) form.requestSubmit(); }
  }
</script>
<form bind:this={form} onsubmit={create}>
  <h2>canvas size</h2>
  <label class="field"><span>width in pixels</span><input bind:this={input} type="number" onkeydown={enter} bind:value={width} min="1" max="16384" step="1" required disabled={busy} /></label>
  <label class="field"><span>height in pixels</span><input type="number" onkeydown={enter} bind:value={height} min="1" max="16384" step="1" required disabled={busy} /></label>
  <p class="muted">up to 32 megapixels, 16,384 pixels per side.</p>
  <Control onclick={() => form.requestSubmit()} disabled={busy || !validCanvasSize({width,height})}>create canvas</Control>
  <Control onclick={onCancel} disabled={busy}>cancel</Control>
</form>
