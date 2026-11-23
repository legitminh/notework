<script lang="ts">
  import { HorizontalSlider, NumberBox, TextBox } from '@legitminh/keyflow';
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
  // The hex field edits a draft; it follows the current colour whenever it is not being edited.
  let hexDraft = $state('');
  $effect(() => { hexDraft = value; });

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

  // Geometry: a hue ring (annulus between OUTER and INNER radii) around an HSV triangle whose
  // corners are the pure hue, white and black. The triangle turns with the hue, as in Krita/GIMP/MyPaint.
  const SIZE = $derived(size), OUTER = $derived(size / 2 - 1), INNER = $derived(size / 2 - Math.max(12, Math.round(size / 9)));
  const TRI = $derived(INNER - 4);
  let wheel: HTMLDivElement;
  let surface = $state<HTMLCanvasElement>();
  let dragging: 'ring' | 'triangle' | undefined;
  /** Screen angle (radians, y down) of a hue; red at the top, hues increase clockwise. */
  const angleOf = (hue: number) => (hue - 90) * Math.PI / 180;
  function corners(hue: number): [[number, number], [number, number], [number, number]] {
    const a = angleOf(hue), r = TRI, c = SIZE / 2;
    const at = (t: number): [number, number] => [c + Math.cos(t) * r, c + Math.sin(t) * r];
    return [at(a), at(a + 2 * Math.PI / 3), at(a + 4 * Math.PI / 3)]; // hue, white, black
  }
  /** Barycentric weights of p in triangle (hue, white, black). */
  function weights(p: [number, number], [h, w, b]: ReturnType<typeof corners>) {
    const det = (w[1] - b[1]) * (h[0] - b[0]) + (b[0] - w[0]) * (h[1] - b[1]);
    const wh = ((w[1] - b[1]) * (p[0] - b[0]) + (b[0] - w[0]) * (p[1] - b[1])) / det;
    const ww = ((b[1] - h[1]) * (p[0] - b[0]) + (h[0] - b[0]) * (p[1] - b[1])) / det;
    return [wh, ww, 1 - wh - ww];
  }
  // HSV from weights: value = hue + white share, saturation = hue share of value.
  function svFromWeights([wh, ww]: number[]): [number, number] {
    const h = clamp(wh, 0, 1), w = clamp(ww, 0, 1 - h), v = clamp(h + w, 0, 1);
    return [v ? clamp(h / v, 0, 1) : 0, v];
  }
  function pick(event: PointerEvent, start = false) {
    const rect = wheel.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    const distance = Math.hypot(x - SIZE / 2, y - SIZE / 2);
    if (start) dragging = distance >= INNER - 2 && distance <= OUTER + 4 ? 'ring' : distance < INNER ? 'triangle' : undefined;
    if (dragging === 'ring') commit([(Math.atan2(y - SIZE / 2, x - SIZE / 2) * 180 / Math.PI + 450) % 360, hsv[1], hsv[2]]);
    else if (dragging === 'triangle') { const [sat, val] = svFromWeights(weights([x, y], corners(hsv[0]))); commit([hsv[0], sat, val]); }
  }
  // Paint ring + triangle into one canvas; repainted only when the hue or size changes.
  $effect(() => {
    const hue = hsv[0], canvas = surface, dpr = Math.max(1, Math.min(3, globalThis.devicePixelRatio || 1));
    if (!canvas) return;
    const pixels = Math.round(SIZE * dpr);
    canvas.width = canvas.height = pixels;
    const context = canvas.getContext('2d')!, image = context.createImageData(pixels, pixels), data = image.data;
    const tri = corners(hue), [r0, g0, b0] = hsvToRgb(hue, 1, 1);
    for (let py = 0; py < pixels; py++) for (let px = 0; px < pixels; px++) {
      const x = (px + 0.5) / dpr, y = (py + 0.5) / dpr, distance = Math.hypot(x - SIZE / 2, y - SIZE / 2), o = (py * pixels + px) * 4;
      if (distance >= INNER && distance <= OUTER) {
        const [r, g, b] = hsvToRgb((Math.atan2(y - SIZE / 2, x - SIZE / 2) * 180 / Math.PI + 450) % 360, 1, 1);
        const edge = Math.min(1, (distance - INNER) * dpr, (OUTER - distance) * dpr);
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255 * edge;
      } else if (distance < INNER) {
        const [wh, ww, wb] = weights([x, y], tri);
        const inside = Math.min(wh, ww, wb);
        if (inside < -1 / (TRI * 0.9)) continue;
        // Pure hue × wh + white × ww + black × wb.
        data[o] = r0 * wh + 255 * ww; data[o + 1] = g0 * wh + 255 * ww; data[o + 2] = b0 * wh + 255 * ww;
        data[o + 3] = 255 * clamp(1 + inside * TRI * 0.9, 0, 1);
      }
    }
    context.putImageData(image, 0, 0);
  });
  const marker = $derived.by(() => {
    const [h, w, b] = corners(hsv[0]), wh = hsv[1] * hsv[2], ww = hsv[2] - wh, wb = 1 - hsv[2];
    return [h[0] * wh + w[0] * ww + b[0] * wb, h[1] * wh + w[1] * ww + b[1] * wb];
  });
  const hueMarker = $derived([SIZE / 2 + Math.cos(angleOf(hsv[0])) * (INNER + OUTER) / 2, SIZE / 2 + Math.sin(angleOf(hsv[0])) * (INNER + OUTER) / 2]);
</script>

<div class="color-wheel-panel">
  <div class="wheel" bind:this={wheel} style:width={`${SIZE}px`} style:height={`${SIZE}px`} role="slider" tabindex="0"
    aria-label="color wheel: hue ring and saturation/value triangle" aria-valuetext={`hue ${Math.round(hsv[0])}, saturation ${Math.round(hsv[1] * 100)}%, value ${Math.round(hsv[2] * 100)}%`} aria-valuenow={Math.round(hsv[0])}
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
    <canvas class="wheel-surface" bind:this={surface} style:width={`${SIZE}px`} style:height={`${SIZE}px`}></canvas>
    <span class="triangle-marker" style:left={`${marker[0]}px`} style:top={`${marker[1]}px`} style:background={value}></span>
    <span class="ring-marker" style:left={`${hueMarker[0]}px`} style:top={`${hueMarker[1]}px`} style:width={`${OUTER - INNER + 2}px`} style:height={`${OUTER - INNER + 2}px`}></span>
  </div>
  <!-- To the right of the wheel: one horizontal stream of mode, channel values, sliders and hex. -->
  <div class="channels">
    <Control onclick={() => mode = 'hsv'} aria-pressed={mode === 'hsv'}>HSV</Control>
    <Control onclick={() => mode = 'rgb'} aria-pressed={mode === 'rgb'}>RGB</Control>
    <span class="swatch current" style:background={value} aria-hidden="true"></span>
    {#if mode === 'hsv'}
      <span class="pair"><span class="channel">H</span><NumberBox value={Math.round(hsv[0])} min={0} max={359} step={1} width="4ch" label="hue value" onchange={(hue: number) => commit([hue, hsv[1], hsv[2]])} /></span>
      <HorizontalSlider value={Math.round(hsv[0])} min={0} max={359} step={1} speed={120} label="hue" onchange={(hue: number) => commit([hue, hsv[1], hsv[2]])} />
      <span class="pair"><span class="channel">S</span><NumberBox value={Math.round(hsv[1] * 100)} min={0} max={100} step={1} width="4ch" label="saturation value" onchange={(sat: number) => commit([hsv[0], sat / 100, hsv[2]])} /></span>
      <HorizontalSlider value={Math.round(hsv[1] * 100)} min={0} max={100} step={1} speed={50} label="saturation" onchange={(sat: number) => commit([hsv[0], sat / 100, hsv[2]])} />
      <span class="pair"><span class="channel">V</span><NumberBox value={Math.round(hsv[2] * 100)} min={0} max={100} step={1} width="4ch" label="value value" onchange={(val: number) => commit([hsv[0], hsv[1], val / 100])} /></span>
      <HorizontalSlider value={Math.round(hsv[2] * 100)} min={0} max={100} step={1} speed={50} label="value" onchange={(val: number) => commit([hsv[0], hsv[1], val / 100])} />
    {:else}
      {#each ['red', 'green', 'blue'] as channel, index (channel)}
        <span class="pair"><span class="channel">{channel[0].toUpperCase()}</span><NumberBox value={rgb[index]} min={0} max={255} step={1} width="4ch" label={`${channel} value`} onchange={(next: number) => setRgb(index, next)} /></span>
        <HorizontalSlider value={rgb[index]} min={0} max={255} step={1} speed={120} label={channel} onchange={(next: number) => setRgb(index, next)} />
      {/each}
    {/if}
    <span class="pair"><span class="channel">hex</span>
    <TextBox singleLine bind:value={hexDraft} label="hex color" spellcheck={false}
      onexit={(text) => { const hex = text.trim(); if (/^#?[0-9a-f]{6}$/i.test(hex)) { const next = rgbToHsv(...hexToRgb(hex)); commit([next[1] && next[2] ? next[0] : hsv[0], next[1], next[2]]); } hexDraft = lastValue || value; }} /></span>
  </div>
</div>

<style>
  /* Wheel on the left; the channel stream fills the rest of the line beside it. */
  .color-wheel-panel { display: flex; gap: 1ch; align-items: center; flex: 1 1 100%; min-width: 0; max-width: 100%; }
  .wheel { position: relative; flex: none; touch-action: none; border-radius: 50%; cursor: crosshair; }
  .wheel:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .wheel-surface { position: absolute; inset: 0; display: block; }
  .triangle-marker, .ring-marker { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; border: 2px solid #fff; box-shadow: 0 0 0 1px #000; pointer-events: none; box-sizing: border-box; }
  .triangle-marker { width: 12px; height: 12px; }
  .ring-marker { background: transparent; }
  .channels { flex: 1 1 18rem; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 .6ch; line-height: var(--min-box); }
  .channels > :global(*) { flex: none; }
  .channel { display: inline-block; min-width: 1.5ch; }
  /* A label stays on the same line as its value box. */
  .pair { display: inline-flex; align-items: center; gap: .4ch; white-space: nowrap; }
  .channels :global(.keyflow-slider) { padding: 0; gap: .3ch; --slider-length: 8rem; }
  .swatch { display: inline-block; width: var(--min-box); height: calc(var(--min-box) * .7); border-radius: 4px; border: 1px solid var(--tertiary); }
</style>
