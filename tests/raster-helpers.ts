import { expect, type Page, type Locator } from '@playwright/test';
export async function sizeCanvas(page: Page, width=1024, height=512) {
  await page.getByLabel('Width in pixels').fill(String(width)); await page.getByLabel('Height in pixels').fill(String(height));
  await page.getByRole('button',{name:'Create canvas',exact:true}).click();
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
