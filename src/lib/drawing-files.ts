import type { LocalFile } from './filesystem';
import { isMissing } from './filesystem';
import { nodeId, parentId, ROOT, type StateNode, type Storage, type Workspace } from './workspace';
import { assertAvailable, connectSibling, containingFolder, requireWrite, resolveFileReference, validFilename, wikiCatalog } from './wiki';
import { readDrawing, serializeDrawing, type Drawing } from './drawing';
import { writeResourceContent } from './resource-content';
import { saveWorkspace } from './persistence';
import { GitHubChanged, GitHubFile, type ResolveGitHubConflict } from './github/repository';

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
}

export async function loadDrawing(handle: LocalFile, storage: Storage): Promise<DrawingResource> {
  const file = await handle.getFile();
  const draft = handle instanceof GitHubFile ? handle.repository.draft(handle.path) : undefined;
  const githubBase = handle instanceof GitHubFile ? (draft ? draft.base : handle.repository.editBase(handle.path)) : undefined;
  return { handle, file, strokes: await readDrawing(file), storage, githubBase };
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

async function writeDrawing(handle: LocalFile, strokes: Drawing, storage: Storage) {
  await writeResourceContent(handle, storage, [serializeDrawing(strokes)]);
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

export async function commitDrawing(resource: DrawingResource, resolve: ResolveGitHubConflict) {
  if (!(resource.handle instanceof GitHubFile)) return resource;
  const { repository, path } = resource.handle;
  for (let attempt = 0; ; attempt++) {
    const draft = repository.draft(path);
    if (!draft) return resource;
    const chosen = await repository.reconcile(path, draft, resolve);
    if (!chosen.content) { await repository.saveDraft(path); return undefined; }
    const file = new File([chosen.content], resource.handle.name);
    const strokes = await readDrawing(file);
    await repository.saveDraft(path, { base: chosen.base, content: chosen.content, modified: Date.now() });
    const checkpoint = repository.checkpoint();
    try {
      if (!chosen.unchanged) repository.stage(path, chosen.content);
      await repository.commit(checkpoint, `edit: ${resource.handle.name}`);
    } catch (error) {
      repository.restore(checkpoint);
      if (error instanceof GitHubChanged && error.path === path && attempt < 2) continue;
      throw error;
    }
    await repository.saveDraft(path);
    return { ...resource, file: await resource.handle.getFile(), strokes, githubBase: repository.editBase(path) };
  }
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
  if (file instanceof GitHubFile) {
    if (!canCreateSiblingDrawing(name)) throw new Error('A new drawing must use an SVG filename without a folder path.');
    const { repository } = file;
    const folder = await containingFolder(workspace, source, file);
    await assertAvailable(folder, name);
    const path = [...source.path.slice(0, -1), name].join('/');
    const handle = new GitHubFile(repository, path);
    await repository.saveDraft(path, { base: null, content: new Blob([serializeDrawing(strokes)]), modified: Date.now() });
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
