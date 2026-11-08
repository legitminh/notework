import { deleteBrowserResource } from './browser-documents';
import type { LocalHandle } from './filesystem';
import { requireWrite } from './wiki';
import type { StateNode, Workspace } from './workspace';

async function matchingChild(parent: FileSystemDirectoryHandle, node: StateNode, expected: LocalHandle) {
  const child = node.kind === 'directory'
    ? await parent.getDirectoryHandle(node.name)
    : await parent.getFileHandle(node.name);
  if (!await child.isSameEntry(expected as unknown as FileSystemHandle)) {
    throw new Error(`“${node.name}” was replaced before it could be deleted. Refresh the folder and try again.`);
  }
}

/** Delete the resource first. Callers prune graph metadata only after this resolves. */
export async function deleteResource(workspace: Workspace, node: StateNode) {
  const handle = workspace.cachedHandle(node.id);
  if (!handle) throw new Error('The resource must be reopened before it can be deleted.');
  if (node.storage === 'browser') {
    await deleteBrowserResource(handle);
    return;
  }
  const repository = workspace.github(node.sourceId);
  if (repository) {
    if (!node.path.length) throw new Error('Disconnect the repository in GitHub settings.');
    const checkpoint = repository.checkpoint();
    try {
      repository.remove(node.path.join('/'), node.kind === 'directory');
      await repository.commit(checkpoint, `delete: ${node.name}`);
      await repository.discardDrafts(node.path.join('/'));
    } catch (error) { repository.restore(checkpoint); throw error; }
    return;
  }

  const knownParent = workspace.deletionParent(node);
  if (knownParent) {
    const parent = knownParent as unknown as FileSystemDirectoryHandle;
    // This is the first awaited operation so the confirmation click can open
    // the browser's write-permission prompt.
    await requireWrite(parent, true);
    await matchingChild(parent, node, handle);
    await parent.removeEntry(node.name, { recursive: node.kind === 'directory' });
    return;
  }

  // Chromium also exposes direct handle removal. Feature-detect it for handles
  // obtained by drag/drop or older connections that did not retain a parent.
  if (handle.remove) {
    await requireWrite(handle, true);
    await handle.remove({ recursive: node.kind === 'directory' });
    return;
  }
  throw new Error('Reconnect this item through its containing folder before deleting it.');
}

export function canDeleteResource(workspace: Workspace, node: StateNode) {
  if (node.storage === 'github') return !!node.path.length;
  if (node.storage === 'browser' || workspace.deletionParent(node)) return true;
  return typeof workspace.cachedHandle(node.id)?.remove === 'function';
}
