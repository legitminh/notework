import { isMissing, type LocalHandle } from './filesystem';
import { isDrawingFile } from './drawing';
import { HiddenResource, inspectText, type TextFormat } from './text-resource';

export const ROOT = 'root';
export interface Source {
  id: string;
  handle: LocalHandle;
  storage?: 'local' | 'browser';
  uri?: string;
  /** Legacy metadata used only to preserve existing drawing references. */
  drawingScope?: string;
  legacyDrawingScope?: string;
  /** Legacy virtual parenting is migrated to an ordinary directed link. */
  parent?: string;
}
export interface WorkspaceData {
  sources: Source[];
  rootIds: string[];
  links: Record<string, string[]>;
  hidden: Record<string, string[]>;
  formats?: Record<string, TextFormat>;
  wiki?: Record<string, Record<string, string>>;
}
export interface StateNode {
  id: string;
  sourceId: string;
  path: string[];
  name: string;
  kind: 'file' | 'directory';
  drawing?: boolean;
  storage: 'local' | 'browser';
  uri: string;
}
export const emptyWorkspace = (): WorkspaceData => ({ sources: [], rootIds: [], links: {}, hidden: {} });
export const nodeId = (sourceId: string, path: string[] = []) => JSON.stringify([sourceId, ...path]);
export const parentId = (node: StateNode) => node.path.length ? nodeId(node.sourceId, node.path.slice(0, -1)) : ROOT;

export class Workspace {
  readonly known = new Map<string, StateNode>();
  private handles = new Map<string, LocalHandle>();
  private drawings = new Set<string>();
  private formats = new Map<string, TextFormat>();
  readonly moving = new Set<string>();
  revision = 0;
  constructor(public data: WorkspaceData = emptyWorkspace()) {
    // Upgrade old handle-only records without inventing machine filesystem paths.
    for (const source of data.sources) {
      source.storage ??= 'local';
      source.uri ??= `notework-local://${source.id}/${encodeURIComponent(source.handle.name)}`;
      const owner = source.parent ?? source.drawingScope;
      if (owner) {
        const from = owner.startsWith('file:') ? owner.slice(5) : owner;
        try {
          const parts = from === ROOT ? [] : JSON.parse(from);
          if (Array.isArray(parts) && (from === ROOT || parts.length > 0) && parts.every((part) => typeof part === 'string')) this.link(from, nodeId(source.id));
        } catch { /* Ignore malformed legacy associations without changing their resources. */ }
      }
      if (source.drawingScope) source.legacyDrawingScope = source.drawingScope;
      delete source.drawingScope;
      delete source.parent;
    }
  }

  private remember(sourceId: string, path: string[], handle: LocalHandle): StateNode {
    const source = this.data.sources.find((source) => source.id === sourceId);
    if (!source) throw new DOMException('Resource is no longer in the graph.', 'NotFoundError');
    const node: StateNode = {
      id: nodeId(sourceId, path), sourceId, path, name: handle.name, kind: handle.kind,
      drawing: this.drawings.has(nodeId(sourceId, path)),
      storage: source.storage ?? 'local',
      uri: source.uri! + (path.length ? '/' + path.map(encodeURIComponent).join('/') : '')
    };
    this.known.set(node.id, node);
    this.handles.set(node.id, handle);
    return node;
  }

  async node(id: string): Promise<StateNode> {
    const [sourceId, ...path] = JSON.parse(id) as string[];
    const source = this.data.sources.find((source) => source.id === sourceId);
    if (!source) { this.forget(id); throw new DOMException('Resource is no longer in the graph.', 'NotFoundError'); }
    let handle = source.handle;
    try {
      for (const [i, name] of path.entries()) {
        if (handle.kind !== 'directory') throw new DOMException('The resource parent no longer exists as a folder.', 'NotFoundError');
        if (i < path.length - 1) {
          try { handle = await handle.getDirectoryHandle(name); }
          catch (error) {
            if (error instanceof DOMException && error.name === 'TypeMismatchError') throw new DOMException('The resource parent was replaced.', 'NotFoundError');
            throw error;
          }
        }
        else {
          try { handle = await handle.getDirectoryHandle(name); }
          catch (error) {
            if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error;
            handle = await handle.getFileHandle(name);
          }
        }
      }
      await this.validate(id, handle);
      return this.remember(sourceId, path, handle);
    } catch (error) {
      if (isMissing(error) && !this.moving.has(id)) this.forget(id);
      throw error;
    }
  }

  private async validate(id: string, handle: LocalHandle) {
    if (handle.kind === 'file') {
      if (handle.name.toLowerCase().endsWith('.svg') && await isDrawingFile(await handle.getFile())) {
        this.drawings.add(id);
        return;
      }
      this.drawings.delete(id);
      const format = await inspectText(handle, this.formats.get(id) ?? this.data.formats?.[id]);
      if (!format) { this.known.delete(id); this.handles.delete(id); throw new HiddenResource('Not a decodable text resource.'); }
      this.setFormat(id, format);
    } else {
      if (handle.name === '.git') { this.known.delete(id); this.handles.delete(id); throw new HiddenResource('Git metadata is hidden.'); }
      const iterator = handle.values();
      try { await iterator.next(); } finally { await iterator.return?.(); }
    }
  }

  format(id: string) { return this.formats.get(id); }
  setFormat(id: string, format: TextFormat) {
    this.formats.set(id, format);
    (this.data.formats ??= {})[id] = format;
  }

  /** Remove a missing resource, descendants, incoming/outgoing edges, and stale caches. */
  forget(id: string) {
    const [sourceId, ...path] = JSON.parse(id) as string[];
    const affected = (candidate: string) => {
      if (candidate === ROOT) return false;
      const [source, ...parts] = JSON.parse(candidate) as string[];
      return source === sourceId && path.every((part, index) => parts[index] === part);
    };
    if (!path.length) this.data.sources = this.data.sources.filter((source) => source.id !== sourceId);
    this.data.rootIds = this.data.rootIds.filter((target) => !affected(target));
    for (const table of [this.data.links, this.data.hidden]) {
      for (const from of Object.keys(table)) {
        if (affected(from)) delete table[from];
        else table[from] = table[from].filter((to) => !affected(to));
      }
    }
    for (const key of this.known.keys()) if (affected(key)) this.known.delete(key);
    for (const key of this.handles.keys()) if (affected(key)) this.handles.delete(key);
    for (const key of this.drawings) if (affected(key)) this.drawings.delete(key);
    for (const key of this.formats.keys()) if (affected(key)) this.formats.delete(key);
    for (const key of Object.keys(this.data.formats ?? {})) if (affected(key)) delete this.data.formats![key];
    for (const [from, targets] of Object.entries(this.data.wiki ?? {})) {
      if (affected(from)) delete this.data.wiki![from];
      else for (const [token, target] of Object.entries(targets)) if (affected(target)) delete targets[token];
    }
    this.revision++;
  }

  async pruneMissing() {
    const ids = new Set([...this.data.sources.map((source) => nodeId(source.id)), ...this.data.rootIds, ...Object.keys(this.data.links), ...Object.values(this.data.links).flat(), ...Object.keys(this.data.formats ?? {}), ...this.known.keys()]);
    for (const id of ids) {
      try { await this.node(id); }
      catch {
        // node() prunes confirmed missing resources. A lost permission is not deletion.
      }
    }
  }

  async handle(id: string): Promise<LocalHandle> {
    await this.node(id);
    return this.handles.get(id)!;
  }

  cachedHandle(id: string) { return this.handles.get(id); }

  async fileAliases(file: LocalHandle) {
    const aliases: StateNode[] = [];
    for (const [id, node] of this.known) {
      const handle = this.handles.get(id);
      if (handle?.kind === 'file' && node.name === file.name && await handle.isSameEntry(file).catch(() => false)) aliases.push(node);
    }
    return aliases;
  }

  replaceWikiLinks(from: string, targets: Record<string, string>) {
    const old = new Set(Object.values(this.data.wiki?.[from] ?? {}));
    const legacy = (this.data.links[from] ?? []).filter((id) => !old.has(id));
    this.data.links[from] = [...new Set([...legacy, ...Object.values(targets)])];
    (this.data.wiki ??= {})[from] = targets;
    this.revision++;
  }

  renameNode(node: StateNode, handle: LocalHandle) {
    const source = this.data.sources.find((item) => item.id === node.sourceId)!;
    const path = node.path.length ? [...node.path.slice(0, -1), handle.name] : [];
    if (!path.length) {
      source.handle = handle;
      source.uri = source.uri!.slice(0, source.uri!.lastIndexOf('/') + 1) + encodeURIComponent(handle.name);
    }
    const next = nodeId(node.sourceId, path);
    const remap = (id: string) => id === node.id ? next : id;
    this.data.rootIds = this.data.rootIds.map(remap);
    for (const key of ['links', 'hidden'] as const) {
      this.data[key] = Object.fromEntries(Object.entries(this.data[key]).map(([from, to]) => [remap(from), to.map(remap)]));
    }
    this.data.wiki = Object.fromEntries(Object.entries(this.data.wiki ?? {}).map(([from, targets]) =>
      [remap(from), Object.fromEntries(Object.entries(targets).map(([token, to]) => [token, remap(to)]))]));
    this.known.delete(node.id); this.handles.delete(node.id); this.formats.delete(node.id);
    if (this.data.formats) delete this.data.formats[node.id];
    this.revision++;
    return this.remember(node.sourceId, path, handle);
  }

  label(node: StateNode) {
    const source = this.data.sources.find((source) => source.id === node.sourceId);
    return [source?.handle.name, ...node.path].join('/');
  }

  async children(id: string): Promise<StateNode[]> {
    const node = await this.node(id);
    const handle = await this.handle(id);
    if (handle.kind !== 'directory') return [];
    const children: StateNode[] = [];
    for await (const child of handle.values()) {
      const path = [...node.path, child.name];
      const childId = nodeId(node.sourceId, path);
      try { await this.validate(childId, child); children.push(this.remember(node.sourceId, path, child)); }
      catch (error) {
        if (isMissing(error)) this.forget(childId);
        else if (!(error instanceof HiddenResource)) throw error;
      }
    }
    return children.sort((a, b) =>
      Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
      a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async reachable(id: string): Promise<{ nodes: StateNode[]; errors: string[] }> {
    const errors: string[] = [];
    const nodes = new Map<string, StateNode>();
    if (id !== ROOT) {
      try {
        for (const child of await this.children(id)) {
          if (!this.data.hidden[id]?.includes(child.id)) nodes.set(child.id, child);
        }
      } catch (error) { if (!(error instanceof HiddenResource) && !isMissing(error)) errors.push(error instanceof Error ? error.message : 'Cannot read folder.'); }
    }
    for (const target of id === ROOT ? this.data.rootIds : this.data.links[id] ?? []) {
      try { nodes.set(target, await this.node(target)); }
      catch (error) { if (!(error instanceof HiddenResource) && !isMissing(error)) errors.push(error instanceof Error ? error.message : 'Cannot read linked state.'); }
    }
    return { nodes: [...nodes.values()], errors };
  }

  async connect(handle: LocalHandle, from: string | null = ROOT, location?: { id: string; uri: string; storage: 'browser' }): Promise<StateNode> {
    let node: StateNode | undefined;
    // Canonicalize picker selections inside existing grants to prevent duplicate states/cycles.
    for (const source of this.data.sources) {
      try {
        if (await source.handle.isSameEntry(handle)) {
          node = this.remember(source.id, [], handle); break;
        }
        if (source.handle.kind === 'directory') {
          const path = await source.handle.resolve(handle);
          if (path !== null) { node = this.remember(source.id, path, handle); break; }
        }
      } catch { /* A revoked old grant must not prevent connecting a new source. */ }
    }
    if (!node) {
      const id = location?.id ?? crypto.randomUUID();
      this.data.sources.push({ id, handle, storage: location?.storage ?? 'local', uri: location?.uri ?? `notework-local://${id}/${encodeURIComponent(handle.name)}` });
      node = this.remember(id, [], handle);
    }
    if (from !== null) this.link(from, node.id);
    return node;
  }

  link(from: string, to: string) {
    if (from === to) return;
    const list = from === ROOT ? this.data.rootIds : (this.data.links[from] ??= []);
    if (!list.includes(to)) list.push(to);
    this.data.hidden[from] = (this.data.hidden[from] ?? []).filter((id) => id !== to);
  }

  unlink(from: string, to: string) {
    if (from === ROOT) this.data.rootIds = this.data.rootIds.filter((id) => id !== to);
    else this.data.links[from] = (this.data.links[from] ?? []).filter((id) => id !== to);
  }

  setChildVisible(from: string, to: string, visible: boolean) {
    const hidden = new Set(this.data.hidden[from] ?? []);
    if (visible) hidden.delete(to); else { hidden.add(to); this.unlink(from, to); }
    this.data.hidden[from] = [...hidden];
  }
}

export interface SearchProgress { visited: number; errors: number; limited: boolean }
export async function searchReachable(
  workspace: Workspace, from: string, query: string, signal: AbortSignal,
  onProgress: (results: StateNode[], progress: SearchProgress) => void, resultLimit = 1000
) {
  const queue = [from];
  const seen = new Set<string>();
  const results: StateNode[] = [];
  const progress: SearchProgress = { visited: 0, errors: 0, limited: false };
  const needle = query.trim().toLocaleLowerCase();
  for (let i = 0; i < queue.length; i++) {
    signal.throwIfAborted();
    const id = queue[i];
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > 20000 || results.length >= resultLimit) { progress.limited = true; break; }
    if (id !== ROOT) {
      try {
        const node = await workspace.node(id);
        if (node.kind === 'file' && workspace.label(node).toLocaleLowerCase().includes(needle)) results.push(node);
      } catch (error) { if (!(error instanceof HiddenResource) && !isMissing(error)) progress.errors++; continue; }
    }
    const reachable = await workspace.reachable(id);
    signal.throwIfAborted();
    progress.errors += reachable.errors.length;
    queue.push(...reachable.nodes.map((node) => node.id));
    progress.visited++;
    if (progress.visited % 25 === 0) {
      onProgress([...results], { ...progress });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  signal.throwIfAborted();
  onProgress(results, progress);
}
