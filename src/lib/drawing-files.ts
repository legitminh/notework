import type { LocalFile } from './filesystem';
import { isMissing } from './filesystem';
import { nodeId, parentId, ROOT, type StateNode, type Workspace } from './workspace';
import { assertAvailable, connectSibling, containingFolder, requireWrite, resolveFileReference, validFilename, wikiCatalog } from './wiki';
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

export function canCreateSiblingDrawing(reference: string) {
  return validFilename(reference) && reference.toLowerCase().endsWith('.svg');
}

async function resolveDrawing(
  workspace: Workspace, source: StateNode, file: LocalFile, reference: string, catalog?: StateNode[]
): Promise<{ resource: DrawingResource; node?: StateNode } | undefined> {
  const files = catalog ?? await wikiCatalog(workspace, new AbortController().signal);
  const target = await resolveFileReference(workspace, source, reference, files);
  if (target) {
    const handle = await workspace.handle(target.id);
    if (handle.kind === 'file') return { resource: await loadDrawing(handle, target.storage), node: target };
  }
  // Older versions placed local drawings in OPFS. Keep those existing links readable.
  const entry = source.storage === 'local' && canCreateSiblingDrawing(reference) ? sidecar(workspace, source, reference) : undefined;
  if (entry) {
    try {
      const node = await workspace.node(nodeId(entry.id));
      return { resource: await loadDrawing(await workspace.handle(node.id) as LocalFile, entry.storage ?? 'browser'), node };
    }
    catch (error) { if (!isMissing(error)) throw error; }
  }
  if (!canCreateSiblingDrawing(reference)) return undefined;
  const folder = await containingFolder(workspace, source, file);
  try { return { resource: await loadDrawing(await folder.getFileHandle(reference) as unknown as LocalFile, source.storage) }; }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

export async function loadDrawingReference(
  workspace: Workspace, source: StateNode, file: LocalFile, reference: string, catalog?: StateNode[]
) {
  return (await resolveDrawing(workspace, source, file, reference, catalog))?.resource;
}

async function writeDrawing(handle: LocalFile, strokes: Drawing, storage: 'local' | 'browser') {
  await writeResourceContent(handle, storage, [serializeDrawing(strokes)]);
}

export async function saveDrawing(resource: DrawingResource, strokes: Drawing, requestWrite = true) {
  if (resource.storage === 'local') await requireWrite(resource.handle, requestWrite);
  const latest = await resource.handle.getFile();
  if (latest.lastModified !== resource.file.lastModified || latest.size !== resource.file.size) {
    throw new Error('The SVG changed outside the editor. Reopen it before saving.');
  }
  await writeDrawing(resource.handle, strokes, resource.storage);
  return { handle: resource.handle, file: await resource.handle.getFile(), strokes, storage: resource.storage };
}

async function stageSibling(
  workspace: Workspace, source: StateNode, file: LocalFile, name: string, strokes: Drawing, requestWrite = true
) {
  if (!canCreateSiblingDrawing(name)) throw new Error('A new drawing must use an SVG filename without a folder path.');
  const folder = await containingFolder(workspace, source, file);
  if (source.storage === 'local') await requireWrite(folder, requestWrite);
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
  workspace: Workspace, source: StateNode, file: LocalFile, name: string, strokes: Drawing, requestWrite = true
) {
  const staged = await stageSibling(workspace, source, file, name, strokes, requestWrite);
  try { await saveWorkspace(workspace.data); return staged.resource; }
  catch (error) { await staged.rollback(); throw error; }
}

export async function prepareSvgPages(
  workspace: Workspace, source: StateNode, file: LocalFile, names: Set<string>, canCreate: (name: string) => boolean,
  requestWrite = true, catalog?: StateNode[]
) {
  const targets: Record<string, string> = Object.create(null);
  const staged: Awaited<ReturnType<typeof stageSibling>>[] = [];
  async function rollback() {
    for (const item of staged.reverse()) await item.rollback();
  }
  try {
    for (const name of names) {
      const existing = await resolveDrawing(workspace, source, file, name, catalog);
      if (existing) targets[name] = existing.node?.id ?? (await connectSibling(workspace, source, existing.resource.handle)).id;
      else if (canCreate(name) && canCreateSiblingDrawing(name)) {
        const item = await stageSibling(workspace, source, file, name, [], requestWrite);
        staged.push(item);
        targets[name] = item.id;
      } else throw new Error(`Drawing resource “${name}” could not be found.`);
    }
    return { targets, rollback };
  } catch (error) { await rollback(); throw error; }
}
