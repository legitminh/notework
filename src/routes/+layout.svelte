<script lang="ts">
  import type { Snippet } from 'svelte';
  import '@legitminh/keyflow/styles.css';
  import '../app.css';
  let { children }: { children: Snippet } = $props();

  function confirmText(event: KeyboardEvent) {
    const input = event.target;
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
        !(input instanceof HTMLInputElement) || !['text', 'search', 'number'].includes(input.type) ||
        input.form || input.closest('.cm-editor')) return;
    event.preventDefault();
    event.stopPropagation();
    if (input.reportValidity()) input.blur();
  }
</script>

<svelte:window onkeydown={confirmText} />

<svelte:head>
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#ffffff" />
</svelte:head>

{@render children()}
