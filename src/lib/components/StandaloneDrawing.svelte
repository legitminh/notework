<script lang="ts">
  import { onMount } from 'svelte';
  import type { Workspace, StateNode } from '../workspace';
  import { loadDrawing, saveDrawing, type DrawingResource } from '../drawing-files';
  import { isMissing } from '../filesystem';
  import { storageError } from '../browser-documents';
  import DrawingEditor from './DrawingEditor.svelte';

  let { workspace, node, onExit, onMissing }: {
    workspace: Workspace; node: StateNode; onExit: () => void; onMissing: () => void;
  } = $props();
  let resource = $state.raw<DrawingResource>();
  let error = $state('');

  onMount(() => {
    let active = true;
    void (async () => {
      try {
        const handle = await workspace.handle(node.id);
        if (handle.kind !== 'file') throw new Error('The drawing is no longer a file.');
        const loaded = await loadDrawing(handle);
        if (active) resource = loaded;
      } catch (cause) {
        if (!active) return;
        if (isMissing(cause)) onMissing();
        else error = storageError(cause);
      }
    })();
    return () => { active = false; };
  });
</script>

{#if resource}
  <DrawingEditor name={node.name} initial={resource.strokes} {onExit}
    onSave={async (strokes) => { resource = await saveDrawing(resource!, strokes); }} />
{:else if error}
  <button type="button" onclick={onExit}>Exit</button>
  <p class="notice" role="alert">{error}</p>
{:else}
  <p class="muted" role="status">opening drawing…</p>
{/if}
