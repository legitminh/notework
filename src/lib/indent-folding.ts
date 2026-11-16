import { mount, unmount } from 'svelte';
import { countColumn, findClusterBreak, Prec, StateEffect, StateField, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import FoldHover from './components/FoldHover.svelte';

interface Fold { parent: number; from: number; to: number }
export type FoldAction = 'toggle' | 'close' | 'open' | 'closeRecursive' | 'openRecursive' | 'closeAll' | 'openAll';
const changeFold = StateEffect.define<{ action: FoldAction; position: number }>();

// Blank lines belong to a body only when followed by another indented child.
// Count columns, rather than characters, so mixed tabs and spaces agree with the editor.
function parents(state: EditorState) {
  const result = new Map<number, Fold>();
  const stack: { parent: number; from: number; indent: number }[] = [];
  let previousEnd = 0, from = 0;
  const close = () => {
    const parent = stack.pop()!;
    if (previousEnd > parent.from) result.set(parent.parent, { ...parent, to: previousEnd });
  };
  for (const text of state.doc.iterLines()) {
    if (text.trim()) {
      const indent = countColumn(text, state.tabSize, /^[ \t]*/.exec(text)![0].length);
      while (stack.length && stack.at(-1)!.indent >= indent) close();
      previousEnd = from + text.length;
      stack.push({ parent: from, from: previousEnd, indent });
    }
    from += text.length + 1;
  }
  while (stack.length) close();
  return result;
}

class FoldArrow extends WidgetType {
  toDOM() {
    const arrow = document.createElement('span');
    arrow.className = 'cm-fold-arrow';
    arrow.textContent = ' ▸';
    arrow.setAttribute('aria-label', 'Folded children');
    return arrow;
  }
}
const arrow = new FoldArrow();

function decorate(all: Map<number, Fold>, closed: Set<number>) {
  const decorations: Range<Decoration>[] = [];
  let hiddenUntil = -1;
  for (const fold of [...closed].map((pos) => all.get(pos)!).sort((a, b) => a.parent - b.parent)) {
    if (fold.parent <= hiddenUntil) continue;
    decorations.push(Decoration.replace({ widget: arrow }).range(fold.from, fold.to));
    hiddenUntil = fold.to;
  }
  return Decoration.set(decorations);
}

const folds = StateField.define({
  create(state) { return { parents: parents(state), closed: new Set<number>(), decorations: Decoration.none }; },
  update(value, tr) {
    if (!tr.docChanged && !foldsChanged(tr)) return value;
    const all = tr.docChanged ? parents(tr.state) : value.parents;
    const closed = new Set([...value.closed].map((pos) => tr.newDoc.lineAt(tr.changes.mapPos(pos, 1)).from).filter((pos) => all.has(pos)));
    for (const effect of tr.effects) {
      if (!effect.is(changeFold)) continue;
      const { action, position } = effect.value;
      const parent = tr.state.doc.lineAt(Math.min(position, tr.newDoc.length)).from;
      const fold = all.get(parent);
      if (action === 'openAll') closed.clear();
      else if (action === 'closeAll') for (const pos of all.keys()) closed.add(pos);
      else if (fold) {
        const open = action === 'open' || action === 'openRecursive' || (action === 'toggle' && closed.has(parent));
        const recursive = action === 'openRecursive' || action === 'closeRecursive';
        for (const pos of all.keys()) {
          if (pos !== parent && !(recursive && pos > parent && pos < fold.to)) continue;
          if (open) closed.delete(pos); else closed.add(pos);
        }
      }
    }
    // Selection changes deliberately do not open folds. Vim and ordinary cursor
    // movement may cross hidden positions without changing the user's fold state.
    return { parents: all, closed, decorations: decorate(all, closed) };
  },
  provide: (field) => Prec.highest(EditorView.decorations.from(field, (value) => value.decorations))
});

export function foldsChanged(transaction: Transaction) {
  return transaction.effects.some((effect) => effect.is(changeFold));
}

export function insideFold(state: EditorState, position: number) {
  const value = state.field(folds, false);
  if (!value) return false;
  for (const parent of value.closed) {
    const fold = value.parents.get(parent)!;
    if (position > fold.from && position <= fold.to) return true;
  }
  return false;
}

export function foldLine(view: EditorView, action: FoldAction = 'toggle', position = view.state.selection.main.head) {
  view.dispatch({ effects: changeFold.of({ action, position }) });
}

// Keep the hover control outside contentDOM: it overlays the last character
// without inserting text, moving the caret, or changing line wrapping.
const hover = ViewPlugin.fromClass(class {
  host?: HTMLElement;
  component?: ReturnType<typeof mount>;
  parent = -1;
  onMove = (event: MouseEvent) => this.move(event);
  onLeave = () => this.clear();
  constructor(readonly view: EditorView) {
    view.dom.addEventListener('mousemove', this.onMove);
    view.dom.addEventListener('mouseleave', this.onLeave);
    view.dom.addEventListener('scroll', this.onLeave, true);
  }
  clear() {
    if (this.component) void unmount(this.component);
    this.host?.remove();
    this.component = undefined; this.host = undefined; this.parent = -1;
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.transactions.some(foldsChanged) || update.geometryChanged) this.clear();
  }
  move(event: MouseEvent) {
    if (this.host?.contains(event.target as Node)) return;
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    const line = pos === null ? undefined : this.view.state.doc.lineAt(pos);
    const value = this.view.state.field(folds);
    if (!line || !value.parents.has(line.from) || insideFold(this.view.state, line.from)) { this.clear(); return; }
    if (this.parent === line.from) return;
    this.clear();
    const lastPos = line.from + findClusterBreak(line.text, line.length, false);
    const start = this.view.domAtPos(lastPos, 1), end = this.view.domAtPos(line.to, -1);
    const range = document.createRange();
    range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
    const last = range.getBoundingClientRect();
    if (!last.height) return;
    const textElement = start.node instanceof Element ? start.node : start.node.parentElement!;
    const bounds = this.view.dom.getBoundingClientRect();
    const host = this.host = document.createElement('div');
    host.className = 'cm-fold-hover';
    host.style.cssText = `left:${last.left - bounds.left}px;top:${last.top - bounds.top}px;height:${last.height}px;width:${Math.max(12, last.width)}px`;
    host.style.font = getComputedStyle(textElement).font;
    host.addEventListener('mousedown', (event) => event.preventDefault());
    this.view.dom.append(host);
    this.parent = line.from;
    const closed = value.closed.has(line.from);
    this.component = mount(FoldHover, { target: host, props: {
      closed, label: `${closed ? 'Unfold' : 'Fold'} children of line ${line.number}`,
      onclick: () => foldLine(this.view, 'toggle', line.from)
    } });
  }
  destroy() {
    this.clear();
    this.view.dom.removeEventListener('mousemove', this.onMove);
    this.view.dom.removeEventListener('mouseleave', this.onLeave);
    this.view.dom.removeEventListener('scroll', this.onLeave, true);
  }
});

export const indentFolding = [folds, hover, EditorView.baseTheme({
  '.cm-fold-arrow': { color: 'var(--primary)', opacity: '.65' },
  '.cm-fold-hover': { position: 'absolute', zIndex: '10', display: 'flex', backgroundColor: 'var(--background)' },
  '.cm-fold-hover .control, .cm-fold-hover button': { width: '100%', height: '100%', minWidth: '0', minHeight: '0', margin: '0', padding: '0', border: '0', fontSize: 'inherit', lineHeight: '1', cursor: 'pointer' },
  '.cm-fold-hover .content': { backgroundColor: 'var(--background)', textAlign: 'center' },
  '.cm-fold-hover .route': { display: 'none' }
})];
