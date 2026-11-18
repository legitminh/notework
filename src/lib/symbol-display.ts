import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import { symbolPattern, symbolShorthands } from './symbol-shorthand';

class SymbolWidget extends WidgetType {
  constructor(readonly source: string, readonly symbol: string) { super(); }
  eq(other: SymbolWidget) { return this.source === other.source; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-symbol';
    span.textContent = this.symbol;
    span.title = this.source;
    return span;
  }
  ignoreEvent() { return false; }
}

export function symbolDisplay() {
  const matcher = new MatchDecorator({
    regexp: new RegExp(symbolPattern),
    decoration(match, view, from) {
      const symbol = symbolShorthands.get(match[1]);
      if (!symbol) return null;
      const to = from + match[0].length;
      if (!view.state.readOnly && view.state.selection.ranges.some((range) => range.from <= to && range.to >= from)) return null;
      return Decoration.replace({ widget: new SymbolWidget(match[0], symbol) });
    }
  });
  return ViewPlugin.fromClass(class {
    decorations;
    constructor(view: EditorView) { this.decorations = matcher.createDeco(view); }
    update(update: ViewUpdate) {
      this.decorations = update.selectionSet || update.docChanged
        ? matcher.createDeco(update.view) : matcher.updateDeco(update, this.decorations);
    }
  }, { decorations: (plugin) => plugin.decorations });
}
