import { rasterPoint, alpha as rasterAlpha, seedImage } from './raster-helpers';
import { chooseMenu } from './menu-helpers';
import { test, expect, webkit } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('WebKit persistent storage creates folders, text, and drawings without cloning handles', async ({ browserName, baseURL }) => {
  test.skip(browserName !== 'webkit', 'Runs with --browser=webkit and a persistent WebKit profile.');
  const profile = await mkdtemp(join(tmpdir(), 'notework-webkit-'));
  const context = await webkit.launchPersistentContext(profile, { viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'standalone', { value: true });
      Object.defineProperty(navigator, 'canShare', { value: (data: ShareData) =>
        ['application/pdf', 'image/png', 'image/jpeg'].includes(data.files?.[0]?.type ?? '') });
      Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => {
        sessionStorage.setItem('pdf-share', JSON.stringify({ name: data.files![0].name, type: data.files![0].type,
          active: navigator.userActivation.isActive, size: data.files![0].size }));
      } });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(baseURL!);
    const action = (name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button, button[data-action=${JSON.stringify(name)}]`);
    await action('app settings').click();
    await action('create new file/folder').click();
    await page.getByLabel('name', { exact: true }).fill('iPad notes');
    await action('create folder').click();
    await expect(page.getByRole('heading', { name: 'iPad notes/', exact: true })).toBeVisible();
    await action('create new file/folder').click();
    await page.getByLabel('name', { exact: true }).fill('first.txt');
    await action('create text file').click();
    await action('open').click();
    const editor = page.getByRole('textbox', { name: 'edit first.txt', exact: true });
    await expect(editor).toBeVisible();
    await editor.fill('Written on iPad');
    const toolbar = page.getByRole('group', { name: 'editor toolbar' });
    await page.keyboard.press('ControlOrMeta+s');
    await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
    await toolbar.getByRole('button', { name: 'export', exact: true }).click();
    const exportDialog = page.getByRole('dialog', { name: 'export', exact: true });
    await expect(exportDialog.getByRole('button', { name: 'share PDF', exact: true })).toBeEnabled();
    const downloadPdf = page.waitForEvent('download');
    await exportDialog.getByRole('button', { name: 'download PDF', exact: true }).click();
    expect((await downloadPdf).suggestedFilename()).toBe('first.pdf');
    await toolbar.getByRole('button', { name: 'export', exact: true }).click();
    await expect(exportDialog.getByRole('button', { name: 'share PDF', exact: true })).toBeEnabled();
    await exportDialog.getByRole('button', { name: 'share PDF', exact: true }).click();
    await expect(exportDialog).toHaveCount(0);
    const shared = await page.evaluate(() => JSON.parse(sessionStorage.getItem('pdf-share')!));
    expect(shared).toMatchObject({ name: 'first.pdf', type: 'application/pdf', active: true });
    expect(shared.size).toBeGreaterThan(100);

    for (const [format, label] of [['png', 'PNG'], ['jpeg', 'JPEG']] as const) {
      await toolbar.getByRole('button', { name: 'export', exact: true }).click();
      await chooseMenu(exportDialog, 'export format', format);
      await expect(exportDialog.getByRole('button', { name: `share ${label}`, exact: true })).toBeEnabled();
      const downloaded = page.waitForEvent('download');
      await exportDialog.getByRole('button', { name: `download ${label}`, exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe(`first.${format}`);
    }

    await toolbar.getByRole('button', { name: 'exit', exact: true }).click();
    await expect(action('open')).toBeVisible();
    await page.keyboard.press('Meta+f');
    const contentSearch = page.getByRole('dialog', { name: 'find in contents', exact: true });
    await contentSearch.getByRole('searchbox').fill('ON IPAD');
    await expect(contentSearch.locator('.content-search-status')).toContainText('1 matching file');
    await expect(contentSearch.locator('mark')).toHaveText('on iPad');
    await contentSearch.locator('.content-match button').click();
    await expect(editor).toHaveText('Written on iPad');
    await toolbar.getByRole('button', { name: 'exit', exact: true }).click();
    await action('..').click();
    await action('create new file/folder').click();
    await page.getByLabel('name', { exact: true }).fill('sketch');
    await action('create svg file').click();
    await action('open').click();
    const drawingToolbar = page.getByRole('group', { name: 'drawing toolbar' });
    await expect(drawingToolbar).toBeVisible();
    const canvas = page.getByRole('img', { name: 'drawing canvas for sketch.svg' });
    const model = await canvas.evaluate((el) => {
      const m = (el as SVGSVGElement).getScreenCTM()!;
      return { a: m.a, d: m.d, e: m.e, f: m.f };
    });
    expect(model.a).toBeCloseTo(model.d, 5);
    await page.mouse.move(model.e + 200 * model.a, model.f + 100 * model.d);
    await page.mouse.down();
    for (const [x, y] of [[400, 100], [400, 300], [200, 300], [200, 100]]) {
      await page.mouse.move(model.e + x * model.a, model.f + y * model.d);
    }
    await page.mouse.up();
    for (const viewport of [{ width: 1180, height: 820 }, { width: 820, height: 1180 }]) {
      await page.setViewportSize(viewport);
      await expect.poll(() => canvas.evaluate((el) => {
        const m = (el as SVGSVGElement).getScreenCTM()!;
        return Math.abs(m.a - m.d);
      })).toBeLessThan(.0001);
      const square = (await canvas.locator('polyline').boundingBox())!;
      const originalRatio = await canvas.locator('polyline').evaluate((el) => {
        const box = (el as SVGGraphicsElement).getBBox();
        return box.width / box.height;
      });
      expect(square.width / square.height).toBeCloseTo(originalRatio, 3);
    }
    await page.keyboard.press('ControlOrMeta+s');
    await drawingToolbar.getByRole('button', { name: 'exit', exact: true }).click();
    await expect(action('open')).toBeVisible();
    await page.reload();
    await action('iPad notes/').click();
    await action('first.txt').click();
    await action('open').click();
    await expect(editor).toHaveText('Written on iPad');
    await toolbar.getByRole('button', { name: 'exit', exact: true }).click();
    await action('configure file').click();
    await action('rename').click();
    let dialog = page.getByRole('dialog', { name: 'rename file' });
    await dialog.getByRole('textbox').fill('renamed.txt');
    await dialog.getByRole('button', { name: 'rename and update links' }).click();
    await expect(page.getByRole('heading', { name: 'renamed.txt', exact: true })).toBeVisible();
    await action('..').click();
    await action('configure folder').click();
    await action('rename').click();
    dialog = page.getByRole('dialog', { name: 'rename folder' });
    await dialog.getByRole('textbox').fill('iPad archive');
    await dialog.getByRole('button', { name: 'rename and update links' }).click();
    await expect(page.getByRole('heading', { name: 'iPad archive/', exact: true })).toBeVisible();
    await expect(action('configure folder')).toBeEnabled();
    await page.reload();
    await action('iPad archive/').click();
    await action('renamed.txt').click();
    await action('open').click();
    await expect(page.getByRole('textbox', { name: 'edit renamed.txt' })).toHaveText('Written on iPad');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('WebKit raster canvas paints pixels, clears a lasso region, and saves undo/redo results', async ({ browserName, baseURL }, testInfo) => {
  test.skip(browserName !== 'webkit', 'Uses isolated persistent WebKit storage.');
  const profile = await mkdtemp(join(tmpdir(), 'notework-raster-webkit-'));
  const context = await webkit.launchPersistentContext(profile, { viewport: {width:820,height:1180},isMobile:true,hasTouch:true });
  try {
    const page = await context.newPage();
    await page.goto(baseURL!);
    const button = (name:string) => page.getByRole('button',{name,exact:true});
    await seedImage(page,'pixels.png',400,200);
    await page.locator('[data-action="open"] button').click();
    const canvas=page.getByRole('img',{name:'drawing canvas for pixels.png'}), pixels=canvas.locator('canvas.visual-canvas');
    await expect(pixels).toBeVisible();
    const at=(x:number,y:number)=>rasterPoint(canvas,x,y);
    const draw=async(points:number[][])=>{for(const[i,p]of points.entries()){const q=await at(p[0],p[1]);await page.mouse.move(q.x,q.y,{steps:i?5:1});if(!i)await page.mouse.down();}await page.mouse.up();};
    const alpha=(x:number,y:number)=>rasterAlpha(canvas,x,y);
    await draw([[50,100],[300,100]]);const inside=await alpha(150,100),outside=await alpha(250,100);expect(inside).toBeGreaterThan(200);expect(outside).toBeGreaterThan(200);
    await button('lasso').click();await draw([[100,50],[200,50],[200,150],[100,150],[100,50]]);
    await button('clear selected pixels').click();expect(await alpha(150,100)).toBe(0);expect(await alpha(250,100)).toBe(outside);
    await page.screenshot({path:testInfo.outputPath('raster-workspace.png')});
    await button('undo').click();expect(await alpha(150,100)).toBe(inside);await button('redo').click();expect(await alpha(150,100)).toBe(0);
    await button('exit').click();await expect(page.locator('[data-action="open"] button')).toBeVisible();await page.reload();await button('pixels.png').click();await page.locator('[data-action="open"] button').click();
    await expect(pixels).toBeVisible();expect(await alpha(150,100)).toBe(0);expect(await alpha(250,100)).toBe(outside);
  } finally {await context.close();await rm(profile,{recursive:true,force:true});}
});
