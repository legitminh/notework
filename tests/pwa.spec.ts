import { sizeCanvas } from './raster-helpers';
import { test, expect } from '@playwright/test';

test('installed app shell and browser documents work offline', async ({ page, context }) => {
  test.skip(process.env.PLAYWRIGHT_PRODUCTION !== '1', 'Service workers are built only for production.');
  await page.goto('/');
  const action = (name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button, button[data-action=${JSON.stringify(name)}]`);
  await expect(action('app settings')).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  expect(manifest.display).toBe('standalone');
  const protocol = await context.newCDPSession(page);
  const installability = await protocol.send('Page.getInstallabilityErrors');
  // Playwright's isolated contexts are incognito, where installation is disabled.
  expect(installability.installabilityErrors.filter((error) => error.errorId !== 'in-incognito')).toEqual([]);
  await action('app settings').click();
  await action('create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('offline.txt');
  await action('create text file').click();
  await action('open').click();
  const editor = page.getByRole('textbox', { name: 'edit offline.txt', exact: true });
  await expect(editor).toBeVisible();
  await editor.click(); await page.keyboard.insertText('Notes survive offline.');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('saved in native storage', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(action('offline.txt')).toBeVisible();
  // The worker must load from the offline app shell before it has ever been started.
  await page.keyboard.press('ControlOrMeta+Shift+f');
  const search = page.getByRole('dialog', { name: 'find in contents', exact: true });
  await search.getByRole('searchbox').fill('SURVIVE OFFLINE');
  await expect(search.locator('.content-search-status')).toContainText('1 matching file');
  await search.locator('.content-match button').click();
  await expect(editor).toHaveText('Notes survive offline.');
  await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' Still writing.');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('saved in native storage', { exact: true })).toBeVisible();
  await page.reload(); await action('offline.txt').click(); await action('open').click();
  await expect(editor).toHaveText('Notes survive offline. Still writing.');
  await page.getByRole('group', { name: 'editor toolbar' }).getByRole('button', { name: 'export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'export', exact: true });
  await expect(exportDialog.getByRole('button', { name: 'download PDF', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'download PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('offline.pdf');
});


test('bundled HEIC codec creates and edits images offline', async ({ page, context }) => {
  test.skip(process.env.PLAYWRIGHT_PRODUCTION !== '1', 'Service workers are built only for production.');
  await page.goto('/');
  const action = (name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button, button[data-action=${JSON.stringify(name)}]`);
  await expect(action('app settings')).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
  });
  await context.setOffline(true);
  await action('app settings').click(); await action('create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('offline'); await action('create visual document').click();
  await sizeCanvas(page);
  const row = page.locator('.file-navigation-row').filter({ has: page.getByRole('button', { name: 'offline.visual', exact: true }) });
  await row.locator('[data-action="open"] button').click();
  const canvas = page.getByRole('img', { name: 'drawing canvas for offline.visual' });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + 50, box.y + 50);
  await page.getByRole('group', { name: 'drawing toolbar' }).getByRole('button', { name: 'exit', exact: true }).click();
  await page.reload(); await row.locator('[data-action="open"] button').click();
  await expect(canvas).toBeVisible();
});
