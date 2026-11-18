export interface CanvasSize { width: number; height: number }
const KEY = 'notework:canvas-size';
export function validCanvasSize(size: CanvasSize) { return Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0 && size.width <= 16384 && size.height <= 16384 && size.width * size.height <= 32 * 1024 * 1024; }
export function canvasSize(): CanvasSize {
  try { const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null'); if (stored && validCanvasSize(stored)) return stored; } catch {}
  return { width: Math.max(1, Math.round(window.visualViewport?.width ?? window.innerWidth)), height: Math.max(1, Math.round(window.visualViewport?.height ?? window.innerHeight)) };
}
export function rememberCanvasSize(size: CanvasSize) { if (validCanvasSize(size)) { try { localStorage.setItem(KEY,JSON.stringify(size)); } catch {} } }
