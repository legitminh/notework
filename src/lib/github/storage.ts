import type { GitSnapshot } from './api';

export interface GitHubDraft { base: string | null; content: Blob; modified: number; id?: string }

export type DraftQueue = <T>(task: () => Promise<T>) => Promise<T>;

// Let Exit wait for any outstanding local autosave before capturing the draft.
export function draftQueue(): DraftQueue {
  let tail = Promise.resolve();
  return (task) => {
    const next = tail.then(task);
    tail = next.then(() => {}, () => {});
    return next;
  };
}

let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('notework-github', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction('data').objectStore('data').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function put(key: string, value?: unknown) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction('data', 'readwrite');
    const store = tx.objectStore('data');
    if (value === undefined) store.delete(key);
    else store.put(value, key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('Could not save the GitHub draft in this browser.'));
  });
}

export const readToken = (id: string) => get<string>(`token:${id}`);
export const storeToken = (id: string, token: string) => put(`token:${id}`, token);
export const readSnapshot = (id: string) => get<GitSnapshot>(`snapshot:${id}`);
export const storeSnapshot = (id: string, snapshot: GitSnapshot) => put(`snapshot:${id}`, snapshot);
export const storeDraft = (id: string, path: string, draft: GitHubDraft) => put(`draft:${id}:${path}`, draft);
export const readBlob = (id: string, sha: string) => get<Blob>(`blob:${id}:${sha}`);
export const storeBlob = (id: string, sha: string, blob: Blob) => put(`blob:${id}:${sha}`, blob);

export async function replaceDraft(id: string, path: string, draftId: string | undefined, draft?: GitHubDraft) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('data', 'readwrite');
    const store = tx.objectStore('data');
    const key = `draft:${id}:${path}`;
    const request = store.get(key);
    // An editor in another tab may have saved a newer draft while we pushed.
    request.onsuccess = () => {
      if (!request.result || request.result.id !== draftId) return;
      if (draft) store.put(draft, key);
      else store.delete(key);
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}

export async function readDrafts(id: string) {
  const database = await db();
  return new Promise<Map<string, GitHubDraft>>((resolve, reject) => {
    const prefix = `draft:${id}:`;
    const drafts = new Map<string, GitHubDraft>();
    const cursor = database.transaction('data').objectStore('data').openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      if (!cursor.result) { resolve(drafts); return; }
      drafts.set(String(cursor.result.key).slice(prefix.length), cursor.result.value);
      cursor.result.continue();
    };
  });
}

export async function clearRepository(id: string) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction('data', 'readwrite');
    const store = tx.objectStore('data');
    store.delete(`token:${id}`);
    store.delete(`snapshot:${id}`);
    for (const prefix of [`blob:${id}:`, `draft:${id}:`]) {
      const cursor = store.openKeyCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      cursor.onsuccess = () => { if (cursor.result) { store.delete(cursor.result.primaryKey); cursor.result.continue(); } };
    }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
}
