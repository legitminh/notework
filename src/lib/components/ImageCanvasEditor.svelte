<script lang="ts">
  import RasterEditor from './RasterEditor.svelte';
  let { usingTools = $bindable(false), ...props }: ComponentProps<typeof RasterEditor> = $props();
  import type { ComponentProps } from 'svelte';
  let editor: RasterEditor;
  export async function saveForNavigation() { return await editor?.saveForNavigation() ?? false; }
  export async function focusToolbar() { editor?.focusToolbar(); }
  export function resumeEditing() { editor?.resumeEditing(); }
</script>
<div class="image-editor" class:standalone-drawing-editor={!props.surfaceTarget}>
  <RasterEditor {...props} bind:this={editor} bind:usingTools />
</div>
<style>.image-editor { min-height:0;height:100%; }</style>
