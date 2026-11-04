import { emptyWorkspace, type Source, type WorkspaceData } from './workspace';

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('notework', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error('Close other Notework tabs to enable local storage.')); };
  });
}

type StoredSource = Omit<Source, 'handle'> & { handle?: Source['handle']; kind?: 'file' | 'directory' };
type StoredWorkspace = Omit<WorkspaceData, 'sources'> & { sources: StoredSource[] };

// Safari cannot structured-clone OPFS handles. Persist their locations instead.
function storedWorkspace(data: WorkspaceData): StoredWorkspace {
  return { ...data, sources: data.sources.map(({ handle, ...source }) =>
    source.storage === 'browser' ? { ...source, kind: handle.kind } : { ...source, handle }) };
}

export function snapshotWorkspace(data: WorkspaceData): WorkspaceData {
  const handles = data.sources.map((source) => source.handle);
  const metadata = structuredClone({ ...data, sources: data.sources.map(({ handle: _handle, ...source }) => source) });
  return { ...metadata, sources: metadata.sources.map((source, index) => ({ ...source, handle: handles[index] })) };
}

async function restoreSource(source: StoredSource): Promise<Source> {
  if (source.storage !== 'browser') {
    if (!source.handle) throw new Error('Missing machine resource handle.');
    return { ...source, handle: source.handle };
  }
  const uri = new URL(source.uri!);
  const path = uri.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (uri.protocol !== 'opfs:' || uri.hostname !== 'notework' || path[0] !== 'documents' || path.length < 2 ||
      path.some((part) => part === '.' || part === '..' || /[/\\\x00]/.test(part))) {
    throw new Error('Invalid browser resource location.');
  }
  let folder = await navigator.storage.getDirectory();
  folder = await folder.getDirectoryHandle('notework');
  for (const part of path.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
  const name = path.at(-1)!;
  let handle: FileSystemHandle;
  const kind = source.kind ?? source.handle?.kind;
  if (kind === 'file') handle = await folder.getFileHandle(name);
  else if (kind === 'directory') handle = await folder.getDirectoryHandle(name);
  else {
    try { handle = await folder.getFileHandle(name); }
    catch (error) {
      if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error;
      handle = await folder.getDirectoryHandle(name);
    }
  }
  return { ...source, handle: handle as unknown as Source['handle'] };
}

export async function loadWorkspace(): Promise<WorkspaceData> {
  const db = await openDatabase();
  const data = await new Promise<StoredWorkspace>((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('current');
    request.onsuccess = () => resolve(request.result ?? emptyWorkspace());
    request.onerror = () => reject(request.error);
  });
  const sources: Source[] = [];
  for (const source of data.sources) {
    try { sources.push(await restoreSource(source)); }
    catch (error) {
      // Leave stale edges for Workspace to prune; never recreate a deleted file.
      if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
    }
  }
  return { ...data, sources };
}

export async function saveWorkspace(data: WorkspaceData): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(storedWorkspace(data), 'current');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Local save was interrupted.'));
  });
}
