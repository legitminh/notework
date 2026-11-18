import { expect, type Page, type Locator } from '@playwright/test';
export async function sizeCanvas(page: Page, width=1024, height=512) {
  await page.getByLabel('Width in pixels').fill(String(width)); await page.getByLabel('Height in pixels').fill(String(height));
  await page.getByRole('button',{name:'Create canvas',exact:true}).click();
}
export async function rasterPoint(canvas: Locator, x:number,y:number) {
  return canvas.locator('[data-image-layer="active"] canvas').evaluate((node,[x,y]) => {
    const rect=node.getBoundingClientRect();return {x:rect.x+x*rect.width/(node as HTMLCanvasElement).width,y:rect.y+y*rect.height/(node as HTMLCanvasElement).height};
  },[x,y]);
}
export async function alpha(canvas: Locator,x:number,y:number) { return canvas.locator('[data-image-layer="active"] canvas').evaluate((node,[x,y]) => (node as HTMLCanvasElement).getContext('2d')!.getImageData(x,y,1,1).data[3],[x,y]); }
export async function expectInk(canvas:Locator, rows:number[], count:number) {
  await expect.poll(async()=>await Promise.all(rows.map(y=>alpha(canvas,140,y)))).toEqual(rows.map((_,i)=>i<count?255:0));
}
