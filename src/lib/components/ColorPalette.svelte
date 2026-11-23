<script lang="ts">
  import Control from './Control.svelte';
  import ColorWheel from './ColorWheel.svelte';

  /**
   * Color wheel, palette and recent colors, shared by the SVG drawing and visual document
   * editors. It renders inline items for a `.tool-stream`, so the parent's layout applies.
   */
  let { value, palette, recent = [], ink = false, inkPreview = '#202733', onchange, onpalettechange }: {
    /** The current color; undefined chooses ink when `ink` is offered. */
    value: string | undefined;
    palette: readonly string[];
    recent?: readonly string[];
    /** Offer "ink", a color that follows the theme (SVG drawings). */
    ink?: boolean;
    /** What the wheel shows while ink is chosen. */
    inkPreview?: string;
    onchange: (color: string | undefined) => void;
    onpalettechange: (palette: string[]) => void;
  } = $props();
  const shown = $derived(value ?? inkPreview);
</script>

<ColorWheel value={shown} size={132} onchange={(color) => onchange(color)} />
<span class="stream-break" aria-hidden="true"></span>
<span class="stream-label">Palette</span>
{#if ink}
  <span class="swatch-control ink-swatch" class:chosen={value === undefined}><Control onclick={() => onchange(undefined)} aria-label="Use ink color (follows theme)" aria-pressed={value === undefined}><span class="swatch" aria-hidden="true"></span></Control></span>
{/if}
{#each palette as swatch (swatch)}
  <span class="swatch-control" class:chosen={value === swatch} style:--swatch={swatch}><Control onclick={() => onchange(swatch)} aria-label={`Use color ${swatch}`} aria-pressed={value === swatch}><span class="swatch" aria-hidden="true"></span></Control></span>
{/each}
{#if value !== undefined && !palette.includes(value)}<Control onclick={() => onpalettechange([...palette, value!])} aria-label="Add current color to palette">+</Control>{/if}
{#if value !== undefined && palette.includes(value)}<Control onclick={() => onpalettechange(palette.filter((item) => item !== value))} aria-label="Remove current color from palette">−</Control>{/if}
{#if recent.length}
  <span class="stream-label">Recent</span>
  {#each recent as color (color)}
    <span class="swatch-control small" class:chosen={value === color} style:--swatch={color}><Control onclick={() => onchange(color)} aria-label={`Use recent color ${color}`}><span class="swatch" aria-hidden="true"></span></Control></span>
  {/each}
{/if}

<style>
  .swatch-control :global(button) { padding: 2px; min-width: 0; }
  /* The chosen colour carries a centred dot, outlined so it shows on light and dark swatches alike. */
  .swatch { position: relative; display: block; width: 22px; height: 22px; border-radius: 4px; background: var(--swatch); border: 1px solid var(--tertiary); }
  .swatch-control.small .swatch { width: 16px; height: 16px; }
  /* Ink shows the theme's text colour, split with the background to read as "follows the theme". */
  .ink-swatch .swatch { background: linear-gradient(135deg, var(--primary) 50%, var(--background) 50%); }
  .swatch-control.chosen .swatch::after { content: ''; position: absolute; left: 50%; top: 50%; width: 8px; height: 8px; transform: translate(-50%, -50%);
    border-radius: 50%; background: #fff; box-shadow: 0 0 0 1.5px #000; }
  .swatch-control.small.chosen .swatch::after { width: 6px; height: 6px; }
</style>
