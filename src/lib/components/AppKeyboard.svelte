<script lang="ts">
  import { onMount } from 'svelte';
  import { VirtualKeyboard, keyflow_key_handler, type VirtualKeyInput } from '@legitminh/keyflow';
  import { shortcutScope } from '../shortcut-scope.svelte';
  import { keyboardLayout, type KeyboardChoice } from '../keyboard';
  let { enabled, choice }: { enabled: boolean; choice: KeyboardChoice } = $props();
  let target: HTMLElement | null = null;
  let shift = $state(false);
  let caps = false;
  let modifier: string | undefined;
  const shifted = '~!@#$%^&*()_+{}|:"<>?';
  const plain = '`1234567890-=[]\\;\',./';
  const modes = new Map<HTMLElement, string | null>();
  function portal(element: HTMLElement, destination: HTMLDialogElement | null) {
    const marker = document.createComment('keyboard location');
    element.before(marker);
    const move = (dialog: HTMLDialogElement | null) => {
      if (dialog) dialog.append(element); else marker.after(element);
    };
    move(destination);
    return { update: move, destroy() { marker.after(element); marker.remove(); } };
  }
  function editable(element: Element | null): element is HTMLElement {
    return element instanceof HTMLElement && (element.isContentEditable || element.matches('input:not([type=file]):not([type=checkbox]):not([type=number]):not([type=password]), textarea'));
  }
  function configure(element: HTMLElement) {
    if (!modes.has(element)) modes.set(element, element.getAttribute('inputmode'));
    element.setAttribute('inputmode', 'none');
  }
  $effect(() => {
    if (enabled) {
      const element = document.activeElement;
      if (editable(element)) { target = element; configure(element); }
    } else {
      for (const [element, mode] of modes) {
        if (mode === null) element.removeAttribute('inputmode'); else element.setAttribute('inputmode', mode);
      }
      modes.clear();
    }
    document.documentElement.classList.toggle('virtual-keyboard-open', enabled);
  });
  onMount(() => {
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement) || event.target.closest('.keyboard-dock')) return;
      target = editable(event.target) ? event.target : null;
      if (enabled && target) configure(target);
    };
    document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('focusin', focus); document.documentElement.classList.remove('virtual-keyboard-open'); };
  });
  function input(event: VirtualKeyInput) {
    if (!target?.isConnected || (document.querySelector('dialog[open]') && !target.closest('dialog[open]'))) {
      keyflow_key_handler(event); return;
    }
    if (event.type !== 'keyup') return;
    let key = event.key;
    if (key === 'shift') { shift = !shift; return; }
    if (key === 'capslock') { caps = !caps; return; }
    if (['control', 'meta', 'alt'].includes(key)) { modifier = key; return; }
    if (key.length === 1 && (shift || caps)) key = /[a-z]/i.test(key) ? key.toUpperCase() : shift && plain.includes(key) ? shifted[plain.indexOf(key)] : key;
    const mod = modifier; modifier = undefined; shift = false;
    if (target.isContentEditable) {
      target.dispatchEvent(new CustomEvent('notework-key', { bubbles: true, detail: { key, modifier: mod } }));
      return;
    }
    const field = target as HTMLInputElement | HTMLTextAreaElement;
    if (key === 'escape') { field.blur(); target = null; return; }
    if (key === 'enter' && field instanceof HTMLInputElement) {
      if (field.reportValidity()) { if (field.form) field.form.requestSubmit(); else field.blur(); }
      return;
    }
    if (mod) {
      if (key.toLowerCase() === 'a') field.select();
      return;
    }
    const start = field.selectionStart ?? field.value.length, end = field.selectionEnd ?? start;
    if (key === 'arrowleft' || key === 'arrowright') {
      const position = key === 'arrowleft' ? Math.max(0, start - 1) : Math.min(field.value.length, end + 1);
      field.setSelectionRange(position, position); return;
    }
    if (key === 'backspace') field.setRangeText('', start === end ? Array.from(field.value.slice(0, start)).slice(0, -1).join('').length : start, end, 'end');
    else if (key === 'delete') field.setRangeText('', start, start === end ? end + (field.value.codePointAt(end)! > 0xffff ? 2 : 1) : end, 'end');
    else if (key.length === 1 || key === 'enter' || key === 'tab') field.setRangeText(key === 'enter' ? '\n' : key === 'tab' ? '  ' : key, start, end, 'end');
    else return;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
</script>

{#if enabled}
  <div class="keyboard-dock" use:portal={shortcutScope.dialog} class:shifted={shift}>
    <VirtualKeyboard layout={keyboardLayout(choice)} onkey={input} />
  </div>
{/if}

<style>
  .keyboard-dock {
    position: fixed; z-index: 30; inset: auto 0 0; height: var(--keyboard-height);
    overflow: auto; border-top: 1px solid var(--tertiary); background: var(--background);
    padding-bottom: env(safe-area-inset-bottom, 0);
    --keyboard-font-size: clamp(1rem, 2vw, 1.4rem);
  }
  /* Use Keyflow's demo dock layout with its native key minimums. Short
     viewports scroll instead of compressing flick directions into the center. */
  .keyboard-dock :global(.keyflow-keyboard) { height: 100%; }
  .keyboard-dock :global(.keyboard-row) { flex: 1 0 auto; }
  .keyboard-dock :global([data-layout="ascii"]),
  .keyboard-dock :global([data-layout="60%"]),
  .keyboard-dock :global([data-layout="ortholinear"]) {
    --keyboard-font-size: clamp(.65rem, 1.3vw, 1rem);
  }
  .shifted { --keyboard-key-background: rgb(128 128 128 / .2); }
</style>
