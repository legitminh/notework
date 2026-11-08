import type { LocalDirectory, LocalFile, LocalHandle } from '../filesystem';
import { GitHubApi, GitHubApiError, type GitEntry, type GitHubConnection, type GitSnapshot, type TreeChange } from './api';
import { clearDraft, readBlob, readDrafts, readSnapshot, readToken, storeBlob, storeDraft, storeSnapshot, storeToken, type GitHubDraft } from './storage';

const keep = '.gitkeep';
const supportedBlob = (entry: GitEntry) => entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const name = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const missing = () => new DOMException('The GitHub item is no longer present.', 'NotFoundError');
const wrongKind = () => new DOMException('A different kind of GitHub item has this name.', 'TypeMismatchError');
const key = (path: string, name: string) => {
  if (!name || name === '.' || name === '..' || /[/\x00]/.test(name)) throw new TypeError('Choose a valid item name.');
  return path ? path + '/' + name : name;
};
const hash = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1',
  await new Blob([`blob ${blob.size}\0`, blob]).arrayBuffer())), (byte) => byte.toString(16).padStart(2, '0')).join('');

interface Change { expected: string | null; expectedMode?: string; blob: Blob | null; mode: string; type: GitEntry['type']; modified: number }
interface Checkpoint { changes: Map<string, Change>; removals: Map<string, string> }
export interface GitHubConflict { path: string; local: Blob; upstream: Blob | null }
export type ResolveGitHubConflict = (conflict: GitHubConflict) => Promise<Blob | null | undefined>;
export class GitHubEditCancelled extends Error {}
export class GitHubChanged extends Error {
  constructor(readonly path: string) { super(`“${path}” changed on GitHub. Reopen it or retry to compare the latest version.`); }
}

export class GitHubRepository {
  readonly root: GitHubDirectory;
  private api: GitHubApi;
  private snapshot?: GitSnapshot;
  private entries = new Map<string, GitEntry>();
  private trackedDirectories = new Set<string>();
  private pending = new Map<string, Change>();
  private removals = new Map<string, string>();
  private files = new Map<string, Promise<Blob>>();
  private directoryIndex?: Map<string, Map<string, 'file' | 'directory'>>;
  private syncing?: Promise<void>;
  private modified = Date.now();
  private drafts = new Map<string, GitHubDraft>();

  constructor(readonly id: string, readonly connection: GitHubConnection, private token: string, snapshot?: GitSnapshot) {
    this.api = new GitHubApi(connection, token);
    this.root = new GitHubDirectory(this, '');
    if (snapshot) this.install(snapshot);
  }

  static async restore(id: string, connection: GitHubConnection) {
    const [token, snapshot, drafts] = await Promise.all([readToken(id), readSnapshot(id), readDrafts(id)]);
    const repository = new GitHubRepository(id, connection, token ?? '', snapshot);
    repository.drafts = drafts;
    return repository;
  }

  static async connect(id: string, owner: string, repo: string, branch: string, token: string) {
    if (!/^[a-z\d][a-z\d-]*$/i.test(owner) || !/^[\w.-]+$/.test(repo) || ['.', '..'].includes(repo)) {
      throw new Error('Enter a GitHub repository as owner/repository.');
    }
    const api = new GitHubApi({ owner, repo, branch }, token);
    const metadata = await api.request<{ default_branch: string; permissions?: { push: boolean }; archived?: boolean }>('', 'open the repository');
    if (metadata.archived || metadata.permissions?.push === false) throw new Error('This repository does not allow writes with this connection.');
    branch ||= metadata.default_branch;
    if (!branch || branch.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Enter a valid branch name.');
    const repository = new GitHubRepository(id, { owner, repo, branch }, token);
    await repository.sync();
    await storeToken(id, token);
    return repository;
  }

  async replaceToken(token: string) {
    const candidate = await GitHubRepository.connect(this.id, this.connection.owner, this.connection.repo, this.connection.branch, token);
    this.api = candidate.api;
    this.token = token;
    this.install(candidate.current());
  }

  private install(snapshot: GitSnapshot) {
    this.snapshot = snapshot;
    this.entries = new Map(snapshot.entries.filter((entry) => entry.type !== 'tree').map((entry) => [entry.path, entry]));
    this.trackedDirectories = new Set(snapshot.entries.filter((entry) => entry.type === 'tree').map((entry) => entry.path));
    for (const path of this.entries.keys()) {
      for (let folder = parent(path); folder && !this.trackedDirectories.has(folder); folder = parent(folder)) this.trackedDirectories.add(folder);
    }
    this.directoryIndex = undefined;
  }

  private current() {
    if (!this.snapshot) throw new Error('The GitHub repository is unavailable. Check the connection in settings.');
    return this.snapshot;
  }

  async sync() {
    if (!this.token) throw new Error('Add a GitHub token in settings to connect this repository.');
    if (!navigator.onLine) throw new Error('GitHub is offline. Changes can stay in this browser until you reconnect.');
    return this.syncing ??= (async () => {
      const head = await this.api.head();
      if (head !== this.snapshot?.head) {
        const snapshot = await this.api.snapshot(head);
        await storeSnapshot(this.id, snapshot);
        this.install(snapshot);
      }
    })().finally(() => { this.syncing = undefined; });
  }

  async blob(sha: string) {
    let request = this.files.get(sha);
    if (!request) {
      request = (async () => {
        const cached = await readBlob(this.id, sha).catch(() => undefined);
        if (cached) return cached;
        const blob = await this.api.blob(sha);
        await storeBlob(this.id, sha, blob).catch(() => {});
        return blob;
      })().catch((error) => { this.files.delete(sha); throw error; });
      if (this.files.size >= 64) this.files.delete(this.files.keys().next().value!);
      this.files.set(sha, request);
    }
    return request;
  }

  private directories() {
    this.current();
    if (this.directoryIndex) return this.directoryIndex;
    const dirs = new Map<string, Map<string, 'file' | 'directory'>>([['', new Map()]]);
    function children(path: string) {
      let map = dirs.get(path);
      if (!map) {
        map = new Map();
        dirs.set(path, map);
        children(parent(path)).set(name(path), 'directory');
      }
      return map;
    }
    for (const path of new Set([...this.entries.keys(), ...this.pending.keys(), ...this.drafts.keys()])) {
      const change = this.pending.get(path);
      const entry = this.entries.get(path);
      const draft = this.drafts.get(path);
      if (change ? !change.blob : !entry && !draft) continue;
      if (path.split('/').some((part) => part.toLowerCase() === '.git')) continue;
      const list = children(parent(path));
      if (name(path) !== keep && (change || draft || (entry && supportedBlob(entry)))) list.set(name(path), 'file');
    }
    return this.directoryIndex = dirs;
  }

  list(path: string) {
    const children = this.directories().get(path);
    if (!children) throw missing();
    return children;
  }

  has(path: string) {
    const change = this.pending.get(path);
    return change ? !!change.blob : this.entries.has(path);
  }

  assertTransferable(path: string) {
    const contains = (candidate: string) => candidate === path || candidate.startsWith(path + '/');
    if ([...this.drafts.keys()].some(contains)) throw new Error('Open the GitHub files with unpublished drafts and exit them before moving or renaming them.');
    if ([...this.entries.values()].some((entry) => contains(entry.path) && !supportedBlob(entry))) {
      throw new Error('This GitHub folder contains a symbolic link or submodule. Move it on GitHub to preserve those entries.');
    }
  }

  entryMode(path: string) { return this.entries.get(path)?.mode; }

  async file(path: string) {
    const change = this.pending.get(path);
    const entry = this.entries.get(path);
    const draft = this.drafts.get(path);
    if (!change && draft) return new File([draft.content], name(path), { lastModified: draft.modified });
    if (change ? !change.blob : !entry || !supportedBlob(entry)) throw missing();
    const blob = change?.blob ?? await this.blob(entry!.sha);
    // The same immutable blob must keep the same file identity across reads.
    return new File([blob], name(path), { lastModified: change?.modified ?? parseInt(entry!.sha.slice(0, 12), 16) });
  }

  stage(path: string, blob: Blob | null, mode?: string) {
    const original = this.entries.get(path);
    const existing = this.pending.get(path);
    this.pending.set(path, { expected: existing ? existing.expected : original?.sha ?? null,
      expectedMode: existing ? existing.expectedMode : original?.mode,
      blob, mode: mode ?? existing?.mode ?? original?.mode ?? '100644', type: original?.type ?? 'blob', modified: ++this.modified });
    this.directoryIndex = undefined;
  }

  createDirectory(path: string) { this.stage(key(path, keep), new Blob()); }

  private directoryVersion(path: string) {
    return JSON.stringify([...this.entries.values()].filter((entry) => entry.path.startsWith(path + '/'))
      .map(({ path, sha, mode }) => [path, sha, mode]).sort());
  }

  remove(path: string, recursive: boolean) {
    if (this.directories().has(path)) {
      const prefix = path + '/';
      const paths = [...new Set([...this.entries.keys(), ...this.pending.keys(), ...this.drafts.keys()])]
        .filter((key) => key.startsWith(prefix) && (this.has(key) || this.drafts.has(key)));
      if (!recursive && paths.some((path) => path !== prefix + keep)) throw new DOMException('The folder is not empty.', 'InvalidModificationError');
      if (!this.removals.has(path)) this.removals.set(path, this.directoryVersion(path));
      for (const file of paths) this.stage(file, null);
    } else if (this.has(path) || this.drafts.has(path)) this.stage(path, null);
    else throw missing();
    const directory = parent(path);
    if (directory && !this.directories().has(directory)) this.createDirectory(directory);
  }

  checkpoint(): Checkpoint { return { changes: new Map(this.pending), removals: new Map(this.removals) }; }
  restore(checkpoint: Checkpoint) {
    this.pending = new Map(checkpoint.changes);
    this.removals = new Map(checkpoint.removals);
    this.directoryIndex = undefined;
  }

  async commit(checkpoint: Checkpoint, message: string) {
    const changes = [...this.pending].filter(([path, change]) => checkpoint.changes.get(path) !== change);
    if (!changes.length) { this.removals = new Map(checkpoint.removals); return false; }
    const uploaded = new Map<string, string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sync();
      const base = this.current();
      for (const [path, version] of this.removals) {
        if (!checkpoint.removals.has(path) && this.directoryVersion(path) !== version) throw new GitHubChanged(path);
      }
      const tree: TreeChange[] = [];
      for (const [path, change] of changes) {
        const current = this.entries.get(path);
        const sha = change.blob ? await hash(change.blob) : null;
        if ((current?.sha ?? null) === sha && (!sha || current?.mode === change.mode)) continue;
        if ((current?.sha ?? null) !== change.expected || current?.mode !== change.expectedMode) throw new GitHubChanged(path);
        if (change.blob) {
          if (this.trackedDirectories.has(path) || (current && !supportedBlob(current))) throw new GitHubChanged(path);
          for (let folder = parent(path); folder; folder = parent(folder)) if (this.entries.has(folder)) throw new GitHubChanged(path);
        }
        if (change.blob && !uploaded.has(path)) uploaded.set(path, await this.api.createBlob(change.blob));
        tree.push({ path, mode: change.mode, type: change.type, sha: change.blob ? uploaded.get(path)! : null });
      }
      if (tree.length) {
        try {
          const published = await this.api.publish(base, tree, message);
          const entries = new Map(this.entries);
          for (const { path, mode, type, sha } of tree) {
            if (sha) entries.set(path, { path, mode, type, sha }); else entries.delete(path);
          }
          const snapshot = { ...published, entries: [...entries.values()] };
          this.install(snapshot);
          for (const [path, { blob }] of changes) {
            const sha = entries.get(path)?.sha;
            if (sha && blob) await storeBlob(this.id, sha, blob).catch(() => {});
          }
          await storeSnapshot(this.id, snapshot).catch(() => {});
        } catch (error) {
          if (!(error instanceof GitHubApiError && [409, 422].includes(error.status)) || await this.api.head() === base.head) throw error;
          continue;
        }
      }
      for (const [path] of changes) this.pending.delete(path);
      this.removals = new Map(checkpoint.removals);
      this.directoryIndex = undefined;
      return tree.length > 0;
    }
    throw new Error('The GitHub branch is changing quickly. Your changes are still available; try saving again.');
  }

  editBase(path: string) { return this.entries.get(path)?.sha ?? null; }
  draft(path: string) { return this.drafts.get(path); }
  async saveDraft(path: string, draft?: GitHubDraft) {
    const previous = this.drafts.get(path);
    if (draft) {
      if (previous?.content === draft.content && previous.base === draft.base) return;
      const next = { ...draft, id: crypto.randomUUID() };
      await storeDraft(this.id, path, next);
      this.drafts.set(path, next);
    } else if (previous) {
      await clearDraft(this.id, path, previous.id);
      this.drafts.delete(path);
    }
    this.directoryIndex = undefined;
  }

  async discardDrafts(path: string) {
    for (const draft of this.drafts.keys()) if (draft === path || draft.startsWith(path + '/')) await this.saveDraft(draft);
  }

  async reconcile(path: string, draft: GitHubDraft, resolve: ResolveGitHubConflict) {
    await this.sync();
    const base = this.editBase(path);
    if (base === await hash(draft.content)) return { base, content: draft.content, unchanged: true };
    if (base === draft.base) return { base, content: draft.content, unchanged: false };
    const upstream = base ? await this.blob(base) : null;
    const content = await resolve({ path, local: draft.content, upstream });
    if (content === undefined) throw new GitHubEditCancelled();
    return { base, content, unchanged: content === upstream };
  }
}

abstract class GitHubHandle {
  abstract readonly kind: 'file' | 'directory';
  constructor(readonly repository: GitHubRepository, readonly path: string) {}
  get name() { return this.path ? name(this.path) : this.repository.connection.repo; }
  async isSameEntry(other: LocalHandle) {
    return other instanceof GitHubHandle && this.repository.id === other.repository.id && this.path === other.path && this.kind === other.kind;
  }
  async queryPermission(): Promise<PermissionState> { return 'granted'; }
  async requestPermission(): Promise<PermissionState> { return 'granted'; }
}

export class GitHubFile extends GitHubHandle implements LocalFile {
  readonly kind = 'file';
  getFile() { return this.repository.file(this.path); }
  async createWritable() {
    const parts: BlobPart[] = [];
    const stream = new WritableStream<BlobPart>({
      write: (chunk) => { parts.push(chunk); },
      close: () => { this.repository.stage(this.path, new Blob(parts)); }
    });
    let writer: WritableStreamDefaultWriter<BlobPart> | undefined;
    const direct = () => writer ??= stream.getWriter();
    return Object.assign(stream, {
      write: (chunk: BlobPart) => direct().write(chunk),
      close: () => direct().close(),
      abort: (error?: unknown) => direct().abort(error)
    });
  }
}

export class GitHubDirectory extends GitHubHandle implements LocalDirectory {
  readonly kind = 'directory';
  async *values(): AsyncIterableIterator<LocalHandle> {
    for (const [name, kind] of this.repository.list(this.path)) {
      const child = key(this.path, name);
      yield kind === 'directory' ? new GitHubDirectory(this.repository, child) : new GitHubFile(this.repository, child);
    }
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const path = key(this.path, name);
    const kind = this.repository.list(this.path).get(name);
    if (kind === 'file' || this.repository.has(path)) throw wrongKind();
    if (!kind && !options?.create) throw missing();
    if (!kind) this.repository.createDirectory(path);
    return new GitHubDirectory(this.repository, path);
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    const path = key(this.path, name);
    const kind = this.repository.list(this.path).get(name);
    if (kind === 'directory') throw wrongKind();
    if (!kind && (this.repository.has(path) || (options?.create && name === keep))) throw new DOMException('This GitHub path is reserved or unsupported.', 'NotAllowedError');
    if (!kind && !options?.create) throw missing();
    if (!kind) this.repository.stage(path, new Blob());
    return new GitHubFile(this.repository, path);
  }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    this.repository.remove(key(this.path, name), options?.recursive ?? false);
  }
  async resolve(handle: LocalHandle) {
    if (!(handle instanceof GitHubHandle) || handle.repository.id !== this.repository.id) return null;
    if (handle.path === this.path) return [];
    if (this.path && !handle.path.startsWith(this.path + '/')) return null;
    return handle.path.slice(this.path ? this.path.length + 1 : 0).split('/');
  }
}
