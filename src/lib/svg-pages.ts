import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, STROKE_WIDTH, drawingBottom, strokePoints, svgPagePattern, type Drawing } from './drawing';

export interface SvgPage { from: number; to: number; name: string }
interface ActivePage { from: number; host: HTMLElement }
const svgNamespace = 'http://www.w3.org/2000/svg';

class SvgPageWidget extends WidgetType {
  constructor(readonly page: SvgPage, readonly drawing: Drawing | undefined, readonly open: (page: SvgPage) => void, readonly image?: { src: string; height: number }) { super(); }
  eq(other: SvgPageWidget) {
    return this.page.from === other.page.from && this.page.name === other.page.name && this.drawing === other.drawing && this.image === other.image;
  }
  toDOM() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'svg-page-preview';
    button.setAttribute('aria-label', `Edit drawing ${this.page.name}`);
    const svg = document.createElementNS(svgNamespace, 'svg');
    const height = this.image?.height ?? (drawingBottom(this.drawing ?? []) || DRAWING_PAGE_HEIGHT);
    svg.setAttribute('viewBox', `0 0 ${DRAWING_WIDTH} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
    svg.setAttribute('width', String(DRAWING_WIDTH));
    svg.setAttribute('height', String(height));
    svg.setAttribute('aria-hidden', 'true');
    for (const stroke of this.drawing ?? []) {
      const path = document.createElementNS(svgNamespace, 'polyline');
      path.setAttribute('points', strokePoints(stroke));
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', String(STROKE_WIDTH));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    }
    if (this.image) {
      const image = document.createElementNS(svgNamespace, 'image');
      image.setAttribute('href', this.image.src); image.setAttribute('width', String(DRAWING_WIDTH)); image.setAttribute('height', String(height));
      svg.prepend(image);
    }
    button.append(svg);
    button.addEventListener('click', () => this.open(this.page));
    return button;
  }
  get estimatedHeight() { return this.image?.height ?? (drawingBottom(this.drawing ?? []) || DRAWING_PAGE_HEIGHT); }
}

class DrawingHost extends WidgetType {
  constructor(readonly host: HTMLElement) { super(); }
  eq(other: DrawingHost) { return this.host === other.host; }
  toDOM() { return this.host; }
}

function scan(doc: Text): SvgPage[] {
  const pages: SvgPage[] = [];
  let from = 0;
  for (const line of doc.iterLines()) {
    const match = svgPagePattern.exec(line);
    if (match) pages.push({ from, to: from + line.length, name: match[1] });
    from += line.length + 1;
  }
  return pages;
}

export function svgPages(open: (page: SvgPage) => void, vimMode: () => boolean) {
  const setPreview = StateEffect.define<{ name: string; strokes: Drawing; image?: { src: string; height: number } }>();
  const setActive = StateEffect.define<ActivePage | undefined>();
  function decorate(state: EditorState, pages: SvgPage[], drawings: Map<string, { strokes: Drawing; image?: { src: string; height: number } }>, active?: ActivePage) {
    return Decoration.set(pages.flatMap((page) => {
      if (active?.from === page.from) return [Decoration.replace({ block: true, widget: new DrawingHost(active.host) }).range(page.from, page.to)];
      if (state.selection.ranges.some((range) => range.from <= page.to && range.to >= page.from)) return [];
      const widget = new SvgPageWidget(page, drawings.get(page.name)?.strokes, open, drawings.get(page.name)?.image);
      // Vim measures display lines for vertical motions. Keep a real line to land on.
      if (vimMode()) return [
        Decoration.line({ class: 'svg-page-source' }).range(page.from),
        Decoration.widget({ block: true, side: 1, widget }).range(page.to)
      ];
      return [Decoration.replace({ block: true, widget }).range(page.from, page.to)];
    }), true);
  }
  const field = StateField.define({
    create(state) {
      const pages = scan(state.doc), drawings = new Map<string, { strokes: Drawing; image?: { src: string; height: number } }>();
      return { pages, drawings, active: undefined as ActivePage | undefined, decorations: decorate(state, pages, drawings) };
    },
    update(value, transaction) {
      let { pages, drawings, active } = value;
      let changed = transaction.docChanged || !!transaction.selection;
      if (transaction.docChanged) {
        pages = scan(transaction.newDoc);
        if (active) active = { ...active, from: transaction.changes.mapPos(active.from) };
      }
      for (const effect of transaction.effects) {
        if (effect.is(setPreview)) {
          drawings = new Map(drawings).set(effect.value.name, effect.value);
          changed = true;
        } else if (effect.is(setActive)) {
          active = effect.value;
          changed = true;
        }
      }
      return changed ? { pages, drawings, active, decorations: decorate(transaction.state, pages, drawings, active) } : value;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
  });
  return { field, setPreview, setActive };
}
