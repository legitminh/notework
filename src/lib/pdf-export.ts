import {
  PDFDocument, PDFName, PDFNumber, rgb, pushGraphicsState, popGraphicsState,
  setStrokingColor, setLineWidth, setLineCap, setLineJoin, LineCapStyle, LineJoinStyle,
  moveTo, lineTo, stroke
} from 'pdf-lib';
import { DRAWING_WIDTH, DRAWING_PAGE_HEIGHT, STROKE_WIDTH, drawingBottom, svgPagePattern, type Drawing } from './drawing';
import { wikiPattern } from './wiki';

import type { ExportStyle } from './export-style';

export interface RasterDrawing { blob: Blob; width: number; height: number }
export type PdfSource = {
  name: string;
  style: ExportStyle;
} & ({ kind: 'text'; lines: () => Iterable<string>; drawing: (name: string) => Promise<Drawing | RasterDrawing> } |
  { kind: 'drawing'; strokes: Drawing } | { kind: 'image'; image: RasterDrawing });

export type ExportFormat = 'pdf' | 'png' | 'jpeg';

interface Fragment { text: string; x: number; top: number; baseline: number; width: number; height: number; color: string }
interface DrawingBlock { top: number; width: number; strokes: Drawing; image?: RasterDrawing }
const yieldTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Full-document browser layout, independent of CodeMirror's virtualized DOM. */
async function layout(source: PdfSource, signal: AbortSignal) {
  const { style } = source;
  const fragments: Fragment[] = [], drawings: DrawingBlock[] = [];
  let width = style.width, height = 0;
  if (source.kind === 'image') return { fragments, drawings: [{ top: 0, width, strokes: [], image: source.image }], width, height: source.image.height / source.image.width * width };
  if (source.kind === 'drawing') {
    return { fragments, drawings: [{ top: 0, width, strokes: source.strokes }], width,
      height: (drawingBottom(source.strokes) || DRAWING_PAGE_HEIGHT) * width / DRAWING_WIDTH };
  }
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, visibility: 'hidden',
    pointerEvents: 'none', font: style.font, lineHeight: `${style.lineHeight}px`, tabSize: '2',
    whiteSpace: style.wrap ? 'pre-wrap' : 'pre', overflowWrap: 'anywhere'
  });
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = style.font;
  const metrics = measure.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent ?? style.fontSize * .8;
  const range = document.createRange();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let count = 0;
  try {
    await document.fonts.ready;
    for (const line of source.lines()) {
      signal.throwIfAborted();
      const page = svgPagePattern.exec(line);
      if (page) {
        const resource = await source.drawing(page[1]);
        const image = 'blob' in resource ? resource : undefined;
        const strokes = image ? [] : resource as Drawing;
        drawings.push({ top: height, width: style.width, strokes, image });
        height += image ? image.height / image.width * style.width : (drawingBottom(strokes) || DRAWING_PAGE_HEIGHT) * style.width / DRAWING_WIDTH;
        continue;
      }
      const paragraph = document.createElement('div');
      paragraph.style.minHeight = `${style.lineHeight}px`;
      if (!style.wrap) paragraph.style.width = 'max-content';
      const runs: { node: Text; color: string }[] = [];
      function append(text: string, color: string) {
        for (const part of text.split(/(\t)/)) {
          if (!part) continue;
          const span = document.createElement('span');
          span.textContent = part;
          paragraph.append(span);
          if (part !== '\t') runs.push({ node: span.firstChild as Text, color });
        }
      }
      let position = 0;
      for (const match of line.matchAll(new RegExp(wikiPattern))) {
        append(line.slice(position, match.index), style.foreground);
        append(match[0], style.link);
        position = match.index! + match[0].length;
      }
      append(line.slice(position), style.foreground);
      host.replaceChildren(paragraph);
      const origin = host.getBoundingClientRect();
      const paragraphHeight = paragraph.getBoundingClientRect().height;
      for (const { node, color } of runs) {
        const boundaries = Array.from(segmenter.segment(node.data), (part) => part.index);
        boundaries.push(node.length);
        let start = 0;
        while (start < boundaries.length - 1) {
          range.setStart(node, boundaries[start]);
          range.setEnd(node, boundaries[start + 1]);
          const top = range.getBoundingClientRect().top;
          let low = start + 1, high = boundaries.length - 1;
          // Find each soft-wrapped row without measuring every character.
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            range.setEnd(node, boundaries[middle]);
            const fits = Array.from(range.getClientRects()).every((rect) => Math.abs(rect.top - top) < 1);
            if (fits) low = middle; else high = middle - 1;
          }
          range.setEnd(node, boundaries[low]);
          const rect = range.getBoundingClientRect();
          const x = rect.left - origin.left, y = height + rect.top - origin.top;
          fragments.push({ text: node.data.slice(boundaries[start], boundaries[low]), x, top: y,
            baseline: y + ascent, width: rect.width, height: rect.height, color });
          width = Math.max(width, x + rect.width);
          start = low;
        }
      }
      height += Math.max(style.lineHeight, paragraphHeight);
      if (++count % 128 === 0) await yieldTask();
    }
    return { width, height: Math.max(1, height), fragments, drawings };
  } finally { range.detach(); host.remove(); }
}

export async function createPdf(source: PdfSource, signal: AbortSignal): Promise<File> {
  const content = await layout(source, signal);
  signal.throwIfAborted();
  const pdf = await PDFDocument.create();
  pdf.setTitle(source.name); pdf.setCreator('Notework'); pdf.setProducer('Notework');
  const { margins, minBox } = source.style;
  const left = margins.left * minBox, top = margins.top * minBox;
  const width = content.width + left + margins.right * minBox;
  const height = content.height + top + margins.bottom * minBox;
  // PDF's UserUnit keeps very tall notes on one page without truncation or distortion.
  const userUnit = Math.max(1, Math.ceil(Math.max(width, height) * .75 / 14400));
  if (userUnit > 75000) throw new Error('This document exceeds the single-page PDF size limit.');
  const scale = .75 / userUnit;
  const page = pdf.addPage([width * scale, height * scale]);
  if (userUnit > 1) page.node.set(PDFName.of('UserUnit'), PDFNumber.of(userUnit));
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = 1;
  const colors = colorCanvas.getContext('2d')!;
  function color(value: string) {
    colors.clearRect(0, 0, 1, 1); colors.fillStyle = value; colors.fillRect(0, 0, 1, 1);
    const [r, g, b] = colors.getImageData(0, 0, 1, 1).data;
    return rgb(r / 255, g / 255, b / 255);
  }
  page.drawRectangle({ x: 0, y: 0, width: page.getWidth(), height: page.getHeight(), color: color(source.style.background) });
  // Small transparent tiles retain system fonts/Unicode without iOS canvas-size limits.
  // SVGs are drawn separately as native PDF paths, never flattened into these images.
  content.fragments.sort((a, b) => a.top - b.top);
  let first = 0;
  for (let y = 0; y < content.height; y += 512) {
    signal.throwIfAborted();
    while (first < content.fragments.length && content.fragments[first].top + content.fragments[first].height <= y) first++;
    const rows: Fragment[] = [];
    for (let i = first; i < content.fragments.length && content.fragments[i].top < y + 512; i++) rows.push(content.fragments[i]);
    if (!rows.length) continue;
    for (let x = 0; x < content.width; x += 1024) {
      const visible = rows.filter((item) => item.x + item.width > x && item.x < x + 1024);
      if (!visible.length) continue;
      const w = Math.min(1024, content.width - x), h = Math.min(512, content.height - y);
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(w * 2); canvas.height = Math.ceil(h * 2);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser could not create the PDF drawing surface.');
      context.scale(2, 2); context.font = source.style.font; context.textBaseline = 'alphabetic';
      for (const item of visible) {
        context.fillStyle = item.color;
        context.fillText(item.text, item.x - x, item.baseline - y);
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) =>
        blob ? resolve(blob) : reject(new Error('The PDF text could not be rendered.')), 'image/png'));
      const image = await pdf.embedPng(await blob.arrayBuffer());
      await image.embed();
      page.drawImage(image, { x: (left + x) * scale, y: page.getHeight() - (top + y + h) * scale, width: w * scale, height: h * scale });
      canvas.width = canvas.height = 0;
    }
    await yieldTask();
  }
  const ink = color(source.style.foreground);
  for (const drawing of content.drawings) {
    signal.throwIfAborted();
    if (drawing.image) {
      const image = await pdf.embedPng(await drawing.image.blob.arrayBuffer());
      const height = drawing.image.height / drawing.image.width * drawing.width;
      page.drawImage(image, { x: left * scale, y: page.getHeight() - (top + drawing.top + height) * scale, width: drawing.width * scale, height: height * scale });
    }
    const unit = drawing.width / DRAWING_WIDTH * scale;
    for (const points of drawing.strokes) {
      if (!points.length) continue;
      const at = ([x, y]: readonly number[]) => ({ x: left * scale + x * unit, y: page.getHeight() - (top + drawing.top) * scale - y * unit });
      if (points.length === 1) {
        page.drawCircle({ ...at(points[0]), size: STROKE_WIDTH / 2 * unit, color: ink });
        continue;
      }
      const start = at(points[0]);
      page.pushOperators(pushGraphicsState(), setStrokingColor(ink), setLineWidth(STROKE_WIDTH * unit),
        setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), moveTo(start.x, start.y));
      for (const point of points.slice(1)) { const { x, y } = at(point); page.pushOperators(lineTo(x, y)); }
      page.pushOperators(stroke(), popGraphicsState());
    }
  }
  signal.throwIfAborted();
  const data = await pdf.save();
  const name = source.name.replace(/\.[^.]+$/, '') || source.name;
  return new File([new Uint8Array(data)], `${name}.pdf`, { type: 'application/pdf' });
}

const RASTER_MAX_SIDE = 8192;
const RASTER_MAX_PIXELS = 16_000_000;

/** Render the same custom-sized page as the PDF into one uniformly scaled bitmap. */
export async function createRaster(source: PdfSource, format: 'png' | 'jpeg', signal: AbortSignal): Promise<File> {
  const content = await layout(source, signal);
  signal.throwIfAborted();
  const { margins, minBox } = source.style;
  const left = margins.left * minBox, top = margins.top * minBox;
  const pageWidth = content.width + left + margins.right * minBox;
  const pageHeight = content.height + top + margins.bottom * minBox;
  const scale = Math.min(1, RASTER_MAX_SIDE / pageWidth, RASTER_MAX_SIDE / pageHeight,
    Math.sqrt(RASTER_MAX_PIXELS / (pageWidth * pageHeight)));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('This document exceeds the single-image export size limit.');
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(pageWidth * scale));
  canvas.height = Math.max(1, Math.floor(pageHeight * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create the image drawing surface.');
  context.fillStyle = source.style.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale);
  context.font = source.style.font;
  context.textBaseline = 'alphabetic';
  for (const item of content.fragments) {
    signal.throwIfAborted();
    context.fillStyle = item.color;
    context.fillText(item.text, left + item.x, top + item.baseline);
  }
  context.strokeStyle = source.style.foreground;
  context.fillStyle = source.style.foreground;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const drawing of content.drawings) {
    signal.throwIfAborted();
    if (drawing.image) {
      const bitmap = await createImageBitmap(drawing.image.blob);
      try { context.drawImage(bitmap, left, top + drawing.top, drawing.width, drawing.image.height / drawing.image.width * drawing.width); }
      finally { bitmap.close(); }
    }
    const unit = drawing.width / DRAWING_WIDTH;
    context.lineWidth = STROKE_WIDTH * unit;
    for (const points of drawing.strokes) {
      if (!points.length) continue;
      const at = ([x, y]: readonly number[]) => [left + x * unit, top + drawing.top + y * unit] as const;
      if (points.length === 1) {
        const [x, y] = at(points[0]);
        context.beginPath(); context.arc(x, y, STROKE_WIDTH / 2 * unit, 0, Math.PI * 2); context.fill();
        continue;
      }
      const [x, y] = at(points[0]);
      context.beginPath(); context.moveTo(x, y);
      for (const point of points.slice(1)) { const [nextX, nextY] = at(point); context.lineTo(nextX, nextY); }
      context.stroke();
    }
  }
  signal.throwIfAborted();
  const type = format === 'png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) =>
    result && result.type === type ? resolve(result) : reject(new Error(`The browser could not encode a ${format.toUpperCase()} image.`)),
  type, format === 'jpeg' ? .95 : undefined));
  canvas.width = canvas.height = 0;
  signal.throwIfAborted();
  const name = source.name.replace(/\.[^.]+$/, '') || source.name;
  return new File([blob], `${name}.${format}`, { type });
}

export function createExport(source: PdfSource, format: ExportFormat, signal: AbortSignal) {
  return format === 'pdf' ? createPdf(source, signal) : createRaster(source, format, signal);
}
