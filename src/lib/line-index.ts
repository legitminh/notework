import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

// Document line indices are zero-based; the left edge is the low bit.
export const lineIndex = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view); }
  build(view: EditorView) {
    const ranges = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
      let pos = view.state.doc.lineAt(from).from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        ranges.add(pos, pos, Decoration.line({ attributes: { class: `line-index line-mod-${(line.number - 1) % 4}`, 'data-line-index': String(line.number - 1) } }));
        if (line.to === view.state.doc.length) break;
        pos = line.to + 1;
      }
    }
    return ranges.finish();
  }
}, { decorations: (plugin) => plugin.decorations });
