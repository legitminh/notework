// Machine folders in the native (Tauri) app. The app has no browser folder picker on
// WebKit, so Notework's own folder browser lists the computer through the app's Rust
// commands, and these handles implement the same interface as File System Access
// handles. Contents are read and written only under folders the person chose.
import type { LocalDirectory, LocalFile, LocalHandle } from './filesystem';

interface TauriInternals {
  invoke<T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T>;
}
declare global {
  interface Window { __TAURI_INTERNALS__?: TauriInternals }
}

export const isNativeApp = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

/** Rust errors are `Name: message`, mirroring the DOMException names the app checks. */
async function call<T>(command: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
  try {
    return await window.__TAURI_INTERNALS__!.invoke<T>(command, args, options);
  } catch (error) {
    const text = String(error);
    const match = /^(\w+Error): (.*)$/s.exec(text);
    throw match ? new DOMException(match[2], match[1]) : new Error(text);
  }
}

/** Tell the macOS shell whether the focused Vim editor currently owns physical command keys. */
export const setNativeVimAtextual = (active: boolean) =>
  isNativeApp() ? call<void>('vim_atextual', { active }) : Promise.resolve();

export interface NativePlace { name: string; path: string }
export interface NativeEntry { name: string; path: string; kind: 'file' | 'directory'; text: boolean }
interface NativeStat { kind: 'file' | 'directory'; size: number; modified: number }

export const nativePlaces = () => call<NativePlace[]>('fs_places');

let documents: Promise<NativeDirectory> | undefined;
/** Native storage: the app's own documents folder, where new resources at home live. */
export function nativeDocuments(): Promise<NativeDirectory> {
  return documents ??= call<string>('fs_documents').then((path) => new NativeDirectory(path), (error) => { documents = undefined; throw error; });
}
/** Names in a folder, for the folder browser. Reads no file contents beyond a text check. */
export const browseNative = (path: string) => call<NativeEntry[]>('fs_browse', { path });
/** Names below a folder that contain `query`, for the folder browser's search. */
export const searchNative = (path: string, query: string) => call<NativeEntry[]>('fs_search', { path, query });
export const parentPath = (path: string) => call<string | null>('fs_parent', { path });

const separator = (path: string) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
const join = (base: string, name: string) => {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) throw new DOMException('the name is not valid here.', 'TypeError');
  return base.endsWith('/') || base.endsWith('\\') ? base + name : base + separator(base) + name;
};
const baseName = (path: string) => path.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) || path;

abstract class NativeHandle {
  /** Marks plain copies made by structured cloning so they can be revived. */
  readonly native = true;
  readonly name: string;
  abstract readonly kind: 'file' | 'directory';
  constructor(readonly path: string) { this.name = baseName(path); }
  async isSameEntry(other: LocalHandle) {
    return other instanceof NativeHandle && other.path === this.path && other.kind === this.kind;
  }
  async queryPermission(): Promise<PermissionState> {
    return await call<boolean>('fs_granted', { path: this.path }) ? 'granted' : 'prompt';
  }
  /** Called only from an explicit action (observe, reconnect, create, save, rename). */
  async requestPermission(): Promise<PermissionState> {
    await call('fs_grant', { path: this.path });
    return 'granted';
  }
  async remove(options?: { recursive?: boolean }) {
    await call('fs_remove', { path: this.path, recursive: options?.recursive ?? false });
  }
}

export class NativeFile extends NativeHandle implements LocalFile {
  readonly kind = 'file';
  async getFile() {
    const stat = await call<NativeStat>('fs_stat', { path: this.path });
    if (stat.kind !== 'file') throw new DOMException('this path is a folder.', 'TypeMismatchError');
    const bytes = await call<ArrayBuffer>('fs_read', { path: this.path });
    return new File([bytes], this.name, { lastModified: stat.modified });
  }
  async createWritable() {
    const parts: BlobPart[] = [];
    const path = this.path;
    const stream = new WritableStream<BlobPart>({
      write: (chunk) => { parts.push(chunk); },
      close: async () => {
        const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
        await call('fs_write', bytes, { headers: { 'notework-path': encodeURIComponent(path) } });
      }
    });
    let writer: WritableStreamDefaultWriter<BlobPart> | undefined;
    const direct = () => writer ??= stream.getWriter();
    return Object.assign(stream, {
      write: (chunk: BlobPart) => direct().write(chunk),
      close: () => direct().close(),
      abort: (error?: unknown) => direct().abort(error)
    });
  }
}

export class NativeDirectory extends NativeHandle implements LocalDirectory {
  readonly kind = 'directory';
  async *values(): AsyncIterableIterator<LocalHandle> {
    const entries = await call<NativeEntry[]>('fs_list', { path: this.path });
    for (const entry of entries) yield entry.kind === 'directory' ? new NativeDirectory(entry.path) : new NativeFile(entry.path);
  }
  private async child(name: string, kind: 'file' | 'directory', create?: boolean) {
    const path = join(this.path, name);
    try {
      const stat = await call<NativeStat>('fs_stat', { path });
      if (stat.kind !== kind) throw new DOMException(`“${name}” is not a ${kind === 'file' ? 'file' : 'folder'}.`, 'TypeMismatchError');
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotFoundError') || !create) throw error;
      await call(kind === 'directory' ? 'fs_mkdir' : 'fs_create', { path });
    }
    return path;
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    return new NativeDirectory(await this.child(name, 'directory', options?.create));
  }
  async getFileHandle(name: string, options?: { create?: boolean }) {
    return new NativeFile(await this.child(name, 'file', options?.create));
  }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    await call('fs_remove', { path: join(this.path, name), recursive: options?.recursive ?? false });
  }
  async resolve(handle: LocalHandle) {
    if (!(handle instanceof NativeHandle)) return null;
    if (handle.path === this.path) return [];
    const prefix = this.path.endsWith('/') || this.path.endsWith('\\') ? this.path : this.path + separator(this.path);
    if (!handle.path.startsWith(prefix)) return null;
    return handle.path.slice(prefix.length).split(/[/\\]/);
  }
}

export const isNativeHandle = (handle: unknown): handle is NativeFile | NativeDirectory => handle instanceof NativeHandle;

/** The folder that contains a native file or folder. */
export function nativeParent(handle: LocalHandle): LocalDirectory {
  if (!(handle instanceof NativeHandle)) throw new Error('this item is not on this device.');
  const path = handle.path.replace(/[/\\]+$/, '');
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (cut < 0) throw new Error('this item has no containing folder.');
  return new NativeDirectory(cut === 0 || /^[A-Za-z]:$/.test(path.slice(0, cut)) ? path.slice(0, cut + 1) : path.slice(0, cut));
}

export const nativeHandle = (entry: { path: string; kind: 'file' | 'directory' }): LocalHandle =>
  entry.kind === 'directory' ? new NativeDirectory(entry.path) : new NativeFile(entry.path);

/** Turns a structured-cloned native handle (from IndexedDB or a snapshot) back into a handle. */
export function reviveNative<T>(value: T): T {
  const plain = value as unknown as { native?: unknown; path?: unknown; kind?: unknown } | undefined;
  if (!plain || plain instanceof NativeHandle || plain.native !== true || typeof plain.path !== 'string') return value;
  if (plain.kind !== 'file' && plain.kind !== 'directory') return value;
  return nativeHandle({ path: plain.path, kind: plain.kind }) as unknown as T;
}

/** One GitHub device-flow login request, sent by the app because GitHub's login pages refuse browser requests. Returns GitHub's JSON. */
export const githubLogin = (step: 'code' | 'token', params: Record<string, string>) => call<string>('github_login', { step, params });
/** Open a GitHub login page in the system browser. The app accepts only https://github.com/login/ pages. */
export const openGitHubLogin = (url: string) => call<void>('github_open', { url });
/** Bring the Notework window to the front, such as after GitHub approves a login. */
export const focusApp = () => call<void>('app_focus');
