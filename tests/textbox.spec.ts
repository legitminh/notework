import { test, expect, type Page } from '@playwright/test';

const button = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);

async function shortcut(page: Page, name: string) {
  const target = button(page, name).last();
  await target.scrollIntoViewIfNeeded();
  const route = target.locator('.pending_route');
  await expect(route).not.toHaveText('');
  await page.keyboard.press((await route.textContent())!.trim());
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(button(page, 'app settings')).toBeEnabled();
});

test('Enter confirms a new name and restores shortcuts without creating until explicitly chosen', async ({ page }) => {
  await button(page, 'app settings').click();
  await button(page, 'create new file/folder').click();
  const name = page.getByLabel('name', { exact: true });
  await name.fill('keyboard-note.txt');
  await name.press('Enter');
  await expect(name).not.toBeFocused();
  await expect(name).toHaveValue('keyboard-note.txt');
  await expect(page.getByRole('heading', { name: 'create new file/folder' })).toBeVisible();
  await shortcut(page, 'create text file');
  await expect(page.getByRole('heading', { name: 'keyboard-note.txt', exact: true })).toBeVisible();

  // Rename keeps its form submission, and the multiline editor keeps newlines.
  await button(page, 'configure file').click();
  await button(page, 'rename').click();
  const renamed = page.getByRole('dialog').getByRole('textbox');
  await renamed.fill('confirmed.txt');
  await renamed.press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'confirmed.txt', exact: true })).toBeVisible();
  await button(page, 'open').click();
  const editor = page.getByRole('textbox', { name: 'Edit confirmed.txt', exact: true });
  await editor.fill('first');
  await editor.press('End');
  await editor.press('Enter');
  await page.keyboard.insertText('second');
  await expect(editor).toBeFocused();
  await expect(editor.locator('.cm-line')).toHaveText(['first', 'second']);
});

test('Enter preserves the search query and restores navigation shortcuts', async ({ page }) => {
  await button(page, 'app settings').click();
  await button(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('find-me.txt');
  await button(page, 'create text file').click();
  await button(page, 'home').click();
  await button(page, 'search').click();
  const field = page.getByRole('searchbox');
  await field.fill('find-me');
  await field.press('Enter');
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue('find-me');
  await expect(page.locator('.search-status')).toContainText('1 result found');
  await shortcut(page, 'find-me.txt');
  await expect(page.getByRole('heading', { name: 'find-me.txt', exact: true })).toBeVisible();
});

test('Enter confirms valid settings, but leaves invalid values and IME composition focused', async ({ page }) => {
  await button(page, 'app settings').click();
  const interval = page.getByLabel('autosave at most every (seconds)', { exact: true });
  await interval.fill('0');
  await interval.press('Enter');
  await expect(interval).toBeFocused();
  await interval.fill('12');
  await interval.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(interval).toBeFocused();
  await interval.press('Enter');
  await expect(interval).not.toBeFocused();
  await expect(interval).toHaveValue('12');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('notework:autosave-seconds'))).toBe('12');

  const margin = page.getByLabel('top margin (min-box)', { exact: true });
  await margin.fill('2');
  await margin.press('Enter');
  await expect(margin).not.toBeFocused();
  await expect(margin).toHaveValue('2');
  await shortcut(page, 'close app settings');
  await expect(page.getByRole('heading', { name: 'app settings', exact: true })).not.toBeVisible();
});
