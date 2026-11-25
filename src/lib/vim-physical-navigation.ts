import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';

const unshifted: Record<string, string> = {
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/'
};

const shifted: Record<string, string> = {
  Digit0: ')', Digit1: '!', Digit2: '@', Digit3: '#', Digit4: '$',
  Digit5: '%', Digit6: '^', Digit7: '&', Digit8: '*', Digit9: '(',
  Backquote: '~', Minus: '_', Equal: '+', BracketLeft: '{', BracketRight: '}',
  Backslash: '|', Semicolon: ':', Quote: '"', Comma: '<', Period: '>', Slash: '?'
};

/** The Vim key printed on the US physical key position, independent of the active layout. */
export function physicalVimKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'shiftKey' | 'getModifierState'>) {
  if (/^Key[A-Z]$/.test(event.code)) {
    const capsLock = event.getModifierState('CapsLock');
    // Some automation and accessibility keyboards emit an uppercase key without
    // a Shift/Caps modifier. Preserve that explicit command rather than lowering it.
    if (!event.shiftKey && !capsLock && /^[A-Z]$/.test(event.key)) return event.key;
    const upper = event.shiftKey !== capsLock;
    const letter = event.code.slice(3);
    return upper ? letter : letter.toLowerCase();
  }
  return (event.shiftKey ? shifted : unshifted)[event.code];
}

function composingLiteral(event: KeyboardEvent, view: EditorView) {
  const cm = getCM(view);
  const vim = cm?.state.vim;
  if (!cm || !vim?.expectLiteralNext || !(event.isComposing || event.key === 'Dead' || event.key === 'Process' || event.key === 'Unidentified')) return;
  // Let the browser finish the input method, but keep its construction keystrokes
  // away from Vim. codemirror-vim's input handler consumes the committed token.
  if (cm.state.vimPlugin) cm.state.vimPlugin.useNextTextInput = true;
  event.stopImmediatePropagation();
}

function physicalExInput(event: KeyboardEvent) {
  const field = event.target;
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) ||
      !field.closest('.cm-vim-panel') ||
      field.parentElement?.firstChild?.textContent !== ':' ||
      event.ctrlKey || event.metaKey || event.altKey) return false;
  const key = physicalVimKey(event);
  if (!key || key === event.key) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  field.setRangeText(key, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, 'end');
  field.dispatchEvent(new InputEvent('input', { data: key, inputType: 'insertText', bubbles: true }));
  return true;
}

/**
 * Navigate Vim with US physical key positions while leaving inserted text and
 * literal character targets (f/F/t/T/r) in the active language and input method.
 */
export function vimPhysicalNavigation(): Extension {
  return [
    ViewPlugin.define((view) => {
      const document = view.dom.ownerDocument;
      const handler = (event: KeyboardEvent) => {
        if (!physicalExInput(event) && view.contentDOM.contains(event.target as Node)) composingLiteral(event, view);
      };
      // CodeMirror mounts its command/search panel outside the scrolling editor.
      document.addEventListener('keydown', handler, true);
      return { destroy: () => document.removeEventListener('keydown', handler, true) };
    }),
    Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        const vim = getCM(view)?.state.vim;
        // Inserted text and a pending literal character are symbolic. Search and
        // Ex fields are outside contentDOM; the capture listener handles only Ex.
        if (!vim || (vim.insertMode && !event.ctrlKey) || vim.exMode || vim.expectLiteralNext || event.isComposing) return false;
        const key = physicalVimKey(event);
        if (!key || key === event.key) return false;
        const replacement = new KeyboardEvent('keydown', {
          key,
          bubbles: true,
          cancelable: true,
          repeat: event.repeat,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey
        });
        view.contentDOM.dispatchEvent(replacement);
        return true;
      }
    }))
  ];
}
