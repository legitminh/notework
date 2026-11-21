import { test, expect, type Page, type Locator } from '@playwright/test';
import { rasterPoint, alpha } from './raster-helpers';

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
type Hooked = HTMLElement & { visualEditor: { layers: { entry: { file: string; kind: string }; missing: boolean }[]; state: { color: string } } };

async function drag(page: Page, canvas: Locator, points: number[][]) {
  for (const [i, p] of points.entries()) { const at = await rasterPoint(canvas, p[0], p[1]); await page.mouse.move(at.x, at.y, { steps: i ? 6 : 1 }); if (!i) await page.mouse.down(); }
  await page.mouse.up();
}
async function createVisual(page: Page, name = 'sketch') {
  await page.goto('/'); await button(page, 'app settings').click(); await button(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill(name);
  await expect(page.locator('.creation-option').filter({ has: button(page, 'create visual document') }).getByLabel('Path for page text file', { exact: true })).toHaveText(`home/${name}/${name}.visual`);
  await button(page, 'create visual document').click();
  await page.getByLabel('Width in pixels').fill('400'); await page.getByLabel('Height in pixels').fill('200');
  await button(page, 'Create canvas').click();
  await expect(page.getByRole('heading', { name: `${name}/`, exact: true })).toBeVisible();
}
async function openMain(page: Page, name = 'sketch') {
  await page.locator('.file-navigation-row').filter({ has: button(page, `${name}.visual`) }).locator('[data-action="open"] button').click();
  const canvas = page.getByRole('img', { name: `Drawing canvas for ${name}.visual` });
  await expect(canvas.locator('canvas.visual-canvas')).toBeVisible();
  return canvas;
}

test('visual documents are page folders whose layers are separate assets, and reopen with their state', async ({ page }) => {
  await createVisual(page);
  let canvas = await openMain(page);
  await drag(page, canvas, [[50, 50], [150, 50]]);
  await expect.poll(() => alpha(canvas, 100, 50)).toBe(255);
  await button(page, 'Add vector layer').click();
  await drag(page, canvas, [[50, 120], [150, 120]]);
  expect(await canvas.evaluate((node) => (node as Hooked).visualEditor.layers.map((layer) => layer.entry.kind))).toEqual(['raster', 'vector']);
  // Brush settings: select Brush again to open size, color wheel and brush types.
  await button(page, 'Brush').click();
  await expect(page.getByRole('slider', { name: 'Color wheel: hue, saturation and value' })).toBeVisible();
  await page.getByLabel('Hex color').fill('#e03131'); await page.getByLabel('Hex color').press('Enter');
  await button(page, 'Basic-1').click();
  await expect(button(page, 'Basic-1')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await button(page, 'Exit').click();
  await button(page, '..').click();
  // Every layer is its own file in the folder, next to the plaintext main file.
  for (const file of ['sketch.visual', 'sketch.layer-1.png', 'sketch.ink-2.svg']) await expect(button(page, file)).toBeVisible();
  await page.goto('/');
  await button(page, 'sketch/').click();
  canvas = await openMain(page);
  await expect.poll(() => alpha(canvas, 100, 50)).toBe(255);
  expect(await canvas.evaluate((node) => (node as Hooked).visualEditor.state.color)).toBe('#e03131');
  // The organizer file is plain text the user can read and edit.
  await button(page, 'Raw text').click();
  const text = page.getByRole('textbox', { name: 'Edit sketch.visual', exact: true });
  await expect(text).toContainText('\\image_editor_raster[sketch.layer-1.png');
  await expect(text).toContainText('\\image_editor_vector[sketch.ink-2.svg');
  await expect(text).toContainText('color=#e03131');
});

test('a missing layer file is reported and its reference kept', async ({ page }) => {
  await createVisual(page, 'gaps');
  let canvas = await openMain(page, 'gaps');
  await drag(page, canvas, [[50, 50], [150, 50]]);
  await button(page, 'Raw text').click();
  const text = page.getByRole('textbox', { name: 'Edit gaps.visual', exact: true });
  await expect(text).toContainText('gaps.layer-1.png');
  await text.press('ControlOrMeta+End'); await page.keyboard.type('\\image_editor_raster[lost-layer.png, 0, 0]');
  await page.keyboard.press('ControlOrMeta+s');
  await button(page, 'Exit').click();
  await button(page, '..').click();
  canvas = await openMain(page, 'gaps');
  await expect(page.getByRole('alert')).toContainText('lost-layer.png');
  expect(await canvas.evaluate((node) => (node as Hooked).visualEditor.layers.map((layer) => [layer.entry.file, layer.missing]))).toEqual([['gaps.layer-1.png', false], ['lost-layer.png', true]]);
});

test('the brush library is created under app.asset with the Krita basic pack', async ({ page }) => {
  await createVisual(page, 'brushes');
  await openMain(page, 'brushes');
  await button(page, 'Exit').click();
  await page.goto('/');
  await button(page, 'app.asset/').click(); await button(page, 'editor.visual/').click(); await button(page, 'brushes/').click();
  await expect(button(page, 'basic-1.vbrush')).toBeVisible();
  await expect(button(page, 'eraser-soft.vbrush')).toBeVisible();
});
