<script lang="ts">
  import Control from './Control.svelte';
  let { closed, label, onclick }: { closed: boolean; label: string; onclick: () => void } = $props();
</script>

<Control aria-label={label} {onclick}>{closed ? '▸' : '▾'}</Control>
