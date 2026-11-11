import { createContext } from 'svelte';
import { GitHubChanged, GitHubEditCancelled, GitHubFile, type GitHubRepository, type ResolveGitHubConflict } from './repository';
import { readSyncJobs, updateSyncJobs, type GitHubSyncJob } from './storage';
import { saveWorkspace } from '../persistence';
import { wikiCatalog, wikiTokens, prepareWikiSave } from '../wiki';
import { svgPageNames } from '../drawing';
import { prepareSvgPages } from '../drawing-files';
import type { StateNode, Workspace } from '../workspace';

class ConflictPending extends Error {}
export class BackgroundSync {
  running = $state(false);
  pending = $state(0);
  completed = $state(0);
  problem = $state.raw<unknown>();
  conflict = $state(false);
  private jobs = new Map<string, GitHubSyncJob[]>();
  private saving = Promise.resolve();
  private stopped = false;
  private working?: Promise<void>;
  private retryAt = 0;
  constructor(private workspace: () => Workspace, private resolve: ResolveGitHubConflict, private changed: () => void) {}
  private repository(id: string) { return this.workspace().github(id); }
  async restore() {
    for (const source of this.workspace().data.sources) {
      if (source.storage === 'github') this.jobs.set(source.id, await readSyncJobs(source.id));
    }
    this.count();
    void this.run();
  }
  private count() {
    this.pending = [...this.jobs.values()].reduce((sum, jobs) => sum + jobs.length, 0);
    for (const [id, jobs] of this.jobs) {
      const repository = this.repository(id);
      if (!repository) continue;
      repository.queuedPaths.clear();
      for (const job of jobs) repository.queuedPaths.add(job.path);
    }
  }
  async enqueue(node: StateNode, file: GitHubFile, text = false, createTokens: string[] = [], createPages: string[] = []) {
    const draft = file.repository.draft(file.path);
    if (!draft) return;
    const job: GitHubSyncJob = { id: crypto.randomUUID(), nodeId: node.id, path: file.path, name: file.name, draft, text, createTokens, createPages };
    // Serialize persistence so concurrent drawing/text exits cannot lose a job.
    const next = this.saving.then(async () => {
      const queue = await updateSyncJobs(file.repository.id, (jobs) =>
        jobs.some((job) => job.draft.id === draft.id) ? jobs : [...jobs, job]);
      this.jobs.set(file.repository.id, queue); this.count();
    });
    this.saving = next.catch(() => {});
    await next;
    this.retryAt = 0;
    void this.run();
  }
  retry(review = false) { this.retryAt = 0; void this.run(review); }
  stop() { this.stopped = true; }
  private run(review = false): Promise<void> {
    if (this.working) return this.working;
    if (this.stopped || !navigator.onLine || Date.now() < this.retryAt) return Promise.resolve();
    this.working = this.drain(review).finally(() => { this.working = undefined; });
    return this.working;
  }
  private async drain(review: boolean) {
    this.running = true; this.problem = undefined; this.conflict = false;
    try {
      for (const [id] of this.jobs) {
        let job: GitHubSyncJob | undefined;
        while (!this.stopped && (job = this.jobs.get(id)?.[0])) {
          const repository = this.repository(id);
          if (!repository) break;
          // Web Locks also prevent two tabs from publishing the same queued job.
          const publish = async () => {
            const persisted = await readSyncJobs(id);
            const latest = persisted.find((item) => item.id === job!.id);
            if (!latest) return false;
            job = latest;
            return this.publish(repository, latest, review);
          };
          const rebase = await repository.exclusive(publish);
          await this.saving;
          const queue = await updateSyncJobs(id, (jobs) => jobs.filter((item) => item.id !== job!.id).map((item) =>
            rebase && item.path === job!.path && item.draft.base === job!.draft.base ? { ...item, draft: { ...item.draft, base: repository.editBase(item.path) } } : item));
          this.jobs.set(id, queue); this.completed++; this.count(); this.changed();
          review = false;
        }
      }
    } catch (error) {
      this.conflict = error instanceof ConflictPending || error instanceof GitHubEditCancelled;
      this.problem = this.conflict ? 'A GitHub file changed. Review the versions when convenient; your draft is safe.' : error;
      this.retryAt = this.conflict ? Infinity : Date.now() + 30_000;
    } finally { this.running = false; }
  }
  private async publish(repository: GitHubRepository, job: GitHubSyncJob, review: boolean) {
    const workspace = this.workspace();
    for (let attempt = 0; attempt < 3; attempt++) {
      const chosen = await repository.reconcile(job.path, job.draft, review ? this.resolve : async () => { throw new ConflictPending(); });
      const checkpoint = repository.checkpoint();
      let wiki: Awaited<ReturnType<typeof prepareWikiSave>> | undefined;
      let pages: Awaited<ReturnType<typeof prepareSvgPages>> | undefined;
      try {
        if (!chosen.unchanged) repository.stage(job.path, chosen.content);
        if (chosen.content && job.text) {
          const node = await workspace.node(job.nodeId);
          const file = new GitHubFile(repository, job.path);
          const { inspectTextFile, decodedChunks } = await import('../text-resource');
          const blob = new File([chosen.content], job.name);
          const format = await inspectTextFile(blob);
          if (format) {
            let text = '';
            for await (const part of decodedChunks(blob, format)) text += part;
            const lines = text.replace(/\r\n?/g, '\n').split('\n');
            const files = await wikiCatalog(workspace, new AbortController().signal);
            wiki = await prepareWikiSave(workspace, node, file, wikiTokens(lines), files,
              (token) => !chosen.unchanged && job.createTokens.includes(token), false, chosen.unchanged);
            pages = await prepareSvgPages(workspace, node, file, svgPageNames(lines),
              (name) => !chosen.unchanged && job.createPages.includes(name), false, files, chosen.unchanged);
          }
        }
        await repository.commit(checkpoint, `edit: ${job.name}`, chosen.head);
      } catch (error) {
        await pages?.rollback(); await wiki?.rollback(); repository.restore(checkpoint);
        if (error instanceof GitHubChanged && attempt < 2) continue;
        throw error;
      }
      // Acknowledgement is conditional: never erase a newer autosave.
      const rebase = chosen.content === job.draft.content;
      await repository.acknowledgeDraft(job.path, job.draft, rebase);
      if (job.text && wiki) workspace.replaceWikiLinks(job.nodeId, { ...wiki?.targets, ...pages?.targets });
      await saveWorkspace(workspace.data);
      return rebase;
    }
  }
}
export const [getBackgroundSync, setBackgroundSync] = createContext<BackgroundSync>();
