import { mount, unmount } from 'svelte';
import { StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { pageReferencePattern } from './page-pattern';
import { prettyContextAt, type PrettyContext } from './pretty-display';
import type { PreviewLocation } from './preview-location';
import type { Workspace, StateNode } from './workspace';
import PageEmbed from './components/PageEmbed.svelte';

export interface PageReferenceOptions {
  workspace: Workspace;
  source: StateNode;
  wrapLines: boolean;
  prettyFontSize: boolean;
  prettyMargin: boolean;
  readOnly?: boolean;
  ancestors: string[];
  context: Map<unknown, unknown>;
  onOpen: (id: string, location?: PreviewLocation) => void;
  catalog: () => Promise<StateNode[]>;
}

const cleanups = new WeakMap<HTMLElement, () => void>();

class PageWidget extends WidgetType {
  constructor(readonly token: string, readonly indent: string, readonly pretty: PrettyContext, readonly options: PageReferenceOptions) { super(); }
  eq(other: PageWidget) {
    return this.token === other.token && this.indent === other.indent && this.pretty.pretty === other.pretty.pretty && this.pretty.depth === other.pretty.depth;
  }
  toDOM(view: EditorView) {
    const host = document.createElement('div');
    host.className = 'page-reference';
    const component = mount(PageEmbed, { target: host, context: this.options.context,
      props: { token: this.token, indent: this.indent, pretty: this.pretty, options: this.options } });
    const observer = new ResizeObserver(() => { if (host.isConnected) view.requestMeasure(); });
    observer.observe(host);
    // CodeMirror can reuse this DOM with an equal, newly constructed WidgetType.
    cleanups.set(host, () => { observer.disconnect(); void unmount(component); });
    return host;
  }
  destroy(host: HTMLElement) {
    cleanups.get(host)?.();
    cleanups.delete(host);
  }
  ignoreEvent() { return true; }
  get estimatedHeight() { return 160; }
}

export function pageReferences(options: PageReferenceOptions) {
  function decorate(state: Parameters<typeof prettyContextAt>[0]) {
    const decorations = [];
    for (let number = 1; number <= state.doc.lines; number++) {
      const line = state.doc.line(number), match = pageReferencePattern.exec(line.text);
      if (!match || (!options.readOnly && state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from))) continue;
      decorations.push(Decoration.replace({ block: true,
        widget: new PageWidget(match[2].trim(), match[1], prettyContextAt(state, line.from), options)
      }).range(line.from, line.to));
    }
    return Decoration.set(decorations);
  }
  return StateField.define({
    create: decorate,
    update(value, transaction) { return transaction.docChanged || transaction.selection ? decorate(transaction.state) : value; },
    provide: (field) => EditorView.decorations.from(field)
  });
}
