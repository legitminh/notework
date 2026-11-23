import { isHexColor } from './drawing';

/**
 * Pen color settings shared by every SVG drawing. Visual documents keep their palette
 * in the document itself; SVG files have no settings of their own, so the palette,
 * recent colors and the current pen color live in this browser.
 */
export const DEFAULT_DRAWING_PALETTE = ['#202733', '#c92a2a', '#e8590c', '#f08c00', '#2f9e44', '#1971c2', '#6741d9', '#ffffff'];
const PALETTE_KEY = 'notework:drawing-palette';
const RECENT_KEY = 'notework:drawing-recent-colors';
const COLOR_KEY = 'notework:drawing-color';
const OPACITY_KEY = 'notework:drawing-opacity';
export const RECENT_LIMIT = 8;

function readColors(key: string, fallback: string[]) {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (Array.isArray(value)) return [...new Set(value.filter(isHexColor).map((color) => color.toLowerCase()))];
  } catch { /* Fall back to defaults. */ }
  return fallback;
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Session only. */ }
}

export interface DrawingColorSettings {
  /** The pen color, or undefined for ink, which follows the theme. */
  color: string | undefined;
  /** Pen opacity in percent. */
  opacity: number;
  palette: string[];
  recent: string[];
}

export function readDrawingColors(): DrawingColorSettings {
  let color: string | undefined, opacity = 100;
  try {
    const stored = localStorage.getItem(COLOR_KEY);
    if (isHexColor(stored)) color = stored.toLowerCase();
    const percent = Number(localStorage.getItem(OPACITY_KEY));
    if (Number.isInteger(percent) && percent >= 1 && percent <= 100) opacity = percent;
  } catch { /* Defaults. */ }
  return { color, opacity, palette: readColors(PALETTE_KEY, DEFAULT_DRAWING_PALETTE), recent: readColors(RECENT_KEY, []) };
}

export function saveDrawingColor(color: string | undefined) {
  try { if (color) localStorage.setItem(COLOR_KEY, color); else localStorage.removeItem(COLOR_KEY); } catch { /* Session only. */ }
}
export const saveDrawingOpacity = (opacity: number) => write(OPACITY_KEY, String(opacity));
export const saveDrawingPalette = (palette: readonly string[]) => write(PALETTE_KEY, JSON.stringify(palette));
export const saveRecentColors = (recent: readonly string[]) => write(RECENT_KEY, JSON.stringify(recent));

/** Move a used color to the front of the recent list. */
export const pushRecentColor = (recent: readonly string[], color: string) =>
  [color, ...recent.filter((item) => item !== color)].slice(0, RECENT_LIMIT);
