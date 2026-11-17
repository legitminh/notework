import { ContentIndex } from './content-index';
import { isDrawingFile } from './drawing';

export type IndexRequest =
  | { type: 'begin'; epoch: number; ids?: string[] }
  | { type: 'retain'; epoch: number; ids: string[] }
  | { type: 'file'; epoch: number; id: string; file: File }
  | { type: 'search'; epoch: number; query: string; limit: number };

const index = new ContentIndex();
let epoch = 0;
let active = new Set<string>();

self.onmessage = async (event: MessageEvent<{ request: number; message: IndexRequest }>) => {
  const { request, message } = event.data;
  try {
    let result: unknown;
    if (message.type === 'begin') { epoch = message.epoch; active = new Set(message.ids); }
    else if (message.epoch === epoch) {
      if (message.type === 'retain') index.retain(new Set(message.ids));
      if (message.type === 'file') {
        const { id, file } = message;
        if (!index.unchanged(id, file)) {
          // Decode once, off the UI thread, with the same encodings as the editor.
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (message.epoch !== epoch) { self.postMessage({ request }); return; }
          const drawing = await isDrawingFile(file);
          if (message.epoch !== epoch) { self.postMessage({ request }); return; }
          let text = '';
          if (!drawing) {
            const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
              : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
            try {
              text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
            } catch (error) { if (!(error instanceof TypeError)) throw error; }
          }
          // Cache negative inspections too; unchanged binary/drawing files need no reread.
          index.add(id, text, file.size, file.lastModified);
        }
        if (message.epoch === epoch) active.add(id);
      }
      if (message.type === 'search') result = index.search(message.query, active, message.limit);
    }
    self.postMessage({ request, result });
  } catch (error) {
    self.postMessage({ request, error: error instanceof Error ? error.message : String(error) });
  }
};
