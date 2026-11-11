import { keyboard_layouts, type KeyboardLayout } from '@legitminh/keyflow';

export type KeyboardChoice = 'ascii' | keyof typeof keyboard_layouts;
export const keyboardChoices: { id: KeyboardChoice; label: string }[] = [
  { id: 'ascii', label: 'ASCII keyboard' },
  ...Object.entries(keyboard_layouts).map(([id, layout]) => ({ id: id as KeyboardChoice, label: layout.label }))
];
const names: Record<string, string> = { escape: 'Esc', backspace: 'Back', enter: 'Enter', shift: 'Shift',
  capslock: 'Caps', control: 'Ctrl', meta: 'Cmd', alt: 'Alt', space: 'Space', tab: 'Tab',
  arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down', delete: 'Del', contextmenu: 'Menu' };
export const asciiKeyboard: KeyboardLayout = { id: 'ascii', label: 'ASCII keyboard', rows: [
  ...keyboard_layouts['60%'].rows.map((row) => row.map((key) => ({ ...key, label: names[key.key] ?? key.key }))),
  ['arrowleft', 'arrowdown', 'arrowup', 'arrowright', 'delete'].map((key) => ({ key, label: names[key] }))
] };
export const keyboardLayout = (choice: KeyboardChoice) => choice === 'ascii' ? asciiKeyboard : keyboard_layouts[choice];
export const isKeyboardChoice = (value: string | null): value is KeyboardChoice => keyboardChoices.some(({ id }) => id === value);
