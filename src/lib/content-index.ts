/** Literal substring index. All contents and postings stay in worker memory. */
export interface ContentMatch {
  position: number;
  line: number;
  before: string;
  text: string;
  after: string;
}
export interface ContentHit { id: string; matches: ContentMatch[] }
export interface ContentResults { hits: ContentHit[]; limited: boolean; candidates: number; milliseconds: number }
interface Document {
  id: string;
  text: string;
  folded: string;
  grams: Set<string>;
  lines: number[];
  size: number;
  modified: number;
}

function grams(text: string) {
  const result = new Set<string>();
  // Include short grams too: even one/two-character queries use postings.
  for (let width = 1; width <= 3; width++)
    for (let i = 0; i <= text.length - width; i++) result.add(text.slice(i, i + width));
  return result;
}

export class ContentIndex {
  private documents = new Map<string, Document>();
  private postings = new Map<string, Set<string>>();

  unchanged(id: string, file: File) {
    const doc = this.documents.get(id);
    return doc?.size === file.size && doc.modified === file.lastModified;
  }

  remove(id: string) {
    const doc = this.documents.get(id);
    if (!doc) return;
    for (const gram of doc.grams) {
      const posting = this.postings.get(gram)!;
      posting.delete(id);
      if (!posting.size) this.postings.delete(gram);
    }
    this.documents.delete(id);
  }

  retain(ids: Set<string>) {
    for (const id of this.documents.keys()) if (!ids.has(id)) this.remove(id);
  }

  add(id: string, content: string, size: number, modified: number) {
    this.remove(id);
    // Match CodeMirror's document offsets, including CRLF/CR input files.
    const text = content.replace(/\r\n?/g, '\n');
    const folded = text.toLowerCase();
    const tokens = grams(folded);
    const lines = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
    this.documents.set(id, { id, text, folded, grams: tokens, lines, size, modified });
    for (const gram of tokens) {
      let posting = this.postings.get(gram);
      if (!posting) this.postings.set(gram, posting = new Set());
      posting.add(id);
    }
  }

  search(query: string, allowed: Set<string>, limit = 200): ContentResults {
    const started = performance.now();
    const needle = query.replace(/\r\n?/g, '\n').toLowerCase();
    const hits: ContentHit[] = [];
    let candidates = 0, limited = false;
    if (needle) {
      const width = Math.min(3, needle.length);
      const tokens = new Set<string>();
      for (let i = 0; i <= needle.length - width; i++) tokens.add(needle.slice(i, i + width));
      const lists: Set<string>[] = [];
      for (const token of tokens) {
        const list = this.postings.get(token);
        if (!list) return { hits, limited, candidates, milliseconds: performance.now() - started };
        lists.push(list);
      }
      lists.sort((a, b) => a.size - b.size);
      for (const id of lists[0]) {
        if (!allowed.has(id) || !lists.every((list) => list.has(id))) continue;
        candidates++;
        const doc = this.documents.get(id)!;
        let offset = doc.folded.indexOf(needle);
        if (offset < 0) continue; // Postings select candidates; always verify the literal string.
        if (hits.length >= limit) { limited = true; break; }
        const matches: ContentMatch[] = [];
        while (offset >= 0 && matches.length < 3) {
          const position = originalOffset(doc.text, doc.folded, offset);
          const end = originalOffset(doc.text, doc.folded, offset + needle.length);
          let low = 0, high = doc.lines.length;
          while (low + 1 < high) {
            const mid = (low + high) >>> 1;
            if (doc.lines[mid] <= position) low = mid; else high = mid;
          }
          matches.push({ position, line: low + 1,
            before: doc.text.slice(Math.max(doc.lines[low], position - 80), position),
            text: doc.text.slice(position, Math.min(end, position + 160)),
            after: doc.text.slice(end, Math.min(doc.text.indexOf('\n', end) < 0 ? doc.text.length : doc.text.indexOf('\n', end), end + 120)) });
          offset = doc.folded.indexOf(needle, offset + Math.max(1, needle.length));
        }
        hits.push({ id, matches });
      }
    }
    return { hits, limited, candidates, milliseconds: performance.now() - started };
  }
}

// Lowercasing can expand Unicode characters (e.g. İ). Preserve editor offsets.
function originalOffset(text: string, folded: string, offset: number) {
  if (text.length === folded.length) return offset;
  let original = 0, lower = 0;
  for (const character of text) {
    if (lower >= offset) break;
    lower += character.toLowerCase().length;
    original += character.length;
  }
  return original;
}
