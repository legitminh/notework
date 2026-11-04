<script lang="ts">
  import type { Snippet } from 'svelte';
  import '@legitminh/keyflow/styles.css';
  import '../app.css';
  let { children }: { children: Snippet } = $props();
</script>

<svelte:head>
  <link rel="manifest" href="/manifest.webmanifest" />
  <meta name="theme-color" content="#ffffff" />
</svelte:head>

{@render children()}
