export type Point = readonly [number, number];
/** Optional paint for a stroke. Without a color a stroke is "ink", which follows the theme. */
export type StrokePaint = { color?: string; opacity?: number };
export type Stroke = readonly Point[] & { width?: number; erase?: boolean } & StrokePaint;
export const strokeWidth = (stroke: Stroke) => stroke.width ?? STROKE_WIDTH;
export const isHexColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
/** The paint a stroke carries, normalized: ink and full opacity are omitted. */
export function strokePaint(stroke: StrokePaint): StrokePaint {
  const paint: StrokePaint = {};
  if (isHexColor(stroke.color)) paint.color = stroke.color.toLowerCase();
  if (typeof stroke.opacity === 'number' && stroke.opacity > 0 && stroke.opacity < 1) paint.opacity = Math.round(stroke.opacity * 100) / 100;
  return paint;
}
export const sizedStroke = (points: readonly Point[], width: number, erase = false, paint: StrokePaint = {}): Stroke =>
  Object.assign([...points], { width, erase }, erase ? {} : strokePaint(paint));
export type Drawing = readonly Stroke[];

export const DRAWING_WIDTH = 1024;
// The text page is 32 min-boxes wide; one drawing page is 16 min-boxes tall.
// Store both axes in page units so neither viewport width nor font size changes them.
export const DRAWING_PAGE_HEIGHT = DRAWING_WIDTH * 16 / 32;
export const STROKE_WIDTH = 3;
/** The color "ink" strokes are saved with; editors show ink in the theme's text color. */
export const INK_COLOR = '#202733';
const header = '<svg xmlns="http://www.w3.org/2000/svg" data-notework-drawing="1"';
export const svgPagePattern = /^[ \t]*\\(?:svg|png|jpeg|heic|ora|visual)page\[([^\[\]\r\n]+)\][ \t]*$/i;

export function drawingBottom(strokes: Drawing) {
  let bottom = 0;
  for (const stroke of strokes) for (const [, y] of stroke) bottom = Math.max(bottom, y + strokeWidth(stroke) / 2);
  return strokes.length ? Math.ceil(bottom) : 0;
}

export function strokePoints(stroke: Stroke) {
  const points = stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

export function serializeDrawing(strokes: Drawing) {
  const height = Math.max(1, drawingBottom(strokes));
  const lines = strokes.map((stroke) => {
    const { color, opacity } = strokePaint(stroke);
    const paint = `${color ? ` stroke="${color}"` : ''}${opacity !== undefined ? ` stroke-opacity="${opacity}"` : ''}`;
    return `  <polyline points="${strokePoints(stroke)}" stroke-width="${strokeWidth(stroke)}"${paint}/>`;
  }).join('\n');
  return `${header} width="${DRAWING_WIDTH}" height="${height}" viewBox="0 0 ${DRAWING_WIDTH} ${height}" preserveAspectRatio="xMinYMin meet">\n<g fill="none" stroke="${INK_COLOR}" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">\n${lines}\n</g>\n</svg>\n`;
}

export async function isDrawingFile(file: File) {
  return file.name.toLowerCase().endsWith('.svg') && (await file.slice(0, header.length).text()) === header;
}

export async function readDrawing(file: File): Promise<Drawing> {
  if (!await isDrawingFile(file)) throw new Error('This SVG is not a Notework drawing.');
  if (file.size > 16 * 1024 * 1024) throw new Error('This drawing is too large to open.');
  const svg = new DOMParser().parseFromString(await file.text(), 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg' || svg.getAttribute('data-notework-drawing') !== '1' ||
      svg.children.length !== 1 || svg.firstElementChild?.localName !== 'g') {
    throw new Error('This drawing contains unsupported SVG data.');
  }
  return Array.from(svg.firstElementChild.children, (line) => {
    const coordinates = line.getAttribute('points');
    if (line.localName !== 'polyline' || !coordinates?.trim()) throw new Error('This drawing contains an invalid stroke.');
    const points = coordinates.trim().split(/\s+/).map((pair): Point => {
      if (!/^\d+(?:\.\d+)?,\d+(?:\.\d+)?$/.test(pair)) throw new Error('This drawing contains an invalid point.');
      const [x, y] = pair.split(',').map(Number);
      if (!Number.isFinite(y) || x > DRAWING_WIDTH || y > 10_000_000) throw new Error('This drawing contains an out-of-range point.');
      return [x, y];
    });
    const width = Number(line.getAttribute('stroke-width') ?? svg.firstElementChild!.getAttribute('stroke-width') ?? STROKE_WIDTH);
    if (!Number.isFinite(width) || width <= 0 || width > DRAWING_WIDTH) throw new Error('This drawing contains an invalid pen size.');
    const color = line.getAttribute('stroke'), opacity = line.getAttribute('stroke-opacity');
    if (color !== null && !isHexColor(color)) throw new Error('This drawing contains an invalid stroke color.');
    if (opacity !== null && !(Number(opacity) > 0 && Number(opacity) <= 1)) throw new Error('This drawing contains an invalid stroke opacity.');
    return sizedStroke(points, width, false, { color: color ?? undefined, opacity: opacity === null ? undefined : Number(opacity) });
  });
}

export function svgPageNames(lines: Iterable<string>) {
  const names = new Set<string>();
  for (const line of lines) {
    const match = svgPagePattern.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

/** Distances are measured in CSS pixels even when the drawing is scaled to fit. */
export function touchesStroke(stroke: Stroke, point: Point, scale: number, radius = 8) {
  for (let i = 0; i < stroke.length; i++) {
    const a = stroke[Math.max(0, i - 1)], b = stroke[i];
    const dx = (b[0] - a[0]) * scale, dy = (b[1] - a[1]) * scale;
    const px = (point[0] - a[0]) * scale, py = (point[1] - a[1]) * scale;
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
    if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= radius ** 2) return true;
  }
  return false;
}
