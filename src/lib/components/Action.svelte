<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { Shortcut } from '@legitminh/keyflow';
  import Control from './Control.svelte';
  let { label, onSelect, children, disabled = false, iconOnly = false, keys }: {
    label: string; onSelect: () => void; children?: Snippet; disabled?: boolean; iconOnly?: boolean; keys?: Shortcut;
  } = $props();
</script>

<div class="action" data-action={label}>
  <Control onclick={onSelect} {disabled} {keys}>
    <span class:visually-hidden={iconOnly}>{label}</span>{@render children?.()}
  </Control>
</div>
