import { DRAWING_WIDTH, STROKE_WIDTH, type Drawing, type Point } from './drawing';

export type Box = { left: number; top: number; right: number; bottom: number };
export type Corner = 'nw' | 'ne' | 'sw' | 'se';
export type Selection = { contour: readonly Point[]; box: Box; indices: ReadonlySet<number> };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const roundCoordinate = (value: number) => Math.round(value * 100) / 100;

export function selectStrokes(strokes: Drawing, contour: readonly Point[], minimum: number, limit: number): Selection | undefined {
  if (contour.length < 3) return;
  let left = DRAWING_WIDTH, right = 0, top = limit, bottom = 0;
  for (const [x, y] of contour) {
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  const radius = STROKE_WIDTH / 2;
  const edges = contour.map((point, i) => [point, contour[(i + 1) % contour.length]] as const);
  const indices = new Set<number>();
  strokes.forEach((stroke, index) => {
    if (!stroke.length || !stroke.every(([x, y]) =>
      x >= left + radius && x <= right - radius && y >= top + radius && y <= bottom - radius)) return;
    const [x, y] = stroke[0];
    let inside = false;
    for (const [[ax, ay], [bx, by]] of edges) {
      if ((ay > y) !== (by > y) && x < ax + (bx - ax) * (y - ay) / (by - ay)) inside = !inside;
    }
    if (!inside) return;
    // The whole round stroke must fit, including segments that could cross a
    // concave boundary even when their endpoints are inside.
    for (let i = 0; i < stroke.length; i++) {
      const a = stroke[Math.max(0, i - 1)], b = stroke[i];
      if (edges.some(([c, d]) => nearEdge(a, b, c, d, radius))) return;
    }
    indices.add(index);
  });
  if (!indices.size) return;
  const [x1, x2] = padAxis(left, right, minimum, DRAWING_WIDTH);
  const [y1, y2] = padAxis(top, bottom, minimum, limit);
  return { contour, indices, box: { left: x1, top: y1, right: x2, bottom: y2 } };
}

function padAxis(low: number, high: number, minimum: number, limit: number) {
  const length = Math.min(limit, Math.max(minimum, high - low));
  const start = clamp((low + high - length) / 2, 0, limit - length);
  return [start, start + length];
}

function nearEdge(a: Point, b: Point, c: Point, d: Point, radius: number) {
  if (Math.max(a[0], b[0]) + radius < Math.min(c[0], d[0]) ||
      Math.max(c[0], d[0]) + radius < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) + radius < Math.min(c[1], d[1]) ||
      Math.max(c[1], d[1]) + radius < Math.min(a[1], b[1])) return false;
  const side = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
  return Math.min(distanceSquared(a, c, d), distanceSquared(b, c, d),
    distanceSquared(c, a, b), distanceSquared(d, a, b)) < radius ** 2;
}

function distanceSquared(p: Point, a: Point, b: Point) {
  const dx = b[0] - a[0], dy = b[1] - a[1], x = p[0] - a[0], y = p[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? clamp((x * dx + y * dy) / length, 0, 1) : 0;
  return (x - t * dx) ** 2 + (y - t * dy) ** 2;
}

export function dragBox(box: Box, [dx, dy]: Point, limit: number, corner?: Corner, minimum = 1): Box {
  const { left, top, right, bottom } = box;
  if (!corner) {
    dx = clamp(dx, -left, DRAWING_WIDTH - right);
    dy = clamp(dy, -top, limit - bottom);
    return { left: left + dx, top: top + dy, right: right + dx, bottom: bottom + dy };
  }
  const width = Math.min(minimum, right - left), height = Math.min(minimum, bottom - top);
  return {
    left: corner[1] === 'w' ? clamp(left + dx, 0, right - width) : left,
    right: corner[1] === 'e' ? clamp(right + dx, left + width, DRAWING_WIDTH) : right,
    top: corner[0] === 'n' ? clamp(top + dy, 0, bottom - height) : top,
    bottom: corner[0] === 's' ? clamp(bottom + dy, top + height, limit) : bottom
  };
}

export function transformSelection(strokes: Drawing, selection: Selection, box: Box) {
  const { left, top, right, bottom } = selection.box;
  if (box.left === left && box.top === top && box.right === right && box.bottom === bottom) return { strokes, selection };
  const sx = (box.right - box.left) / (right - left), sy = (box.bottom - box.top) / (bottom - top);
  const transform = ([x, y]: Point): Point =>
    [roundCoordinate(box.left + (x - left) * sx), roundCoordinate(box.top + (y - top) * sy)];
  return {
    strokes: strokes.map((stroke, i) => selection.indices.has(i) ? stroke.map(transform) : stroke),
    selection: { ...selection, box, contour: selection.contour.map(transform) }
  };
}
