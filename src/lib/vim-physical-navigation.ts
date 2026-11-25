import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin } from '@codemirror/view';
import { getCM } from '@replit/codemirror-vim';
import { setNativeVimAtextual } from './native-fs';

interface NativePhysicalKey {
  keyCode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  capsLock: boolean;
  repeat: boolean;
}

const macCodes: Record<number, string> = {
  0: 'KeyA', 1: 'KeyS', 2: 'KeyD', 3: 'KeyF', 4: 'KeyH', 5: 'KeyG',
  6: 'KeyZ', 7: 'KeyX', 8: 'KeyC', 9: 'KeyV', 11: 'KeyB', 12: 'KeyQ',
  13: 'KeyW', 14: 'KeyE', 15: 'KeyR', 16: 'KeyY', 17: 'KeyT',
  18: 'Digit1', 19: 'Digit2', 20: 'Digit3', 21: 'Digit4', 22: 'Digit6',
  23: 'Digit5', 24: 'Equal', 25: 'Digit9', 26: 'Digit7', 27: 'Minus',
  28: 'Digit8', 29: 'Digit0', 30: 'BracketRight', 31: 'KeyO', 32: 'KeyU',
  33: 'BracketLeft', 34: 'KeyI', 35: 'KeyP', 36: 'Enter', 37: 'KeyL',
  38: 'KeyJ', 39: 'Quote', 40: 'KeyK', 41: 'Semicolon', 42: 'Backslash',
  43: 'Comma', 44: 'Slash', 45: 'KeyN', 46: 'KeyM', 47: 'Period',
  48: 'Tab', 49: 'Space', 50: 'Backquote', 51: 'Backspace', 53: 'Escape',
  115: 'Home', 116: 'PageUp', 117: 'Delete', 119: 'End', 121: 'PageDown',
  123: 'ArrowLeft', 124: 'ArrowRight', 125: 'ArrowDown', 126: 'ArrowUp'
};

const namedKeys: Record<string, string> = {
  Enter: 'Enter', Tab: 'Tab', Space: ' ', Backspace: 'Backspace', Escape: 'Escape',
  Home: 'Home', PageUp: 'PageUp', Delete: 'Delete', End: 'End', PageDown: 'PageDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp'
};

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

function nativePhysicalKey(detail: NativePhysicalKey) {
  const code = macCodes[detail.keyCode];
  if (!code) return;
  const key = namedKeys[code] ?? physicalVimKey({
    key: '', code, shiftKey: detail.shiftKey,
    getModifierState: (name: string) => name === 'CapsLock' && detail.capsLock
  });
  return key ? { code, key } : undefined;
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
      let nativeActive = false;
      let nativeEntry = 0;
      let destroyed = false;
      const exField = () => {
        const field = document.activeElement;
        return (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) &&
          !!field.closest('.cm-vim-panel') && field.parentElement?.firstChild?.textContent === ':' ? field : undefined;
      };
      const syncNativeMode = (force = false) => {
        if (destroyed) return;
        const vim = getCM(view)?.state.vim;
        const field = exField();
        const active = !!vim && (field !== undefined ||
          (view.hasFocus && !vim.insertMode && !vim.exMode && !vim.expectLiteralNext));
        const pending = !!vim && (!!vim.inputState.operator || vim.inputState.keyBuffer.length > 0);
        const entry = active && !field && !pending ? (vim?.visualMode ? 2 : 1) : 0;
        if (!force && active === nativeActive && entry === nativeEntry) return;
        nativeActive = active;
        nativeEntry = entry;
        void setNativeVimAtextual(active, entry).catch(() => {});
      };
      const syncSoon = () => queueMicrotask(syncNativeMode);
      const handler = (event: KeyboardEvent) => {
        if (!physicalExInput(event) && view.contentDOM.contains(event.target as Node)) composingLiteral(event, view);
        syncSoon();
      };
      const nativeHandler = (event: Event) => {
        const detail = (event as CustomEvent<NativePhysicalKey>).detail;
        if (!detail || !nativeActive) return;
        const physical = nativePhysicalKey(detail);
        if (!physical) return;
        const init: KeyboardEventInit = {
          key: physical.key, bubbles: true, cancelable: true, repeat: detail.repeat,
          ctrlKey: detail.ctrlKey, altKey: detail.altKey, metaKey: detail.metaKey, shiftKey: detail.shiftKey
        };
        const field = exField();
        if (field && physical.key.length === 1 && !detail.ctrlKey && !detail.altKey && !detail.metaKey) {
          field.setRangeText(physical.key, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, 'end');
          field.dispatchEvent(new InputEvent('input', { data: physical.key, inputType: 'insertText', bubbles: true }));
        } else {
          (field ?? view.contentDOM).dispatchEvent(new KeyboardEvent('keydown', init));
        }
        // Native interception consumes the previously confirmed state. Publish
        // the result immediately, even when Vim remains in the same broad mode.
        syncNativeMode(true);
      };
      // CodeMirror mounts its command/search panel outside the scrolling editor.
      document.addEventListener('keydown', handler, true);
      document.addEventListener('notework-native-keydown', nativeHandler);
      view.contentDOM.addEventListener('focusin', syncSoon);
      view.contentDOM.addEventListener('focusout', syncSoon);
      view.contentDOM.addEventListener('compositionend', syncSoon);
      syncSoon();
      return {
        update: syncSoon,
        destroy: () => {
          destroyed = true;
          document.removeEventListener('keydown', handler, true);
          document.removeEventListener('notework-native-keydown', nativeHandler);
          view.contentDOM.removeEventListener('focusin', syncSoon);
          view.contentDOM.removeEventListener('focusout', syncSoon);
          view.contentDOM.removeEventListener('compositionend', syncSoon);
          if (nativeActive) void setNativeVimAtextual(false).catch(() => {});
        }
      };
    }),
    Prec.highest(EditorView.domEventHandlers({
      keydown(event, view) {
        const vim = getCM(view)?.state.vim;
        // Inserted text and a pending literal character are symbolic. Search and
        // Ex fields are outside contentDOM; the capture listener handles only Ex.
        if (!vim || (vim.insertMode && !event.ctrlKey) || vim.exMode || vim.expectLiteralNext) return false;
        const key = physicalVimKey(event);
        if (!key) return false;
        // Always replace the original printable key, even when its symbol already
        // matches. Input methods may emit text after that original event unless it
        // is explicitly cancelled, causing commands such as j/k to also type.
        event.preventDefault();
        event.stopImmediatePropagation();
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
