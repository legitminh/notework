import { Decoration, EditorView, MatchDecorator, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { wikiPattern } from './wiki';

export function wikiDisplay(open: (token: string) => void) {
  const matcher = new MatchDecorator({
    regexp: new RegExp(wikiPattern),
    decoration(match, view, from) {
      const to = from + match[0].length;
      if (view.state.selection.ranges.some((range) => range.from <= to && range.to >= from)) return null;
      return Decoration.mark({
        class: 'cm-wiki-link',
        attributes: { 'data-wiki-target': match[1].trim() }
      });
    }
  });
  const target = (event: MouseEvent) => event.button === 0 && event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-wiki-target]')?.dataset.wikiTarget : undefined;

  return [
    ViewPlugin.fromClass(class {
      decorations;
      constructor(view: EditorView) { this.decorations = matcher.createDeco(view); }
      update(update: ViewUpdate) {
        this.decorations = update.selectionSet || update.docChanged
          ? matcher.createDeco(update.view)
          : matcher.updateDeco(update, this.decorations);
      }
    }, { decorations: (plugin) => plugin.decorations }),
    EditorView.domEventHandlers({
      // Keep the selection outside the link until click, or it becomes plain text.
      mousedown(event) {
        if (!target(event)) return false;
        event.preventDefault();
        return true;
      },
      click(event) {
        const token = target(event);
        if (!token) return false;
        event.preventDefault();
        open(token);
        return true;
      }
    }),
    EditorView.theme({
      '.cm-wiki-link': {
        color: 'color-mix(in srgb, #4c8ce4 85%, var(--primary))',
        cursor: 'pointer'
      },
      '.cm-wiki-link:hover': { textDecoration: 'underline' }
    })
  ];
}
