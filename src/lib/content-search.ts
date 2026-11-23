import type { ContentResults } from './content-index';
import type { IndexRequest } from './content-search-worker';
import { isMissing } from './filesystem';
import type { Workspace, StateNode } from './workspace';

export interface IndexProgress { visited: number; total: number; errors: number; done: boolean }

/** One index per workspace/tab; closing the dialog keeps it warm without persisting contents. */
export class ContentSearch {
  private worker = new Worker(new URL('./content-search-worker.ts', import.meta.url), { type: 'module' });
  private request = 0;
  private epoch = 0;
  private pending = new Map<number, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();
  private failure: Error | undefined;
  nodes = new Map<string, StateNode>();

  constructor() {
    this.worker.onmessage = ({ data }) => {
      const callback = this.pending.get(data.request);
      this.pending.delete(data.request);
      if (data.error) callback?.reject(new Error(data.error)); else callback?.resolve(data.result);
    };
    this.worker.onerror = () => {
      this.failure = new Error('the content search worker could not start. reload to try again.');
      for (const callback of this.pending.values()) callback.reject(this.failure);
      this.pending.clear();
    };
  }

  private call(message: IndexRequest): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const request = ++this.request;
      this.pending.set(request, { resolve, reject });
      try { this.worker.postMessage({ request, message }); }
      catch (error) { this.pending.delete(request); reject(error); }
    });
  }

  async prepare(workspace: Workspace, from: string, signal: AbortSignal, update: (progress: IndexProgress) => void) {
    const epoch = ++this.epoch;
    this.nodes.clear();
    await this.call({ type: 'begin', epoch });
    const { files, errors, retainedIds } = await workspace.contentScope(from, signal);
    signal.throwIfAborted();
    // Retain only active-graph caches. The worker activates scope members after revalidation.
    await this.call({ type: 'retain', epoch, ids: retainedIds });
    const progress: IndexProgress = { visited: 0, total: files.length, errors, done: false };
    update({ ...progress });
    let cursor = 0;
    // Bound filesystem concurrency and worker queue size even for huge trees.
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      while (cursor < files.length) {
        signal.throwIfAborted();
        const { node, handle } = files[cursor++];
        try {
          const file = await handle.getFile();
          signal.throwIfAborted();
          await this.call({ type: 'file', epoch, id: node.id, file });
          signal.throwIfAborted();
          this.nodes.set(node.id, node);
        } catch (error) {
          signal.throwIfAborted();
          if (this.failure) throw this.failure;
          if (isMissing(error)) { if (!workspace.moving.has(node.id)) workspace.forget(node.id); }
          else progress.errors++;
        }
        progress.visited++;
        update({ ...progress });
      }
    }));
    progress.done = true;
    update({ ...progress });
  }

  search(query: string, limit: number) {
    return this.call({ type: 'search', epoch: this.epoch, query, limit }) as Promise<ContentResults | undefined>;
  }

  freeze() {
    // In-flight reads from an aborted scan may finish; they must not expand partial results.
    return this.call({ type: 'begin', epoch: ++this.epoch, ids: [...this.nodes.keys()] });
  }

  destroy() {
    this.worker.terminate();
    for (const callback of this.pending.values()) callback.reject(new Error('search closed.'));
    this.pending.clear();
  }
}
