import { test, expect, type Page } from '@playwright/test';

const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button, button[data-action=${JSON.stringify(name)}]`);
const tools = (page: Page) => page.getByRole('group', { name: 'Editor toolbar' });

async function create(page: Page, name = 'folds.txt') {
  await page.goto('/');
  await action(page, 'app settings').click();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill(name);
  await action(page, 'create text file').click();
  await action(page, 'open').click();
  const editor = page.getByRole('textbox', { name: `Edit ${name}`, exact: true });
  await expect(editor).toBeFocused();
  return editor;
}

test('Fold keeps the parent, preserves nested folds, and never changes saved text', async ({ page }) => {
  const editor = await create(page);
  const source = 'Parent\n  Child\n    Grandchild\n\n  Second child\nPeer\n  Peer child\nLeaf';
  await editor.fill(source);
  await editor.press('ControlOrMeta+Home');
  await editor.press('ArrowDown');
  await tools(page).getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(editor.locator('.cm-line')).toHaveText(['Parent', '  Child ▸', '', '  Second child', 'Peer', '  Peer child', 'Leaf']);
  await editor.press('ControlOrMeta+Home');
  await tools(page).getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer', '  Peer child', 'Leaf']);
  await editor.press('ControlOrMeta+Home');
  await page.keyboard.insertText('Edited ');
  await expect(editor.locator('.cm-line')).toHaveText(['Edited Parent ▸', 'Peer', '  Peer child', 'Leaf']);
  await editor.press('ControlOrMeta+z');
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer', '  Peer child', 'Leaf']);
  for (const key of ['ArrowDown', 'ArrowUp', 'End', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ControlOrMeta+End', 'ControlOrMeta+Home']) await editor.press(key);
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer', '  Peer child', 'Leaf']);
  await tools(page).getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(editor.locator('.cm-line')).toHaveText(['Parent', '  Child ▸', '', '  Second child', 'Peer', '  Peer child', 'Leaf']);
  await editor.press('ControlOrMeta+End');
  await tools(page).getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(1); // Leaf is not a parent.
  await tools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await action(page, 'open').click();
  await expect(editor.locator('.cm-line')).toHaveText(source.split('\n'));
});

test('hover arrow overlays the parent’s last character and toggles with the mouse', async ({ page }) => {
  const editor = await create(page);
  await editor.fill('Parent\n\tChild\n\t  Grandchild\nPeer');
  await editor.press('ControlOrMeta+End');
  const parent = editor.locator('.cm-line').first();
  await parent.hover({ position: { x: 10, y: 8 } });
  const fold = page.getByRole('button', { name: 'Fold children of line 1', exact: true });
  await expect(fold).toBeVisible();
  const position = await parent.evaluate((element) => {
    const range = document.createRange();
    const text = element.firstChild!;
    range.setStart(text, text.textContent!.length - 1); range.setEnd(text, text.textContent!.length);
    const end = range.getBoundingClientRect();
    const toggle = document.querySelector('.cm-fold-hover')!.getBoundingClientRect();
    return { end: end.left, toggle: toggle.left, top: end.top, toggleTop: toggle.top };
  });
  expect(position.toggle).toBeCloseTo(position.end, 0);
  expect(position.toggleTop).toBeCloseTo(position.top, 0);
  await fold.click();
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer']);
  await parent.hover({ position: { x: 10, y: 8 } });
  await page.getByRole('button', { name: 'Unfold children of line 1', exact: true }).click();
  await expect(editor.locator('.cm-line')).toHaveText(['Parent', '\tChild', '\t  Grandchild', 'Peer']);
  await editor.locator('.cm-line').last().hover();
  await expect(page.locator('.cm-fold-hover')).toHaveCount(0);
});

test('Vim fold commands and navigation keep children closed until explicitly opened', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notework:vim-mode', 'true'));
  const editor = await create(page);
  await page.keyboard.press('i');
  await page.keyboard.insertText('Parent\n  Child\n    Grandchild\n  Second child\nPeer\n  Peer child');
  await page.keyboard.press('Escape');
  await page.keyboard.type('ggzc');
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer', '  Peer child']);
  await page.keyboard.type('jjkkllhhGgg');
  await editor.press('ArrowDown'); await editor.press('ArrowUp');
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer', '  Peer child']);
  await page.keyboard.type('ggzo');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(0);
  await page.keyboard.type('zC');
  await page.keyboard.type('zo');
  await expect(editor.locator('.cm-line')).toHaveText(['Parent', '  Child ▸', '  Second child', 'Peer', '  Peer child']);
  await page.keyboard.type('zO');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(0);
  await page.keyboard.type('za');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(1);
  await page.keyboard.type('za');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(0);
  await page.keyboard.type('zM');
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer ▸']);
  await page.keyboard.type('zR');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(0);
  await page.keyboard.type(':fold'); await page.keyboard.press('Enter');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(1);
  await page.keyboard.type(':foldopen'); await page.keyboard.press('Enter');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(0);
  await page.keyboard.type('zfj');
  await expect(editor.locator('.cm-fold-arrow')).toHaveCount(1);
});

test('hover controls follow the size and bounds of a formatted Unicode heading', async ({ page }) => {
  const editor = await create(page);
  await editor.fill('\\pretty\nParent 📝\n  Child\nPeer');
  await editor.press('ControlOrMeta+End');
  const parent = editor.locator('.cm-line').filter({ hasText: 'Parent 📝' });
  await parent.hover({ position: { x: 10, y: 15 } });
  const toggle = page.getByRole('button', { name: 'Fold children of line 2', exact: true });
  await expect(toggle).toBeVisible();
  const geometry = await parent.evaluate((line) => {
    const text = line.querySelector('.cm-pretty-text')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - 2); range.setEnd(text, text.textContent!.length);
    const glyph = range.getBoundingClientRect(), hover = document.querySelector('.cm-fold-hover')!.getBoundingClientRect();
    return { glyph: [glyph.x, glyph.y, glyph.width, glyph.height], hover: [hover.x, hover.y, hover.width, hover.height] };
  });
  geometry.hover.forEach((value, index) => expect(value).toBeCloseTo(geometry.glyph[index], 0));
  await toggle.click();
  await expect(editor).not.toContainText('Child');
  await expect(editor).toContainText('Parent 📝 ▸');
});

test('ordinary arrow keys land on embedded page source so it can be deleted', async ({ page }) => {
  const editor = await create(page);
  await editor.fill('before\n\\page[embedded.txt]\nafter');
  await editor.press('ControlOrMeta+End');
  await expect(page.locator('.page-reference')).toHaveCount(1);
  await editor.press('ArrowUp');
  await expect(page.locator('.page-reference')).toHaveCount(0);
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('\\page[embedded.txt]');
  await editor.press('Home'); await editor.press('Shift+End');
  await editor.press('Backspace');
  await expect(editor.locator('.cm-line')).toHaveText(['before', '', 'after']);
});

test('folds hide links, drawing and image previews, and embedded pages even when navigating', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const editor = await create(page);
  await editor.fill('Parent\n  [[linked.txt]]\n  \\svgpage[sketch.svg]\n  \\pngpage[image.png]\n  \\page[embedded.txt]\nPeer');
  await editor.press('ControlOrMeta+End');
  await expect(page.locator('.cm-wiki-link')).toHaveCount(1);
  await expect(page.locator('.svg-page-preview')).toHaveCount(2);
  await expect(page.locator('.page-reference')).toHaveCount(1);
  await editor.press('ControlOrMeta+Home');
  await tools(page).getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(editor.locator('.cm-line')).toHaveText(['Parent ▸', 'Peer']);
  await expect(page.locator('.cm-wiki-link, .svg-page-preview, .page-reference')).toHaveCount(0);
  for (let i = 0; i < 8; i++) await editor.press('ArrowRight');
  await expect(page.locator('.cm-wiki-link, .svg-page-preview, .page-reference')).toHaveCount(0);
  await editor.press('ControlOrMeta+Home');
  await tools(page).getByRole('button', { name: 'Fold', exact: true }).click();
  await expect(page.locator('.svg-page-preview')).toHaveCount(2);
  await expect(page.locator('.page-reference')).toHaveCount(1);
  expect(errors).toEqual([]);
});
