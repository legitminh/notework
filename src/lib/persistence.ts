import { emptyWorkspace, Workspace, type Source, type WorkspaceData } from './workspace';
import { clearRepository } from './github/storage';
import { GitHubDirectory, GitHubRepository } from './github/repository';
import { isNativeApp, nativeDocuments, reviveNative } from './native-fs';
import type { LocalDirectory, LocalHandle } from './filesystem';

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('notework', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('close other Notework tabs to enable local storage.')); };
  });
}

type StoredSource = Omit<Source, 'handle'> & { handle?: Source['handle']; kind?: 'file' | 'directory' };
type StoredWorkspace = Omit<WorkspaceData, 'sources'> & { sources: StoredSource[] };

// Safari cannot structured-clone OPFS handles. Persist their locations instead.
function storedWorkspace(data: WorkspaceData): StoredWorkspace {
  return { ...data, sources: data.sources.map(({ handle, ...source }) =>
    source.storage !== 'local' && source.storage !== undefined ? { ...source, kind: handle.kind } : { ...source, handle }) };
}

export function snapshotWorkspace(data: WorkspaceData): WorkspaceData {
  const handles = data.sources.map((source) => source.handle);
  const metadata = structuredClone({ ...data, sources: data.sources.map(({ handle: _handle, ...source }) => source) });
  return { ...metadata, sources: metadata.sources.map((source, index) => ({ ...source, handle: handles[index], physicalParent: reviveNative(source.physicalParent) })) };
}

/** The path below the app's `documents` folder that an app storage URI names. */
function appPath(uri: string, protocol: 'opfs:' | 'native:') {
  const url = new URL(uri);
  const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (url.protocol !== protocol || url.hostname !== 'notework' || path[0] !== 'documents' || path.length < 2 ||
      path.some((part) => part === '.' || part === '..' || /[/\\\x00]/.test(part))) {
    throw new Error('invalid native storage location.');
  }
  return path.slice(1);
}

async function browserDocuments(create = false) {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle('notework', { create });
  return await app.getDirectoryHandle('documents', { create }) as unknown as LocalDirectory;
}

async function walk(documents: LocalDirectory, path: string[], kind?: 'file' | 'directory'): Promise<LocalHandle> {
  let folder = documents;
  for (const part of path.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
  const name = path.at(-1)!;
  if (kind === 'file') return folder.getFileHandle(name);
  if (kind === 'directory') return folder.getDirectoryHandle(name);
  try { return await folder.getFileHandle(name); }
  catch (error) {
    if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error;
    return folder.getDirectoryHandle(name);
  }
}

async function restoreSource(source: StoredSource): Promise<Source> {
  if (source.storage === 'github') {
    if (!source.github) throw new Error('missing GitHub connection.');
    return { ...source, handle: (await GitHubRepository.restore(source.id, source.github)).root };
  }
  const kind = source.kind ?? source.handle?.kind;
  if (source.storage === 'native') {
    // Stored as a location, not a path: the app's data folder can move (iOS app updates).
    const handle = await walk(await nativeDocuments(), appPath(source.uri!, 'native:'), kind);
    return { ...source, handle };
  }
  if (source.storage !== 'browser') {
    if (!source.handle) throw new Error('missing machine resource handle.');
    // Native app handles are stored as plain paths; browser handles clone as themselves.
    return { ...source, handle: reviveNative(source.handle), physicalParent: reviveNative(source.physicalParent) };
  }
  return { ...source, handle: await walk(await browserDocuments(), appPath(source.uri!, 'opfs:'), kind) };
}

async function copyInto(handle: LocalHandle, folder: LocalDirectory) {
  if (handle.kind === 'file') {
    const target = await folder.getFileHandle(handle.name, { create: true });
    const writer = await (target as unknown as FileSystemFileHandle).createWritable();
    await writer.write(await (await handle.getFile()).arrayBuffer());
    await writer.close();
    return;
  }
  const target = await folder.getDirectoryHandle(handle.name, { create: true });
  for await (const child of handle.values()) await copyInto(child, target);
}

/**
 * The native app keeps what the person creates at home in native storage on disk. Copy
 * documents an earlier version kept in the app's browser storage there, keeping each
 * source's id so every graph edge, link, and format still applies. Returns the browser
 * folders to remove once the new locations are saved; on any failure nothing changes.
 */
async function migrateBrowserStorage(data: StoredWorkspace): Promise<string[]> {
  const sources = data.sources.filter((source) => source.storage === 'browser' && source.uri);
  if (!sources.length) return [];
  try {
    const [from, to] = await Promise.all([browserDocuments(), nativeDocuments()]);
    const buckets = [...new Set(sources.map((source) => appPath(source.uri!, 'opfs:')[0]))];
    const copied: string[] = [];
    for (const bucket of buckets) {
      let folder: LocalDirectory;
      try { folder = await from.getDirectoryHandle(bucket); }
      catch (error) { if (error instanceof DOMException && error.name === 'NotFoundError') continue; throw error; }
      await copyInto(folder, to);
      copied.push(bucket);
    }
    for (const source of sources) {
      source.kind = source.kind ?? source.handle?.kind;
      delete source.handle;
      source.storage = 'native';
      source.uri = 'native:' + source.uri!.slice('opfs:'.length);
    }
    return copied;
  } catch {
    // Keep using browser storage this time; a later start retries.
    return [];
  }
}

export async function loadWorkspace(): Promise<WorkspaceData> {
  const db = await openDatabase();
  const data = await new Promise<StoredWorkspace>((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result ?? emptyWorkspace());
    request.onerror = () => reject(request.error);
  });
  const migrated = isNativeApp() ? await migrateBrowserStorage(data) : [];
  const sources: Source[] = [];
  for (const source of data.sources) {
    try { sources.push(await restoreSource(source)); }
    catch (error) {
      // Leave stale edges for Workspace to prune; never recreate a deleted file.
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
    }
  }
  const workspace = new Workspace({ ...data, sources });
  const removed = sources.filter((source) => !workspace.data.sources.includes(source));
  for (const source of removed) if (source.handle instanceof GitHubDirectory) {
    await source.handle.repository.disconnect();
    await clearRepository(source.id);
  }
  await saveWorkspace(workspace.data);
  if (migrated.length) {
    const documents = await browserDocuments().catch(() => undefined);
    for (const bucket of migrated) await documents?.removeEntry(bucket, { recursive: true }).catch(() => {});
  }
  return workspace.data;
}

export async function saveWorkspace(data: WorkspaceData): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(storedWorkspace(data), 'current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('local save was interrupted.'));
  });
}
