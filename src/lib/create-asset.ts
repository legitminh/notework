import { assetName, validAssetName, type AssetType } from './asset-types';
import { writeResourceContent } from './resource-content';
import type { LocalFile, LocalHandle } from './filesystem';
import { saveWorkspace } from './persistence';
import { ROOT, nodeId, type StateNode, type Workspace } from './workspace';
import { requireWrite } from './wiki';

export async function createAsset(workspace: Workspace, parent: StateNode | null, input: string, type: AssetType) {
  const name = assetName(input, type);
  if (!validAssetName(input.trim()) || !validAssetName(name)) throw new Error('Choose a name without slashes or control characters. “.”, “..”, and “.git” are reserved.');
  const selected = parent ? workspace.cachedHandle(parent.id) : undefined;
  if (parent?.storage === 'local') {
    if (!selected || selected.kind !== 'directory') throw new Error('Reopen the selected folder before creating an item.');
    // Request permission before any asynchronous directory traversal consumes the user gesture.
    await requireWrite(selected as unknown as FileSystemDirectoryHandle);
  }
  if (parent && (await workspace.node(parent.id)).kind !== 'directory') throw new Error('Create assets inside a folder.');
  if (!parent) {
    const existing = (await workspace.reachable(ROOT)).nodes;
    if (existing.some((node) => node.name.toLowerCase() === name.toLowerCase())) throw new Error('An item with this name already exists.');
  }

  let directory: FileSystemDirectoryHandle;
  let location: { id: string; uri: string; storage: 'browser' } | undefined;
  let discardBucket: (() => Promise<void>) | undefined;
  if (parent) {
    directory = await workspace.handle(parent.id) as unknown as FileSystemDirectoryHandle;
    if (parent.storage === 'browser') {
      const path = await (await navigator.storage.getDirectory()).resolve(directory);
      if (!path || path[0] !== 'notework' || path[1] !== 'documents') throw new Error('Only app-owned browser folders can be changed.');
    } else if (!await directory.isSameEntry(selected as unknown as FileSystemDirectoryHandle)) {
      throw new Error('The folder changed outside Notework. Reopen it before creating an item.');
    }
  } else {
    // Root has no backing folder; new root resources use app-owned browser storage.
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework', { create: true });
    const documents = await app.getDirectoryHandle('documents', { create: true });
    const id = crypto.randomUUID();
    directory = await documents.getDirectoryHandle(id, { create: true });
    discardBucket = () => documents.removeEntry(id, { recursive: true });
    location = { id, uri: `opfs://notework/documents/${id}/${encodeURIComponent(name)}`, storage: 'browser' };
  }
  let created = false;
  let createdId: string | undefined;
  const repository = parent && workspace.github(parent.sourceId);
  const checkpoint = repository?.checkpoint();
  try {
    // Check hidden resources too. Never open an existing file for writing.
    for await (const entry of directory.values()) {
      if (entry.name.toLowerCase() === name.toLowerCase()) throw new Error('An item with this name already exists.');
    }
    const handle: FileSystemHandle = type.kind === 'directory'
      ? await directory.getDirectoryHandle(name, { create: true })
      : await directory.getFileHandle(name, { create: true });
    created = true;
    if (type.kind === 'file') await writeResourceContent(handle as unknown as LocalFile, parent?.storage ?? 'browser', [type.initialContent?.() ?? '']);
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
