export type Point = readonly [number, number];
export type Stroke = readonly Point[];
export type Drawing = readonly Stroke[];

export const DRAWING_WIDTH = 1024;
// The text page is 32 min-boxes wide; one drawing page is 16 min-boxes tall.
// Store both axes in page units so neither viewport width nor font size changes them.
export const DRAWING_PAGE_HEIGHT = DRAWING_WIDTH * 16 / 32;
export const STROKE_WIDTH = 3;
const header = '<svg xmlns="http://www.w3.org/2000/svg" data-notework-drawing="1"';
export const svgPagePattern = /^[ \t]*\\svgpage\[([^\[\]\r\n]+\.svg)\][ \t]*$/i;

export function drawingBottom(strokes: Drawing) {
  let bottom = 0;
  for (const stroke of strokes) for (const [, y] of stroke) bottom = Math.max(bottom, y);
  return strokes.length ? Math.ceil(bottom + STROKE_WIDTH / 2) : 0;
}

export function strokePoints(stroke: Stroke) {
  const points = stroke.length === 1 ? [stroke[0], stroke[0]] : stroke;
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

export function serializeDrawing(strokes: Drawing) {
  const height = Math.max(1, drawingBottom(strokes));
  const lines = strokes.map((stroke) => `  <polyline points="${strokePoints(stroke)}"/>`).join('\n');
  return `${header} width="${DRAWING_WIDTH}" height="${height}" viewBox="0 0 ${DRAWING_WIDTH} ${height}" preserveAspectRatio="xMinYMin meet">\n<g fill="none" stroke="#202733" stroke-width="${STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round">\n${lines}\n</g>\n</svg>\n`;
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
    return points;
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
