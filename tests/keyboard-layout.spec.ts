import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1512, height: 982 } });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('notework:virtual-keyboard', 'true');
    if (!localStorage.getItem('notework:keyboard-layout')) localStorage.setItem('notework:keyboard-layout', 'flick-alpha');
  });
  await page.goto('/');
  await expect(page.locator('.keyboard-dock')).toBeVisible();
});

test('flick rows fill the dock and app styles do not overlap directional labels', async ({ page }, testInfo) => {
  const keyboard = page.locator('.keyflow-keyboard');
  const dock = page.locator('.keyboard-dock');
  const key = keyboard.getByRole('button', { name: 'q', exact: true });
  const measurements = await key.evaluate(element => {
    const key = element.getBoundingClientRect();
    const center = element.querySelector('.center')!.getBoundingClientRect();
    const hints = [...element.querySelectorAll<HTMLElement>('.hint')].map(hint => {
      const box = hint.getBoundingClientRect(), style = getComputedStyle(hint);
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, padding: style.padding };
    });
    const overlaps = hints.some(box => box.left < center.right && box.right > center.left && box.top < center.bottom && box.bottom > center.top);
    return { height: key.height, fontSize: parseFloat(getComputedStyle(element).fontSize), hints, overlaps };
  });
  expect(measurements.height).toBeGreaterThanOrEqual(72);
  expect(measurements.fontSize).toBeGreaterThanOrEqual(16);
  expect(measurements.hints.every(hint => hint.padding === '0px')).toBe(true);
  expect(measurements.overlaps).toBe(false);
  const last = await keyboard.locator('.keyboard-row').last().boundingBox();
  const bounds = (await dock.boundingBox())!;
  expect(bounds.y + bounds.height - last!.y - last!.height).toBeLessThan(20);
  await dock.screenshot({ path: testInfo.outputPath('flick-desktop.png') });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`flick touch targets retain their height at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const dock = page.locator('.keyboard-dock');
    const geometry = await dock.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth,
      height: element.clientHeight, scrollHeight: element.scrollHeight,
      heights: [...element.querySelectorAll('.keyflow-flick-key')].map(key => key.getBoundingClientRect().height) }));
    expect(Math.min(...geometry.heights)).toBeGreaterThanOrEqual(72);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    await page.screenshot({ path: testInfo.outputPath(`flick-${viewport.width}.png`) });
  });
}

test('ASCII keyboard retains ordinary touch targets and fills its dock', async ({ page }, testInfo) => {
  await page.evaluate(() => localStorage.setItem('notework:keyboard-layout', 'ascii'));
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  const keyboard = page.locator('.keyflow-keyboard[data-layout="ascii"]');
  await expect(keyboard).toBeVisible();
  const geometry = await keyboard.evaluate(element => ({
    width: element.clientWidth, scrollWidth: element.scrollWidth,
    heights: [...element.querySelectorAll('.keyflow-key')].map(key => key.getBoundingClientRect().height)
  }));
  expect(Math.min(...geometry.heights)).toBeGreaterThanOrEqual(44);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  await page.screenshot({ path: testInfo.outputPath('ascii-phone.png') });
});
