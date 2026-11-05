import type { LocalFile } from './filesystem';
import { isMissing } from './filesystem';
import { nodeId, parentId, ROOT, type StateNode, type Workspace } from './workspace';
import { assertAvailable, connectSibling, containingFolder, requireWrite, validFilename } from './wiki';
import { readDrawing, serializeDrawing, type Drawing } from './drawing';
import { writeResourceContent } from './resource-content';
import { saveWorkspace } from './persistence';

function drawingScope(source: StateNode) {
  const parent = parentId(source);
  return parent === ROOT ? `file:${source.id}` : parent;
}

function sidecar(workspace: Workspace, source: StateNode, name: string) {
  return workspace.data.sources.find((item) => item.legacyDrawingScope === drawingScope(source) && item.handle.name === name);
}

export interface DrawingResource {
  handle: LocalFile;
  strokes: Drawing;
  file: File;
  storage: 'local' | 'browser';
}

export async function loadDrawing(handle: LocalFile, storage: 'local' | 'browser'): Promise<DrawingResource> {
  const file = await handle.getFile();
  return { handle, file, strokes: await readDrawing(file), storage };
}

export async function loadSiblingDrawing(workspace: Workspace, source: StateNode, file: LocalFile, name: string) {
  if (!validFilename(name) || !name.toLowerCase().endsWith('.svg')) throw new Error('A drawing must be an SVG filename in this folder.');
  const saved = workspace.data.wiki?.[source.id]?.[name];
  if (saved) {
    try {
      const node = await workspace.node(saved);
      const handle = await workspace.handle(saved);
      if (handle.kind === 'file') return loadDrawing(handle, node.storage);
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  // Older versions placed local drawings in OPFS. Keep those existing links readable.
  const entry = source.storage === 'local' ? sidecar(workspace, source, name) : undefined;
  if (entry) {
    try { return await loadDrawing(await workspace.handle(nodeId(entry.id)) as LocalFile, entry.storage ?? 'browser'); }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  const folder = await containingFolder(workspace, source, file);
  try { return await loadDrawing(await folder.getFileHandle(name) as unknown as LocalFile, source.storage); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function writeDrawing(handle: LocalFile, strokes: Drawing, storage: 'local' | 'browser') {
  await writeResourceContent(handle, storage, [serializeDrawing(strokes)]);
}

export async function saveDrawing(resource: DrawingResource, strokes: Drawing) {
  if (resource.storage === 'local') await requireWrite(resource.handle);
  const latest = await resource.handle.getFile();
  if (latest.lastModified !== resource.file.lastModified || latest.size !== resource.file.size) {
    throw new Error('The SVG changed outside the editor. Reopen it before saving.');
  }
  await writeDrawing(resource.handle, strokes, resource.storage);
  return { handle: resource.handle, file: await resource.handle.getFile(), strokes, storage: resource.storage };
}

async function stageSibling(
  workspace: Workspace, source: StateNode, file: LocalFile, name: string, strokes: Drawing
) {
  if (!validFilename(name) || !name.toLowerCase().endsWith('.svg')) throw new Error('A drawing must be an SVG filename in this folder.');
  const folder = await containingFolder(workspace, source, file);
  if (source.storage === 'local') await requireWrite(folder);
  await assertAvailable(folder, name);
  const handle = await folder.getFileHandle(name, { create: true }) as unknown as LocalFile;
  let id: string | undefined;
  async function rollback() {
    await folder.removeEntry(name).catch(() => {});
    if (id) workspace.forget(id);
  }
  try {
    await writeDrawing(handle, strokes, source.storage);
    id = (await connectSibling(workspace, source, handle)).id;
    return { id, resource: { handle, file: await handle.getFile(), strokes, storage: source.storage }, rollback };
  } catch (error) { await rollback(); throw error; }
}

export async function saveSiblingDrawing(
  workspace: Workspace, source: StateNode, file: LocalFile, name: string, strokes: Drawing
) {
  const staged = await stageSibling(workspace, source, file, name, strokes);
  try { await saveWorkspace(workspace.data); return staged.resource; }
  catch (error) { await staged.rollback(); throw error; }
}

export async function prepareSvgPages(
  workspace: Workspace, source: StateNode, file: LocalFile, names: Set<string>, canCreate: (name: string) => boolean
) {
  const targets: Record<string, string> = Object.create(null);
  const staged: Awaited<ReturnType<typeof stageSibling>>[] = [];
  async function rollback() {
    for (const item of staged.reverse()) await item.rollback();
  }
  try {
    for (const name of names) {
      const existing = await loadSiblingDrawing(workspace, source, file, name);
      if (existing) targets[name] = (await connectSibling(workspace, source, existing.handle)).id;
      else if (canCreate(name)) {
        const item = await stageSibling(workspace, source, file, name, []);
        staged.push(item);
        targets[name] = item.id;
      }
    }
    return { targets, rollback };
  } catch (error) { await rollback(); throw error; }
}
