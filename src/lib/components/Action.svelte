<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ButtonPositional } from '@legitminh/keyflow';
  let { label, onSelect, children, disabled = false, iconOnly = false }: {
    label: string; onSelect: () => void; children?: Snippet; disabled?: boolean; iconOnly?: boolean;
  } = $props();
</script>

<div class="action" data-action={label}>
  {#if disabled}
    <button type="button" disabled><span class:visually-hidden={iconOnly}>{label}</span>{@render children?.()}</button>
  {:else}
    <ButtonPositional on_close={onSelect}>
      <span class:visually-hidden={iconOnly}>{label}</span>{@render children?.()}
    </ButtonPositional>
  {/if}
</div>
