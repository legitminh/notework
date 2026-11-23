import { withGitHubRepositories } from './github/repository';
import { assetName, validAssetInput, type AssetType } from './asset-types';
import { writeResourceContent } from './resource-content';
import type { LocalFile, LocalHandle } from './filesystem';
import { saveWorkspace } from './persistence';
import { ROOT, nodeId, type AppLocation, type StateNode, type Workspace } from './workspace';
import { isNativeApp, nativeDocuments } from './native-fs';
import { requireWrite } from './wiki';

export function createAsset(workspace: Workspace, parent: StateNode | null, input: string, type: AssetType) {
  const repository = parent ? workspace.github(parent.sourceId) : undefined;
  return withGitHubRepositories([repository], () => createAssetInternal(workspace, parent, input, type));
}
async function createAssetInternal(workspace: Workspace, parent: StateNode | null, input: string, type: AssetType) {
  const name = assetName(input, type);
  if (!validAssetInput(input, type)) throw new Error('choose a name without slashes or control characters. each generated name must fit within 255 characters. “.”, “..”, and “.git” are reserved.');
  const selected = parent ? workspace.cachedHandle(parent.id) : undefined;
  if (parent?.storage === 'local') {
    if (!selected || selected.kind !== 'directory') throw new Error('reopen the selected folder before creating an item.');
    // Request permission before any asynchronous directory traversal consumes the user gesture.
    await requireWrite(selected as unknown as FileSystemDirectoryHandle);
  }
  if (parent && (await workspace.node(parent.id)).kind !== 'directory') throw new Error('create assets inside a folder.');
  if (!parent) {
    const existing = (await workspace.reachable(ROOT)).nodes;
    if (existing.some((node) => node.name.toLowerCase() === name.toLowerCase())) throw new Error('an item with this name already exists.');
  }

  let directory: FileSystemDirectoryHandle;
  let location: AppLocation | undefined;
  let discardBucket: (() => Promise<void>) | undefined;
  if (parent) {
    directory = await workspace.handle(parent.id) as unknown as FileSystemDirectoryHandle;
    if (parent.storage === 'browser') {
      const path = await (await navigator.storage.getDirectory()).resolve(directory);
      if (!path || path[0] !== 'notework' || path[1] !== 'documents') throw new Error('only app-owned browser folders can be changed.');
    } else if (!await directory.isSameEntry(selected as unknown as FileSystemDirectoryHandle)) {
      throw new Error('the folder changed outside Notework. reopen it before creating an item.');
    }
  } else {
    // Root has no backing folder; new root resources use native storage: the app's own
    // folder on disk in the native app, or app-owned browser storage (OPFS) in the PWA.
    const bucket = await appBucket();
    directory = bucket.directory;
    discardBucket = bucket.discard;
    location = bucket.location(name);
  }
  let created = false;
  let createdId: string | undefined;
  const repository = parent && workspace.github(parent.sourceId);
  const checkpoint = repository?.checkpoint();
  try {
    // Check hidden resources too. Never open an existing file for writing.
    for await (const entry of directory.values()) {
      if (entry.name.toLowerCase() === name.toLowerCase()) throw new Error('an item with this name already exists.');
    }
    const handle: FileSystemHandle = type.kind === 'directory'
      ? await directory.getDirectoryHandle(name, { create: true })
      : await directory.getFileHandle(name, { create: true });
    created = true;
    if (type.kind === 'directory' && type.initialFileName) {
      const file = await (handle as FileSystemDirectoryHandle).getFileHandle(type.initialFileName(name), { create: true });
      await writeResourceContent(file as unknown as LocalFile, parent?.storage ?? location!.storage, [type.initialFileContent?.() ?? '']);
    }
    if (type.kind === 'file') await writeResourceContent(handle as unknown as LocalFile, parent?.storage ?? location!.storage, [await type.initialContent?.() ?? '']);
    createdId = parent ? nodeId(parent.sourceId, [...parent.path, name])
      : (await workspace.connect(handle as unknown as LocalHandle, ROOT, location)).id;
    const node = await workspace.node(createdId);
    if (repository && checkpoint) await repository.commit(checkpoint, `create: ${name}`);
    await saveWorkspace(workspace.data);
    return node;
  } catch (error) {
    if (repository && checkpoint) repository.restore(checkpoint);
    else if (created) await directory.removeEntry(name, { recursive: true }).catch(() => {});
    await discardBucket?.().catch(() => {});
    if (createdId) workspace.forget(createdId);
    throw error;
  }
}

/**
 * A new, empty folder in native storage for one resource at home: the native app's
 * documents folder on disk, or app-owned OPFS in the PWA.
 */
export async function appBucket() {
  const id = crypto.randomUUID();
  if (isNativeApp()) {
    const documents = await nativeDocuments();
    const directory = await documents.getDirectoryHandle(id, { create: true }) as unknown as FileSystemDirectoryHandle;
    return {
      id, directory,
      discard: () => documents.removeEntry(id, { recursive: true }),
      location: (name: string): AppLocation => ({ id, uri: `native://notework/documents/${id}/${encodeURIComponent(name)}`, storage: 'native' })
    };
  }
  const root = await navigator.storage.getDirectory();
  // Ask once to keep native storage in the PWA; browsers may still decline.
  void navigator.storage.persist?.().catch(() => false);
  const app = await root.getDirectoryHandle('notework', { create: true });
  const documents = await app.getDirectoryHandle('documents', { create: true });
  const directory = await documents.getDirectoryHandle(id, { create: true });
  return {
    id, directory,
    discard: () => documents.removeEntry(id, { recursive: true }),
    location: (name: string): AppLocation => ({ id, uri: `opfs://notework/documents/${id}/${encodeURIComponent(name)}`, storage: 'browser' })
  };
}
