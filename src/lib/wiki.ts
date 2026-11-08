import { isMissing, type LocalDirectory, type LocalFile } from './filesystem';
import { ROOT, searchReachable, type StateNode, type Workspace } from './workspace';

export const wikiPattern = /\[\[([^\[\]\r\n]+)\]\]/g;
const fold = (value: string) => value.toLowerCase();
const nativeFile = (handle: LocalFile) => handle as unknown as FileSystemFileHandle;

export function validFilename(name: string) {
  return !!name && name.length <= 255 && !/[\/\\\[\]\x00-\x1f]/.test(name) && name !== '.' && name !== '..' && name !== '.git';
}

export function wikiTokens(lines: Iterable<string>) {
  const tokens = new Set<string>();
  for (const line of lines) for (const match of line.matchAll(wikiPattern)) {
    const token = match[1].trim();
    if (token) tokens.add(token);
  }
  return tokens;
}

export const parentUri = (node: StateNode) => node.uri.slice(0, node.uri.lastIndexOf('/'));

export async function wikiCatalog(workspace: Workspace, signal: AbortSignal) {
  let found: StateNode[] = [];
  await searchReachable(workspace, ROOT, '', signal, (results) => { found = results; }, 20000);
  return [...new Map([...found, ...workspace.known.values()].filter((node) => node.kind === 'file').map((node) => [node.id, node])).values()];
}

export function wikiToken(workspace: Workspace, source: StateNode, target: StateNode, catalog: StateNode[]) {
  if (parentUri(source) === parentUri(target)) return target.name;
  const path = workspace.label(target);
  return catalog.some((other) => other.id !== target.id &&
    (fold(workspace.label(other)) === fold(path) || fold(other.name) === fold(path))) ? target.uri : path;
}

export function findWikiTarget(workspace: Workspace, source: StateNode, token: string, catalog: StateNode[]) {
  const key = fold(token);
  const exact = catalog.find((node) => node.uri === token);
  if (exact) return exact;
  const siblings = catalog.filter((node) => parentUri(node) === parentUri(source) && fold(node.name) === key);
  const exactSibling = siblings.find((node) => node.name === token);
  if (exactSibling) return exactSibling;
  if (siblings.length === 1) return siblings[0];
  const matches = catalog.filter((node) => fold(node.name) === key || fold(workspace.label(node)) === key);
  const exactMatches = matches.filter((node) => node.name === token || workspace.label(node) === token);
  if (exactMatches.length === 1) return exactMatches[0];
  if (matches.length > 1 || siblings.length > 1) throw new Error(`“${token}” matches multiple files. Choose a target from the suggestions.`);
  return matches[0];
}

/** Resolve a saved or URI/path/name file reference without assuming physical parentage. */
export async function resolveFileReference(workspace: Workspace, source: StateNode, token: string, catalog: StateNode[]) {
  const references = workspace.data.wiki?.[source.id];
  const saved = references && Object.hasOwn(references, token) ? references[token] : undefined;
  let target = saved ? await workspace.node(saved).catch((error) => {
    if (!isMissing(error)) throw error;
    return undefined;
  }) : undefined;
  const candidate = target ?? findWikiTarget(workspace, source, token, catalog);
  if (candidate && !target) {
    target = await workspace.node(candidate.id).catch((error) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
  }
  return target?.kind === 'file' ? target : undefined;
}

export function wikiScore(query: string, name: string) {
  query = fold(query); name = fold(name);
  if (!query || name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  let offset = 0;
  for (const char of query) {
    const index = name.indexOf(char, offset);
    if (index < 0) return Infinity;
    offset = index + 1;
  }
  return 3 + offset - query.length;
}

export async function containingFolder(workspace: Workspace, node: StateNode, file: LocalFile) {
  if (node.storage === 'browser') {
    let directory = await navigator.storage.getDirectory();
    const path = await directory.resolve(nativeFile(file));
    if (!path || path[0] !== 'notework' || path[1] !== 'documents') throw new Error('The browser document is no longer in Notework storage.');
    for (const part of path.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
    return directory;
  }
  if (node.path.length) {
    const parent = await workspace.handle(JSON.stringify([node.sourceId, ...node.path.slice(0, -1)]));
    if (parent.kind === 'directory') return parent as unknown as FileSystemDirectoryHandle;
  }
  if (node.storage === 'github') throw new Error('Open the GitHub file through its repository folder.');
  for (const source of workspace.data.sources) {
    if (source.handle.kind !== 'directory') continue;
    const path = await source.handle.resolve(file).catch(() => null);
    if (!path?.length) continue;
    let folder: LocalDirectory = source.handle;
    for (const name of path.slice(0, -1)) folder = await folder.getDirectoryHandle(name);
    return folder as unknown as FileSystemDirectoryHandle;
  }
  throw new Error('Connect the file’s containing folder in App settings before creating a sibling or renaming this file.');
}

export class WritePermissionRequired extends Error {
  constructor() { super('Autosave is waiting for write permission. Exit the editor to save.'); }
}

export async function requireWrite(handle: FileSystemHandle | LocalFile, request = true) {
  const permission = handle as LocalFile;
  const state = request
    ? await permission.requestPermission({ mode: 'readwrite' })
    : await permission.queryPermission({ mode: 'readwrite' });
  if (state !== 'granted') {
    if (!request) throw new WritePermissionRequired();
    throw new Error('Write permission was not granted. Your edits are still open.');
  }
}

export async function assertAvailable(folder: FileSystemDirectoryHandle, name: string, except?: string) {
  for await (const entry of folder.values()) {
    if (entry.name !== except && fold(entry.name) === fold(name)) throw new Error(`An item named “${name}” already exists in this folder.`);
  }
}

export async function connectSibling(workspace: Workspace, source: StateNode, handle: LocalFile) {
  if (source.storage === 'browser') {
    const node = await workspace.connect(handle, null, {
      id: crypto.randomUUID(), storage: 'browser', uri: `${parentUri(source)}/${encodeURIComponent(handle.name)}`
    });
    if (!node.path.length) workspace.link(ROOT, node.id);
    return node;
  }
  return workspace.connect(handle, null);
}

export async function prepareWikiSave(
  workspace: Workspace, source: StateNode, file: LocalFile, tokens: Set<string>, catalog: StateNode[],
  canCreate: (token: string) => boolean, requestWrite = true, allowUnresolved = false
) {
  catalog = [...catalog];
  const targets: Record<string, string> = Object.create(null);
  const created: { node: StateNode; folder: FileSystemDirectoryHandle; name: string }[] = [];
  let folder: FileSystemDirectoryHandle | undefined;
  async function rollback() {
    for (const item of created.reverse()) {
      await item.folder.removeEntry(item.name).catch(() => {});
      workspace.forget(item.node.id);
    }
  }
  try {
    for (const token of tokens) {
      let target: StateNode | undefined;
      try { target = await resolveFileReference(workspace, source, token, catalog); }
      catch (error) { if (allowUnresolved) continue; throw error; }
      if (!target) {
        if (!canCreate(token)) continue;
        if (!validFilename(token)) throw new Error(`Cannot create “${token}”. Use a filename without a path or choose an existing file.`);
        if (!folder) {
          folder = await containingFolder(workspace, source, file);
          if (source.storage === 'local') await requireWrite(folder, requestWrite);
        }
        await assertAvailable(folder, token);
        const handle = await folder.getFileHandle(token, { create: true });
        let connected: StateNode;
        try {
          connected = await connectSibling(workspace, source, handle as unknown as LocalFile);
        } catch (error) {
          await folder.removeEntry(token).catch(() => {});
          throw error;
        }
        created.push({ node: connected, folder, name: token });
        catalog.push(connected);
        target = connected;
      }
      if (target.id !== source.id) {
        const resource = await workspace.handle(target.id);
        if (!await resource.isSameEntry(file).catch(() => false)) targets[token] = target.id;
      }
    }
    return { targets, rollback };
  } catch (error) { await rollback(); throw error; }
}
