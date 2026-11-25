<script lang="ts">
  import { tick, type Snippet } from 'svelte';
  import { Button, ButtonPositional, StaticButton, type Shortcut } from '@legitminh/keyflow';
  import { shortcutScope } from '../shortcut-scope.svelte';

  let { children, onclick, disabled = false, keys, registered = true, class: className = '', 'aria-label': ariaLabel, 'aria-keyshortcuts': ariaKeys, 'aria-pressed': ariaPressed }: {
    children?: Snippet;
    onclick: () => void;
    disabled?: boolean;
    keys?: Shortcut;
    registered?: boolean;
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
  // Keep Notework's names, existing editor shortcuts and toggle semantics on
  // the actual button while Keyflow handles disabled state and registration.
  $effect(() => {
    const element = host;
    const attributes = { 'aria-label': ariaLabel, 'aria-keyshortcuts': ariaKeys, 'aria-pressed': ariaPressed };
    void available; void disabled; void keys; void registered;
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
  {#if keys}
    <StaticButton {keys} {registered} disabled={disabled || !available} on_close={onclick}>{@render children?.()}</StaticButton>
  {:else if host?.closest('dialog')}
    <Button {registered} disabled={disabled || !available} on_close={onclick}>{@render children?.()}</Button>
  {:else if !registered}
    <Button {registered} disabled={disabled || !available} on_close={onclick}>{@render children?.()}</Button>
  {:else}
    <ButtonPositional disabled={disabled || !available} on_close={onclick}>{@render children?.()}</ButtonPositional>
  {/if}
</span>
