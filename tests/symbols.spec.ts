import { test, expect, type Page } from '@playwright/test';
import { renderSymbolShorthands } from '../src/lib/symbol-shorthand';

const names = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'.split(' ');
const lower = Array.from('αβγδεζηθικλμνξοπρστυφχψω');
const upper = Array.from('ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ');
const commands = names.flatMap((name) => [`\\${name}`, `\\${name[0].toUpperCase()}${name.slice(1)}`]);
const symbols = lower.flatMap((letter, index) => [letter, upper[index]]);
const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
const toolbar = (page: Page) => page.getByRole('group', { name: 'Editor toolbar' });

async function create(page: Page, name: string) {
  await action(page, 'app settings').click();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill(name);
  await action(page, 'create text file').click();
  await action(page, 'open').click();
  return page.getByRole('textbox', { name: `Edit ${name}`, exact: true });
}

test('Greek and mathematical shorthands match complete case-sensitive commands', () => {
  expect(renderSymbolShorthands(commands.join(' '))).toBe(symbols.join(' '));
  expect(renderSymbolShorthands('\\varsigma \\varepsilon \\vartheta \\varpi \\varrho \\varphi \\aleph \\itg \\sqr')).toBe('ς ϵ ϑ ϖ ϱ ϕ ℵ ∫ √');
  const literal = String.raw`\\sigma \sigmafoo \sigma1 \sigma-name \SIGMA \unknown \constructor`;
  expect(renderSymbolShorthands(literal)).toBe(literal);
  expect(renderSymbolShorthands(String.raw`(\Sigma)+\lambda=\pi,\itg\sqr`)).toBe('(Σ)+λ=π,∫√');
});

test('symbols render in editable notes, previews and embedded pages while saves retain source', async ({ page }) => {
  await page.goto('/');
  const editor = await create(page, 'symbols.txt');
  const lines = Array.from({ length: 6 }, (_, index) => commands.slice(index * 8, index * 8 + 8).join(' '));
  const source = [...lines, '\\aleph \\itg \\sqr', 'end'].join('\n');
  await editor.fill(source);
  await editor.press('ControlOrMeta+End');
  await expect(editor.locator('.cm-symbol')).toHaveText([...symbols, 'ℵ', '∫', '√']);
  // The first command is editable, and selecting all exposes the exact draft.
  await editor.press('ControlOrMeta+Home');
  await expect(editor.locator('.cm-line').first()).toContainText('\\alpha');
  await editor.press('ControlOrMeta+a');
  await expect(editor.locator('.cm-line')).toHaveText(source.split('\n'));
  await editor.press('ControlOrMeta+End');
  await editor.press('ControlOrMeta+s');
  await toolbar(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(page.locator('.file-preview .cm-symbol')).toHaveText([...symbols, 'ℵ', '∫', '√']);
  await page.reload();
  await action(page, 'symbols.txt').click();
  await action(page, 'open').click();
  await editor.press('ControlOrMeta+a');
  await expect(editor.locator('.cm-line')).toHaveText(source.split('\n'));
  await toolbar(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await action(page, 'home').click();
  const parent = await create(page, 'parent.txt');
  await parent.fill('\\page[symbols.txt]\nend');
  await parent.press('ControlOrMeta+End');
  await expect(page.locator('.page-reference .cm-symbol')).toHaveText([...symbols, 'ℵ', '∫', '√']);
});

test('inline autocomplete offers both cases and keeps the shorthand editable', async ({ page }) => {
  await page.goto('/');
  const editor = await create(page, 'completion.txt');
  await editor.fill('value: ');
  await editor.press('End');
  await page.keyboard.type('\\Sig');
  const option = page.getByRole('option').filter({ hasText: /\\Sigma/ });
  await expect(option).toContainText('Σ');
  await option.click();
  await page.keyboard.insertText(' + \\sigma ');
  await expect(editor.locator('.cm-symbol')).toHaveText(['Σ', 'σ']);
  await editor.press('ControlOrMeta+a');
  await expect(editor).toHaveText('value: \\Sigma + \\sigma ');
});

test('PDF and raster exports draw the rendered symbols', async ({ page }) => {
  await page.goto('/');
  const editor = await create(page, 'export-symbols.txt');
  await editor.fill('\\sigma \\Sigma \\lambda \\Lambda \\pi \\Pi \\aleph \\itg \\sqr');
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
      sessionStorage.setItem('drawn-symbols', (sessionStorage.getItem('drawn-symbols') ?? '') + text);
      if (maxWidth === undefined) original.call(this, text, x, y); else original.call(this, text, x, y, maxWidth);
    };
  });
  for (const format of ['pdf', 'png', 'jpeg']) {
    await page.evaluate(() => sessionStorage.removeItem('drawn-symbols'));
    await toolbar(page).getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
    await dialog.getByLabel('Export format').selectOption(format);
    await expect(dialog.getByRole('button', { name: `Download ${format.toUpperCase()}`, exact: true })).toBeEnabled();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('drawn-symbols'))).toContain('σ Σ λ Λ π Π ℵ ∫ √');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});
