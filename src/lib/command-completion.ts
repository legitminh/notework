import { pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { Transaction } from '@codemirror/state';
import { resourceProximity } from './resource-proximity';
import { wikiScore, wikiToken } from './wiki';
import type { StateNode, Workspace } from './workspace';

function drawingTargets(workspace: Workspace, source: StateNode, query: string, files: StateNode[]): Completion[] {
  const distance = resourceProximity(workspace, source);
  const bindings = workspace.data.wiki?.[source.id];
  return files.map((file) => workspace.known.get(file.id))
    .filter((file): file is StateNode => !!file?.drawing && file.id !== source.id)
    .map((file) => {
      const path = workspace.label(file);
      return { file, path, score: Math.min(wikiScore(query, file.name), wikiScore(query, path)), ...distance(file) };
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || (a.hops ?? Infinity) - (b.hops ?? Infinity) ||
      (a.upstream ?? Infinity) - (b.upstream ?? Infinity) || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map(({ file, path }) => {
      const short = wikiToken(workspace, source, file, files);
      // Use a URI when a saved reference already owns this token or the
      // display path contains a bracket that would break the directive.
      const token = /[\[\]\r\n]/.test(short) ||
        (bindings && Object.hasOwn(bindings, short) && bindings[short] !== file.id) ? file.uri : short;
      return {
        label: file.name, detail: path, type: 'file',
        apply(editor, completion, from, to) {
          const suffix = editor.state.sliceDoc(to, editor.state.doc.lineAt(to).to);
          const existing = /^[^\[\]]*\]/.exec(suffix);
          const insert = `[${token}]`;
          editor.dispatch({
            changes: { from, to: to + (existing?.[0].length ?? 0), insert },
            selection: { anchor: from + insert.length },
            annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')]
          });
        }
      };
    });
}

interface EditorCommand {
  name: string;
  detail: string;
  targets?: typeof drawingTargets;
}

const commands: readonly EditorCommand[] = [
  { name: 'svgpage', detail: 'Insert a drawing page', targets: drawingTargets }
];

const commandOptions = commands.map(({ name, detail, targets }): Completion => ({
  label: `\\${name}`, detail, type: 'keyword',
  apply(editor, completion, from, to) {
    const suffix = editor.state.sliceDoc(to, editor.state.doc.lineAt(to).to);
    const rest = /^[a-z0-9-]*/i.exec(suffix)![0].length;
    const label = completion.label;
    const insert = label + (targets && suffix[rest] !== '[' ? '[]' : '');
    editor.dispatch({
      changes: { from, to: to + rest, insert },
      selection: { anchor: from + label.length + (targets ? 1 : 0) },
      annotations: [pickedCompletion.of(completion), Transaction.userEvent.of('input.complete')]
    });
  }
}));

export const opensCommandArguments = (option: Completion) =>
  commands.some(({ targets }, index) => !!targets && commandOptions[index] === option);

function commandArgument(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos);
  const match = /^[ \t]*\\([a-z0-9-]+)\[([^\[\]]*)$/i.exec(line.text.slice(0, context.pos - line.from));
  if (!match) return;
  const [, name, query] = match;
  const targets = commands.find((command) => command.name === name.toLowerCase())?.targets;
  // Include the opening bracket in the range so the list can stay open when
  // a user backspaces the last character of a nonempty query.
  if (targets) return { from: context.pos - query.length - 1, query: query.trim(), targets };
}

export function commandCompletion(workspace: Workspace, source: StateNode, catalog: () => Promise<StateNode[]>) {
  function argumentResult({ from, query, targets }: NonNullable<ReturnType<typeof commandArgument>>, files: StateNode[]): CompletionResult {
    return {
      from, options: targets(workspace, source, query, files), filter: false,
      update(_result, _from, _to, context) {
        const argument = commandArgument(context);
        return argument ? argumentResult(argument, files) : null;
      }
    };
  }
  return (context: CompletionContext) => {
    const argument = commandArgument(context);
    if (argument) return catalog().then((files) => context.aborted ? null : argumentResult(argument, files)).catch(() => null);
    const match = context.matchBefore(/\\[a-z0-9-]*$/i);
    return match ? { from: match.from, options: commandOptions, validFor: /\\[a-z0-9-]*/i } : null;
  };
}
