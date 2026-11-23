import { imageLoadingIndicator } from './image-loading';
import { StateEffect, StateField, type EditorState, type Text } from '@codemirror/state';
import { BlockType, Decoration, EditorView, GutterMarker, WidgetType, lineNumberWidgetMarker } from '@codemirror/view';
import { foldsChanged, insideFold } from './indent-folding';
import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, strokeWidth, drawingBottom, strokePoints, svgPagePattern, type Drawing } from './drawing';

export interface SvgPage { from: number; to: number; name: string }
interface ActivePage { from: number; host: HTMLElement }
const svgNamespace = 'http://www.w3.org/2000/svg';

class SvgPageWidget extends WidgetType {
  constructor(readonly page: SvgPage, readonly drawing: Drawing | undefined, readonly open: (page: SvgPage) => void, readonly image?: { src: string; height: number }, readonly readOnly = false, readonly loading = false) { super(); }
  eq(other: SvgPageWidget) {
    return this.page.from === other.page.from && this.page.name === other.page.name && this.drawing === other.drawing && this.image === other.image && this.loading === other.loading;
  }
  toDOM() {
    const button = document.createElement(this.readOnly ? 'div' : 'button');
    if (button instanceof HTMLButtonElement) button.type = 'button';
    button.className = 'svg-page-preview';
    button.dataset.pageFrom = String(this.page.from);
    button.setAttribute('aria-label', `${this.readOnly ? 'preview of' : 'edit drawing'} ${this.page.name}`);
    const indicator = this.loading || this.image ? imageLoadingIndicator() : undefined;
    if (indicator) button.append(indicator);
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
      path.setAttribute('stroke', stroke.color ?? 'currentColor');
      if (stroke.opacity !== undefined) path.setAttribute('stroke-opacity', String(stroke.opacity));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-width', String(strokeWidth(stroke)));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.append(path);
    }
    if (this.image) {
      const image = document.createElementNS(svgNamespace, 'image');
      image.addEventListener('load', () => indicator?.remove(), { once: true });
      image.addEventListener('error', () => { if (indicator) { indicator.textContent = 'image unavailable'; indicator.setAttribute('aria-label', 'image unavailable'); } }, { once: true });
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

/** A line number for an image display, drawn at the top of its gutter cell: the display is one tall line. */
class ImageLineNumber extends GutterMarker {
  constructor(readonly number: number) { super(); }
  eq(other: ImageLineNumber) { return this.number === other.number; }
  toDOM() { return document.createTextNode(String(this.number)); }
}

// Line numbers skip block widgets that replace a line; image displays keep their line's number.
const imageLineNumbers = lineNumberWidgetMarker.of((view, widget, block) =>
  block.type === BlockType.WidgetRange && (widget instanceof SvgPageWidget || widget instanceof DrawingHost)
    ? new ImageLineNumber(view.state.doc.lineAt(block.from).number) : null);

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

export function svgPages(open: (page: SvgPage) => void, vimMode: () => boolean, readOnly = false) {
  const setPreview = StateEffect.define<{ name: string; strokes: Drawing; image?: { src: string; height: number } }>();
  const setLoading = StateEffect.define<{ name: string; loading: boolean }>();
  const setActive = StateEffect.define<ActivePage | undefined>();
  function decorate(state: EditorState, pages: SvgPage[], drawings: Map<string, { strokes: Drawing; image?: { src: string; height: number } }>, active?: ActivePage, loading = new Set<string>()) {
    return Decoration.set(pages.flatMap((page) => {
      if (insideFold(state, page.from)) return [];
      if (readOnly && !drawings.has(page.name) && !loading.has(page.name)) return [];
      if (active?.from === page.from) return [Decoration.replace({ block: true, widget: new DrawingHost(active.host) }).range(page.from, page.to)];
      if (!readOnly && state.selection.ranges.some((range) => range.from <= page.to && range.to >= page.from)) return [];
      const widget = new SvgPageWidget(page, drawings.get(page.name)?.strokes, open, drawings.get(page.name)?.image, readOnly, loading.has(page.name));
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
      return { pages, drawings, loading: new Set<string>(), active: undefined as ActivePage | undefined, decorations: decorate(state, pages, drawings) };
    },
    update(value, transaction) {
      let { pages, drawings, active, loading } = value;
      let changed = transaction.docChanged || !!transaction.selection || foldsChanged(transaction);
      if (transaction.docChanged) {
        pages = scan(transaction.newDoc);
        if (active) active = { ...active, from: transaction.changes.mapPos(active.from) };
      }
      for (const effect of transaction.effects) {
        if (effect.is(setPreview)) {
          drawings = new Map(drawings).set(effect.value.name, effect.value);
          changed = true;
        } else if (effect.is(setLoading)) {
          loading = new Set(loading);
          if (effect.value.loading) loading.add(effect.value.name); else loading.delete(effect.value.name);
          changed = true;
        } else if (effect.is(setActive)) {
          active = effect.value;
          changed = true;
        }
      }
      return changed ? { pages, drawings, active, loading, decorations: decorate(transaction.state, pages, drawings, active, loading) } : value;
    },
    provide: (field) => [EditorView.decorations.from(field, (value) => value.decorations), imageLineNumbers]
  });
  return { field, setPreview, setActive, setLoading };
}
