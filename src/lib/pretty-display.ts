import { countColumn, StateField, type EditorState, type Range, type Text } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { svgPagePattern } from './drawing';

const modeSwitch = /^[ \t]*\\(pretty|unpretty)(?:\[\])?[ \t]*$/i;
const blockStart = /^[ \t]*\\(pretty1|unpretty1)\[/i;
const hideLine = Decoration.replace({ block: true });
const hideSyntax = Decoration.replace({});

interface PrettyBlock { start: number; end: number; pretty: boolean }
interface SourceLine { from: number; to: number; content?: { from: number; to: number } }

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

function layout(doc: Text, tabSize: number) {
  const blocks = findBlocks(doc);
  const scopes: PrettyBlock[] = [];
  const source: SourceLine[] = [];
  const headings: Range<Decoration>[] = [];
  const chain: number[] = [];
  let pretty = false, previousIndent = 0, from = 0;

  function flushChain() {
    // Each line's degree is the number of successive increases after it.
    for (let i = 0; i < chain.length - 1; i++) {
      headings.push(Decoration.line({
        class: 'cm-pretty-heading',
        attributes: { style: `--pretty-degree: ${chain.length - 1 - i}` }
      }).range(chain[i]));
    }
    chain.length = 0;
  }

  for (const raw of doc.iterLines()) {
    const to = from + raw.length;
    const opening = blocks.get(from);
    if (opening) {
      flushChain();
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
      flushChain();
      pretty = toggle[1].toLowerCase() === 'pretty';
    } else if (pretty && line.trim() && !svgPagePattern.test(line)) {
      const indent = countColumn(line, tabSize, /^[ \t]*/.exec(line)![0].length);
      if (indent <= previousIndent) flushChain();
      chain.push(from);
      previousIndent = indent;
    } else {
      flushChain();
    }

    if (closing) {
      flushChain();
      scopes.pop();
      // The utility commands expand to explicit mode switches on both sides.
      pretty = !closing.pretty;
    }
    from = to + 1;
  }
  flushChain();
  return { source, headings: Decoration.set(headings) };
}

function hideInactiveSource(state: EditorState, source: SourceLine[]) {
  const editing = new Set(state.selection.ranges.map(({ head }) => state.doc.lineAt(head).from));
  const decorations: Range<Decoration>[] = [];
  for (const { from, to, content } of source) {
    if (editing.has(from)) continue;
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
    const display = layout(state.doc, state.tabSize);
    return { ...display, hidden: hideInactiveSource(state, display.source) };
  },
  update(value, transaction) {
    const changed = transaction.docChanged || transaction.startState.tabSize !== transaction.state.tabSize;
    if (!changed && !transaction.selection) return value;
    const display = changed ? layout(transaction.newDoc, transaction.state.tabSize) : value;
    return { ...display, hidden: hideInactiveSource(transaction.state, display.source) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.headings),
    EditorView.decorations.from(field, (value) => value.hidden)
  ]
});

export const prettyDisplay = [prettyField, EditorView.baseTheme({
  '.cm-line.cm-pretty-heading': {
    fontWeight: 'bold',
    fontSize: 'calc(1em + var(--min-box) * var(--pretty-degree) / 4)',
    // Padding adds space inside the block measured by CodeMirror.
    paddingBlockStart: 'calc(var(--min-box) / 2)'
  }
})];
