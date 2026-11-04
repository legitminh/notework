import type { LocalFile, LocalHandle } from './filesystem';

export const supportsBrowserDocuments = () => typeof navigator !== 'undefined' &&
  window.isSecureContext && !!navigator.storage?.getDirectory;

export async function createBrowserDocument(name: string) {
  name = name.trim();
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new Error('Choose a document name without slashes or null characters.');
  const id = crypto.randomUUID();
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle('notework', { create: true });
  const documents = await app.getDirectoryHandle('documents', { create: true });
  const folder = await documents.getDirectoryHandle(id, { create: true });
  try {
    const handle = await folder.getFileHandle(name, { create: true });
    return {
      id, handle: handle as unknown as LocalFile,
      uri: `opfs://notework/documents/${id}/${encodeURIComponent(name)}`,
      storage: 'browser' as const,
      discard: () => documents.removeEntry(id, { recursive: true })
    };
  } catch (error) { await documents.removeEntry(id, { recursive: true }).catch(() => {}); throw error; }
}

/** Stream text or arbitrary binary chunks to app-owned OPFS only, never a machine file. */
export async function writeBrowserContent(handle: LocalFile, chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>) {
  const root = await navigator.storage.getDirectory();
  const native = handle as unknown as FileSystemFileHandle;
  const path = await root.resolve(native);
  if (!path || path[0] !== 'notework' || path[1] !== 'documents') throw new Error('Only app-created browser documents can be edited.');
  const writer = await native.createWritable();
  try {
    for await (const chunk of chunks) await writer.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    await writer.close();
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
}

export async function storageInfo() {
  const [estimate, persistent] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()]);
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persistent };
}

export function storageError(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return 'Browser storage is full. Export a backup or free space, then save again. Your current edits are still open.';
  return error instanceof Error ? error.message : 'Browser storage could not be accessed.';
}

/** Delete only resources inside Notework's own browser storage. */
export async function deleteBrowserResource(handle: LocalHandle) {
  const root = await navigator.storage.getDirectory();
  const path = await root.resolve(handle as unknown as FileSystemHandle);
  if (!path || path.length < 3 || path[0] !== 'notework' || path[1] !== 'documents') {
    throw new Error('Only resources in Notework’s browser storage can be deleted.');
  }
  let parent = root;
  for (const part of path.slice(0, -1)) parent = await parent.getDirectoryHandle(part);
  await parent.removeEntry(path.at(-1)!, { recursive: handle.kind === 'directory' });
}
