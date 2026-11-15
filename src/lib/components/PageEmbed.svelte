<script lang="ts">
  import { onMount } from 'svelte';
  import FilePreview from './FilePreview.svelte';
  import type { StateNode } from '../workspace';
  import type { PrettyContext } from '../pretty-display';
  import type { PageReferenceOptions } from '../page-references';
  import { resolveFileReference } from '../wiki';

  let { token, indent, pretty, options }: { token: string; indent: string; pretty: PrettyContext; options: PageReferenceOptions } = $props();
  let node = $state.raw<StateNode>();
  let error = $state('');
  onMount(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const files = await options.catalog();
        const target = await resolveFileReference(options.workspace, options.source, token, files);
        abort.signal.throwIfAborted();
        if (!target || !files.some((file) => file.id === target.id)) throw new Error(`Referenced file “${token}” is unavailable.`);
        if (options.ancestors.includes(target.id)) throw new Error(`Circular page reference: ${token}`);
        if (options.ancestors.length >= 8) throw new Error('Page reference nesting limit reached.');
        node = target;
      } catch (cause) { if (!abort.signal.aborted) error = cause instanceof Error ? cause.message : String(cause); }
    })();
    return () => abort.abort();
  });
</script>

<section class="page-embed" aria-label={`Referenced file ${token}`} data-reference-target={node?.id}>
  {#if node}
    <FilePreview workspace={options.workspace} {node} wrapLines={options.wrapLines} prettyFontSize={options.prettyFontSize}
      prettyMargin={options.prettyMargin} showLineNumbers={false} disabled={false} {indent} inheritedPretty={pretty}
      catalog={options.catalog} ancestors={[...options.ancestors, node.id]} onOpen={(location) => options.onOpen(node!.id, location)} onOpenReference={options.onOpen} />
  {:else if error}<p class="notice" role="status">{error}</p>
  {:else}<p class="muted" role="status">loading {token}…</p>{/if}
</section>
