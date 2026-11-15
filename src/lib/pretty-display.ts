import { f } from '@legitminh/keyflow';
import { getIndentUnit } from '@codemirror/language';
import { countColumn, Facet, StateField, type EditorState, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { svgPagePattern } from './drawing';

const modeSwitch = /^[ \t]*\\(pretty|unpretty|prettify|unprettify)(?:\[\])?[ \t]*$/i;
const blockStart = /^[ \t]*\\(pretty1|unpretty1)\[/i;
const hideLine = Decoration.replace({ block: true });
const hideSyntax = Decoration.replace({});
const headingText = Decoration.mark({ class: 'cm-pretty-text' });

interface PrettyBlock { start: number; end: number; pretty: boolean }
interface SourceLine { from: number; to: number; content?: { from: number; to: number } }
export interface PrettyContext { pretty: boolean; depth: number }
const inheritedContext = Facet.define<PrettyContext, PrettyContext>({ combine: (values) => values.at(-1) ?? { pretty: false, depth: 0 } });

// Match balanced brackets so wiki links and other bracketed text can appear in a
// block. Unfinished commands remain source text until their closing bracket exists.
function findBlocks(doc: Text) {
  const blocks = new Map<number, PrettyBlock>();
  const pending: { line: number; start: number; pretty: boolean; depth: number }[] = [];
  let from = 0, depth = 0;
  for (const line of doc.iterLines()) {
    const opening = blockStart.exec(line);
    if (pending.length || opening) {
      const opener = opening ? opening[0].length - 1 : -1;
      const brackets = /[\[\]]/g;
      brackets.lastIndex = pending.length ? 0 : opener;
      for (let match; (match = brackets.exec(line));) {
        if (match[0] === '[') {
          depth++;
          if (match.index === opener) {
            pending.push({ line: from, start: from + match.index + 1, pretty: opening![1].toLowerCase() === 'pretty1', depth });
          }
        } else {
          const block = pending.at(-1);
          if (block?.depth === depth) {
            pending.pop();
            if (!line.slice(match.index + 1).trim()) {
              blocks.set(block.line, { start: block.start, end: from + match.index, pretty: block.pretty });
            }
            if (!pending.length) { depth = 0; break; }
          }
          depth--;
        }
      }
    }
    from += line.length + 1;
  }
  return blocks;
}

function layout(state: EditorState) {
  const { doc, tabSize } = state;
  const indentWidth = getIndentUnit(state);
  const blocks = findBlocks(doc);
  const scopes: PrettyBlock[] = [];
  const source: SourceLine[] = [];
  const headings: Range<Decoration>[] = [];
  const contexts = new Map<number, PrettyContext>();
  const inherited = state.facet(inheritedContext);
  let previous: { from: number; indent: number; depth: number; textFrom: number; textTo: number } | undefined;
  const ancestors: number[] = [];
  let pretty = inherited.pretty, from = 0;

  for (const raw of doc.iterLines()) {
    const to = from + raw.length;
    const opening = blocks.get(from);
    if (opening) {
      previous = undefined; ancestors.length = 0;
      scopes.push(opening);
      pretty = opening.pretty;
    }
    const scope = scopes.at(-1);
    const closing = scope && scope.end <= to ? scope : undefined;
    const contentFrom = opening?.start ?? from, contentTo = closing?.end ?? to;
    const line = raw.slice(contentFrom - from, contentTo - from);
    const toggle = modeSwitch.exec(line);

    if (toggle || ((opening || closing) && !line.trim())) {
      source.push({ from, to });
    } else if (opening || closing) {
      source.push({ from, to, content: { from: contentFrom, to: contentTo } });
    }

    if (toggle) {
      previous = undefined;
      pretty = ['pretty', 'prettify'].includes(toggle[1].toLowerCase());
      ancestors.length = 0;
    } else if (pretty && line.trim() && !svgPagePattern.test(line)) {
      headings.push(Decoration.line({ class: 'cm-pretty-line' }).range(from));
      const indentLength = /^[ \t]*/.exec(line)![0].length;
      const indent = countColumn(line, tabSize, indentLength);
      // A line has positive degree as soon as the next line is more indented.
      if (previous && indent > previous.indent) {
        const order = Math.floor(previous.indent / indentWidth);
        const bucket = f(256, 32, inherited.depth + previous.depth);
        const hue = bucket === undefined ? undefined : bucket * 360 / 256;
        headings.push(Decoration.line({
          class: 'cm-pretty-heading',
          attributes: { style: `--pretty-order: ${order};${hue === undefined ? '' : `--pretty-hue: ${hue};`}` }
        }).range(previous.from));
        // Keep leading spaces and tabs in the editor's normal font.
        headings.push(headingText.range(previous.textFrom, previous.textTo));
      }
      while (ancestors.length && ancestors.at(-1)! >= indent) ancestors.pop();
      const depth = ancestors.length;
      ancestors.push(indent);
      previous = { from, indent, depth, textFrom: contentFrom + indentLength, textTo: contentTo };
    } else {
      previous = undefined;
    }

    contexts.set(from, { pretty, depth: inherited.depth + Math.max(0, ancestors.length - 1) });
    if (closing) {
      previous = undefined;
      scopes.pop(); ancestors.length = 0;
      // The utility commands expand to explicit mode switches on both sides.
      pretty = !closing.pretty;
    }
    from = to + 1;
  }
  return { source, headings: Decoration.set(headings, true), contexts };
}

function hideInactiveSource(state: EditorState, source: SourceLine[]) {
  const editing = new Set(state.selection.ranges.map(({ head }) => state.doc.lineAt(head).from));
  const decorations: Range<Decoration>[] = [];
  for (const { from, to, content } of source) {
    if (!state.readOnly && editing.has(from)) continue;
    if (!content) decorations.push(hideLine.range(from, to));
    else {
      if (content.from > from) decorations.push(hideSyntax.range(from, content.from));
      if (content.to < to) decorations.push(hideSyntax.range(content.to, to));
    }
  }
  return Decoration.set(decorations);
}

const prettyField = StateField.define({
  create(state) {
    const display = layout(state);
    return { ...display, hidden: hideInactiveSource(state, display.source) };
  },
  update(value, transaction) {
    const { startState, state } = transaction;
    const changed = transaction.docChanged || startState.tabSize !== state.tabSize || getIndentUnit(startState) !== getIndentUnit(state);
    if (!changed && !transaction.selection) return value;
    const display = changed ? layout(state) : value;
    return { ...display, hidden: hideInactiveSource(state, display.source) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.headings),
    EditorView.decorations.from(field, (value) => value.hidden)
  ]
});

const prettyTheme = EditorView.baseTheme({
  '&.cm-pretty-margin .cm-line.cm-pretty-heading': {
    // Padding adds space inside the block measured by CodeMirror.
    paddingBlockStart: 'max(0px, calc(3em - var(--pretty-order) * .25em))'
  },
  '.cm-pretty-line': { color: '#000' },
  '.cm-pretty-line.cm-pretty-heading': { color: 'hsl(var(--pretty-hue, 0) 100% var(--pretty-lightness, 25%))' },
  '.cm-pretty-line .cm-wiki-link': { color: 'inherit' },
  '.cm-pretty-text': { fontWeight: 'bold' },
  '&.cm-pretty-size .cm-pretty-text': {
    // The heading inherits the regular editor size as its unit.
    fontSize: 'max(1.25em, calc(4em - var(--pretty-order) * .25em))'
  }
});

export function prettyContextAt(state: EditorState, position: number): PrettyContext {
  return state.field(prettyField, false)?.contexts.get(state.doc.lineAt(position).from) ?? { pretty: false, depth: 0 };
}

export function prettyDisplay(resizeText: boolean, margin: boolean, context?: PrettyContext) {
  return [prettyField, prettyTheme, context ? inheritedContext.of(context) : [],
    resizeText ? EditorView.editorAttributes.of({ class: 'cm-pretty-size' }) : [],
    margin ? EditorView.editorAttributes.of({ class: 'cm-pretty-margin' }) : []];
}
