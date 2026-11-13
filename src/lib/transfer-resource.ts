import type { LocalFile, LocalHandle } from './filesystem';
import { assertAvailable, containingFolder, requireWrite, validFilename, wikiPattern } from './wiki';
import { decodedChunks, encodedChunks, inspectText, type TextFormat } from './text-resource';
import { saveWorkspace, snapshotWorkspace } from './persistence';
import { Workspace, ROOT, nodeId, type StateNode } from './workspace';
import { GitHubDirectory, GitHubFile, withGitHubRepositories, type GitHubRepository } from './github/repository';
import { GitHubWriteUncertain } from './github/api';
import { cleanFilename, invalidFilenameMessage } from './filenames';

const native = (handle: LocalHandle) => handle as unknown as FileSystemHandle;
const startsWith = (path: string[], prefix: string[]) => prefix.every((part, i) => path[i] === part);
const remote = (handle: unknown) => handle instanceof GitHubDirectory || handle instanceof GitHubFile;
const sameEntry = async (a: FileSystemHandle, b: FileSystemHandle) => remote(a) === remote(b) && await a.isSameEntry(b);
const resolveEntry = async (folder: FileSystemDirectoryHandle, handle: FileSystemHandle) =>
  remote(folder) === remote(handle) ? await folder.resolve(handle) : null;

async function at(root: FileSystemHandle, path: string[]): Promise<FileSystemHandle> {
  let handle = root;
  for (const name of path) {
    const directory = handle as FileSystemDirectoryHandle;
    try { handle = await directory.getDirectoryHandle(name); }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error;
      handle = await directory.getFileHandle(name);
    }
  }
  return handle;
}

async function writeText(handle: LocalFile, text: string, format: TextFormat) {
  const writer = await (native(handle) as FileSystemFileHandle).createWritable();
  try {
    for (const chunk of encodedChunks([text], { ...format, eol: '\n' })) await writer.write(chunk);
    await writer.close();
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
}

/** Copy, rebind graph references, then remove the original; shared by rename and relocate. */
export function transferResource(workspace: Workspace, source: StateNode, name: string, target?: StateNode | null) {
  return withGitHubRepositories([workspace.github(source.sourceId), target ? workspace.github(target.sourceId) : undefined],
    () => transferResourceInternal(workspace, source, name, target));
}
async function transferResourceInternal(workspace: Workspace, source: StateNode, name: string, target?: StateNode | null) {
  const relocating = target !== undefined;
  const sourceRepo = workspace.github(source.sourceId);
  const destinationRepo = relocating ? (target ? workspace.github(target.sourceId) : undefined) : sourceRepo;
  if (sourceRepo && !source.path.length) throw new Error('Manage the repository itself in GitHub settings.');
  sourceRepo?.assertTransferable(source.path.join('/'));
  if (!relocating) name = cleanFilename(name);
  if (!relocating && (!validFilename(name) || name.toLowerCase() === '.git')) throw new Error(invalidFilenameMessage(name));
  if (!relocating && name === source.name) return { node: source, warning: '', remap: (id: string) => id };
  if (!relocating && name.toLowerCase() === source.name.toLowerCase()) throw new Error('Rename to a different name first, then change its capitalization.');
  // Start permission requests in the explicit Rename/Choose/Yes gesture.
  const cachedParent = workspace.deletionParent(source);
  const selected = target ? workspace.cachedHandle(target.id) : undefined;
  if (target && (!selected || selected.kind !== 'directory')) throw new Error('Choose a folder as the destination.');
  await Promise.all([
    ...(source.storage === 'local' && cachedParent ? [requireWrite(cachedParent as unknown as FileSystemDirectoryHandle)] : []),
    ...(target?.storage === 'local' && selected ? [requireWrite(selected as unknown as FileSystemDirectoryHandle)] : [])
  ]);
  const original = await workspace.handle(source.id);
  const folder = cachedParent as unknown as FileSystemDirectoryHandle | undefined
    ?? await containingFolder(workspace, source, original as LocalFile);
  if (source.storage === 'local' && !cachedParent) await requireWrite(folder);
  const storage = relocating ? target?.storage ?? 'browser' : source.storage;
  let destinationFolder = folder;
  let destinationSource = source.sourceId;
  let destinationPath = source.path.length ? [...source.path.slice(0, -1), name] : [];
  let destinationUri = source.uri.slice(0, source.uri.lastIndexOf('/') + 1) + encodeURIComponent(name);
  let discardBucket: (() => Promise<void>) | undefined;
  if (relocating && target) {
    destinationFolder = await workspace.handle(target.id) as unknown as FileSystemDirectoryHandle;
    if (!await destinationFolder.isSameEntry(native(selected!))) throw new Error('The destination changed. Reopen it before relocating.');
    if (original.kind === 'directory' && await resolveEntry(native(original) as FileSystemDirectoryHandle, native(selected!)) !== null) {
      throw new Error('A folder cannot be relocated into itself or one of its subfolders.');
    }
    if (await sameEntry(folder, destinationFolder)) return { node: source, warning: '', remap: (id: string) => id };
    destinationSource = target.sourceId;
    destinationPath = [...target.path, name];
    destinationUri = target.uri + '/' + encodeURIComponent(name);
    if (storage === 'browser') {
      const path = await (await navigator.storage.getDirectory()).resolve(destinationFolder);
      if (!path || path[0] !== 'notework' || path[1] !== 'documents') throw new Error('Choose an app-owned browser folder.');
    }
  } else if (relocating) {
    if (!source.path.length && source.storage === 'browser' && workspace.data.rootIds.includes(source.id)) return { node: source, warning: '', remap: (id: string) => id };
    if ((await workspace.reachable(ROOT)).nodes.some((node) => node.id !== source.id && node.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`An item named “${name}” already exists at home.`);
    }
    const app = await (await navigator.storage.getDirectory()).getDirectoryHandle('notework', { create: true });
    const documents = await app.getDirectoryHandle('documents', { create: true });
    destinationSource = crypto.randomUUID();
    destinationPath = [];
    destinationFolder = await documents.getDirectoryHandle(destinationSource, { create: true });
    discardBucket = () => documents.removeEntry(destinationSource, { recursive: true });
    destinationUri = `opfs://notework/documents/${destinationSource}/${encodeURIComponent(name)}`;
  }
  await assertAvailable(destinationFolder, name);
  const previous = snapshotWorkspace(workspace.data);
  const next = new Workspace(snapshotWorkspace(workspace.data));
  const aliases = new Map<string, string[]>();
  for (const grant of previous.sources) {
    if (await sameEntry(native(grant.handle), native(original))) aliases.set(grant.id, []);
    else if (original.kind === 'directory') {
      const path = await resolveEntry(native(original) as FileSystemDirectoryHandle, native(grant.handle)).catch(() => null);
      if (path) aliases.set(grant.id, path);
    }
  }
  // A resource can also be reachable through a separately connected ancestor.
  const prefixes = new Map<string, { before: string[]; after: string[] }>([
    [source.sourceId, { before: source.path, after: [] }]
  ]);
  if (relocating) for (const grant of previous.sources) {
    const alias = aliases.get(grant.id);
    if (alias) prefixes.set(grant.id, { before: [], after: alias });
    else if (grant.handle.kind === 'directory') {
      const path = await resolveEntry(native(grant.handle) as FileSystemDirectoryHandle, native(original)).catch(() => null);
      if (path) prefixes.set(grant.id, { before: path, after: [] });
    }
  }
  const remap = (id: string) => {
    if (id === ROOT || (!relocating && !source.path.length)) return id;
    const [grant, ...path] = JSON.parse(id) as string[];
    const prefix = prefixes.get(grant);
    return prefix && startsWith(path, prefix.before)
      ? nodeId(destinationSource, [...destinationPath, ...prefix.after, ...path.slice(prefix.before.length)]) : id;
  };
  const ids = new Set([...workspace.known.keys(), ...previous.rootIds,
    ...Object.keys(previous.links), ...Object.values(previous.links).flat(),
    ...Object.keys(previous.hidden), ...Object.values(previous.hidden).flat(),
    ...Object.keys(previous.wiki ?? {}), ...Object.values(previous.wiki ?? {}).flatMap(Object.values)]);
  for (const id of ids) workspace.moving.add(id);
  const snapshots: { handle: FileSystemFileHandle; size: number; modified: number }[] = [];
  const directories: { handle: FileSystemDirectoryHandle; names: string[] }[] = [];
  const backups: { handle: LocalFile; before: string; after: string; format: TextFormat }[] = [];
  let destinationCreated = false;
  let committed = false;
  let installed = false;
  let published = false;
  const repositories = workspace.data.sources.flatMap((source) => workspace.github(source.id) ?? []);
  const checkpoints = new Map(repositories.map((repository) => [repository, repository.checkpoint()]));
  const publish = async (repository: GitHubRepository) => {
    if (await repository.commit(checkpoints.get(repository)!, `${relocating ? 'move' : 'rename'}: ${source.name}`)) published = true;
  };
  try {
    async function copy(handle: FileSystemHandle, parent: FileSystemDirectoryHandle, filename: string) {
      if (destinationRepo && filename.toLowerCase() === '.git') throw new Error('A folder containing .git metadata cannot be moved into GitHub.');
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        snapshots.push({ handle: handle as FileSystemFileHandle, size: file.size, modified: file.lastModified });
        const target = await parent.getFileHandle(filename, { create: true });
        if (target instanceof GitHubFile && handle instanceof GitHubFile) {
          target.repository.stage(target.path, file, handle.repository.entryMode(handle.path));
        } else await file.stream().pipeTo(await target.createWritable());
        return target;
      }
      const target = await parent.getDirectoryHandle(filename, { create: true });
      const names: string[] = [];
      for await (const entry of (handle as FileSystemDirectoryHandle).values()) {
        names.push(entry.name);
        await copy(entry, target, entry.name);
      }
      directories.push({ handle: handle as FileSystemDirectoryHandle, names: names.sort() });
      return target;
    }
    // Keep the original tree intact until its replacement and backlinks are saved.
    await assertAvailable(destinationFolder, name);
    destinationCreated = true;
    const destination = await copy(native(original), destinationFolder, name);
    if (relocating && !target) next.data.sources.push({ id: destinationSource, handle: destination as unknown as LocalHandle, storage, uri: destinationUri });
    for (const grant of next.data.sources) {
      const path = aliases.get(grant.id);
      if (path) {
        grant.handle = await at(destination, path) as unknown as LocalHandle;
        grant.uri = destinationUri + (path.length ? '/' + path.map(encodeURIComponent).join('/') : '');
        grant.storage = storage;
        if (storage === 'local') grant.physicalParent = await at(destinationFolder, [name, ...path].slice(0, -1)) as unknown as typeof grant.physicalParent;
        else delete grant.physicalParent;
      }
      if (grant.legacyDrawingScope?.startsWith('[')) grant.legacyDrawingScope = remap(grant.legacyDrawingScope);
      else if (grant.legacyDrawingScope?.startsWith('file:')) grant.legacyDrawingScope = 'file:' + remap(grant.legacyDrawingScope.slice(5));
    }
    if (relocating) next.data.sources = next.data.sources.filter((grant) => !aliases.has(grant.id));
    next.data.rootIds = [...new Set(next.data.rootIds.filter((id) => !relocating || id !== source.id).map(remap))];
    if (relocating && !target) next.link(ROOT, remap(source.id));
    for (const table of ['links', 'hidden'] as const) {
      const mapped: Record<string, string[]> = {};
      for (const [from, targets] of Object.entries(next.data[table])) mapped[remap(from)] = [...new Set([...(mapped[remap(from)] ?? []), ...targets.map(remap)])];
      next.data[table] = mapped;
    }
    next.data.formats = Object.fromEntries(Object.entries(next.data.formats ?? {}).map(([id, format]) => [remap(id), format]));
    next.data.wiki = {};
    const writes = new Map<string, { handle: LocalFile; before: string; after: string; format: TextFormat; outside: boolean }>();
    for (const [from, references] of Object.entries(previous.wiki ?? {})) {
      const replacements = new Map<string, string>();
      const targets: Record<string, string> = Object.create(null);
      for (const [token, target] of Object.entries(references)) {
        const oldTarget = await workspace.node(target);
        const newTarget = await next.node(remap(target));
        const updated = token === oldTarget.uri ? newTarget.uri : token === oldTarget.name ? newTarget.name : next.label(newTarget);
        targets[updated] = remap(target);
        if (token !== updated) replacements.set(token, updated);
      }
      next.data.wiki[remap(from)] = { ...next.data.wiki[remap(from)], ...targets };
      if (!replacements.size) continue;
      const handle = await workspace.handle(from);
      if (handle.kind !== 'file') continue;
      const format = await inspectText(handle);
      if (!format) throw new Error('A linking file cannot be updated as text.');
      let before = '';
      for await (const chunk of decodedChunks(await handle.getFile(), format)) before += chunk;
      const afterNode = await next.node(remap(from));
      const pending = writes.get(afterNode.uri);
      const after = (pending?.after ?? before).replace(wikiPattern, (raw, token: string) => {
        const updated = replacements.get(token.trim());
        return updated ? `[[${updated}]]` : raw;
      }).replace(/^([ \t]*\\(?:svg|png|jpeg|heic|ora)page\[)([^\]\r\n]+)(\][ \t]*\r?)$/gm,
        (raw, prefix: string, token: string, suffix: string) => replacements.has(token) ? prefix + replacements.get(token) + suffix : raw);
      if (before === after) continue;
      const targetHandle = await next.handle(afterNode.id) as LocalFile;
      const outside = await sameEntry(native(handle), native(targetHandle));
      if (outside && targetHandle instanceof GitHubFile) targetHandle.repository.assertTransferable(targetHandle.path);
      if (afterNode.storage === 'local' && outside) await requireWrite(handle);
      // URI canonicalization deduplicates independently selected handles to one file.
      writes.set(afterNode.uri, { handle: targetHandle, before: pending?.before ?? before, after, format, outside });
    }
    for (const item of writes.values()) {
      if (item.outside) {
        const latest = await item.handle.getFile();
        if (latest.size !== item.format.size || latest.lastModified !== item.format.modified) throw new Error('A linking file changed outside Notework. Retry the operation.');
      }
      await writeText(item.handle, item.after, item.format);
      if (item.outside) backups.push(item);
    }
    for (const item of snapshots) {
      const latest = await item.handle.getFile();
      if (latest.size !== item.size || latest.lastModified !== item.modified) throw new Error('A resource changed outside Notework. Retry the operation.');
    }
    for (const item of directories) {
      const names: string[] = [];
      for await (const entry of item.handle.values()) names.push(entry.name);
      if (JSON.stringify(names.sort()) !== JSON.stringify(item.names)) throw new Error('The folder changed outside Notework. Retry the operation.');
    }
    if (!await (await at(folder, [source.name])).isSameEntry(native(original))) throw new Error('The original was replaced. Reopen it before retrying.');
    await saveWorkspace(next.data);
    installed = true;
    workspace.data = next.data;
    // Drop cached handles to the old tree. Node reads rebuild them from new locations.
    workspace.clearCaches();
    let warning = '';
    if (sourceRepo) await folder.removeEntry(source.name, { recursive: source.kind === 'directory' });
    // Publish the destination and backlink changes before removing an original
    // in a different location. Within one repository the move is one commit.
    if (destinationRepo) await publish(destinationRepo);
    for (const repository of repositories) if (repository !== destinationRepo && repository !== sourceRepo) await publish(repository);
    if (sourceRepo && sourceRepo !== destinationRepo) await publish(sourceRepo);
    try { if (!sourceRepo) await folder.removeEntry(source.name, { recursive: source.kind === 'directory' }); }
    catch (error) {
      if (source.kind === 'file' && !published) throw error;
      warning = `${relocating ? 'Relocated' : 'Renamed'} successfully, but the original could not be removed. Both copies were kept; remove the old copy after checking the new one.`; }
    committed = true;
    workspace.revision++;
    return { node: await workspace.node(remap(source.id)), warning, remap };
  } catch (error) {
    for (const [repository, checkpoint] of checkpoints) repository.restore(checkpoint);
    if (published || error instanceof GitHubWriteUncertain) {
      throw new Error(`${error instanceof Error ? error.message + ' ' : ''}Notework kept the destination copy because part of the move may already be on GitHub.`);
    }
    if (!committed) {
      let rollbackFailed = false;
      for (const item of backups.reverse()) {
        if (item.handle instanceof GitHubFile) continue;
        try { await writeText(item.handle, item.before, item.format); } catch { rollbackFailed = true; }
      }
      if (installed) {
        try { await saveWorkspace(previous); } catch { rollbackFailed = true; }
        workspace.data = previous;
        workspace.clearCaches();
      }
      if (destinationCreated && !destinationRepo && !rollbackFailed) await destinationFolder.removeEntry(name, { recursive: true }).catch(() => {});
      if (!rollbackFailed) await discardBucket?.().catch(() => {});
      if (rollbackFailed) throw new Error(`${relocating ? 'Relocation' : 'Rename'} could not be fully rolled back. Both copies were kept. Check the affected files before retrying.`);
    }
    throw error;
  } finally { for (const id of ids) workspace.moving.delete(id); }
}
