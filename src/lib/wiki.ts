import { isMissing, type LocalDirectory, type LocalFile } from './filesystem';
import { ROOT, searchReachable, type StateNode, type Workspace } from './workspace';
import { decodedChunks, encodedChunks, inspectText } from './text-resource';
import { saveWorkspace } from './persistence';

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

export async function requireWrite(handle: FileSystemHandle | LocalFile) {
  const permission = handle as LocalFile;
  if (await permission.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Write permission was not granted.');
}

export async function assertAvailable(folder: FileSystemDirectoryHandle, name: string, except?: string) {
  for await (const entry of folder.values()) {
    if (entry.name !== except && fold(entry.name) === fold(name)) throw new Error(`An item named “${name}” already exists in this folder.`);
  }
}

export async function connectSibling(workspace: Workspace, source: StateNode, handle: LocalFile) {
  if (source.storage === 'browser') {
    return workspace.connect(handle, ROOT, {
      id: crypto.randomUUID(), storage: 'browser', uri: `${parentUri(source)}/${encodeURIComponent(handle.name)}`
    });
  }
  return workspace.connect(handle, null);
}

export async function prepareWikiSave(
  workspace: Workspace, source: StateNode, file: LocalFile, tokens: Set<string>, catalog: StateNode[],
  canCreate: (token: string) => boolean
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
      const references = workspace.data.wiki?.[source.id];
      const saved = references && Object.hasOwn(references, token) ? references[token] : undefined;
      let target = saved ? await workspace.node(saved).catch((error) => {
        if (!isMissing(error)) throw error;
      }) : undefined;
      const candidate = target ?? findWikiTarget(workspace, source, token, catalog);
      if (candidate && !target) {
        target = await workspace.node(candidate.id).catch((error) => {
          if (!isMissing(error)) throw error;
          return undefined;
        });
      }
      if (!target) {
        if (!canCreate(token)) continue;
        if (!validFilename(token)) throw new Error(`Cannot create “${token}”. Use a filename without a path or choose an existing file.`);
        if (!folder) {
          folder = await containingFolder(workspace, source, file);
          if (source.storage === 'local') await requireWrite(folder);
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

async function writeText(handle: LocalFile, text: string, format: NonNullable<Awaited<ReturnType<typeof inspectText>>>) {
  const writer = await nativeFile(handle).createWritable();
  try {
    for (const chunk of encodedChunks([text], format)) await writer.write(chunk);
    await writer.close();
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function renameWikiFile(workspace: Workspace, source: StateNode, file: LocalFile, name: string) {
  name = name.trim();
  if (!validFilename(name)) throw new Error('Enter a valid filename without a folder path.');
  if (name === source.name) return source;
  const folder = await containingFolder(workspace, source, file);
  if (source.storage === 'local') await requireWrite(folder);
  await assertAvailable(folder, name, source.name);
  const original = await file.getFile();
  const aliases = new Map((await workspace.fileAliases(file)).map((node) => [node.id, node]));
  aliases.set(source.id, source);

  const changes = new Map<string, Map<string, { token: string; target: string }>>();
  const files: { handle: LocalFile; name: string; storage: StateNode['storage']; replacements: Map<string, string> }[] = [];
  for (const [from, references] of Object.entries(workspace.data.wiki ?? {})) {
    const incoming = Object.entries(references).filter(([, target]) => aliases.has(target));
    if (!incoming.length) continue;
    const resource = await workspace.node(from);
    const handle = await workspace.handle(from);
    if (handle.kind !== 'file') continue;
    let entry: (typeof files)[number] | undefined;
    for (const known of files) {
      if (await known.handle.isSameEntry(handle)) { entry = known; break; }
    }
    if (!entry) {
      entry = { handle, name: resource.name, storage: resource.storage, replacements: new Map() };
      files.push(entry);
    }
    const mapping = new Map<string, { token: string; target: string }>();
    for (const [token, target] of incoming) {
      const last = token.lastIndexOf('/');
      const updated = last < 0 ? name : token.slice(0, last + 1) + (token.includes('://') ? encodeURIComponent(name) : name);
      mapping.set(token, { token: updated, target });
      entry.replacements.set(token, updated);
    }
    changes.set(from, mapping);
  }

  const backups = [];
  for (const { handle, name, storage, replacements } of files) {
    const format = await inspectText(handle);
    if (!format) throw new Error(`Cannot update links in “${name}”.`);
    const snapshot = await handle.getFile();
    let before = '';
    for await (const chunk of decodedChunks(snapshot, format)) before += chunk;
    const after = before.replace(wikiPattern, (raw, token: string) => {
      const replacement = replacements.get(token.trim());
      return replacement ? `[[${replacement}]]` : raw;
    });
    if (before === after) continue;
    if (storage === 'local') await requireWrite(handle);
    backups.push({ handle, before, after, format: { ...format, eol: '\n' as const } });
  }

  // Native rename preserves identity when available for browser files. Machine files
  // use copy-then-remove because browsers do not consistently expose native move.
  type Movable = FileSystemFileHandle & { move?: (name: string) => Promise<void> };
  const native = nativeFile(file) as Movable;
  const useMove = !!native.move && (source.storage === 'browser' || fold(name) === fold(source.name));
  if (!useMove && fold(name) === fold(source.name)) throw new Error('Rename to a different name first, then change its capitalization.');
  const completed: typeof backups = [];
  const renamedNodes = new Map<string, StateNode>();
  const previousWiki = structuredClone(workspace.data.wiki ?? {});
  let destinationCreated = false;
  let metadataSaved = false;
  for (const id of aliases.keys()) workspace.moving.add(id);
  try {
    const latest = await file.getFile();
    if (latest.lastModified !== original.lastModified || latest.size !== original.size) throw new Error('The file changed outside Notework. Retry the rename.');
    await assertAvailable(folder, name, source.name);
    if (useMove) {
      await native.move!(name);
      destinationCreated = true;
    } else {
      const destination = await folder.getFileHandle(name, { create: true });
      destinationCreated = true;
      await original.stream().pipeTo(await destination.createWritable());
    }
    const renamed = await folder.getFileHandle(name) as unknown as LocalFile;
    for (const node of aliases.values()) renamedNodes.set(node.id, workspace.renameNode(node, renamed));
    for (const item of backups) {
      const live = await item.handle.getFile();
      if (live.lastModified !== item.format.modified || live.size !== item.format.size) {
        throw new Error('A linking file changed outside Notework. Retry the rename.');
      }
      await writeText(item.handle, item.after, item.format);
      completed.push(item);
    }
    for (const [from, mapping] of changes) {
      const id = renamedNodes.get(from)?.id ?? from;
      const references = workspace.data.wiki![id];
      workspace.data.wiki![id] = Object.fromEntries(Object.entries(references).map(([token, target]) => {
        const replacement = mapping.get(token);
        return replacement ? [replacement.token, renamedNodes.get(replacement.target)!.id] : [token, target];
      }));
    }
    await saveWorkspace(workspace.data);
    metadataSaved = true;
    if (!useMove) {
      const latest = await file.getFile();
      if (latest.lastModified !== original.lastModified || latest.size !== original.size) throw new Error('The file changed outside Notework. Retry the rename.');
      // The original remains in place until the copy, backlinks, and graph are saved.
      await folder.removeEntry(source.name);
    }
    return renamedNodes.get(source.id)!;
  } catch (error) {
    let rollbackFailed = false;
    try {
      if (useMove && destinationCreated) {
        const destination = await folder.getFileHandle(name) as Movable;
        await destination.move!(source.name);
      }
      if (renamedNodes.size) {
        const originalHandle = await folder.getFileHandle(source.name) as unknown as LocalFile;
        for (const next of renamedNodes.values()) workspace.renameNode(next, originalHandle);
        workspace.data.wiki = previousWiki;
      }
      if (metadataSaved) await saveWorkspace(workspace.data);
    } catch { rollbackFailed = true; }
    for (const item of completed.reverse()) {
      try { await writeText(item.handle, item.before, item.format); }
      catch { rollbackFailed = true; }
    }
    if (!useMove && destinationCreated && !rollbackFailed) {
      try { await folder.removeEntry(name); }
      catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error('Rename could not be fully rolled back. Check the affected files before retrying.');
    throw error;
  } finally {
    for (const id of aliases.keys()) workspace.moving.delete(id);
  }
}
