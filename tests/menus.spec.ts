import { rasterPoint, alpha, seedImage } from './raster-helpers';
import { test, expect, type Page } from '@playwright/test';
import { choiceMenu } from './menu-helpers';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function create(page: Page, name: string, kind = 'text file') {
  await button(page, 'app settings').click();
  await button(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill(name);
  await button(page, `create ${kind}`).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(button(page, 'app settings')).toBeEnabled();
});

test('settings screens support shortcuts, categories, Escape and focus restoration', async ({ page }, testInfo) => {
  const settings = button(page, 'app settings');
  await settings.focus();
  const shortcut = (await settings.locator('.pending_route').textContent())!.trim();
  await page.keyboard.type(shortcut);
  await expect(page.getByRole('heading', { name: 'app settings', exact: true })).toBeVisible();
  await expect(button(page, 'close app settings')).toBeFocused();
  // Settings replace the home screen rather than layering over it.
  await expect(page.getByRole('navigation', { name: 'state navigation' })).toHaveCount(0);
  await expect(button(page, 'create new file/folder')).toBeVisible();
  await expect(button(page, 'add existing folder/file')).toBeVisible();
  await expect(choiceMenu(page, 'color theme')).toHaveCount(0);

  await button(page, 'appearance').click();
  await expect(page.getByRole('heading', { name: 'appearance', exact: true })).toBeVisible();
  await expect(button(page, 'back to app settings')).toBeFocused();
  await expect(button(page, 'create new file/folder')).toHaveCount(0);
  const theme = choiceMenu(page, 'color theme').locator('.subkeyframe-trigger');
  await theme.focus(); await theme.press('Enter');
  await expect(button(page, 'dark')).toBeFocused();
  await expect(button(page, 'system')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('settings-appearance.png') });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(theme).toHaveAttribute('aria-label', 'color theme: light');
  await expect(theme).toBeFocused();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('notework:theme'))).toBe('light');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'app settings', exact: true })).toBeVisible();
  await expect(button(page, 'appearance')).toBeFocused();

  await button(page, 'keyboard').click();
  const alphabet = choiceMenu(page, 'shortcut input space').locator('.subkeyframe-trigger');
  await alphabet.focus(); await alphabet.press('Enter');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(choiceMenu(page, 'shortcut input space')).toHaveAttribute('data-value', 'letters');
  await expect(alphabet).toBeFocused();
  const layout = choiceMenu(page, 'virtual keyboard layout');
  await layout.locator('.subkeyframe-trigger').focus();
  await page.keyboard.press('Enter');
  const flick = layout.locator('button:has([data-choice-option="flick-alpha"])');
  const route = (await flick.locator('.pending_route').textContent())!.trim();
  expect(route).not.toBe('');
  await page.keyboard.type(route);
  await expect(layout).toHaveAttribute('data-value', 'flick-alpha');
  await expect(layout.locator('.subkeyframe-trigger')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button(page, 'keyboard')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'app settings', exact: true })).toHaveCount(0);
  await expect(settings).toBeFocused();
  await expect(button(page, 'search')).toBeEnabled();
  await expect(page.locator('.viewport')).toHaveCSS('overflow-y', 'auto');

  // Category screens can also exit settings directly.
  await settings.click(); await button(page, 'text editor').click();
  await button(page, 'close app settings').click();
  await expect(settings).toBeFocused();
});

for (const kind of ['file', 'folder']) {
  test(`configure ${kind} uses a Keyflow frame and preserves rename validation`, async ({ page }) => {
    await create(page, kind === 'file' ? 'menu.txt' : 'menu-folder', kind === 'file' ? 'text file' : 'folder');
    const config = button(page, `configure ${kind}`);
    await config.focus(); await config.press('Enter');
    await expect(button(page, `close configure ${kind}`)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    if (kind === 'folder') {
      await expect(button(page, 'refresh folder')).toBeFocused();
      await page.keyboard.press('ArrowDown');
    }
    await expect(button(page, 'rename')).toBeFocused();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(config).toHaveAttribute('aria-expanded', 'false');
    const name = dialog.getByRole('textbox');
    await name.fill(''); await name.press('Enter');
    await expect(dialog).toBeVisible();
    await name.fill(kind === 'file' ? 'renamed-menu.txt' : 'renamed-menu-folder');
    await name.press('Enter');
    await expect(dialog).not.toBeVisible();
    await expect(config).toBeFocused();
    await config.focus(); await config.press('Enter');
    await page.keyboard.press('Escape');
    await expect(config).toBeFocused();
  });
}

test('export dropdown Escape restores its trigger before the enclosing dialog closes', async ({ page }) => {
  await create(page, 'menu-export.txt');
  await page.locator('[data-action="open"] button').click();
  await page.getByRole('textbox', { name: 'edit menu-export.txt', exact: true }).fill('Menu export');
  await button(page, 'export').click();
  const dialog = page.getByRole('dialog', { name: 'export', exact: true });
  const format = choiceMenu(dialog, 'export format').locator('.subkeyframe-trigger');
  await format.focus(); await format.press('Enter');
  await expect(button(page, 'PDF')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(format).toHaveAttribute('aria-label', 'export format: PNG');
  await expect(format).toBeFocused();
  await format.press('Enter'); await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(format).toBeFocused();
  await expect(format).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('search and drawing format choosers provide Keyflow arrow navigation and Back', async ({ page }) => {
  await button(page, 'search').focus(); await button(page, 'search').press('Enter');
  await expect(button(page, 'search text in folder children')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(button(page, 'search file in folder children')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'search', exact: true })).not.toBeVisible();
  await expect(button(page, 'search')).toBeFocused();
  await create(page, 'drawing-menu.txt');
  await page.locator('[data-action="open"] button').click();
  await button(page, 'draw…').click();
  await expect(button(page, 'SVG')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(button(page, 'visual document')).toBeFocused();
  await page.keyboard.press('End');
  await expect(button(page, 'cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'choose drawing format', exact: true })).not.toBeVisible();
  await expect(button(page, 'draw…')).toBeFocused();
});

test('image-layer menu owns Escape and keyboard selection while the drawing editor is mounted', async ({ page }) => {
  await seedImage(page, 'layers.ora', 400, 200);
  await page.locator('[data-action="open"] button').click();
  await button(page, 'layer').click();
  await button(page, 'add layer').click();
  await expect(button(page, 'add layer')).toBeEnabled();
  const layer = choiceMenu(page, 'active layer');
  const trigger = layer.locator('.subkeyframe-trigger');
  await trigger.focus(); await trigger.press('Enter');
  await expect(layer.locator('[data-choice-option]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(layer).toHaveAttribute('data-value', '1');
  await expect(button(page, 'add layer')).toBeEnabled();
  await expect(trigger).toBeFocused();
});

test('settings use the page scroll as their only scroll area, above the virtual keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 500 });
  await button(page, 'app settings').click();
  await button(page, 'keyboard').click();
  await button(page, 'virtual keyboard: off').click();
  await expect(page.locator('.keyboard-dock')).toBeVisible();
  const root = page.locator('.viewport'), screen = page.locator('.settings-page');
  expect(await screen.evaluate((node) => [node, ...node.querySelectorAll('*')].filter((child) =>
    /auto|scroll/.test(getComputedStyle(child).overflowY) && child.scrollHeight > child.clientHeight).length)).toBe(0);
  expect(await root.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await screen.hover(); await page.mouse.wheel(0, 400);
  await expect.poll(() => root.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  // Switching screens starts each one at the top.
  await button(page, 'back to app settings').click();
  await expect.poll(() => root.evaluate((node) => node.scrollTop)).toBe(0);
  await expect(button(page, 'keyboard')).toBeFocused();
  await button(page, 'close app settings').click();
  await expect(button(page, 'app settings')).toBeFocused();
});
