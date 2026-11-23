import { expect, type Page, type Locator } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
export async function sizeCanvas(page: Page, width=1024, height=512) {
  await page.getByLabel('width in pixels').fill(String(width)); await page.getByLabel('height in pixels').fill(String(height));
  await page.getByRole('button',{name:'create canvas',exact:true}).click();
}
type Hooked = HTMLElement & { visualEditor: { activeLayer: { raster?: { read(rect: object): { data: Uint8ClampedArray } } } }; visualView: { toScreen(x: number, y: number): [number, number] } };
/** Screen position of a document pixel inside a visual.editor viewport (`canvas` is the role=img viewport). */
export async function rasterPoint(canvas: Locator, x:number,y:number) {
  return canvas.evaluate((node,[x,y]) => {
    const hooked = node as Hooked, rect = node.getBoundingClientRect(), [sx, sy] = hooked.visualView.toScreen(x + 0.5, y + 0.5);
    return { x: rect.x + sx, y: rect.y + sy };
  },[x,y]);
}
/** RGBA of a document pixel on the active layer. */
export async function pixel(canvas: Locator, x:number, y:number) {
  return canvas.evaluate((node,[x,y]) => Array.from((node as Hooked).visualEditor.activeLayer.raster!.read({ x, y, width: 1, height: 1 }).data),[x,y]);
}
export async function alpha(canvas: Locator,x:number,y:number) { return (await pixel(canvas,x,y))[3]; }
export async function expectInk(canvas:Locator, rows:number[], count:number) {
  await expect.poll(async()=>await Promise.all(rows.map(y=>alpha(canvas,140,y)))).toEqual(rows.map((_,i)=>i<count?255:0));
}

/**
 * Put a raster image into the current folder. Notework no longer creates PNG/JPEG/ORA files, but it
 * still opens and edits existing ones, so tests create an empty file of that name through the normal
 * create flow, write real image bytes into its app-owned OPFS file, reload, and select it.
 */
export async function seedImage(page: Page, name: string, width = 1024, height = 512, layers = 1) {
  const action = (label: string) => page.locator(`[data-action=${JSON.stringify(label)}] button, button[data-action=${JSON.stringify(label)}]`);
  await action('app settings').click(); await action('create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill(name);
  await action('create text file').click();
  await expect(action('open')).toBeVisible();
  const format = name.toLowerCase().endsWith('.ora') ? 'ora' : /\.jpe?g$/i.test(name) ? 'jpeg' : 'png';
  const png = await page.evaluate(async ([width, height, jpeg]) => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    if (jpeg) { const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); }
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), jpeg ? 'image/jpeg' : 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, [width, height, format === 'jpeg'] as const);
  const bytes = format === 'ora' ? Array.from(zipSync({
    mimetype: strToU8('image/openraster'),
    'stack.xml': strToU8(`<image w="${width}" h="${height}"><stack>${Array.from({ length: layers }, (_, i) => `<layer name="layer ${layers - i}" src="data/layer${i}.png"/>`).join('')}</stack></image>`),
    ...Object.fromEntries(Array.from({ length: layers }, (_, i) => [`data/layer${i}.png`, new Uint8Array(png)]))
  }, { level: 0 })) : png;
  const written = await page.evaluate(async ([name, bytes]) => {
    const documents = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('notework')).getDirectoryHandle('documents');
    let newest: { handle: FileSystemFileHandle; modified: number } | undefined;
    async function search(folder: FileSystemDirectoryHandle) {
      for await (const entry of (folder as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        if (entry.kind === 'directory') await search(entry as FileSystemDirectoryHandle);
        else if (entry.name === name) {
          const modified = (await (entry as FileSystemFileHandle).getFile()).lastModified;
          if (!newest || modified >= newest.modified) newest = { handle: entry as FileSystemFileHandle, modified };
        }
      }
    }
    await search(documents);
    if (!newest) return false;
    const writable = await newest.handle.createWritable(); await writable.write(new Uint8Array(bytes)); await writable.close();
    return true;
  }, [name, bytes] as const);
  expect(written).toBe(true);
  await page.reload();
  await action(name).click();
  await expect(action('open')).toBeVisible();
}
