<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { SubKeyframe, type SubKeyframeContext, type SubKeyframeItem } from '@legitminh/keyflow';
  import { shortcutScope } from '../shortcut-scope.svelte';

  let { label, children, items = [], disabled = false, open = $bindable(false), showTrigger = true,
    backLabel = 'Back', itemDisplay, onopen, onclose }: {
    label: string;
    children?: Snippet<[SubKeyframeContext]>;
    items?: readonly SubKeyframeItem[];
    disabled?: boolean;
    open?: boolean;
    showTrigger?: boolean;
    backLabel?: string;
    itemDisplay?: Snippet<[SubKeyframeItem, SubKeyframeContext]>;
    onopen?: () => void;
    onclose?: () => void;
  } = $props();
  let host = $state<HTMLDivElement>();
  const available = $derived(!shortcutScope.dialog || !!host && shortcutScope.dialog.contains(host));
  let restoreAfterDialog = false;
  $effect.pre(() => {
    if (!available && open) restoreAfterDialog = true;
    if (available && !disabled && restoreAfterDialog) {
      restoreAfterDialog = false;
      void tick().then(() => {
        if (document.activeElement === document.body)
          host?.querySelector<HTMLButtonElement>('.subkeyframe-trigger')?.focus({ preventScroll: true });
      });
    }
  });

  // Keep Notework action names separate from Keyflow's visible shortcut routes.
  onMount(() => {
    const element = host!;
    const nameButtons = () => {
      for (const button of element.querySelectorAll<HTMLButtonElement>('button')) {
        if (button.closest('.menu') !== element || button.closest('.control')) continue;
        const content = button.querySelector('.content');
        if (content) {
          const caption = content.cloneNode(true) as HTMLElement;
          caption.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
          button.setAttribute('aria-label', caption.textContent!.trim());
        }
        const choice = button.querySelector<HTMLElement>('[data-choice-option]');
        if (choice) button.setAttribute('aria-pressed', choice.dataset.selected ?? 'false');
        if (button.classList.contains('subkeyframe-trigger')) button.dataset.action = button.getAttribute('aria-label')!;
      }
    };
    nameButtons();
    const observer = new MutationObserver(nameButtons);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    const dialog = element.closest('dialog');
    const cancel = (event: Event) => {
      if (!open) return;
      // Escape dismisses this dropdown before the enclosing native dialog.
      event.preventDefault(); event.stopImmediatePropagation();
      open = false;
    };
    dialog?.addEventListener('cancel', cancel, true);
    return () => { observer.disconnect(); dialog?.removeEventListener('cancel', cancel, true); };
  });

</script>

<div class="menu" bind:this={host}>
  <SubKeyframe {label} {items} {showTrigger} {backLabel} {children} {itemDisplay} bind:open disabled={disabled || !available}
    enterTrigger={showTrigger ? undefined : null}
    {onopen}
    {onclose} />
</div>

<style>
  .menu { max-width: 100%; }
  .menu :global(.keyflow-subkeyframe) { max-width: 100%; }
  .menu :global(.subkeyframe-panel) { max-width: 100%; overflow-wrap: anywhere; }
</style>
