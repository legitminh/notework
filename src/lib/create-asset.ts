import { assetName, validAssetName, type AssetType } from './asset-types';
import { writeBrowserContent } from './browser-documents';
import type { LocalFile, LocalHandle } from './filesystem';
import { saveWorkspace } from './persistence';
import { ROOT, type StateNode, type Workspace } from './workspace';

export async function createAsset(workspace: Workspace, parent: StateNode | null, input: string, type: AssetType) {
  const name = assetName(input, type);
  if (!validAssetName(input.trim()) || !validAssetName(name)) throw new Error('Choose a name without slashes or control characters. “.”, “..”, and “.git” are reserved.');
  if (parent && (await workspace.node(parent.id)).kind !== 'directory') throw new Error('Create assets inside a folder.');
  const existing = parent ? await workspace.children(parent.id) : (await workspace.reachable(ROOT)).nodes;
  if (existing.some((node) => node.name.toLowerCase() === name.toLowerCase())) throw new Error('An item with this name already exists.');

  let directory: FileSystemDirectoryHandle;
  let location: { id: string; uri: string; storage: 'browser'; parent?: string } | undefined;
  let discardBucket: (() => Promise<void>) | undefined;
  if (parent?.storage === 'browser') {
    directory = await workspace.handle(parent.id) as unknown as FileSystemDirectoryHandle;
    const path = await (await navigator.storage.getDirectory()).resolve(directory);
    if (!path || path[0] !== 'notework' || path[1] !== 'documents') throw new Error('Only app-owned browser folders can be changed.');
  } else {
    // Machine folders remain read-only. New resources are browser-backed children.
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework', { create: true });
    const documents = await app.getDirectoryHandle('documents', { create: true });
    const id = crypto.randomUUID();
    directory = await documents.getDirectoryHandle(id, { create: true });
    discardBucket = () => documents.removeEntry(id, { recursive: true });
    location = { id, uri: `opfs://notework/documents/${id}/${encodeURIComponent(name)}`, storage: 'browser', parent: parent?.id };
  }
  let created = false;
  let createdId: string | undefined;
  try {
    // Check hidden resources too. Never open an existing file for writing.
    for await (const entry of directory.values()) {
      if (entry.name.toLowerCase() === name.toLowerCase()) throw new Error('An item with this name already exists.');
    }
    const handle: FileSystemHandle = type.kind === 'directory'
      ? await directory.getDirectoryHandle(name, { create: true })
      : await directory.getFileHandle(name, { create: true });
    created = true;
    if (type.kind === 'file') await writeBrowserContent(handle as unknown as LocalFile, [type.initialContent?.() ?? '']);
    const connected = await workspace.connect(handle as unknown as LocalHandle, parent ? null : ROOT, location);
    createdId = connected.id;
    const node = await workspace.node(connected.id);
    await saveWorkspace(workspace.data);
    return node;
  } catch (error) {
    if (created) await directory.removeEntry(name, { recursive: true }).catch(() => {});
    await discardBucket?.().catch(() => {});
    if (createdId) workspace.forget(createdId);
    throw error;
  }
}
