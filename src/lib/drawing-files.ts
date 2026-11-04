import type { LocalFile } from './filesystem';
import { isMissing } from './filesystem';
import { nodeId, parentId, ROOT, type StateNode, type Workspace } from './workspace';
import { assertAvailable, connectSibling, containingFolder, validFilename } from './wiki';
import { readDrawing, serializeDrawing, type Drawing } from './drawing';
import { createBrowserDocument, writeBrowserContent } from './browser-documents';
import { saveWorkspace } from './persistence';

function drawingScope(source: StateNode) {
  const parent = parentId(source);
  return parent === ROOT ? `file:${source.id}` : parent;
}

function sidecar(workspace: Workspace, source: StateNode, name: string) {
  return workspace.data.sources.find((item) => item.drawingScope === drawingScope(source) && item.handle.name === name);
}

export interface DrawingResource {
  handle: LocalFile;
  strokes: Drawing;
  file: File;
}

export async function loadDrawing(handle: LocalFile): Promise<DrawingResource> {
  const file = await handle.getFile();
  return { handle, file, strokes: await readDrawing(file) };
}

export async function loadSiblingDrawing(workspace: Workspace, source: StateNode, file: LocalFile, name: string) {
  if (!validFilename(name) || !name.toLowerCase().endsWith('.svg')) throw new Error('A drawing must be an SVG filename in this folder.');
  if (source.storage === 'local') {
    const entry = sidecar(workspace, source, name);
    if (!entry) return;
    try { return await loadDrawing(await workspace.handle(nodeId(entry.id)) as LocalFile); }
    catch (error) { if (isMissing(error)) return; throw error; }
  }
  const folder = await containingFolder(workspace, source, file);
  try { return await loadDrawing(await folder.getFileHandle(name) as unknown as LocalFile); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function writeDrawing(handle: LocalFile, strokes: Drawing) {
  await writeBrowserContent(handle, [serializeDrawing(strokes)]);
}

export async function saveDrawing(resource: DrawingResource, strokes: Drawing) {
  const latest = await resource.handle.getFile();
  if (latest.lastModified !== resource.file.lastModified || latest.size !== resource.file.size) {
    throw new Error('The SVG changed outside the editor. Reopen it before saving.');
  }
  await writeDrawing(resource.handle, strokes);
  return { handle: resource.handle, file: await resource.handle.getFile(), strokes };
}

async function stageSibling(
  workspace: Workspace, source: StateNode, file: LocalFile, name: string, strokes: Drawing
) {
  if (!validFilename(name) || !name.toLowerCase().endsWith('.svg')) throw new Error('A drawing must be an SVG filename in this folder.');
  if (source.storage === 'local') {
    if (sidecar(workspace, source, name)) throw new Error('A drawing with that name already exists.');
    const document = await createBrowserDocument(name);
    let id: string | undefined;
    async function rollback() {
      await document.discard().catch(() => {});
      if (id) workspace.forget(id);
    }
    try {
      await writeDrawing(document.handle, strokes);
      id = (await workspace.connect(document.handle, null, { ...document, drawingScope: drawingScope(source) })).id;
      return { id, resource: { handle: document.handle, file: await document.handle.getFile(), strokes }, rollback };
    } catch (error) { await rollback(); throw error; }
  }
  const folder = await containingFolder(workspace, source, file);
  await assertAvailable(folder, name);
  const handle = await folder.getFileHandle(name, { create: true }) as unknown as LocalFile;
  let id: string | undefined;
  async function rollback() {
    await folder.removeEntry(name).catch(() => {});
    if (id) workspace.forget(id);
  }
  try {
    await writeDrawing(handle, strokes);
    id = (await connectSibling(workspace, source, handle)).id;
    return { id, resource: { handle, file: await handle.getFile(), strokes }, rollback };
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
      if (existing) targets[name] = source.storage === 'local'
        ? nodeId(sidecar(workspace, source, name)!.id)
        : (await connectSibling(workspace, source, existing.handle)).id;
      else if (canCreate(name)) {
        const item = await stageSibling(workspace, source, file, name, []);
        staged.push(item);
        targets[name] = item.id;
      }
    }
    return { targets, rollback };
  } catch (error) { await rollback(); throw error; }
}
