import { choiceMenu, chooseMenu, expectChoiceCount } from './menu-helpers';
import { test, expect, type Page } from '@playwright/test';
// Image codecs share the browser's raster resources; run these cases sequentially.
test.describe.configure({ mode: 'default', timeout: 90_000 });
const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button, button[data-action=${JSON.stringify(name)}]`);
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
  await expect(choiceMenu(page, 'shortcut input space')).toHaveAttribute('data-value', 'alphanumeric');
  await expect(choiceMenu(page, 'virtual keyboard layout')).toHaveAttribute('data-value', 'ascii');
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
  await chooseMenu(page, 'virtual keyboard layout', 'flick-alpha');
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

test('virtual keyboard toggles immediately and stays responsive after modal search', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await action(page, 'app settings').click();
  const dock = page.locator('.keyboard-dock');
  for (let cycle = 0; cycle < 2; cycle++) {
    await action(page, 'virtual keyboard: off').click();
    await expect(dock).toHaveCount(1);
    await expect(dock).toBeVisible();
    await expect(page.locator('html')).toHaveClass(/virtual-keyboard-open/);
    await expect(action(page, 'virtual keyboard: on')).toBeVisible();

    await page.keyboard.press('Control+Shift+p');
    const dialog = page.getByRole('dialog', { name: 'Search all files', exact: true });
    await expect(dialog.locator('.keyboard-dock')).toBeVisible();
    const field = dialog.getByRole('searchbox');
    await expect(field).toHaveAttribute('inputmode', 'none');
    await dialog.locator('.keyboard-dock').getByRole('button', { name: 'a', exact: true }).click();
    await expect(field).toHaveValue('a');
    await dialog.getByRole('button', { name: 'Exit search', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(dock).toBeVisible();

    await action(page, 'app settings').click();
    await action(page, 'virtual keyboard: on').click();
    await expect(dock).toHaveCount(0);
    await expect(page.locator('html')).not.toHaveClass(/virtual-keyboard-open/);
    await expect(action(page, 'virtual keyboard: off')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('notework:virtual-keyboard'))).toBe('false');
  }
  expect(errors).toEqual([]);
});

test('mod-4 uses spare space without narrowing editors and alternates gray with transparency', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 900 });
  await action(page, 'app settings').click();
  await action(page, 'line numbers: on').click();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('lines.txt'); await action(page, 'create text file').click();
  await action(page, 'open').click();
  const text = page.getByRole('textbox', { name: 'Edit lines.txt' }); await text.fill('zero\none\ntwo\nthree\nfour');
  await expect(page.locator('.cm-lineNumbers')).toHaveCount(0);
  const geometry = () => page.locator('.editor-container').evaluate(container => {
    const line = container.querySelector('.cm-line')!, content = container.querySelector('.cm-content')!;
    const box = container.getBoundingClientRect(), row = line.getBoundingClientRect();
    return { left: box.left, width: box.width, lineLeft: row.left, lineWidth: row.width,
      borderLeft: getComputedStyle(container).borderLeftWidth, borderRight: getComputedStyle(container).borderRightWidth,
      contentBorder: getComputedStyle(content).borderLeftWidth, linePadding: getComputedStyle(line).paddingLeft };
  });
  const wide = await geometry();
  expect(wide.left).toBe(0);
  expect([wide.borderLeft, wide.borderRight, wide.contentBorder, wide.linePadding]).toEqual(['0px', '0px', '0px', '0px']);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await geometry();
  expect(narrow.width).toBe(390);
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await home(page); await action(page, 'app settings').click();
  await action(page, 'line index mod 4: off').click();
  await action(page, 'close app settings').click();
  await action(page, 'lines.txt').click(); await action(page, 'open').click();
  await expect(page.locator('.line-mod-0')).toHaveCount(2);
  expect(await geometry()).toEqual(narrow);
  await expect.poll(() => page.locator('.line-index').first().evaluate(line =>
    [getComputedStyle(line, '::before').width, getComputedStyle(line, '::after').width])).toEqual(['0px', '0px']);
  await page.setViewportSize({ width: 1800, height: 900 });
  expect(await geometry()).toEqual(wide);
  await expect.poll(() => page.locator('.line-index').first().evaluate(line =>
    parseFloat(getComputedStyle(line, '::after').width))).toBeCloseTo(1800 - wide.width, 0);
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const colors = await page.locator('.line-index').evaluateAll((lines) => lines.slice(0, 4).map((line) => {
      const left = getComputedStyle(line, '::before'), right = getComputedStyle(line, '::after');
      return [left.backgroundColor, right.backgroundColor];
    }));
    const gray = 'rgb(136, 136, 136)', clear = 'rgba(0, 0, 0, 0)';
    expect(colors).toEqual([[gray, gray], [clear, gray], [gray, clear], [clear, clear]]);
    await page.screenshot({ path: testInfo.outputPath(`line-index-${colorScheme}.png`) });
  }
});

test('Draw SVG enters drawing immediately; Delete drawing removes its reference and saved file', async ({ page }) => {
  await create(page, 'note.txt'); await action(page, 'open').click();
  await textTools(page).getByRole('button', { name: 'Draw…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose drawing format' }).getByRole('button', { name: 'SVG', exact: true }).click();
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
      await expect(choiceMenu(page, 'active layer')).toHaveAttribute('data-value', '0');
      await expectChoiceCount(page, 'active layer', 2);
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
    if (format === 'ora') await expectChoiceCount(page, 'active layer', 2);
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

test('Cmd/Ctrl+Shift+P searches from root with separate open and navigation actions', async ({ page }) => {
  await create(page, 'other.txt'); await home(page); await create(page, 'source.txt'); await action(page, 'open').click();
  const source = page.getByRole('textbox', { name: 'Edit source.txt' }); await source.fill('Keep this draft');
  await page.keyboard.down('Meta'); await expect(page.getByLabel('Command and Control shortcuts')).toBeVisible();
  await page.keyboard.press('Shift+p'); await page.keyboard.up('Meta');
  const dialog = page.getByRole('dialog', { name: 'Search all files', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('searchbox').fill('other');
  await expect(dialog.locator('.search-status')).toContainText('1 result found');
  const row = dialog.locator('.search-result-row').filter({ has: action(page, 'other.txt') });
  expect(await row.locator(':scope > [data-action]').evaluateAll((actions) =>
    actions.map((action) => action.getAttribute('data-action')))).toEqual(['open', 'other.txt']);
  await row.locator('[data-action="open"] button').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Edit other.txt' })).toBeVisible();
  expect(Buffer.from((await bytes(page, 'source.txt'))!).toString()).toBe('Keep this draft');
  await page.getByRole('textbox', { name: 'Edit other.txt' }).fill('Save before navigating');
  await page.keyboard.press('Control+Shift+p'); await dialog.getByRole('searchbox').fill('source');
  await dialog.locator('[data-action="source.txt"] button').click();
  await expect(dialog).toHaveCount(0);
  await expect(action(page, 'open')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Edit source.txt' })).toHaveCount(0);
  expect(Buffer.from((await bytes(page, 'other.txt'))!).toString()).toBe('Save before navigating');

  // Quick-open also enters the editor when its result is already selected.
  await page.keyboard.press('Control+Shift+p'); await dialog.getByRole('searchbox').fill('source');
  await dialog.locator('[data-action="open"] button').click();
  await expect(dialog).toHaveCount(0);
  await expect(source).toBeVisible();
  await source.fill('Save this file too');
  await page.keyboard.press('Control+Shift+p'); await dialog.getByRole('searchbox').fill('source');
  await dialog.locator('[data-action="source.txt"] button').click();
  await expect(dialog).toHaveCount(0);
  await expect(source).toHaveCount(0);
  await expect(action(page, 'open')).toBeVisible();
  expect(Buffer.from((await bytes(page, 'source.txt'))!).toString()).toBe('Save this file too');
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
  await page.keyboard.press('Control+Shift+p');
  const dialog = page.getByRole('dialog', { name: 'Search all files', exact: true });
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  for (const key of ['a', 'p', 'p']) await dialog.locator('.keyboard-dock').getByRole('button', { name: key, exact: true }).click();
  await expect(dialog.getByRole('searchbox')).toHaveValue('app');
  await expect(dialog.locator('[data-action="apple.txt"] button')).toBeVisible();
  await dialog.getByRole('button', { name: 'Exit search', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.keyboard-dock')).toBeVisible();
});

test('updated flick keyboard enters uppercase and editing gestures in the editor and search', async ({ page }) => {
  await create(page, 'gestures.txt'); await home(page); await action(page, 'app settings').click();
  await chooseMenu(page, 'virtual keyboard layout', 'flick-alpha');
  await action(page, 'virtual keyboard: off').click(); await action(page, 'close app settings').click();
  await action(page, 'gestures.txt').click(); await action(page, 'open').click();
  const editor = page.getByRole('textbox', { name: 'Edit gestures.txt', exact: true });
  await editor.fill('ab');
  const keyboard = page.locator('.keyflow-keyboard[data-layout="flick-alpha"]');
  await expect(keyboard.locator('.keyboard-row')).toHaveCount(3);
  for (const row of await keyboard.locator('.keyboard-row').all()) await expect(row.getByRole('button')).toHaveCount(10);
  async function flick(key: string, direction: 'left' | 'down' | 'up') {
    const box = (await keyboard.getByRole('button', { name: key, exact: true }).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(direction === 'left' ? box.x - 8 : x,
      direction === 'up' ? box.y - 8 : direction === 'down' ? box.y + box.height + 8 : y);
    await page.mouse.up();
  }
  await flick('q', 'down'); await expect(editor).toHaveText('abQ');
  await flick('escape', 'left'); await expect(editor).toHaveText('ab');
  await keyboard.getByRole('button', { name: 'escape', exact: true }).press('Alt+ArrowRight');
  await expect(editor).toHaveText('ab  ');
  await flick('space', 'left'); await keyboard.getByRole('button', { name: 'z', exact: true }).click();
  await expect(editor).toHaveText('ab z ');
  await flick('q', 'up'); await expect(editor).toHaveText('ab z1 ');
  await keyboard.getByRole('button', { name: 'escape', exact: true }).click();
  await expect(editor).not.toBeFocused();
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();

  await page.keyboard.press('Control+Shift+p');
  const dialog = page.getByRole('dialog', { name: 'Search all files', exact: true });
  await dialog.getByRole('searchbox').fill('gestures');
  await expect(dialog.locator('.search-status')).toContainText('1 result found');
  await dialog.locator('.keyboard-dock').getByRole('button', { name: 'escape', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'search all files and folders' })).toBeFocused();
  await expect(dialog.getByRole('searchbox')).toHaveValue('gestures');
  await dialog.locator('[data-action="open"] button').click();
  await expect(editor).toHaveText('ab z1 ');
});

test('navigation previews are read only, render prettify, and open the matching editor', async ({ page }) => {
  await create(page, 'preview.txt'); await action(page, 'open').click();
  const editor = page.getByRole('textbox', { name: 'Edit preview.txt', exact: true });
  await editor.fill('\\prettify\nParent\n\tChild\n\t\tLeaf\nOther');
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  const preview = page.locator('.file-preview');
  await expect(preview.locator('.cm-pretty-heading')).toHaveCount(2);
  await expect(preview.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(preview.locator('.cm-pretty-heading').first()).toHaveCSS('color', 'rgb(128, 0, 0)');
  await expect(preview.locator('.cm-pretty-heading').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(preview.locator('.cm-pretty-line').filter({ hasText: 'Leaf' })).toHaveCSS('color', colorScheme === 'dark' ? 'rgb(204, 204, 204)' : 'rgb(51, 51, 51)');
  }
  const hues = await preview.locator('.cm-pretty-heading').evaluateAll(lines => lines.map(line => (line as HTMLElement).style.getPropertyValue('--pretty-hue')));
  expect(hues).toEqual(['0', '45']);
  const shades = await preview.locator('.cm-pretty-heading').first().evaluate(line => {
    const root = document.documentElement;
    const saved = root.style.getPropertyValue('--pretty-lightness');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const result = ['25%', '75%'].map(lightness => {
      root.style.setProperty('--pretty-lightness', lightness);
      context.fillStyle = getComputedStyle(line).color; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    });
    if (saved) root.style.setProperty('--pretty-lightness', saved); else root.style.removeProperty('--pretty-lightness');
    return result;
  });
  expect(shades).toEqual([[128, 0, 0, 255], [255, 128, 128, 255]]);
  await expect(preview.getByRole('button', { name: 'Open preview.txt from preview', exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Open preview.txt from preview', exact: true }).click();
  await expect(editor).toBeEditable();
  await expect(editor).toContainText('Parent');
  for (const colorScheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(editor.locator('.cm-pretty-line').filter({ hasText: 'Leaf' })).toHaveCSS('color', colorScheme === 'dark' ? 'rgb(204, 204, 204)' : 'rgb(51, 51, 51)');
  }
});

test('bracket shortcuts traverse separate navigation and editor histories and branch after going back', async ({ page }) => {
  await create(page, 'first.txt'); await action(page, 'open').click();
  await page.getByRole('textbox', { name: 'Edit first.txt', exact: true }).fill('first');
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await home(page); await create(page, 'second.txt'); await action(page, 'open').click();
  const second = page.getByRole('textbox', { name: 'Edit second.txt', exact: true });
  await second.fill('second');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(second).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByRole('textbox', { name: 'Edit first.txt', exact: true })).toHaveText('first');
  await expect(textTools(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(second).toHaveText('second');
  await expect(textTools(page)).toBeFocused();
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(page.locator('.file-preview')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(page.getByRole('button', { name: 'open: second.txt', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+[');
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await action(page, 'first.txt').click();
  await expect(page.getByRole('button', { name: 'open: first.txt', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(page.getByRole('button', { name: 'open: first.txt', exact: true })).toBeVisible();
  await home(page); await create(page, 'third.png', 'png image'); await action(page, 'open').click();
  await expect(page.getByRole('img', { name: 'Drawing canvas for third.png', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('ControlOrMeta+[');
  await expect(second).toHaveText('second'); await expect(textTools(page)).toBeFocused();
  await page.keyboard.press('ControlOrMeta+]');
  await expect(drawTools(page)).toBeFocused();
});

test('pen size uses a nested Keyflow slider, remains scoped, and survives SVG save/reopen', async ({ page }) => {
  await create(page, 'sized.svg', 'svg file'); await action(page, 'open').click();
  await drawTools(page).getByRole('button', { name: 'Brush', exact: true }).click();
  const slider = page.getByRole('slider', { name: 'Pen size', exact: true });
  await expect(slider).toBeVisible();
  const old = Number(await slider.getAttribute('aria-valuenow'));
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(150); await page.keyboard.up('ArrowUp');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(old);
  const size = Number(await slider.getAttribute('aria-valuenow'));
  await page.keyboard.press('Escape');
  await expect(slider).toHaveCount(0);
  await stroke(page);
  await expect(page.locator('.drawing-canvas > polyline')).toHaveAttribute('stroke-width', String(size));
  await drawTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await action(page, 'open').click();
  await expect(page.locator('.drawing-canvas > polyline')).toHaveAttribute('stroke-width', String(size));
});

test('raster eraser removes saved pixels locally, supports undo, and keeps surrounding pixels', async ({ page }) => {
  await create(page, 'erase-note.txt'); await action(page, 'open').click();
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
    const context = canvas.getContext('2d')!; context.fillStyle = 'red'; context.fillRect(0, 0, 400, 200);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!)));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  await page.getByLabel('Image file to insert').setInputFiles({ name: 'erase.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  const canvas = page.getByRole('img', { name: /^Drawing canvas for erase-.*\.png/ });
  await expect(canvas).toBeVisible();
  const name = (await canvas.getAttribute('aria-label'))!.slice('Drawing canvas for '.length);
  const eraser = drawTools(page).getByRole('button', { name: 'Eraser', exact: true });
  await eraser.click(); await eraser.click();
  const slider = page.getByRole('slider', { name: 'Eraser size', exact: true });
  await expect(slider).toBeVisible();
  await page.keyboard.down('ArrowUp'); await page.waitForTimeout(100); await page.keyboard.up('ArrowUp');
  await page.keyboard.press('Escape');
  const box = (await canvas.boundingBox())!;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(center.x - 12, center.y); await page.mouse.down();
  await page.mouse.move(center.x + 12, center.y, { steps: 8 }); await page.mouse.up();
  await expect(canvas.locator('mask polyline')).not.toHaveCount(0);
  await drawTools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(canvas.locator('mask polyline')).toHaveCount(0);
  await drawTools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await drawTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(textTools(page)).toBeVisible();
  const data = await bytes(page, name);
  const pixels = await page.evaluate(async data => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(data!)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    return [Array.from(context.getImageData(200, 100, 1, 1).data), Array.from(context.getImageData(50, 50, 1, 1).data)];
  }, data);
  expect(pixels).toEqual([[0, 0, 0, 0], [255, 0, 0, 255]]);
});

test('filename opens separately, and a long preview click opens the clicked text position', async ({ page }) => {
  await create(page, 'long-preview.txt'); await action(page, 'open').click();
  const editor = page.getByRole('textbox', { name: 'Edit long-preview.txt', exact: true });
  await editor.fill(Array.from({ length: 800 }, (_, i) => `Line ${i + 1}: preview content`).join('\n'));
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  const preview = page.locator('.file-preview');
  const title = page.getByRole('button', { name: 'open: long-preview.txt', exact: true });
  await expect(title).toBeVisible();
  await expect(title.locator('..').locator('..')).not.toHaveClass(/file-preview/);
  await page.mouse.move(0, 0);
  await expect(preview.locator('.preview-open-hint')).toHaveCSS('opacity', '0');
  await expect(preview.locator('.cm-line').first()).toBeVisible();
  await page.locator('.viewport').evaluate(viewport => {
    const content = document.querySelector('.file-preview .cm-content')!;
    const rect = content.getBoundingClientRect();
    const height = parseFloat(getComputedStyle(content).lineHeight);
    viewport.scrollBy({ top: rect.top + 499 * height - 200, behavior: 'instant' });
  });
  const line = preview.locator('.cm-line').filter({ hasText: /^Line 500:/ });
  await expect(line).toBeInViewport();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await expect(preview.locator('.preview-open-hint')).toHaveCSS('opacity', '1');
  await page.mouse.click(box.x + 5, box.y + box.height / 2);
  await expect(editor).toBeFocused();
  await expect(editor.locator('.cm-line').filter({ hasText: /^Line 500:/ })).toBeInViewport();
  expect(await page.locator('.editor-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  await page.keyboard.insertText('@');
  await expect(editor.locator('.cm-line').filter({ hasText: /@/ })).toHaveText(/^@?L?@?ine 500:/);
});

test('system is the default theme and Keyflow dropdown persists explicit choices', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await action(page, 'app settings').click();
  const menu = () => page.getByRole('button', { name: /^color theme:/ });
  await expect(menu()).toHaveAttribute('aria-label', 'color theme: system');
  await expect(page.locator('html')).toHaveCSS('--background', 'hsl(0, 0%, 0%)');
  await menu().click();
  const choices = page.getByRole('region', { name: 'color theme: system' });
  await expect(choices).toBeInViewport();
  await expect(choices.getByRole('list').getByRole('button')).toHaveCount(3);
  await choices.getByRole('button', { name: /light$/ }).click();
  await expect(page.locator('html')).toHaveCSS('--background', 'hsl(0, 0%, 100%)');
  await page.emulateMedia({ colorScheme: 'light' }); await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveCSS('--background', 'hsl(0, 0%, 100%)');
  await page.reload(); await action(page, 'app settings').click();
  await expect(menu()).toHaveAttribute('aria-label', 'color theme: light');
  await menu().click(); await page.getByRole('region', { name: 'color theme: light' }).getByRole('button', { name: /system$/ }).click();
  await expect(page.locator('html')).toHaveCSS('--background', 'hsl(0, 0%, 0%)');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveCSS('--background', 'hsl(0, 0%, 100%)');
});

test('page embeds are indented, inherit pretty, save graph links, and open with editor history', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await create(page, 'child.txt'); await action(page, 'open').click();
  await page.getByRole('textbox', { name: 'Edit child.txt', exact: true }).fill('Child\n  Leaf\nTail');
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await home(page); await create(page, 'parent.txt'); await action(page, 'open').click();
  const parent = page.getByRole('textbox', { name: 'Edit parent.txt', exact: true });
  await parent.fill('\\pretty\nRoot\n  \\page[child.txt]\nEnd');
  const embedded = page.getByRole('region', { name: 'Referenced file child.txt', exact: true });
  await expect(embedded.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(embedded.locator('.cm-line').first()).toHaveText('  Child');
  await expect(embedded.locator('.cm-line').nth(1)).toHaveText('    Leaf');
  await expect(embedded.locator('.cm-pretty-heading')).toHaveCSS('color', 'rgb(128, 96, 0)');
  const embeddedBase = await embedded.locator('.cm-editor').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await expect(embedded.locator('.cm-pretty-text')).toHaveCSS('font-size', `${embeddedBase * 1.5}px`);
  for (const edge of ['paddingTop', 'paddingBottom'] as const) {
    expect(await embedded.locator('.cm-pretty-heading').evaluate((element, edge) => parseFloat(getComputedStyle(element)[edge]), edge)).toBeCloseTo(embeddedBase * 1.5 * .83, 2);
  }
  await embedded.getByRole('button', { name: 'Open child.txt from preview', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Edit child.txt', exact: true })).toHaveText('Child  LeafTail');
  await page.keyboard.press('Escape'); await page.keyboard.press('ControlOrMeta+[');
  await expect(parent).toBeVisible(); await expect(textTools(page)).toBeFocused();
  await expect(embedded).toBeVisible();
  expect(Buffer.from((await bytes(page, 'parent.txt'))!).toString()).toContain('\\page[child.txt]');
  expect(Buffer.from((await bytes(page, 'child.txt'))!).toString()).toBe('Child\n  Leaf\nTail');
  expect(errors).toEqual([]);
});

test('nested page references stop cycles and missing references do not create files', async ({ page }) => {
  await create(page, 'cycle.txt'); await action(page, 'open').click();
  const editor = page.getByRole('textbox', { name: 'Edit cycle.txt', exact: true });
  await editor.fill('\\page[cycle.txt]\n\\page[missing.txt]\nEnd');
  await expect(page.getByText('Circular page reference: cycle.txt', { exact: true })).toBeVisible();
  await expect(page.getByText('Referenced file “missing.txt” is unavailable.', { exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  expect(await bytes(page, 'missing.txt')).toBeNull();
});

test('a click low in a drawing preview opens that drawing point without adding ink', async ({ page }) => {
  await create(page, 'tall.svg', 'svg file');
  await expect(page.getByRole('button', { name: 'open: tall.svg', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const documents = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('notework')).getDirectoryHandle('documents');
    for await (const bucket of documents.values()) {
      if (bucket.kind !== 'directory') continue;
      try {
        const file = await bucket.getFileHandle('tall.svg'); const writer = await file.createWritable();
        await writer.write('<svg xmlns="http://www.w3.org/2000/svg" data-notework-drawing="1" width="1024" height="3002" viewBox="0 0 1024 3002"><g fill="none" stroke="#202733" stroke-width="3"><polyline points="500,100 500,3000"/></g></svg>');
        await writer.close(); return;
      } catch { /* Isolated test buckets only. */ }
    }
    throw new Error('Missing test drawing');
  });
  await home(page); await action(page, 'tall.svg').click();
  const image = page.locator('.file-preview img'); await expect(image).toBeVisible();
  await image.evaluate(img => {
    const rect = img.getBoundingClientRect();
    document.querySelector('.viewport')!.scrollBy({ top: rect.top + 2400 / 1024 * rect.width - 200, behavior: 'instant' });
  });
  const box = (await image.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 2400 / 1024 * box.width);
  const canvas = page.getByRole('img', { name: 'Drawing canvas for tall.svg', exact: true });
  await expect(canvas).toBeVisible();
  await expect.poll(() => canvas.evaluate(svg => {
    const point = new DOMPoint(512, 2400).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
    const surface = svg.closest('.drawing-surface')!.getBoundingClientRect();
    return point.y > surface.top && point.y < surface.bottom;
  })).toBe(true);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  expect(await page.locator('.drawing-surface').evaluate(surface => surface.scrollTop)).toBeGreaterThan(500);
});

test('page completion offers text targets and renaming updates the saved page directive', async ({ page }) => {
  await create(page, 'source-page.txt'); await action(page, 'open').click();
  await page.getByRole('textbox', { name: 'Edit source-page.txt', exact: true }).fill('Referenced content');
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await home(page); await create(page, 'linked-page.txt'); await action(page, 'open').click();
  const parent = page.getByRole('textbox', { name: 'Edit linked-page.txt', exact: true });
  await parent.fill('\\page[sour');
  const option = page.getByRole('option').filter({ hasText: 'source-page.txt' });
  await expect(option).toBeVisible(); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Referenced file source-page.txt', exact: true }).locator('.cm-content')).toHaveText('Referenced content');
  await textTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
  await home(page); await action(page, 'source-page.txt').click(); await action(page, 'configure file').click(); await action(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename file', exact: true });
  await dialog.getByRole('textbox').fill('renamed-page.txt'); await dialog.getByRole('button', { name: 'Rename and update links', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(Buffer.from((await bytes(page, 'linked-page.txt'))!).toString()).toContain('\\page[renamed-page.txt]');
  await home(page); await action(page, 'linked-page.txt').click(); await action(page, 'open').click();
  await expect(parent).toBeFocused();
  await page.keyboard.press('ControlOrMeta+End');
  await expect(page.getByRole('region', { name: 'Referenced file renamed-page.txt', exact: true }).locator('.cm-content')).toHaveText('Referenced content');
});

for (const format of ['svg', 'png']) {
  test(`${format} keeps strokes drawn during saves and ignores palm touches around pen input`, async ({ page, context }) => {
    await create(page, `continuous.${format}`, format === 'svg' ? 'svg file' : 'png image');
    await action(page, 'open').click();
    const canvas = page.getByRole('img', { name: `Drawing canvas for continuous.${format}` });
    await expect(canvas).toBeVisible();
    const protocol = await context.newCDPSession(page);
    const position = async (y: number) => canvas.evaluate((svg, y) => {
      const matrix = (svg as SVGSVGElement).getScreenCTM()!;
      const a = new DOMPoint(80, y).matrixTransform(matrix), b = new DOMPoint(200, y).matrixTransform(matrix);
      return { x: a.x, y: a.y, end: b.x };
    }, y);
    const draw = async (y: number) => {
      const p = await position(y);
      await page.mouse.move(p.x, p.y); await page.mouse.down();
      await page.mouse.move(p.end, p.y, { steps: 5 }); await page.mouse.up();
    };
    await draw(60);
    await page.evaluate(() => {
      const original = FileSystemFileHandle.prototype.createWritable;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      Object.assign(window, { releaseDrawingSave: release, drawingSaveStarted: false });
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        FileSystemFileHandle.prototype.createWritable = original;
        Object.assign(window, { drawingSaveStarted: true });
        await gate;
        return original.apply(this, args);
      };
    });
    await page.keyboard.press('Control+s');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'drawingSaveStarted'))).toBe(true);
    await expect(page.getByText('saving drawing…', { exact: true })).toBeVisible();
    await draw(120);
    await expect(canvas.locator(':scope > polyline')).toHaveCount(2);
    await page.evaluate(() => Reflect.get(window, 'releaseDrawingSave')());
    await expect(page.getByText('saving drawing…', { exact: true })).toHaveCount(0);
    const p = await position(180);
    await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, x: p.x, y: p.y });
    await canvas.evaluate(svg => {
      const contacts = [1, 2].map(identifier => new Touch({ identifier, target: svg, clientX: 30 + identifier * 30, clientY: 50 }));
      const dispatch = (type: string, touches: Touch[]) => svg.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, changedTouches: contacts }));
      dispatch('touchstart', contacts); dispatch('touchend', []); dispatch('touchcancel', []);
    });
    await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', buttons: 1, x: p.end, y: p.y });
    await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, x: p.end, y: p.y });
    // A palm lifting immediately after the pen must not undo the completed stroke.
    await canvas.evaluate(svg => {
      const contacts = [1, 2].map(identifier => new Touch({ identifier, target: svg, clientX: 30 + identifier * 30, clientY: 50 }));
      svg.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: contacts, changedTouches: contacts }));
      svg.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: contacts }));
    });
    await expect(canvas.locator(':scope > polyline')).toHaveCount(3);
    await drawTools(page).getByRole('button', { name: 'Exit', exact: true }).click();
    await expect(action(page, 'open')).toBeVisible();
    const data = (await bytes(page, `continuous.${format}`))!;
    if (format === 'svg') expect(Buffer.from(data).toString().match(/<polyline/g)).toHaveLength(3);
    else expect(await page.evaluate(async data => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(data)], { type: 'image/png' }));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return [60, 120, 180].map(y => ctx.getImageData(140, y, 1, 1).data[3]);
    }, data)).toEqual([255, 255, 255]);
  });
}

test('image previews and editors animate a loading icon inside the image while decoding', async ({ page }) => {
  await create(page, 'loading.png', 'png image');
  await expect(action(page, 'open')).toBeVisible();
  await page.reload();
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releaseImageDecode: release });
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      await gate;
      return original(...args);
    }) as typeof createImageBitmap;
  });
  await action(page, 'loading.png').click();
  const preview = page.locator('.file-preview');
  const indicator = preview.getByRole('status', { name: 'Loading image', exact: true });
  await expect(indicator).toBeVisible();
  await expect(indicator.locator('svg')).toHaveCSS('animation-name', 'image-loading-spin');
  const inside = await indicator.evaluate(el => {
    const icon = el.getBoundingClientRect(), image = el.closest('.file-preview')!.getBoundingClientRect();
    return icon.top >= image.top && icon.bottom <= image.bottom && icon.left >= image.left && icon.right <= image.right;
  });
  expect(inside).toBe(true);
  await page.evaluate(() => Reflect.get(window, 'releaseImageDecode')());
  await expect(preview.locator('img')).toBeVisible();
  await expect(indicator).toHaveCount(0);
  await page.evaluate(() => {
    const original = window.createImageBitmap;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    Object.assign(window, { releaseImageDecode: release });
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      await gate;
      return original(...args);
    }) as typeof createImageBitmap;
  });
  await action(page, 'open').click();
  await expect(page.getByRole('status', { name: 'Loading image', exact: true })).toBeVisible();
  await page.evaluate(() => Reflect.get(window, 'releaseImageDecode')());
  await expect(page.getByRole('img', { name: 'Drawing canvas for loading.png' })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading image', exact: true })).toHaveCount(0);
});
