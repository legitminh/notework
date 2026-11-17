import { test, expect } from '@playwright/test';
import { ContentIndex } from '../src/lib/content-index';

test('substring postings narrow a codebase-sized corpus and verify exact matches', () => {
  const index = new ContentIndex();
  const allowed = new Set<string>();
  for (let i = 0; i < 10_000; i++) {
    const id = `file-${i}`; allowed.add(id);
    index.add(id, `export function operation${i}() { return "common text ${i}"; }\n`, 80, i);
  }
  index.add('file-5678', 'prefix\r\nconst result = foo?.bar("Needle");\r\ntail', 80, 2);
  const result = index.search('foo?.bar("needle")', allowed);
  expect(result.hits).toHaveLength(1);
  expect(result.candidates).toBe(1);
  expect(result.hits[0]).toMatchObject({ id: 'file-5678', matches: [{ line: 2, position: 22, text: 'foo?.bar("Needle")' }] });
  // Posting intersections can contain grams in the wrong order; literal verification rejects them.
  index.add('false-positive', 'abc bcd cde def', 15, 0); allowed.add('false-positive');
  expect(index.search('abcdef', allowed).hits).toEqual([]);
  expect(index.search('common', allowed, 50)).toMatchObject({ limited: true });
  expect(index.search('common', new Set(['file-5678'])).hits).toEqual([]);
  index.remove('file-5678');
  expect(index.search('foo?.bar', allowed).hits).toEqual([]);
  console.log(`10,000-file indexed literal query: ${result.milliseconds.toFixed(2)} ms, ${result.candidates} candidate`);
});

test('short, Unicode, multiline, replacement, and retained-scope searches preserve offsets', () => {
  const index = new ContentIndex(), allowed = new Set(['a']);
  index.add('a', 'İ X\r\nđiện\rlast line', 20, 0);
  expect(index.search('x', allowed).hits[0].matches[0]).toMatchObject({ position: 2, line: 1, text: 'X' });
  expect(index.search('ĐI', allowed).hits[0].matches[0]).toMatchObject({ position: 4, line: 2, text: 'đi' });
  expect(index.search('điện\nlast', allowed).hits[0].matches[0]).toMatchObject({ position: 4, line: 2, text: 'điện\nlast' });
  index.add('a', 'replacement', 11, 1);
  expect(index.search('điện', allowed).hits).toEqual([]);
  expect(index.search('replace', allowed).hits).toHaveLength(1);
  index.retain(new Set());
  expect(index.search('replace', allowed).hits).toEqual([]);
});
