import { canvasBlob, imageCanvas, paintBlob, type ImageDocument } from './images';
import type { Point } from './drawing';

export interface PixelBox { x: number; y: number; width: number; height: number }
export interface RasterLayer { id: string; name: string; visible: boolean; opacity: number; canvas: HTMLCanvasElement }
interface Tile extends PixelBox { layer: RasterLayer; before: ImageData; after?: ImageData }
interface Frame { tiles: Tile[]; before: number; after: number; layersBefore?: RasterLayer[]; layersAfter?: RasterLayer[] }
export interface PixelSelection extends PixelBox { mask: HTMLCanvasElement; pixels: HTMLCanvasElement; path: Point[] }
const TILE = 128, HISTORY_BYTES = 96 * 1024 * 1024;

/** Pixels are authoritative. History copies only touched tiles, once per operation. */
export class Raster {
  layers: RasterLayer[] = [];
  revision = 0;
  private sequence = 0;
  private undoFrames: Frame[] = [];
  private redoFrames: Frame[] = [];
  private pending?: Frame;
  private captured = new Set<string>();
  private encoded = new WeakMap<HTMLCanvasElement,Promise<Blob>>();
  constructor(readonly width: number, readonly height: number) {}
  static async open(image: ImageDocument) {
    const raster = new Raster(image.width, image.height);
    raster.layers = await Promise.all(image.layers.map(async (layer) => {
      const canvas = imageCanvas(image.width, image.height);
      await paintBlob(canvas.getContext('2d')!, layer.png);
      raster.encoded.set(canvas,Promise.resolve(layer.png));
      return { ...layer, id: crypto.randomUUID(), canvas };
    }));
    return raster;
  }
  get canUndo() { return this.undoFrames.length > 0; }
  get canRedo() { return this.redoFrames.length > 0; }
  begin() { if (!this.pending) { this.pending = { before: this.revision, after: 0, tiles: [] }; this.captured.clear(); } }
  capture(layer: RasterLayer, box: PixelBox) {
    this.begin(); this.encoded.delete(layer.canvas);
    const x0 = Math.max(0, Math.floor(box.x / TILE)), y0 = Math.max(0, Math.floor(box.y / TILE));
    const x1 = Math.min(Math.ceil(this.width / TILE), Math.ceil((box.x + box.width) / TILE));
    const y1 = Math.min(Math.ceil(this.height / TILE), Math.ceil((box.y + box.height) / TILE));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const key = `${layer.id}:${x}:${y}`;
      if (this.captured.has(key)) continue;
      this.captured.add(key);
      const tile = { x: x * TILE, y: y * TILE, width: Math.min(TILE, this.width - x * TILE), height: Math.min(TILE, this.height - y * TILE) };
      this.pending!.tiles.push({ ...tile, layer, before: layer.canvas.getContext('2d')!.getImageData(tile.x, tile.y, tile.width, tile.height) });
    }
  }
  commit() {
    const frame = this.pending; this.pending = undefined;
    if (!frame || (!frame.tiles.length && !frame.layersBefore)) return false;
    for (const tile of frame.tiles) tile.after = tile.layer.canvas.getContext('2d')!.getImageData(tile.x, tile.y, tile.width, tile.height);
    frame.after = ++this.sequence; this.revision = frame.after;
    this.undoFrames.push(frame); this.redoFrames = [];
    let bytes = 0;
    for (let i = this.undoFrames.length - 1; i >= 0; i--) {
      bytes += this.undoFrames[i].tiles.reduce((sum, tile) => sum + tile.before.data.byteLength * 2, 0);
      if ((bytes > HISTORY_BYTES && i < this.undoFrames.length - 1) || this.undoFrames.length - i > 100) { this.undoFrames.splice(0, i + 1); break; }
    }
    return true;
  }
  cancel() { if (this.pending) this.apply(this.pending, false); this.pending = undefined; }
  private apply(frame: Frame, forward: boolean) {
    for (const tile of frame.tiles) { this.encoded.delete(tile.layer.canvas); tile.layer.canvas.getContext('2d')!.putImageData(forward ? tile.after! : tile.before, tile.x, tile.y); }
    const layers = forward ? frame.layersAfter : frame.layersBefore;
    if (layers) this.layers = layers.map((layer) => ({ ...layer }));
    this.revision = forward ? frame.after : frame.before;
  }
  undo() { const frame = this.undoFrames.pop(); if (frame) { this.apply(frame, false); this.redoFrames.push(frame); } }
  redo() { const frame = this.redoFrames.pop(); if (frame) { this.apply(frame, true); this.undoFrames.push(frame); } }
  changeLayers(change: (layers: RasterLayer[]) => RasterLayer[]) {
    this.begin(); this.pending!.layersBefore = this.layers.map((layer) => ({ ...layer }));
    this.layers = change(this.layers.map((layer) => ({ ...layer })));
    this.pending!.layersAfter = this.layers.map((layer) => ({ ...layer })); this.commit();
  }
  brush(layer: RasterLayer, from: Point, to: Point, size: number, erase: boolean, selection?: PixelSelection) {
    const radius = size / 2 + 2;
    this.capture(layer, { x: Math.min(from[0], to[0]) - radius, y: Math.min(from[1], to[1]) - radius,
      width: Math.abs(to[0] - from[0]) + radius * 2, height: Math.abs(to[1] - from[1]) + radius * 2 });
    const ctx = layer.canvas.getContext('2d')!;
    ctx.save();
    if (selection) { ctx.beginPath(); selection.path.forEach(([x,y], i) => i ? ctx.lineTo(x,y) : ctx.moveTo(x,y)); ctx.closePath(); ctx.clip('evenodd'); }
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#202733'; ctx.fillStyle = '#202733'; ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (from[0] === to[0] && from[1] === to[1]) { ctx.beginPath(); ctx.arc(to[0], to[1], size / 2, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(...from); ctx.lineTo(...to); ctx.stroke(); }
    ctx.restore();
  }
  select(layer: RasterLayer, path: Point[]): PixelSelection | undefined {
    if (path.length < 3) return;
    const bounds = path.reduce((box,p) => ({ left:Math.min(box.left,p[0]),top:Math.min(box.top,p[1]),right:Math.max(box.right,p[0]),bottom:Math.max(box.bottom,p[1]) }),{left:Infinity,top:Infinity,right:-Infinity,bottom:-Infinity});
    const x = Math.max(0,Math.floor(bounds.left)), y = Math.max(0,Math.floor(bounds.top));
    const right = Math.min(this.width,Math.ceil(bounds.right)), bottom = Math.min(this.height,Math.ceil(bounds.bottom));
    if (right <= x || bottom <= y) return;
    const mask = imageCanvas(right - x, bottom - y), ctx = mask.getContext('2d')!;
    ctx.translate(-x, -y); ctx.beginPath(); path.forEach(([px,py], i) => i ? ctx.lineTo(px,py) : ctx.moveTo(px,py)); ctx.closePath(); ctx.fill('evenodd');
    const pixels = imageCanvas(mask.width, mask.height), selected = pixels.getContext('2d')!;
    selected.drawImage(layer.canvas, -x, -y); selected.globalCompositeOperation = 'destination-in'; selected.drawImage(mask, 0, 0);
    return { x, y, width: mask.width, height: mask.height, mask, pixels, path };
  }
  clear(layer: RasterLayer, selection: PixelSelection) {
    this.capture(layer, selection);
    const ctx = layer.canvas.getContext('2d')!;
    ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(selection.mask, selection.x, selection.y); ctx.restore();
  }
  place(layer: RasterLayer, selection: PixelSelection, box: PixelBox) {
    this.capture(layer, box); layer.canvas.getContext('2d')!.drawImage(selection.pixels, box.x, box.y, box.width, box.height);
  }
  async snapshot(): Promise<ImageDocument> {
    // Snapshot each canvas synchronously before awaiting encoders, so a later edit cannot leak into an earlier save.
    const layers = this.layers.map(layer => {
      let png = this.encoded.get(layer.canvas);
      if (!png) {
        const pending = canvasBlob(layer.canvas); png = pending; this.encoded.set(layer.canvas,pending);
        void pending.catch(() => { if (this.encoded.get(layer.canvas) === pending) this.encoded.delete(layer.canvas); });
      }
      return { ...layer, png };
    });
    return { width: this.width, height: this.height, layers: await Promise.all(layers.map(async layer => ({ name: layer.name, visible: layer.visible, opacity: layer.opacity, png: await layer.png }))) };
  }
}
