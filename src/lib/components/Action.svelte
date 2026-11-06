<script lang="ts">
  import type { Snippet } from 'svelte';
  import Control from './Control.svelte';
  let { label, onSelect, children, disabled = false, iconOnly = false }: {
    label: string; onSelect: () => void; children?: Snippet; disabled?: boolean; iconOnly?: boolean;
  } = $props();
</script>

<div class="action" data-action={label}>
  <Control onclick={onSelect} {disabled}>
    <span class:visually-hidden={iconOnly}>{label}</span>{@render children?.()}
  </Control>
</div>
