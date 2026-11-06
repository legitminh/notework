import type { LocalFile } from './filesystem';
import { writeBrowserContent } from './browser-documents';

/** Callers acquire local write permission from an explicit Create, Rename, save shortcut, or saving Exit action. */
export async function writeResourceContent(
  handle: LocalFile, storage: 'local' | 'browser',
  chunks: Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>
) {
  if (storage === 'browser') return writeBrowserContent(handle, chunks);
  const writer = await (handle as unknown as FileSystemFileHandle).createWritable();
  try {
    for await (const chunk of chunks) await writer.write(typeof chunk === 'string' ? chunk : new Uint8Array(chunk));
    await writer.close();
  } catch (error) { await writer.abort().catch(() => {}); throw error; }
}
