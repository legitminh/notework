import {
  VisualEditor, defaultDocument, serializeDocument, parseBrush, serializeBrush, importBrush, brushFileName, kritaBasicFiles,
  encodePng, BRUSH_EXTENSION, VISUAL_EXTENSION, DEFAULT_BRUSH, DEFAULT_ERASER, type Brush
} from 'visual.editor';
import type { CanvasSize } from './canvas-size';
import type { LocalFile } from './filesystem';
import { isMissing } from './filesystem';
import { writeResourceContent } from './resource-content';
import { containingFolder, requireWrite, resolveFileReference, wikiCatalog } from './wiki';
import { nodeId, ROOT, type StateNode, type Storage, type Workspace } from './workspace';
import { GitHubDirectory, GitHubFile, gitBlobSha } from './github/repository';
import type { ImageDocument } from './images';

/**
 * Notework host for visual.editor documents. A visual document is a page folder: `name/name.visual`
 * is the plaintext organizer, and every layer is a sibling asset (PNG raster, SVG vector) that shows
 * up in the file tree. Brushes live in `app.asset/editor.visual/brushes` (browser storage at Home)
 * unless a document references brush files elsewhere.
 */
type Directory = FileSystemDirectoryHandle;

export const BRUSH_LIBRARY = 'app.asset/editor.visual/brushes';
const LIBRARY_PATH = BRUSH_LIBRARY.split('/');

export interface VisualContext {
  workspace: Workspace;
  /** The main `.visual` file's node (or the referencing note when the file is not in the graph yet). */
  node: StateNode;
  handle: LocalFile;
  folder: Directory;
  storage: Storage;
  /** GitHub paths saved as drafts since the last publish. */
  pendingGitHub: Set<string>;
  catalog?: Promise<StateNode[]>;
}

export const isVisualName = (name: string) => name.toLowerCase().endsWith(VISUAL_EXTENSION);
export const visualBase = (name: string) => name.replace(/\.visual$/i, '');

export async function visualContext(workspace: Workspace, node: StateNode, handle: LocalFile, folder?: Directory): Promise<VisualContext> {
  return { workspace, node, handle, storage: node.storage, pendingGitHub: new Set(),
    folder: folder ?? await containingFolder(workspace, node, handle) };
}

/** Walk a relative path (`a/b.png`) inside a folder. `..` is not allowed: layers stay inside their document. */
async function walk(folder: Directory, reference: string, create = false): Promise<FileSystemFileHandle | undefined> {
  const parts = reference.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) return undefined;
  let directory = folder;
  for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create });
  return directory.getFileHandle(parts.at(-1)!, { create });
}

const missingLike = (error: unknown) => isMissing(error) || error instanceof TypeError ||
  (error instanceof DOMException && ['TypeMismatchError', 'NotAllowedError'].includes(error.name));

/** Resolve a layer or brush reference: relative to the document folder, then the brush library, then the graph. */
export async function readReference(context: VisualContext, reference: string): Promise<Blob | undefined> {
  try { const handle = await walk(context.folder, reference); if (handle) return await handle.getFile(); }
  catch (error) { if (!missingLike(error)) throw error; }
  if (reference.startsWith(BRUSH_LIBRARY + '/')) {
    const blob = await readLibraryFile(context.workspace, reference.slice(BRUSH_LIBRARY.length + 1));
    if (blob) return blob;
  }
  try {
    context.catalog ??= wikiCatalog(context.workspace, new AbortController().signal);
    const target = await resolveFileReference(context.workspace, context.node, reference, await context.catalog);
    if (target) return await (await context.workspace.handle(target.id) as LocalFile).getFile();
  } catch (error) { if (!missingLike(error) && !(error instanceof Error && /matches multiple/.test(error.message))) throw error; }
  return undefined;
}

async function writeFile(context: VisualContext, name: string, data: string | Uint8Array) {
  if (context.folder instanceof GitHubDirectory || context.handle instanceof GitHubFile) {
    const folder = context.folder as unknown as GitHubDirectory, repository = folder.repository;
    const path = folder.path ? `${folder.path}/${name}` : name;
    const draft = repository.draft(path);
    let base: string | null = null;
    if (!draft && repository.has(path)) base = await gitBlobSha(await repository.file(path));
    const content = new Blob([data as BlobPart]);
    await repository.saveDraft(path, { base: draft ? draft.base : base, basedOn: draft?.basedOn, content, modified: Date.now() });
    context.pendingGitHub.add(path);
    return;
  }
  const handle = await walk(context.folder, name, true);
  if (!handle) throw new Error(`“${name}” is not a valid layer file name.`);
  await writeResourceContent(handle as unknown as LocalFile, context.storage, [data]);
}

// ------------------------------------------------------------------------------------------ brushes

export interface LibraryBrush { reference: string; file: string; brush: Brush }

async function appAssetFolder(workspace: Workspace, create: boolean): Promise<Directory | undefined> {
  for (const id of workspace.data.rootIds) {
    const node = await workspace.node(id).catch(() => undefined);
    if (node?.kind === 'directory' && node.name === LIBRARY_PATH[0]) return await workspace.handle(node.id) as unknown as Directory;
  }
  if (!create) return undefined;
  const [{ createAsset }, { assetTypes }] = await Promise.all([import('./create-asset'), import('./asset-types')]);
  const node = await createAsset(workspace, null, LIBRARY_PATH[0], assetTypes.find((type) => type.id === 'folder')!);
  return await workspace.handle(node.id) as unknown as Directory;
}

/** The brush folder, created and seeded with the Krita basic pack on first use. */
export async function brushFolder(workspace: Workspace, create = true): Promise<Directory | undefined> {
  const root = await appAssetFolder(workspace, create);
  if (!root) return undefined;
  try {
    let folder = root;
    for (const part of LIBRARY_PATH.slice(1)) folder = await folder.getDirectoryHandle(part, { create });
    let empty = true;
    for await (const _ of folder.values()) { empty = false; break; }
    if (empty && create) for (const file of kritaBasicFiles()) {
      const handle = await folder.getFileHandle(file.name, { create: true });
      await writeResourceContent(handle as unknown as LocalFile, 'browser', [file.text]);
    }
    return folder;
  } catch (error) { if (missingLike(error)) return undefined; throw error; }
}

async function readLibraryFile(workspace: Workspace, relative: string) {
  const folder = await brushFolder(workspace, false).catch(() => undefined);
  if (!folder) return undefined;
  try { return await (await walk(folder, relative))?.getFile(); } catch (error) { if (missingLike(error)) return undefined; throw error; }
}

export async function listLibraryBrushes(workspace: Workspace): Promise<LibraryBrush[]> {
  let folder: Directory | undefined;
  try { folder = await brushFolder(workspace, true); } catch { return []; }
  if (!folder) return [];
  const brushes: LibraryBrush[] = [];
  for await (const entry of folder.values()) {
    if (entry.kind !== 'file' || !entry.name.toLowerCase().endsWith(BRUSH_EXTENSION)) continue;
    try {
      const text = await (await (entry as FileSystemFileHandle).getFile()).text();
      brushes.push({ reference: `${BRUSH_LIBRARY}/${entry.name}`, file: entry.name, brush: parseBrush(text, entry.name.replace(/\.[^.]+$/, '')) });
    } catch { /* Skip unreadable brush files; they stay visible in the file tree. */ }
  }
  return brushes.sort((a, b) => a.brush.name.localeCompare(b.brush.name, undefined, { numeric: true }));
}

/** Convert a Krita/GIMP/MyPaint/visual brush file into the library. */
export async function importBrushFile(workspace: Workspace, file: File): Promise<LibraryBrush> {
  const brush = await importBrush(file.name, new Uint8Array(await file.arrayBuffer()));
  const folder = await brushFolder(workspace, true);
  if (!folder) throw new Error('The brush library could not be created.');
  const taken = new Set<string>();
  for await (const entry of folder.values()) taken.add(entry.name.toLowerCase());
  const base = brushFileName(brush.name).replace(/\.vbrush$/, '');
  let name = `${base}${BRUSH_EXTENSION}`;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}-${i}${BRUSH_EXTENSION}`;
  const handle = await folder.getFileHandle(name, { create: true });
  await writeResourceContent(handle as unknown as LocalFile, 'browser', [serializeBrush(brush)]);
  return { reference: `${BRUSH_LIBRARY}/${name}`, file: name, brush };
}

/** Write edited brush settings back to wherever the reference resolves. */
export async function saveBrush(context: VisualContext, reference: string, brush: Brush) {
  const text = serializeBrush(brush);
  if (reference.startsWith(BRUSH_LIBRARY + '/')) {
    const folder = await brushFolder(context.workspace, true);
    const handle = folder && await walk(folder, reference.slice(BRUSH_LIBRARY.length + 1), true);
    if (!handle) throw new Error('The brush file could not be written.');
    await writeResourceContent(handle as unknown as LocalFile, 'browser', [text]);
    return;
  }
  context.catalog ??= wikiCatalog(context.workspace, new AbortController().signal);
  const target = await resolveFileReference(context.workspace, context.node, reference, await context.catalog).catch(() => undefined);
  if (target) {
    const handle = await context.workspace.handle(target.id) as LocalFile;
    if (target.storage === 'local') await requireWrite(handle, true);
    await writeResourceContent(handle, target.storage, [text]);
  } else await writeFile(context, reference, text);
}

// ------------------------------------------------------------------------------------------ documents

export interface OpenedVisual { editor: VisualEditor; missingBrushes: string[]; library: LibraryBrush[] }

export async function openVisualDocument(context: VisualContext): Promise<OpenedVisual> {
  const text = await (await context.handle.getFile()).text();
  const existing: string[] = [];
  for await (const entry of context.folder.values()) existing.push(entry.name);
  const editor = await VisualEditor.open(text, { read: (reference) => readReference(context, reference) },
    { base: visualBase(context.handle.name), existing });
  const library = await listLibraryBrushes(context.workspace);
  for (const item of library) editor.addBrush(item.reference, item.brush, false);
  const missingBrushes: string[] = [];
  const references = new Set([...editor.doc.brushes, editor.state.brush, editor.state.eraser].filter((ref): ref is string => !!ref));
  for (const reference of references) {
    if (editor.brushes.has(reference)) { if (editor.doc.brushes.includes(reference)) editor.addBrush(reference, editor.brushes.get(reference)!, true); continue; }
    const blob = await readReference(context, reference).catch(() => undefined);
    try {
      if (!blob) throw new Error('missing');
      editor.addBrush(reference, parseBrush(await blob.text(), reference.replace(/^.*\//, '').replace(/\.[^.]+$/, '')), editor.doc.brushes.includes(reference));
    } catch { missingBrushes.push(reference); }
  }
  // A new document starts with the whole library as its brush palette and Krita's everyday defaults.
  if (!editor.doc.brushes.length) for (const item of library) editor.addBrush(item.reference, item.brush, true);
  const pick = (brush: Brush) => library.find((item) => item.brush.name === brush.name)?.reference;
  if (!editor.state.brush) editor.state.brush = pick(DEFAULT_BRUSH);
  if (!editor.state.eraser) editor.state.eraser = pick(DEFAULT_ERASER);
  return { editor, missingBrushes, library };
}

export async function saveVisualDocument(context: VisualContext, editor: VisualEditor, requestWrite: boolean) {
  if (context.storage === 'local') await requireWrite(context.folder, requestWrite);
  const result = await editor.save();
  for (const file of result.files) await writeFile(context, file.name, file.data);
  await writeFile(context, context.handle.name, result.main);
  editor.markSaved(result);
}

/** Queue GitHub commits for every file saved as a draft. The main file goes last. */
export async function publishVisualDocument(context: VisualContext, enqueue: (node: StateNode, file: GitHubFile) => Promise<void>) {
  if (!(context.folder instanceof GitHubDirectory)) return;
  const folder = context.folder, folderPath = folder.path;
  const paths = [...context.pendingGitHub].sort((a, b) => Number(isVisualName(a)) - Number(isVisualName(b)));
  for (const path of paths) {
    const relative = folderPath ? path.slice(folderPath.length + 1).split('/') : path.split('/');
    const id = nodeId(context.node.sourceId, [...context.node.path.slice(0, -1), ...relative]);
    const node = await context.workspace.node(id).catch(() => ({ ...context.node, id, name: relative.at(-1)!, path: [...context.node.path.slice(0, -1), ...relative] }));
    await enqueue(node, new GitHubFile(folder.repository, path));
    context.pendingGitHub.delete(path);
  }
}

/** Initial main-file text for a new document. Layer files are written by the first save. */
export function newVisualDocumentText(size: CanvasSize) {
  return serializeDocument(defaultDocument(size.width, size.height));
}

/** Create `name/name.visual` in a folder; returns the main file handle. */
export async function createVisualDocument(folder: Directory, name: string, size: CanvasSize, storage: Storage) {
  for await (const entry of folder.values()) if (entry.name.toLowerCase() === name.toLowerCase()) throw new Error(`An item named “${name}” already exists in this folder.`);
  const directory = await folder.getDirectoryHandle(name, { create: true });
  const main = await directory.getFileHandle(`${name}${VISUAL_EXTENSION}`, { create: true });
  await writeResourceContent(main as unknown as LocalFile, storage, [newVisualDocumentText(size)]);
  return { directory, main: main as unknown as LocalFile };
}

/** Flattened preview used by navigation, inline pages and export. */
export async function visualPreview(context: VisualContext): Promise<{ image: ImageDocument; preview: string }> {
  const text = await (await context.handle.getFile()).text();
  const editor = await VisualEditor.open(text, { read: (reference) => readReference(context, reference) }, { base: visualBase(context.handle.name) });
  return flattenToImage(editor);
}

export async function flattenToImage(editor: VisualEditor): Promise<{ image: ImageDocument; preview: string }> {
  const flat = editor.flatten(undefined, editor.doc.config.background);
  const png = new Blob([await encodePng(flat) as BlobPart], { type: 'image/png' });
  const preview = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result as string); reader.onerror = () => reject(reader.error); reader.readAsDataURL(png);
  });
  return { image: { width: editor.width, height: editor.height, layers: [{ name: 'Composite', png, visible: true, opacity: 1 }] }, preview };
}

export { ROOT };
