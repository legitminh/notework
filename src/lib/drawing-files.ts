import { imageFormat, readImage, composite, canvasBlob, encodeImage, blankImage, type ImageDocument } from './images';
import type { LocalFile } from './filesystem';
import { isMissing } from './filesystem';
import { nodeId, parentId, ROOT, type StateNode, type Storage, type Workspace } from './workspace';
import { assertAvailable, connectSibling, containingFolder, requireWrite, resolveFileReference, validFilename, wikiCatalog } from './wiki';
import { readDrawing, serializeDrawing, type Drawing } from './drawing';
import { writeResourceContent } from './resource-content';
import { saveWorkspace } from './persistence';
import { GitHubFile } from './github/repository';

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
  storage: Storage;
  githubBase?: string | null;
  image?: ImageDocument;
  preview?: string;
}

export function hasDrawingDraft(resource?: DrawingResource) {
  return resource?.handle instanceof GitHubFile && !!resource.handle.repository.draft(resource.handle.path);
}

export async function loadDrawing(handle: LocalFile, storage: Storage): Promise<DrawingResource> {
  const file = await handle.getFile();
  const draft = handle instanceof GitHubFile ? handle.repository.draft(handle.path) : undefined;
  const githubBase = handle instanceof GitHubFile ? (draft ? draft.base : handle.repository.editBase(handle.path)) : undefined;
  if (imageFormat(file.name)) {
    const image = await readImage(file);
    const preview = await new Promise<string>(async (resolve, reject) => {
      try {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(await canvasBlob(await composite(image)));
      } catch (error) { reject(error); }
    });
    return { handle, file, strokes: [], storage, githubBase, image, preview };
  }
  return { handle, file, strokes: await readDrawing(file), storage, githubBase };
}

export function canCreateSiblingDrawing(reference: string) {
  return validFilename(reference) && (reference.toLowerCase().endsWith('.svg') || !!imageFormat(reference));
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

async function writeDrawing(handle: LocalFile, strokes: Drawing, storage: Storage) {
  const format = imageFormat(handle.name);
  await writeResourceContent(handle, storage, [format ? new Uint8Array(await (await blankImage(format)).arrayBuffer()) : serializeDrawing(strokes)]);
}

export async function saveDrawing(resource: DrawingResource, strokes: Drawing, requestWrite = true) {
  if (resource.handle instanceof GitHubFile) {
    const { repository, path } = resource.handle;
    const draft = repository.draft(path);
    await repository.saveDraft(path, { base: draft ? draft.base : resource.githubBase ?? null,
      content: new Blob([serializeDrawing(strokes)]), modified: Date.now() });
    return { ...resource, file: await resource.handle.getFile(), strokes };
  }
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
  if (!canCreateSiblingDrawing(name)) throw new Error('Choose a supported drawing filename without a folder path.');
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
    return { id, resource: await loadDrawing(handle, source.storage), rollback };
  } catch (error) { await rollback(); throw error; }
}

export async function saveSiblingDrawing(
  workspace: Workspace, source: StateNode, file: LocalFile, name: string, strokes: Drawing, requestWrite = true
) {
  if (file instanceof GitHubFile) {
    if (!canCreateSiblingDrawing(name)) throw new Error('Choose a supported drawing filename without a folder path.');
    const { repository } = file;
    const folder = await containingFolder(workspace, source, file);
    await assertAvailable(folder, name);
    const path = [...source.path.slice(0, -1), name].join('/');
    const handle = new GitHubFile(repository, path);
    await repository.saveDraft(path, { base: null, content: imageFormat(name) ? await blankImage(imageFormat(name)!) : new Blob([serializeDrawing(strokes)]), modified: Date.now() });
    return loadDrawing(handle, 'github');
  }
  const staged = await stageSibling(workspace, source, file, name, strokes, requestWrite);
  try { await saveWorkspace(workspace.data); return staged.resource; }
  catch (error) { await staged.rollback(); throw error; }
}

export async function prepareSvgPages(
  workspace: Workspace, source: StateNode, file: LocalFile, names: Set<string>, canCreate: (name: string) => boolean,
  requestWrite = true, catalog?: StateNode[], allowMissing = false
) {
  const targets: Record<string, string> = Object.create(null);
  const staged: Awaited<ReturnType<typeof stageSibling>>[] = [];
  async function rollback() {
    for (const item of staged.reverse()) await item.rollback();
  }
  try {
    for (const name of names) {
      let existing: Awaited<ReturnType<typeof resolveDrawing>>;
      try { existing = await resolveDrawing(workspace, source, file, name, catalog); }
      catch (error) { if (allowMissing) continue; throw error; }
      if (existing) targets[name] = existing.node?.id ?? (await connectSibling(workspace, source, existing.resource.handle)).id;
      else if (canCreate(name) && canCreateSiblingDrawing(name)) {
        const item = await stageSibling(workspace, source, file, name, [], requestWrite);
        staged.push(item);
        targets[name] = item.id;
      } else if (!allowMissing) throw new Error(`Drawing resource “${name}” could not be found.`);
    }
    return { targets, rollback };
  } catch (error) { await rollback(); throw error; }
}

export async function saveImage(resource: DrawingResource, image: ImageDocument, requestWrite: boolean) {
  if (resource.storage === 'local') await requireWrite(resource.handle, requestWrite);
  const content = await encodeImage(image, imageFormat(resource.handle.name)!);
  if (resource.handle instanceof GitHubFile) {
    const { repository, path } = resource.handle;
    const draft = repository.draft(path);
    await repository.saveDraft(path, { base: draft ? draft.base : resource.githubBase ?? null, content, modified: Date.now() });
  } else {
    const latest = await resource.handle.getFile();
    if (latest.size !== resource.file.size || latest.lastModified !== resource.file.lastModified) throw new Error('The image changed outside the editor. Reopen it before saving.');
    await writeResourceContent(resource.handle, resource.storage, [new Uint8Array(await content.arrayBuffer())]);
  }
  const blob = await canvasBlob(await composite(image));
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
  return { ...resource, file: await resource.handle.getFile(), image, preview };
}
