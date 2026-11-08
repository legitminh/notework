import type { LocalFile } from './filesystem';

export interface TextFormat {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be';
  bom: boolean;
  eol: '\n' | '\r\n' | '\r';
  size: number;
  modified: number;
}
export class HiddenResource extends Error {}

/** Validate actual bytes, not a filename extension. Never persist file contents. */
export async function inspectText(handle: LocalFile, cached?: TextFormat): Promise<TextFormat | null> {
  return inspectTextFile(await handle.getFile(), cached);
}

export async function inspectTextFile(file: File, cached?: TextFormat): Promise<TextFormat | null> {
  if (cached && cached.size === file.size && cached.modified === file.lastModified) return cached;
  const prefix = new Uint8Array(await file.slice(0, 3).arrayBuffer());
  const encoding = prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le' : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : 'utf-8';
  const bom = encoding !== 'utf-8' || (prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf);
  const format: TextFormat = { encoding, bom, eol: '\n', size: file.size, modified: file.lastModified };
  try {
    let endingFound = false;
    let previous = '';
    for await (const chunk of decodedChunks(file, format)) {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(chunk)) return null;
      if (!endingFound) {
        const match = (previous + chunk).match(/\r\n|\r(?!$)|\n/);
        if (match) { format.eol = match[0] as TextFormat['eol']; endingFound = true; }
      }
      previous = chunk.slice(-1);
    }
    if (!endingFound && previous === '\r') format.eol = '\r';
    return format;
  } catch (error) {
    if (error instanceof TypeError) return null; // Invalid Unicode byte sequence.
    throw error;
  }
}

export async function* decodedChunks(file: File, format: TextFormat) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder(format.encoding, { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function* encodedChunks(chunks: Iterable<string>, format: TextFormat): Generator<string | Uint8Array<ArrayBuffer>> {
  if (format.bom) yield new Uint8Array(format.encoding === 'utf-8' ? [0xef, 0xbb, 0xbf] : format.encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
  for (const chunk of chunks) {
    const text = format.eol === '\n' ? chunk : chunk.replace(/\n/g, format.eol);
    if (format.encoding === 'utf-8') yield text;
    else {
      const bytes = new Uint8Array(text.length * 2);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), format.encoding === 'utf-16le');
      yield bytes;
    }
  }
}
