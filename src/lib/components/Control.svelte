<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { Button, ButtonPositional, StaticButton, type Shortcut } from '@legitminh/keyflow';
  import { shortcutScope } from '../shortcut-scope.svelte';

  let { children, onclick, disabled = false, keys, class: className = '', 'aria-label': ariaLabel, 'aria-keyshortcuts': ariaKeys, 'aria-pressed': ariaPressed }: {
    children?: Snippet;
    onclick: () => void;
    disabled?: boolean;
    keys?: Shortcut;
    class?: string;
    'aria-label'?: string;
    'aria-keyshortcuts'?: string;
    'aria-pressed'?: boolean;
  } = $props();
  let host = $state<HTMLSpanElement>();
  const available = $derived.by(() => {
    const modal = shortcutScope.dialog;
    if (!host) return false;
    const dialog = host.closest('dialog');
    return (!dialog || dialog === modal) && (!modal || modal.contains(host));
  });
  // Opening a dialog can replace its initially focused native fallback.
  $effect.pre(() => {
    const enabled = available && !disabled;
    void keys;
    const previous = host?.querySelector('button');
    const focused = previous === document.activeElement;
    if (enabled && focused) void tick().then(() => {
      // Restore a replaced button only if another control has not taken focus.
      if (document.activeElement === previous || document.activeElement === document.body)
        host?.querySelector('button')?.focus({ preventScroll: true });
    });
  });
  // Keyflow 0.2 does not forward native attributes. Keep Notework's names,
  // existing editor shortcuts and toggle semantics on the actual button.
  $effect(() => {
    const element = host;
    const attributes = { 'aria-label': ariaLabel, 'aria-keyshortcuts': ariaKeys, 'aria-pressed': ariaPressed };
    void available; void disabled; void keys;
    let active = true;
    let observer: MutationObserver | undefined;
    void tick().then(() => {
      if (!active || !element) return;
      const update = () => {
        const button = element.querySelector('button');
        if (!button) return;
        // Route labels are visual instructions, not part of the action's name.
        const content = (button.querySelector('.content') ?? button).cloneNode(true) as HTMLElement;
        content.querySelectorAll('[aria-hidden="true"]').forEach((node) => node.remove());
        const name = ariaLabel ?? content.textContent?.trim();
        if (name) button.setAttribute('aria-label', name);
        for (const [name, value] of Object.entries(attributes)) {
          if (name === 'aria-label') continue;
          if (value === undefined) button.removeAttribute(name);
          else button.setAttribute(name, String(value));
        }
      };
      update();
      observer = new MutationObserver(update);
      observer.observe(element, { childList: true, characterData: true, subtree: true });
    });
    return () => { active = false; observer?.disconnect(); };
  });
</script>

<span class={`control ${className}`} bind:this={host}>
  {#if disabled || !available}
    <button type="button" {disabled} {onclick}>{@render children?.()}</button>
  {:else if keys}
    <StaticButton {keys} on_close={onclick}>{@render children?.()}</StaticButton>
  {:else if host?.closest('dialog')}
    <Button on_close={onclick}>{@render children?.()}</Button>
  {:else}
    <ButtonPositional on_close={onclick}>{@render children?.()}</ButtonPositional>
  {/if}
</span>
