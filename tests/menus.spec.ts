import { test, expect, type Page } from '@playwright/test';
import { choiceMenu } from './menu-helpers';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

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

test('settings and nested choices support arrow keys, shortcuts, Escape and focus restoration', async ({ page }, testInfo) => {
  const settings = button(page, 'app settings');
  await settings.focus();
  const shortcut = (await settings.locator('.pending_route').textContent())!.trim();
  await page.keyboard.type(shortcut);
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await expect(button(page, 'close app settings')).toBeFocused();
  await expect(button(page, 'search')).toBeDisabled();
  await page.keyboard.press('ArrowDown');
  await expect(button(page, 'create new file/folder')).toBeFocused();
  await page.keyboard.press('End');
  await expect(region(page, 'app settings').getByRole('button', { name: 'Back', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(button(page, 'close app settings')).toBeFocused();

  const theme = choiceMenu(page, 'color theme').locator('.subkeyframe-trigger');
  await theme.focus(); await theme.press('Enter');
  await expect(button(page, 'dark')).toBeFocused();
  await expect(button(page, 'system')).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: testInfo.outputPath('settings-menu.png') });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(theme).toHaveAttribute('aria-label', 'color theme: light');
  await expect(theme).toBeFocused();
  await expect(settings).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('notework:theme'))).toBe('light');

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
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  await expect(settings).toBeFocused();
  await expect(button(page, 'search')).toBeEnabled();
  await expect(page.locator('.viewport')).toHaveCSS('overflow-y', 'auto');
  await settings.click();
  await page.getByRole('region', { name: 'current state', exact: true }).getByRole('heading', { name: 'home', exact: true }).click();
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
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
  await page.getByRole('textbox', { name: 'Edit menu-export.txt', exact: true }).fill('Menu export');
  await button(page, 'Export').click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  const format = choiceMenu(dialog, 'Export format').locator('.subkeyframe-trigger');
  await format.focus(); await format.press('Enter');
  await expect(button(page, 'PDF')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(format).toHaveAttribute('aria-label', 'Export format: PNG');
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
  await expect(page.getByRole('dialog', { name: 'Search', exact: true })).not.toBeVisible();
  await expect(button(page, 'search')).toBeFocused();
  await create(page, 'drawing-menu.txt');
  await page.locator('[data-action="open"] button').click();
  await button(page, 'Draw…').click();
  await expect(button(page, 'SVG')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(button(page, 'PNG')).toBeFocused();
  await page.keyboard.press('End');
  await expect(button(page, 'Cancel')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Choose drawing format', exact: true })).not.toBeVisible();
  await expect(button(page, 'Draw…')).toBeFocused();
});

test('image-layer menu owns Escape and keyboard selection while the drawing editor is mounted', async ({ page }) => {
  await create(page, 'layers', 'ora image');
  await page.locator('[data-action="open"] button').click();
  await button(page, 'Add layer').click();
  await expect(button(page, 'Add layer')).toBeEnabled();
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
  await expect(button(page, 'Add layer')).toBeEnabled();
  await expect(trigger).toBeFocused();
});
