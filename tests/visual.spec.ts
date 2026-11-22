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
  await button(page, 'Layer').click();
  await button(page, 'Add vector layer').click();
  await page.keyboard.press('Escape');
  await drag(page, canvas, [[50, 120], [150, 120]]);
  expect(await canvas.evaluate((node) => (node as Hooked).visualEditor.layers.map((layer) => layer.entry.kind))).toEqual(['raster', 'vector']);
  // Brush settings: select Brush again to open size, color wheel and brush types.
  await button(page, 'Brush').click();
  await expect(page.getByRole('slider', { name: /^Color wheel/ })).toBeVisible();
  // Keyflow single-line textbox: open it, type, Enter commits.
  await button(page, 'Hex color').click();
  await page.getByRole('textbox', { name: 'Hex color', exact: true }).press('ControlOrMeta+a');
  await page.keyboard.type('#e03131'); await page.keyboard.press('Enter');
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
  // The vector layer was active when the document closed, and is active again; read the raster layer directly.
  expect(await canvas.evaluate((node) => (node as Hooked).visualEditor.layers.map((layer) => layer.entry.kind))).toEqual(['raster', 'vector']);
  await expect.poll(() => canvas.evaluate((node) => (node as unknown as { visualEditor: { layers: { raster?: { read(r: object): { data: Uint8ClampedArray } } }[] } }).visualEditor.layers[0].raster!.read({ x: 100, y: 50, width: 1, height: 1 }).data[3])).toBe(255);
  await button(page, 'Layer').click();
  await expect(page.locator('[data-choice="active layer"]')).toHaveAttribute('data-value', '0');
  await page.keyboard.press('Escape');
  expect(await canvas.evaluate((node) => (node as Hooked).visualEditor.state.color)).toBe('#e03131');
  // The organizer file is plain text the user can read and edit, with a way back to the canvas.
  await button(page, 'Editor').click();
  await button(page, 'Raw text').click();
  const text = page.getByRole('textbox', { name: 'Edit sketch.visual', exact: true });
  await expect(text).toContainText('\\image_editor_raster[sketch.layer-1.png');
  await expect(text).toContainText('\\image_editor_vector[sketch.ink-2.svg');
  await expect(text).toContainText('color=#e03131');
  await button(page, 'Visual editor').click();
  await expect(page.getByRole('img', { name: 'Drawing canvas for sketch.visual' }).locator('canvas.visual-canvas')).toBeVisible();
});

test('a missing layer file is reported and its reference kept', async ({ page }) => {
  await createVisual(page, 'gaps');
  let canvas = await openMain(page, 'gaps');
  await drag(page, canvas, [[50, 50], [150, 50]]);
  await button(page, 'Editor').click();
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

test('toolbar streams title, editor, exit, tools, undo/redo, layer, export and folds like text; menus overlay it', async ({ page }) => {
  // Menus extend down as far as there is room; a tall window leaves canvas visible below the brush panel.
  await page.setViewportSize({ width: 1600, height: 1600 });
  await createVisual(page, 'a-long-document-name');
  await openMain(page, 'a-long-document-name');
  const bar = page.getByRole('group', { name: 'Drawing toolbar' });
  const labels = await bar.locator(':scope > *').evaluateAll((nodes) => nodes.map((node) => (node.getAttribute('aria-label') ?? node.textContent ?? '').trim()).filter(Boolean));
  expect(labels.slice(0, 3)[0]).toContain('a-long-document-name');
  for (const name of ['Editor', 'Exit', 'Brush', 'Eraser', 'Lasso', 'Transform', 'Undo', 'Redo', 'Layer']) await expect(button(page, name)).toBeVisible();
  // The title is bounded to 16 characters and scrolls.
  const title = bar.locator('.keyflow-bounded-text');
  expect(await title.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  // Horizontal component stream: nothing overflows sideways; items fold onto new lines instead.
  expect(await bar.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 500, height: 1600 });
  const lines = await bar.locator(':scope > *').evaluateAll((nodes) => new Set(nodes.filter((node) => (node as HTMLElement).offsetParent).map((node) => Math.round(node.getBoundingClientRect().top))).size);
  expect(lines).toBeGreaterThan(1);
  expect(await bar.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1600, height: 1600 });
  // Brush settings stay open while painting on the canvas.
  await button(page, 'Brush').click();
  await expect(page.getByRole('slider', { name: 'Pen size', exact: true })).toBeVisible();
  const canvas = page.getByRole('img', { name: 'Drawing canvas for a-long-document-name.visual' });
  await drag(page, canvas, [[50, 150], [150, 150]]);
  await expect(page.getByRole('slider', { name: 'Pen size', exact: true })).toBeVisible();
  await expect.poll(() => alpha(canvas, 100, 150)).toBe(255);
  await page.getByRole('button', { name: /Increase Pen size$/ }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('slider', { name: 'Pen size', exact: true })).toHaveCount(0);
});

test('transform tool moves, rotates and asks before keeping content outside the canvas', async ({ page }) => {
  await createVisual(page, 'moves');
  const canvas = await openMain(page, 'moves');
  await drag(page, canvas, [[40, 100], [120, 100]]);
  await button(page, 'Transform').click();
  await expect(page.getByRole('slider', { name: 'Rotate', exact: true })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Scale', exact: true })).toBeVisible();
  await drag(page, canvas, [[80, 100], [380, 100]]);
  await button(page, 'Brush').click();
  await expect(button(page, 'Crop to canvas')).toBeVisible();
  await button(page, 'Crop to canvas').click();
  await expect.poll(() => alpha(canvas, 390, 100)).toBe(255);
  expect(await canvas.evaluate((node) => { const b = (node as unknown as { visualEditor: { activeLayer: { raster: { bounds(): { x: number; width: number } } } } }).visualEditor.activeLayer.raster.bounds(); return b.x + b.width; })).toBe(400);
  await button(page, 'Undo').click();
  await expect.poll(() => alpha(canvas, 80, 100)).toBe(255);
});

test('vector lasso selects strokes fully inside, then Transform moves only them', async ({ page }) => {
  await createVisual(page, 'ink');
  const canvas = await openMain(page, 'ink');
  await button(page, 'Layer').click(); await button(page, 'Add vector layer').click(); await page.keyboard.press('Escape');
  await drag(page, canvas, [[30, 30], [70, 30]]);
  await drag(page, canvas, [[30, 150], [370, 150]]);
  await button(page, 'Lasso').click();
  await drag(page, canvas, [[10, 10], [100, 10], [100, 60], [10, 60], [10, 10]]);
  expect(await canvas.evaluate((node) => (node as unknown as { visualEditor: { selection?: { strokeIds?: Set<string> } } }).visualEditor.selection?.strokeIds?.size)).toBe(1);
  await button(page, 'Transform').click();
  await drag(page, canvas, [[50, 30], [50, 90]]);
  await button(page, 'Brush').click();
  const ys = await canvas.evaluate((node) => (node as unknown as { visualEditor: { activeLayer: { vector: { strokes: { points: number[] }[] } } } }).visualEditor.activeLayer.vector.strokes.map((stroke) => Math.round(stroke.points[1])).sort((a, b) => a - b));
  expect(Math.abs(ys[0] - 90)).toBeLessThanOrEqual(2); expect(Math.abs(ys[1] - 150)).toBeLessThanOrEqual(2);
});

test('visual editor settings are Keyflow controls: number boxes, sliders, toggles and single-line text', async ({ page }) => {
  await createVisual(page, 'keys');
  const canvas = await openMain(page, 'keys');
  const state = () => canvas.evaluate((node) => (node as unknown as { visualEditor: { state: { color: string }; currentBrush: { sizePressure: boolean }; activeLayer: { entry: { name?: string } } } }).visualEditor);
  await button(page, 'Brush').click();
  await button(page, 'RGB').click();
  await button(page, 'Red value').click();
  await page.getByRole('textbox', { name: 'Red value', exact: true }).press('ControlOrMeta+a');
  await page.keyboard.type('300'); await page.keyboard.press('Enter');
  expect((await canvas.evaluate((node) => (node as unknown as { visualEditor: { state: { color: string } } }).visualEditor.state.color)).slice(0, 3)).toBe('#ff');
  // Configure is a nested Keyflow input frame with its own trigger and Back.
  await page.getByRole('button', { name: /^Configure / }).click();
  const pressure = () => canvas.evaluate((node) => (node as unknown as { visualEditor: { currentBrush: { sizePressure: boolean } } }).visualEditor.currentBrush.sizePressure);
  const before = await pressure();
  await button(page, 'Pressure → size').click();
  expect(await pressure()).toBe(!before);
  await expect(button(page, 'Pressure → size')).toHaveAttribute('aria-pressed', String(!before));
  await page.keyboard.press('Escape');
  await expect(button(page, 'Pressure → size')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Pen size', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await button(page, 'Layer').click();
  await button(page, 'Layer name').click();
  await page.getByRole('textbox', { name: 'Layer name', exact: true }).press('ControlOrMeta+a');
  await page.keyboard.type('Ink lines'); await page.keyboard.press('Enter');
  expect(await canvas.evaluate((node) => (node as unknown as { visualEditor: { activeLayer: { entry: { name?: string } } } }).visualEditor.activeLayer.entry.name)).toBe('Ink lines');
  void state;
  // One min-box per line: toolbar buttons are exactly one min-box tall.
  const [minBox, height] = await page.evaluate(() => [parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--min-box')),
    document.querySelector<HTMLElement>('.visual-tools button')!.getBoundingClientRect().height]);
  expect(Math.abs(height - minBox)).toBeLessThanOrEqual(2);
});

test('pressing Lasso or Transform again turns it off', async ({ page }) => {
  await createVisual(page, 'toggles');
  const canvas = await openMain(page, 'toggles');
  const tool = () => canvas.evaluate((node) => (node as unknown as { visualEditor: { state: { tool: string } } }).visualEditor.state.tool);
  await drag(page, canvas, [[150, 100], [250, 100]]);
  await button(page, 'Eraser').click();
  await button(page, 'Lasso').click();
  await expect(button(page, 'Lasso')).toHaveAttribute('aria-pressed', 'true');
  await button(page, 'Lasso').click();
  await expect(button(page, 'Lasso')).toHaveAttribute('aria-pressed', 'false');
  expect(await tool()).toBe('eraser');
  await button(page, 'Brush').click();
  await button(page, 'Transform').click();
  await expect(page.getByRole('slider', { name: 'Rotate', exact: true })).toBeVisible();
  await button(page, 'Transform').click();
  await expect(page.getByRole('slider', { name: 'Rotate', exact: true })).toHaveCount(0);
  await expect(button(page, 'Transform')).toHaveAttribute('aria-pressed', 'false');
  expect(await tool()).toBe('brush');
  // Moving content off the canvas still asks before Transform turns off.
  await button(page, 'Transform').click();
  await drag(page, canvas, [[200, 100], [390, 100]]);
  await button(page, 'Transform').click();
  await expect(button(page, 'Crop to canvas')).toBeVisible();
  await button(page, 'Crop to canvas').click();
  await expect(button(page, 'Transform')).toHaveAttribute('aria-pressed', 'false');
});

test('brush configuration stays open while autosave runs, and the colour channels wrap beside the wheel', async ({ page }) => {
  await createVisual(page, 'config');
  const canvas = await openMain(page, 'config');
  const dirty = () => canvas.evaluate((node) => (node as unknown as { visualEditor: { dirty: boolean } }).visualEditor.dirty);
  await button(page, 'Brush').click();
  // Colour panel: wheel on the left, every channel control inside the menu's width (no horizontal overflow).
  const fits = await page.evaluate(() => {
    const panel = document.querySelector('.color-wheel-panel')!, menu = panel.closest('.subkeyframe-viewport')!;
    const right = Math.max(...[...panel.querySelectorAll('.channels > *')].map((node) => node.getBoundingClientRect().right));
    return { overflow: menu.scrollWidth > menu.clientWidth, inside: right <= menu.getBoundingClientRect().right + 1 };
  });
  expect(fits).toEqual({ overflow: false, inside: true });
  await page.getByRole('button', { name: /^Configure / }).click();
  const slider = page.locator('.brush-config-menu .keyflow-slider').first();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2, { steps: 5 }); await page.mouse.up();
  expect(await dirty()).toBe(true);
  await expect.poll(dirty, { timeout: 20_000 }).toBe(false);
  await expect(button(page, 'Pressure → size')).toBeVisible();
});
