import { test, expect, type Page } from '@playwright/test';
// Image codecs share the browser's raster resources; run these cases sequentially.
test.describe.configure({ mode: 'default', timeout: 90_000 });
const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
const textTools = (page: Page) => page.getByRole('group', { name: 'Editor toolbar' });
const drawTools = (page: Page) => page.getByRole('group', { name: 'Drawing toolbar' });
async function create(page: Page, name: string, type = 'text file') {
  await action(page, 'app settings').click();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill(name);
  await action(page, `create ${type}`).click();
}
async function home(page: Page) { await action(page, 'home').click(); }
async function bytes(page: Page, name: string) {
  return page.evaluate(async (name) => {
    const app = await (await navigator.storage.getDirectory()).getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents');
    for await (const bucket of documents.values()) {
      if (bucket.kind !== 'directory') continue;
      try { return Array.from(new Uint8Array(await (await (await bucket.getFileHandle(name)).getFile()).arrayBuffer())); }
      catch { /* Search isolated app-owned buckets. */ }
    }
    return null;
  }, name);
}
async function stroke(page: Page) {
  const canvas = page.getByRole('img', { name: /^Drawing canvas for / });
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 100, { steps: 5 }); await page.mouse.up();
}

test.beforeEach(async ({ page }) => { await page.goto('/'); await expect(action(page, 'app settings')).toBeEnabled({ timeout: 30_000 }); });

test('keyboard defaults, persisted settings, virtual ASCII text and real flick input', async ({ page }) => {
  await expect(page.locator('.keyboard-dock')).toHaveCount(0);
  await action(page, 'app settings').click();
  await expect(page.getByLabel('shortcut input space', { exact: true })).toHaveValue('alphanumeric');
  await expect(page.getByLabel('virtual keyboard layout', { exact: true })).toHaveValue('ascii');
  await action(page, 'virtual keyboard: off').click();
  await expect(page.getByRole('region', { name: 'ASCII keyboard', exact: true })).toBeVisible();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('keys.txt');
  await action(page, 'create text file').click();
  await action(page, 'open').click();
  const text = page.getByRole('textbox', { name: 'Edit keys.txt', exact: true });
  await expect(text).toBeFocused();
  await page.locator('.keyboard-dock button').filter({ hasText: /^\[a\]$/ }).click();
  await expect(text).toHaveText('a');
  await page.locator('.keyboard-dock button').filter({ hasText: /^\[Enter\]$/ }).click();
  await expect(text.locator('.cm-line')).toHaveCount(2);
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await home(page); await action(page, 'app settings').click();
  await page.getByLabel('virtual keyboard layout', { exact: true }).selectOption('flick-alpha');
  await page.reload();
  await action(page, 'keys.txt').click(); await action(page, 'open').click();
  await expect(page.locator('.keyflow-keyboard')).toHaveAttribute('data-layout', 'flick-alpha');
  const key = page.locator('.keyflow-flick-key').first();
  await expect(key).toBeVisible();
  const box = (await key.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 8); await page.mouse.up();
  await expect(text).toContainText('1');
});

test('line numbers can be removed and mod-4 edges use zero-based little endian colors', async ({ page }) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await action(page, 'app settings').click();
  await action(page, 'line numbers: on').click(); await action(page, 'line index mod 4: off').click();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('lines.txt'); await action(page, 'create text file').click();
  await action(page, 'open').click();
  const text = page.getByRole('textbox', { name: 'Edit lines.txt' }); await text.fill('zero\none\ntwo\nthree\nfour');
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0);
  await expect(page.locator('.line-mod-0')).toHaveCount(2);
  const colors = await page.locator('.line-index').evaluateAll((lines) => lines.slice(0, 4).map((line) => {
    const left = getComputedStyle(line, '::before'), right = getComputedStyle(line, '::after');
    return [left.backgroundColor, right.backgroundColor];
  }));
  expect(colors).toEqual([['rgb(136, 136, 136)', 'rgb(136, 136, 136)'], ['rgb(255, 255, 255)', 'rgb(136, 136, 136)'], ['rgb(136, 136, 136)', 'rgb(255, 255, 255)'], ['rgb(255, 255, 255)', 'rgb(255, 255, 255)']]);
  await page.screenshot({ path: '/private/tmp/notework-line-index.png' });
});

test('+svg enters drawing immediately; Delete drawing removes its reference and saved file', async ({ page }) => {
  await create(page, 'note.txt'); await action(page, 'open').click();
  await textTools(page).getByRole('button', { name: '+svg', exact: true }).click();
  const canvas = page.getByRole('img', { name: /^Drawing canvas for / });
  await expect(canvas).toBeVisible();
  const name = (await canvas.getAttribute('aria-label'))!.slice('Drawing canvas for '.length);
  await stroke(page); await page.keyboard.press('Control+s');
  await expect.poll(() => bytes(page, name)).not.toBeNull();
  page.once('dialog', (dialog) => dialog.accept());
  await drawTools(page).getByRole('button', { name: 'Delete drawing', exact: true }).click();
  await expect(textTools(page)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Edit note.txt' })).not.toContainText('svgpage');
  expect(await bytes(page, name)).toBeNull();
});

for (const format of ['png', 'jpeg', 'heic', 'ora']) {
  test(`${format} creates real encoded content, draws, saves, and reopens`, async ({ page }) => {
    test.setTimeout(90_000);
    await create(page, `picture.${format}`, `${format} image`);
    await action(page, 'open').click(); await stroke(page);
    if (format === 'ora') {
      await page.getByRole('button', { name: 'Add layer', exact: true }).click();
      await expect(page.getByLabel('active layer')).toHaveValue('0');
      await expect(page.getByLabel('active layer').locator('option')).toHaveCount(2);
      await stroke(page);
    }
    await drawTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(action(page, 'open')).toBeVisible({ timeout: 30_000 });
    const data = (await bytes(page, `picture.${format}`))!;
    if (format === 'png') expect(data.slice(0, 8)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    if (format === 'jpeg') expect(data.slice(0, 3)).toEqual([255, 216, 255]);
    if (format === 'heic') expect(Buffer.from(data).subarray(4, 8).toString()).toBe('ftyp');
    if (format === 'ora') expect(data.slice(0, 2)).toEqual([80, 75]);
    await page.reload(); await action(page, `picture.${format}`).click(); await action(page, 'open').click();
    await expect(page.getByRole('img', { name: `Drawing canvas for picture.${format}` })).toBeVisible();
    if (format === 'ora') await expect(page.getByLabel('active layer').locator('option')).toHaveCount(2);
    const image = page.locator('.drawing-canvas image').first();
    await expect(image).toHaveAttribute('href', /^blob:/);
  });
}

test('drawing format choice inserts the matching image directive and opens its editor', async ({ page }) => {
  await create(page, 'images.txt'); await action(page, 'open').click();
  await textTools(page).getByRole('button', { name: 'Draw…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose drawing format' });
  await dialog.getByRole('button', { name: 'PNG', exact: true }).click();
  await stroke(page); await drawTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  const text = page.getByRole('textbox', { name: 'Edit images.txt' });
  await expect(page.getByRole('button', { name: /^Edit drawing drawing-.*\.png$/ })).toBeVisible();
  await text.press('Control+s'); await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  expect(Buffer.from((await bytes(page, 'images.txt'))!).toString()).toMatch(/\\pngpage\[drawing-.*\.png\]/);
});

test('Cmd/Ctrl+P masks the app, searches from root, and preserves editing/navigation mode', async ({ page }) => {
  await create(page, 'other.txt'); await home(page); await create(page, 'source.txt'); await action(page, 'open').click();
  const source = page.getByRole('textbox', { name: 'Edit source.txt' }); await source.fill('Keep this draft');
  await page.keyboard.down('Meta'); await expect(page.getByLabel('Command and Control shortcuts')).toBeVisible();
  await page.keyboard.press('p'); await page.keyboard.up('Meta');
  const dialog = page.getByRole('dialog', { name: 'Search all files', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('searchbox').fill('other');
  await expect(dialog.locator('.search-status')).toContainText('1 result found');
  await dialog.locator('[data-action="other.txt"] button').click();
  await expect(page.getByRole('textbox', { name: 'Edit other.txt' })).toBeVisible();
  expect(Buffer.from((await bytes(page, 'source.txt'))!).toString()).toBe('Keep this draft');
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await page.keyboard.press('Control+p'); await dialog.getByRole('searchbox').fill('source');
  await dialog.locator('[data-action="source.txt"] button').click();
  await expect(action(page, 'open')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Edit source.txt' })).toHaveCount(0);
});

test('imported image pixels survive drawing, and image links export and rename correctly', async ({ page }) => {
  await create(page, 'photo-note.txt'); await action(page, 'open').click();
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
    const context = canvas.getContext('2d')!; context.fillStyle = '#e00000'; context.fillRect(0, 0, 400, 200);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByLabel('Image file to insert').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  const canvas = page.getByRole('img', { name: /^Drawing canvas for photo-.*\.png/ });
  await expect(canvas).toBeVisible();
  const name = (await canvas.getAttribute('aria-label'))!.slice('Drawing canvas for '.length);
  await stroke(page); await drawTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  const preview = page.getByRole('button', { name: `Edit drawing ${name}` });
  await expect(preview.locator('image')).toHaveAttribute('href', /^data:image\/png/);
  await textTools(page).getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  expect((await downloaded).suggestedFilename()).toBe('photo-note.pdf');
  await expect(dialog).toHaveCount(0);
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  const saved = await bytes(page, name);
  const pixel = await page.evaluate(async data => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data!)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    return Array.from(context.getImageData(390, 190, 1, 1).data);
  }, saved);
  expect(pixel).toEqual([224, 0, 0, 255]);
  await action(page, name).click(); await action(page, 'configure file').click(); await action(page, 'rename').click();
  const rename = page.getByRole('dialog', { name: 'Rename file' }); await rename.getByRole('textbox').fill('renamed.png');
  await rename.getByRole('button', { name: 'Rename and update links', exact: true }).click();
  await expect(rename).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'renamed.png', exact: true })).toBeVisible();
  expect(Buffer.from((await bytes(page, 'photo-note.txt'))!).toString()).toContain('\\pngpage[renamed.png]');
});

test('virtual keyboard remains usable inside modal global search', async ({ page }) => {
  await create(page, 'apple.txt'); await home(page); await action(page, 'app settings').click();
  await action(page, 'virtual keyboard: off').click(); await action(page, 'close app settings').click();
  await page.keyboard.press('Control+p');
  const dialog = page.getByRole('dialog', { name: 'Search all files', exact: true });
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  for (const key of ['a', 'p', 'p']) await dialog.locator('.keyboard-dock').getByRole('button', { name: key, exact: true }).click();
  await expect(dialog.getByRole('searchbox')).toHaveValue('app');
  await expect(dialog.locator('[data-action="apple.txt"] button')).toBeVisible();
  await dialog.getByRole('button', { name: 'Exit search', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.keyboard-dock')).toBeVisible();
});
