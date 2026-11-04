import { test, expect } from '@playwright/test';

test('installed app shell and browser documents work offline', async ({ page, context }) => {
  test.skip(process.env.PLAYWRIGHT_PRODUCTION !== '1', 'Service workers are built only for production.');
  await page.goto('/');
  const action = (name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
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
  await action('create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('offline.txt');
  await action('create text file').click();
  await action('open').click();
  const editor = page.getByRole('textbox', { name: 'Edit offline.txt', exact: true });
  await expect(editor).toBeVisible();
  await editor.click(); await page.keyboard.insertText('Notes survive offline.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(action('offline.txt')).toBeVisible();
  await action('offline.txt').click(); await action('open').click();
  await expect(editor).toHaveText('Notes survive offline.');
  await editor.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' Still writing.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await page.reload(); await action('offline.txt').click(); await action('open').click();
  await expect(editor).toHaveText('Notes survive offline. Still writing.');
  await page.getByRole('group', { name: 'Editor toolbar' }).getByRole('button', { name: 'Export', exact: true }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(exportDialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  const download = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('offline.pdf');
});
