export interface HandleBase {
  name: string;
  kind: 'file' | 'directory';
  isSameEntry(other: LocalHandle): Promise<boolean>;
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  /** Direct removal is newer and not available in every File System Access implementation. */
  remove?(options?: { recursive?: boolean }): Promise<void>;
}
export interface LocalFile extends HandleBase {
  kind: 'file';
  getFile(): Promise<File>;
}
export interface LocalDirectory extends HandleBase {
  kind: 'directory';
  values(): AsyncIterableIterator<LocalHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<LocalDirectory>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<LocalFile>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  resolve(handle: LocalHandle): Promise<string[] | null>;
}
export type LocalHandle = LocalFile | LocalDirectory;
export interface LocalSelection { handle: LocalHandle; parent?: LocalDirectory }
export const isMissing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError';

declare global {
  interface Window {
    showDirectoryPicker?: (options: { mode: 'read'; id: string }) => Promise<LocalDirectory>;
  }
}

export const supportsFilesystem = () =>
  typeof window !== 'undefined' && window.isSecureContext &&
  !!window.showDirectoryPicker;

export function explainError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'Access is not available. Reconnect this source in app settings and allow read access.';
    if (error.name === 'NotFoundError')
      return 'This file or folder has moved or was deleted. Select it again in app settings.';
  }
  return error instanceof Error ? error.message : 'Something went wrong while reading this source.';
}

export async function pickLocation(): Promise<LocalDirectory> {
  if (!supportsFilesystem()) throw new Error('Use Chrome or Edge on HTTPS or localhost to connect local files.');
  // Call the picker immediately, while the click/keyboard gesture is still active.
  return window.showDirectoryPicker!({ mode: 'read', id: 'notework-location' });
}

export async function droppedHandles(items: DataTransferItemList): Promise<LocalHandle[]> {
  const files = Array.from(items).filter((item) => item.kind === 'file');
  if (!files.length) throw new Error('Drag a file or folder from your computer.');
  // Extract every handle in the drop event's synchronous turn, before awaiting anything.
  const pending = files.map((item) => {
    const entry = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<LocalHandle | null> };
    if (!entry.getAsFileSystemHandle) throw new Error('This browser cannot retain dropped filesystem handles. Use browse location instead.');
    return entry.getAsFileSystemHandle();
  });
  const handles = await Promise.all(pending);
  if (handles.some((handle) => !handle)) throw new Error('The selection could not be connected. Try browse location instead.');
  return handles as LocalHandle[];
}
