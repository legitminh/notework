<script lang="ts">
  import Control from './Control.svelte';
  let { value, onchange, size = 184 }: { value: string; onchange: (hex: string) => void; size?: number } = $props();

  type HSV = [number, number, number];
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  function hexToRgb(hex: string): [number, number, number] {
    const v = /^#?([0-9a-f]{6})/i.exec(hex)?.[1] ?? '000000';
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  const rgbToHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0')).join('');
  function rgbToHsv(r: number, g: number, b: number): HSV {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    const h = !d ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, max ? d / max : 0, max];
  }
  function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const f = (n: number) => { const k = (n + h / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
    return [f(5), f(3), f(1)];
  }

  // Hue is kept separately so it survives greys and black (where it is undefined).
  let hsv = $state<HSV>([0, 0, 0]);
  let lastValue = '';
  $effect(() => {
    if (value.toLowerCase() === lastValue) return;
    const next = rgbToHsv(...hexToRgb(value));
    hsv = [next[1] && next[2] ? next[0] : hsv[0], next[1], next[2]];
    lastValue = value.toLowerCase();
  });
  const rgb = $derived(hsvToRgb(...hsv).map(Math.round) as [number, number, number]);
  let mode = $state<'hsv' | 'rgb'>('hsv');

  function commit(next: HSV) {
    hsv = next;
    lastValue = rgbToHex(...hsvToRgb(...next));
    onchange(lastValue);
  }
  function setRgb(index: number, channel: number) {
    const next = [...rgb] as [number, number, number]; next[index] = clamp(channel || 0, 0, 255);
    const converted = rgbToHsv(...next);
    commit([converted[1] && converted[2] ? converted[0] : hsv[0], converted[1], converted[2]]);
  }

  // Wheel geometry: hue ring outside, saturation/value square inside.
  const SIZE = $derived(size), RING = $derived(Math.round(size / 10)), SQUARE = $derived(Math.floor((size / 2 - Math.round(size / 10) - 6) * Math.SQRT2));
  let wheel: HTMLDivElement;
  let dragging: 'ring' | 'square' | undefined;
  function pick(event: PointerEvent, start = false) {
    const rect = wheel.getBoundingClientRect(), x = event.clientX - rect.left - SIZE / 2, y = event.clientY - rect.top - SIZE / 2;
    if (start) dragging = Math.hypot(x, y) > SIZE / 2 - RING - 4 ? 'ring' : Math.abs(x) <= SQUARE / 2 + 4 && Math.abs(y) <= SQUARE / 2 + 4 ? 'square' : undefined;
    if (dragging === 'ring') commit([(Math.atan2(y, x) * 180 / Math.PI + 450) % 360, hsv[1], hsv[2]]);
    else if (dragging === 'square') commit([hsv[0], clamp(x / SQUARE + 0.5, 0, 1), clamp(0.5 - y / SQUARE, 0, 1)]);
  }
  const hueAngle = $derived((hsv[0] - 90) * Math.PI / 180);
</script>

<div class="color-wheel-panel">
  <div class="wheel" bind:this={wheel} style:width={`${SIZE}px`} style:height={`${SIZE}px`} role="slider" tabindex="0"
    aria-label="Color wheel: hue, saturation and value" aria-valuetext={`hue ${Math.round(hsv[0])}, saturation ${Math.round(hsv[1] * 100)}%, value ${Math.round(hsv[2] * 100)}%`} aria-valuenow={Math.round(hsv[0])}
    onpointerdown={(event) => { wheel.setPointerCapture(event.pointerId); pick(event, true); }}
    onpointermove={(event) => { if (dragging) pick(event); }}
    onpointerup={() => { dragging = undefined; }}
    onkeydown={(event) => {
      const step = event.shiftKey ? 10 : 2;
      if (event.key === 'ArrowLeft') commit([(hsv[0] - step + 360) % 360, hsv[1], hsv[2]]);
      else if (event.key === 'ArrowRight') commit([(hsv[0] + step) % 360, hsv[1], hsv[2]]);
      else if (event.key === 'ArrowUp') commit([hsv[0], hsv[1], clamp(hsv[2] + step / 100, 0, 1)]);
      else if (event.key === 'ArrowDown') commit([hsv[0], hsv[1], clamp(hsv[2] - step / 100, 0, 1)]);
      else return;
      event.preventDefault();
    }}>
    <div class="ring" style:--ring={`${RING}px`}></div>
    <div class="square" style:width={`${SQUARE}px`} style:height={`${SQUARE}px`} style:--hue={`hsl(${hsv[0]} 100% 50%)`}>
      <span class="square-marker" style:left={`${hsv[1] * 100}%`} style:top={`${(1 - hsv[2]) * 100}%`}></span>
    </div>
    <span class="ring-marker" style:left={`${SIZE / 2 + Math.cos(hueAngle) * (SIZE / 2 - RING / 2)}px`} style:top={`${SIZE / 2 + Math.sin(hueAngle) * (SIZE / 2 - RING / 2)}px`}></span>
  </div>
  <div class="channels">
    <div class="editor-controls">
      <Control onclick={() => mode = 'hsv'} aria-pressed={mode === 'hsv'}>HSV</Control>
      <Control onclick={() => mode = 'rgb'} aria-pressed={mode === 'rgb'}>RGB</Control>
      <span class="swatch current" style:background={value} aria-hidden="true"></span>
    </div>
    {#if mode === 'hsv'}
      <label>H <input type="range" min="0" max="359" value={Math.round(hsv[0])} oninput={(e) => commit([Number(e.currentTarget.value), hsv[1], hsv[2]])} class="hue-range" aria-label="Hue" /><span>{Math.round(hsv[0])}°</span></label>
      <label>S <input type="range" min="0" max="100" value={Math.round(hsv[1] * 100)} oninput={(e) => commit([hsv[0], Number(e.currentTarget.value) / 100, hsv[2]])} aria-label="Saturation" /><span>{Math.round(hsv[1] * 100)}%</span></label>
      <label>V <input type="range" min="0" max="100" value={Math.round(hsv[2] * 100)} oninput={(e) => commit([hsv[0], hsv[1], Number(e.currentTarget.value) / 100])} aria-label="Value" /><span>{Math.round(hsv[2] * 100)}%</span></label>
    {:else}
      {#each ['R', 'G', 'B'] as channel, index}
        <label>{channel} <input type="range" min="0" max="255" value={rgb[index]} oninput={(e) => setRgb(index, Number(e.currentTarget.value))} aria-label={['Red', 'Green', 'Blue'][index]} />
          <input type="number" min="0" max="255" value={rgb[index]} onchange={(e) => setRgb(index, Number(e.currentTarget.value))} aria-label={`${['Red', 'Green', 'Blue'][index]} value`} /></label>
      {/each}
    {/if}
    <label>Hex <input class="hex" value={value} aria-label="Hex color" onchange={(e) => { const hex = e.currentTarget.value.trim(); if (/^#?[0-9a-f]{6}$/i.test(hex)) { const next = rgbToHsv(...hexToRgb(hex)); commit([next[1] && next[2] ? next[0] : hsv[0], next[1], next[2]]); } else e.currentTarget.value = value; }} /></label>
  </div>
</div>

<style>
  .color-wheel-panel { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
  .wheel { position: relative; flex: none; touch-action: none; border-radius: 50%; cursor: crosshair; }
  .wheel:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .ring { position: absolute; inset: 0; border-radius: 50%;
    background: conic-gradient(from 0deg, hsl(0 100% 50%), hsl(60 100% 50%), hsl(120 100% 50%), hsl(180 100% 50%), hsl(240 100% 50%), hsl(300 100% 50%), hsl(360 100% 50%));
    -webkit-mask: radial-gradient(circle, transparent calc(50% - var(--ring)), #000 calc(50% - var(--ring) + 1px));
    mask: radial-gradient(circle, transparent calc(50% - var(--ring)), #000 calc(50% - var(--ring) + 1px)); }
  .square { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    background: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, var(--hue)); }
  .square-marker, .ring-marker { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #000; pointer-events: none; }
  .ring-marker { width: 14px; height: 14px; margin: -7px 0 0 -7px; }
  .channels { display: grid; gap: 2px; min-width: 11rem; font-size: 12px; }
  .channels :global(button) { font-size: 12px; }
  .channels label { display: flex; align-items: center; gap: 6px; }
  .channels input[type=range] { flex: 1; min-width: 6rem; }
  .channels input[type=number] { width: 4.2em; }
  .hex { width: 6.5em; font-family: var(--font-mono); padding: 2px 4px; min-height: 0; height: auto; }
  .hue-range { accent-color: var(--primary); }
  .swatch { display: inline-block; width: 28px; height: 28px; border-radius: 4px; border: 1px solid var(--tertiary); }
</style>
