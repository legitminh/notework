import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

export type ImageFormat = 'png' | 'jpeg' | 'heic' | 'ora';
export interface ImageLayer { name: string; png: Blob; visible: boolean; opacity: number }
export interface ImageDocument { width: number; height: number; layers: ImageLayer[] }
export const imageFormats: ImageFormat[] = ['png', 'jpeg', 'heic', 'ora'];
export function imageFormat(name: string): ImageFormat | undefined {
  const extension = name.split('.').at(-1)?.toLowerCase();
  return extension === 'jpg' ? 'jpeg' : imageFormats.includes(extension as ImageFormat) ? extension as ImageFormat : undefined;
}
const MAX_PIXELS = 32 * 1024 * 1024;
export function imageCanvas(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > MAX_PIXELS) throw new Error('This image exceeds the editor’s 32 megapixel / 16,384 pixel side limit.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  return canvas;
}
export const canvasBlob = (canvas: HTMLCanvasElement, type = 'image/png') => new Promise<Blob>((resolve, reject) =>
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode this image.')), type, .94));
export async function paintBlob(context: CanvasRenderingContext2D, blob: Blob, x = 0, y = 0) {
  const bitmap = await createImageBitmap(blob);
  try { context.drawImage(bitmap, x, y); } finally { bitmap.close(); }
}
export async function composite(document: ImageDocument, layers = document.layers) {
  const canvas = imageCanvas(document.width, document.height), context = canvas.getContext('2d')!;
  for (const layer of [...layers].reverse()) {
    if (!layer.visible) continue;
    context.globalAlpha = layer.opacity;
    await paintBlob(context, layer.png);
  }
  context.globalAlpha = 1;
  return canvas;
}
let heicSequence = 0;
async function heic(type: 'decode' | 'encode', data: Uint8Array, width?: number, height?: number): Promise<{ data: Uint8Array; image: { width: number; height: number; data: Uint8Array } }> {
  const worker = new Worker(new URL('./heic-worker.ts', import.meta.url), { type: 'module' });
  const id = ++heicSequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('HEIC processing timed out. Your original file is unchanged.')), 120_000);
    function finish(error?: Error, result?: unknown) {
      clearTimeout(timeout); worker.terminate();
      if (error) reject(error); else resolve(result as Awaited<ReturnType<typeof heic>>);
    }
    worker.onerror = (event) => finish(new Error(event.message || 'The local HEIC codec could not start.'));
    worker.onmessage = (event) => { if (event.data.id === id) finish(event.data.error ? new Error(event.data.error) : undefined, event.data); };
    worker.postMessage({ id, type, data, width, height }, [data.buffer]);
  });
}
export async function readImage(file: File): Promise<ImageDocument> {
  if (file.size > 128 * 1024 * 1024) throw new Error('This image exceeds the 128 MB editor limit.');
  const format = imageFormat(file.name);
  if (format === 'ora') {
    let total = 0;
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: ({ originalSize, name }) => {
      if (!['mimetype', 'stack.xml'].includes(name) && !name.toLowerCase().endsWith('.png')) return false;
      total += originalSize;
      if (total > 256 * 1024 * 1024) throw new Error('The expanded ORA exceeds 256 MB.');
      return true;
    } });
    if (!archive['mimetype'] || strFromU8(archive['mimetype']) !== 'image/openraster' || !archive['stack.xml']) throw new Error('This is not an OpenRaster file.');
    const xml = new DOMParser().parseFromString(strFromU8(archive['stack.xml']), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('The ORA layer stack is invalid.');
    const root = xml.documentElement, stack = root.querySelector(':scope > stack');
    const width = Number(root.getAttribute('w')), height = Number(root.getAttribute('h'));
    imageCanvas(width, height);
    if (!stack || stack.querySelector('stack')) throw new Error('Nested ORA layer groups are not supported. Flatten the groups before opening.');
    const layers: ImageLayer[] = [];
    for (const layer of stack.children) {
      if (layers.length >= 100) throw new Error('ORA files may have at most 100 layers.');
      if (layer.localName !== 'layer' || ![null, 'svg:src-over'].includes(layer.getAttribute('composite-op'))) throw new Error('This ORA uses an unsupported layer blend mode.');
      const data = archive[layer.getAttribute('src') ?? ''];
      if (!data) throw new Error('An ORA layer image is missing.');
      const canvas = imageCanvas(width, height);
      await paintBlob(canvas.getContext('2d')!, new Blob([new Uint8Array(data)], { type: 'image/png' }), Number(layer.getAttribute('x') ?? 0), Number(layer.getAttribute('y') ?? 0));
      layers.push({ name: layer.getAttribute('name') || `Layer ${layers.length + 1}`, png: await canvasBlob(canvas), visible: layer.getAttribute('visibility') !== 'hidden', opacity: Math.max(0, Math.min(1, Number(layer.getAttribute('opacity') ?? 1))) });
    }
    if (!layers.length || layers.length > 100) throw new Error('ORA files must have between 1 and 100 layers.');
    return { width, height, layers };
  }
  let canvas: HTMLCanvasElement;
  if (format === 'heic') {
    const { image } = await heic('decode', new Uint8Array(await file.arrayBuffer()));
    canvas = imageCanvas(image.width, image.height);
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  } else {
    const bitmap = await createImageBitmap(file);
    try { canvas = imageCanvas(bitmap.width, bitmap.height); canvas.getContext('2d')!.drawImage(bitmap, 0, 0); }
    finally { bitmap.close(); }
  }
  return { width: canvas.width, height: canvas.height, layers: [{ name: 'Image', png: await canvasBlob(canvas), visible: true, opacity: 1 }] };
}
const escapeXml = (text: string) => text.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
export async function encodeImage(document: ImageDocument, format: ImageFormat): Promise<Blob> {
  const canvas = await composite(document);
  if (format === 'ora') {
    const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
      mimetype: [strToU8('image/openraster'), { level: 0 }],
      'mergedimage.png': new Uint8Array(await (await canvasBlob(canvas)).arrayBuffer())
    };
    const layers: string[] = [];
    for (const [index, layer] of document.layers.entries()) {
      const src = `data/layer${index}.png`;
      entries[src] = new Uint8Array(await layer.png.arrayBuffer());
      layers.push(`<layer name="${escapeXml(layer.name)}" src="${src}" x="0" y="0" opacity="${layer.opacity}" visibility="${layer.visible ? 'visible' : 'hidden'}" composite-op="svg:src-over"/>`);
    }
    entries['stack.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><image version="0.0.3" w="${document.width}" h="${document.height}"><stack>${layers.join('')}</stack></image>`);
    return new Blob([new Uint8Array(zipSync(entries))], { type: 'image/openraster' });
  }
  if (format === 'heic') {
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    const encoded = await heic('encode', new Uint8Array(data.data), canvas.width, canvas.height);
    return new Blob([new Uint8Array(encoded.data)], { type: 'image/heic' });
  }
  if (format === 'jpeg') {
    const context = canvas.getContext('2d')!; context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvasBlob(canvas, format === 'jpeg' ? 'image/jpeg' : 'image/png');
}
export async function blankImage(format: ImageFormat) {
  const canvas = imageCanvas(1024, 512);
  return encodeImage({ width: 1024, height: 512, layers: [{ name: 'Layer 1', png: await canvasBlob(canvas), visible: true, opacity: 1 }] }, format);
}
