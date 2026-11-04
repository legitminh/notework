import type { LocalFile, LocalHandle } from './filesystem';
import { assertAvailable, containingFolder, requireWrite, validFilename, wikiPattern } from './wiki';
import { decodedChunks, encodedChunks, inspectText, type TextFormat } from './text-resource';
import { saveWorkspace, snapshotWorkspace } from './persistence';
import { Workspace, nodeId, type StateNode } from './workspace';

const native = (handle: LocalHandle) => handle as unknown as FileSystemHandle;
const startsWith = (path: string[], prefix: string[]) => prefix.every((part, i) => path[i] === part);

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

export async function renameResource(workspace: Workspace, source: StateNode, name: string) {
  name = name.trim();
  if (!validFilename(name) || name.toLowerCase() === '.git') throw new Error('Enter a valid name without a folder path.');
  if (name === source.name) return { node: source, warning: '' };
  if (name.toLowerCase() === source.name.toLowerCase()) throw new Error('Rename to a different name first, then change its capitalization.');
  const original = await workspace.handle(source.id);
  const folder = await containingFolder(workspace, source, original as LocalFile);
  if (source.storage === 'local') await requireWrite(folder);
  await assertAvailable(folder, name);
  const previous = snapshotWorkspace(workspace.data);
  const next = new Workspace(snapshotWorkspace(workspace.data));
  const aliases = new Map<string, string[]>();
  for (const grant of previous.sources) {
    if (await grant.handle.isSameEntry(original)) aliases.set(grant.id, []);
    else if (original.kind === 'directory') {
      const path = await original.resolve(grant.handle).catch(() => null);
      if (path) aliases.set(grant.id, path);
    }
  }
  const remap = (id: string) => {
    if (id === 'root' || !source.path.length) return id;
    const [grant, ...path] = JSON.parse(id) as string[];
    return grant === source.sourceId && startsWith(path, source.path)
      ? nodeId(grant, [...source.path.slice(0, -1), name, ...path.slice(source.path.length)]) : id;
  };
  const ids = new Set([...workspace.known.keys(), ...previous.rootIds,
    ...Object.keys(previous.links), ...Object.values(previous.links).flat(),
    ...Object.keys(previous.wiki ?? {}), ...Object.values(previous.wiki ?? {}).flatMap(Object.values)]);
  for (const id of ids) workspace.moving.add(id);
  const snapshots: { handle: FileSystemFileHandle; size: number; modified: number }[] = [];
  const directories: { handle: FileSystemDirectoryHandle; names: string[] }[] = [];
  const backups: { handle: LocalFile; before: string; after: string; format: TextFormat }[] = [];
  let destinationCreated = false;
  let committed = false;
  let installed = false;
  try {
    async function copy(handle: FileSystemHandle, parent: FileSystemDirectoryHandle, filename: string) {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        snapshots.push({ handle: handle as FileSystemFileHandle, size: file.size, modified: file.lastModified });
        const target = await parent.getFileHandle(filename, { create: true });
        await file.stream().pipeTo(await target.createWritable());
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
    await assertAvailable(folder, name);
    destinationCreated = true;
    const destination = await copy(native(original), folder, name);
    const renamedUri = source.uri.slice(0, source.uri.lastIndexOf('/') + 1) + encodeURIComponent(name);
    for (const grant of next.data.sources) {
      const path = aliases.get(grant.id);
      if (path) {
        grant.handle = await at(destination, path) as unknown as LocalHandle;
        grant.uri = renamedUri + (path.length ? '/' + path.map(encodeURIComponent).join('/') : '');
      }
      if (grant.parent) grant.parent = remap(grant.parent);
      if (grant.drawingScope?.startsWith('[')) grant.drawingScope = remap(grant.drawingScope);
    }
    next.data.rootIds = next.data.rootIds.map(remap);
    for (const table of ['links', 'hidden'] as const) next.data[table] = Object.fromEntries(
      Object.entries(next.data[table]).map(([from, targets]) => [remap(from), targets.map(remap)]));
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
      next.data.wiki[remap(from)] = targets;
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
      }).replace(/^([ \t]*\\svgpage\[)([^\]\r\n]+)(\][ \t]*\r?)$/gm,
        (raw, prefix: string, token: string, suffix: string) => replacements.has(token) ? prefix + replacements.get(token) + suffix : raw);
      if (before === after) continue;
      const targetHandle = await next.handle(afterNode.id) as LocalFile;
      const outside = await handle.isSameEntry(targetHandle);
      if (afterNode.storage === 'local' && outside) await requireWrite(handle);
      // URI canonicalization deduplicates independently selected handles to one file.
      writes.set(afterNode.uri, { handle: targetHandle, before: pending?.before ?? before, after, format, outside });
    }
    for (const item of writes.values()) {
      if (item.outside) {
        const latest = await item.handle.getFile();
        if (latest.size !== item.format.size || latest.lastModified !== item.format.modified) throw new Error('A linking file changed outside Notework. Retry the rename.');
      }
      await writeText(item.handle, item.after, item.format);
      if (item.outside) backups.push(item);
    }
    for (const item of snapshots) {
      const latest = await item.handle.getFile();
      if (latest.size !== item.size || latest.lastModified !== item.modified) throw new Error('A resource changed outside Notework. Retry the rename.');
    }
    for (const item of directories) {
      const names: string[] = [];
      for await (const entry of item.handle.values()) names.push(entry.name);
      if (JSON.stringify(names.sort()) !== JSON.stringify(item.names)) throw new Error('The folder changed outside Notework. Retry the rename.');
    }
    await saveWorkspace(next.data);
    installed = true;
    workspace.data = next.data;
    // Drop cached handles to the old tree. Node reads rebuild them from new locations.
    workspace.known.clear();
    let warning = '';
    try { await folder.removeEntry(source.name, { recursive: source.kind === 'directory' }); }
    catch (error) {
      if (source.kind === 'file') throw error;
      warning = 'Renamed successfully, but the original could not be removed. Both copies were kept; remove the old copy after checking the new one.'; }
    committed = true;
    workspace.revision++;
    return { node: await workspace.node(remap(source.id)), warning };
  } catch (error) {
    if (!committed) {
      let rollbackFailed = false;
      for (const item of backups.reverse()) {
        try { await writeText(item.handle, item.before, item.format); } catch { rollbackFailed = true; }
      }
      if (installed) {
        try { await saveWorkspace(previous); } catch { rollbackFailed = true; }
        workspace.data = previous;
      }
      if (destinationCreated && !rollbackFailed) await folder.removeEntry(name, { recursive: true }).catch(() => {});
      if (rollbackFailed) throw new Error('Rename could not be fully rolled back. Both copies were kept. Check the affected files before retrying.');
    }
    throw error;
  } finally { for (const id of ids) workspace.moving.delete(id); }
}
