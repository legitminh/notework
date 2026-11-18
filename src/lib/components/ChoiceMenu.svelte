<script lang="ts">
  import { tick } from 'svelte';
  import Menu from './Menu.svelte';
  let { label, value, choices, disabled = false, onchange }: {
    label: string;
    value: string;
    choices: readonly { id: string; label: string }[];
    disabled?: boolean;
    onchange: (value: string) => void | Promise<void>;
  } = $props();
  const selected = $derived(choices.find((choice) => choice.id === value)?.label ?? value);
  let host: HTMLDivElement;
  async function choose(id: string) {
    await onchange(id);
    await tick();
    // An asynchronous layer change temporarily disables the trigger. Restore
    // focus when it finishes, unless the user has moved to another control.
    if (document.activeElement === document.body)
      host?.querySelector<HTMLButtonElement>('.subkeyframe-trigger')?.focus({ preventScroll: true });
  }
</script>

<div class="choice-menu" data-choice={label} data-value={value} bind:this={host}>
  <Menu label={`${label}: ${selected}`} {disabled}
    items={choices.map((choice) => ({ id: choice.id, label: choice.label, on_select: () => { void choose(choice.id); } }))}>
    {#snippet itemDisplay(item)}
      <span data-choice-option={item.id} data-selected={String(item.id === value)}>{item.label}</span>
      {#if item.id === value}<span aria-hidden="true"> ✓</span>{/if}
    {/snippet}
  </Menu>
</div>
