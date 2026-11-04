<script lang="ts">
  import type { Snippet } from 'svelte';
  import { ButtonPositional } from '@legitminh/keyflow';
  let { label, onSelect, children, disabled = false }: {
    label: string; onSelect: () => void; children?: Snippet; disabled?: boolean;
  } = $props();
</script>

<div class="action" data-action={label}>
  {#if disabled}
    <button type="button" disabled>{label}</button>
  {:else}
    <ButtonPositional on_close={onSelect}>
      <span>{label}</span>{@render children?.()}
    </ButtonPositional>
  {/if}
</div>
