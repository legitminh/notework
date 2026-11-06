import { test, expect, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFArray, PDFRawStream, PDFName, decodePDFRawStream } from 'pdf-lib';

const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
const tools = (page: Page) => page.getByRole('group', { name: 'Editor toolbar' });
async function startCreate(page: Page) {
  await page.locator('[data-action="configure folder"] button, [data-action="app settings"] button').click();
  await action(page, 'create new file/folder').click();
}
async function note(page: Page, name: string) {
  await page.goto('/');
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill(name);
  await action(page, 'create text file').click();
  await action(page, 'open').click();
  const editor = page.getByRole('textbox', { name: `Edit ${name}` });
  await expect(editor).toBeVisible();
  return editor;
}
async function readPdf(download: Download) {
  const file = await download.path();
  const pdf = await PDFDocument.load(await readFile(file!));
  expect(pdf.getPageCount()).toBe(1);
  const page = pdf.getPage(0);
  expect(page.getMediaBox()).toEqual(page.getCropBox());
  expect(page.getMediaBox().x).toBe(0); expect(page.getMediaBox().y).toBe(0);
  const content = page.node.Contents();
  const streams = content instanceof PDFArray ? content.asArray().map((ref) => pdf.context.lookup(ref)) : [content];
  const operators = streams.filter((stream): stream is PDFRawStream => stream instanceof PDFRawStream)
    .map((stream) => Buffer.from(decodePDFRawStream(stream).decode()).toString('latin1')).join('\n');
  return { pdf, page, operators };
}

test('PDF export includes the whole unsaved draft, styled links, and vector SVG with default margins', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  const editor = await note(page, 'export-note.txt');
  await tools(page).getByRole('button', { name: 'Brush', exact: true }).click();
  await page.keyboard.insertText('below');
  const preview = page.getByRole('button', { name: /^Edit drawing drawing-/ });
  const name = (await preview.getAttribute('aria-label'))!.slice('Edit drawing '.length);
  await preview.click();
  const canvas = page.getByRole('img', { name: `Drawing canvas for ${name}` });
  const matrix = await canvas.evaluate((el) => {
    const m = (el as SVGSVGElement).getScreenCTM()!; return { a: m.a, d: m.d, e: m.e, f: m.f };
  });
  await page.mouse.move(matrix.e + 100 * matrix.a, matrix.f + 50 * matrix.d); await page.mouse.down();
  await page.mouse.move(matrix.e + 500 * matrix.a, matrix.f + 200 * matrix.d);
  await page.mouse.move(matrix.e + 100 * matrix.a, matrix.f + 200 * matrix.d); await page.mouse.up();
  const drawingTools = page.getByRole('group', { name: 'Drawing toolbar' });
  await page.keyboard.press('ControlOrMeta+s');
  await drawingTools.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(editor).toBeEditable();
  await editor.press('ControlOrMeta+a');
  await editor.press('Backspace');
  await page.keyboard.insertText(`PDF layout: Tiếng Việt αβ 🙂\n[[linked-note.txt]]\n\\svgpage[${name}]\nAfter drawing\n${Array.from({ length: 80 }, (_, i) => `off-screen line ${i + 1}`).join('\n')}\nDEEP END`);
  await tools(page).getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog.getByLabel('Export format')).toHaveValue('pdf');
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('export-note.pdf');
  const { page: pdfPage, operators } = await readPdf(download);
  const dimensions = await page.evaluate(() => ({
    width: parseFloat(document.querySelector<HTMLElement>('.cm-editor')!.style.getPropertyValue('--drawing-page-width')),
    minBox: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--min-box'))
  }));
  expect(pdfPage.getWidth()).toBeCloseTo((dimensions.width + 2 * dimensions.minBox) * .75, 3);
  const translations = Array.from(operators.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) cm/g));
  expect(translations.some((match) => Math.abs(Number(match[1]) - dimensions.minBox * .75) < .001)).toBe(true);
  expect(pdfPage.getHeight()).toBeGreaterThan(1500);
  expect(operators).toContain(' Do'); // Font-matched text tiles.
  expect(operators).toContain(' l'); // Vector stroke geometry, not an SVG source literal.
  expect(operators).toContain('S');
  await download.saveAs('/tmp/notework-export-qa.pdf');
  await expect(page.getByText('unsaved changes', { exact: true })).toBeVisible();
  await editor.press('ControlOrMeta+End');
  await expect(editor.locator('.cm-line').last()).toHaveText('DEEP END');
  expect(errors).toEqual([]);
});

test('PWA export shares a prepared PDF from a fresh tap and treats cancellation as cancellation', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    Object.defineProperty(navigator, 'canShare', { value: (data: ShareData) => data.files?.[0]?.type === 'application/pdf' });
    Object.defineProperty(navigator, 'share', { value: async (data: ShareData) => {
      const calls = JSON.parse(sessionStorage.getItem('shares') || '[]');
      calls.push({ name: data.files![0].name, type: data.files![0].type, active: navigator.userActivation.isActive });
      sessionStorage.setItem('shares', JSON.stringify(calls));
      if (calls.length === 1) throw new DOMException('Cancelled', 'AbortError');
    } });
  });
  const downloads: Download[] = []; page.on('download', (download) => downloads.push(download));
  const editor = await note(page, 'share-note.txt'); await editor.fill('Shared current draft');
  await tools(page).getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  const share = dialog.getByRole('button', { name: 'Share PDF', exact: true });
  await expect(share).toBeEnabled(); await share.click();
  await expect(dialog.getByRole('status')).toHaveText('Sharing cancelled.');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  expect(downloads).toHaveLength(0);
  await share.click(); await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('shares')!))).toEqual([
    { name: 'share-note.pdf', type: 'application/pdf', active: true },
    { name: 'share-note.pdf', type: 'application/pdf', active: true }
  ]);
  expect(downloads).toHaveLength(0);
});

test('PWA export falls back to a normal PDF download when file sharing is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { value: true });
    Object.defineProperty(navigator, 'canShare', { value: () => false });
    Object.defineProperty(navigator, 'share', { value: () => { throw new Error('Must not be called'); } });
  });
  const editor = await note(page, 'fallback.txt'); await editor.fill('Download fallback');
  await tools(page).getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await readPdf(await downloaded);
});

test('standalone drawing export includes unsaved strokes as vector geometry', async ({ page }) => {
  await page.goto('/'); await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('export-drawing');
  await action(page, 'create svg file').click(); await action(page, 'open').click();
  const canvas = page.getByRole('img', { name: 'Drawing canvas for export-drawing.svg' });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 50); await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 100); await page.mouse.up();
  const drawingTools = page.getByRole('group', { name: 'Drawing toolbar' });
  await drawingTools.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('export-drawing.pdf');
  const { operators } = await readPdf(download);
  expect(operators).toContain(' l'); expect(operators).not.toContain(' Do');
  await expect(page.getByText('unsaved drawing changes', { exact: true })).toBeVisible();
});

test('inline export uses the current unsaved drawing and leaves its source draft untouched', async ({ page }) => {
  const editor = await note(page, 'inline.txt');
  await tools(page).getByRole('button', { name: 'Brush', exact: true }).click();
  await page.keyboard.insertText('below');
  await page.getByRole('button', { name: /^Edit drawing drawing-/ }).click();
  const canvas = page.getByRole('img', { name: /^Drawing canvas for drawing-/ });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 100); await page.mouse.up();
  const drawingTools = page.getByRole('group', { name: 'Drawing toolbar' });
  await drawingTools.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('inline.pdf');
  const { operators } = await readPdf(download);
  expect(operators).toContain(' l'); expect(operators).toContain(' Do');
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await expect(page.getByText('unsaved drawing changes', { exact: true })).toBeVisible();
  await expect(editor).not.toBeEditable();
});

test('tall notes stay on a single PDF page, and cancelling preparation leaves the draft editable', async ({ page }) => {
  const editor = await note(page, 'tall.txt');
  await editor.fill(Array.from({ length: 850 }, (_, i) => `line ${i + 1}`).join('\n'));
  await tools(page).getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(editor).toBeEditable();
  await tools(page).getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled({ timeout: 15000 });
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const { page: pdfPage } = await readPdf(await downloaded);
  expect(pdfPage.node.get(PDFName.of('UserUnit'))?.toString()).toBe('2');
  expect(pdfPage.getHeight()).toBeLessThanOrEqual(14400);
  await expect(page.getByText('unsaved changes', { exact: true })).toBeVisible();
});

test('independent PDF margins persist in min-boxes and pad drawing exports without stretching', async ({ page }) => {
  await page.goto('/');
  await action(page, 'app settings').click();
  const values = { left: 2.5, right: .5, top: 1.25, bottom: 3 };
  for (const [side, value] of Object.entries(values)) {
    const input = page.getByLabel(`${side} margin (min-box)`, { exact: true });
    await expect(input).toHaveValue('1');
    await input.fill(String(value));
  }
  await page.getByLabel('left margin (min-box)', { exact: true }).fill('-2');
  expect(await page.getByLabel('left margin (min-box)', { exact: true }).evaluate((el) => (el as HTMLInputElement).validity.valid)).toBe(false);
  await page.reload();
  await action(page, 'app settings').click();
  for (const [side, value] of Object.entries(values)) {
    await expect(page.getByLabel(`${side} margin (min-box)`, { exact: true })).toHaveValue(String(value));
  }
  await action(page, 'larger type').click();
  const minBox = await page.locator('html').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--min-box')));
  await action(page, 'close app settings').click();
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('margins.svg');
  await action(page, 'create svg file').click(); await action(page, 'open').click();
  const canvas = page.getByRole('img', { name: 'Drawing canvas for margins.svg' });
  await expect(canvas).toBeVisible();
  const matrix = await canvas.evaluate((el) => {
    const m = (el as SVGSVGElement).getScreenCTM()!; return { a: m.a, d: m.d, e: m.e, f: m.f };
  });
  await page.mouse.move(matrix.e + 100 * matrix.a, matrix.f + 100 * matrix.d); await page.mouse.down();
  await page.mouse.move(matrix.e + 300 * matrix.a, matrix.f + 200 * matrix.d); await page.mouse.up();
  const points = (await canvas.locator('polyline').getAttribute('points'))!.split(' ').map((point) => point.split(',').map(Number));
  const bottom = Math.ceil(Math.max(...points.map((point) => point[1])) + 1.5);
  const width = await page.locator('.drawing-page-viewport').evaluate((el) => el.clientWidth);
  const drawingTools = page.getByRole('group', { name: 'Drawing toolbar' });
  async function exported() {
    await drawingTools.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
    await expect(dialog.getByRole('button', { name: 'Download PDF', exact: true })).toBeEnabled();
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: 'Download PDF', exact: true }).click();
    return readPdf(await downloaded);
  }
  const custom = await exported();
  expect(custom.page.getWidth()).toBeCloseTo((width + (values.left + values.right) * minBox) * .75, 3);
  expect(custom.page.getHeight()).toBeCloseTo((bottom * width / 1024 + (values.top + values.bottom) * minBox) * .75, 3);
  const stroke = custom.operators.match(/([\d.-]+) ([\d.-]+) m\n([\d.-]+) ([\d.-]+) l\nS/)!;
  expect(stroke).not.toBeNull();
  expect(Number(stroke[1])).toBeCloseTo((values.left * minBox + points[0][0] * width / 1024) * .75, 3);
  expect(Number(stroke[2])).toBeCloseTo(custom.page.getHeight() - (values.top * minBox + points[0][1] * width / 1024) * .75, 3);
  expect((Number(stroke[3]) - Number(stroke[1])) / (Number(stroke[2]) - Number(stroke[4])))
    .toBeCloseTo((points[1][0] - points[0][0]) / (points[1][1] - points[0][1]), 3);
  await page.keyboard.press('ControlOrMeta+s');
  await drawingTools.getByRole('button', { name: 'Exit', exact: true }).click();
  await action(page, '..').click(); await action(page, 'app settings').click();
  for (const side of Object.keys(values)) await page.getByLabel(`${side} margin (min-box)`, { exact: true }).fill('0');
  await page.reload(); await action(page, 'margins.svg').click(); await action(page, 'open').click();
  await expect(canvas).toBeVisible();
  const zeroWidth = await page.locator('.drawing-page-viewport').evaluate((el) => el.clientWidth);
  const zero = await exported();
  expect(zero.page.getWidth()).toBeCloseTo(zeroWidth * .75, 3);
  expect(zero.page.getHeight()).toBeCloseTo(bottom * zeroWidth / 1024 * .75, 3);
});
