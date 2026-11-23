import { rasterPoint, alpha, expectInk, seedImage } from './raster-helpers';
import { test, expect, type Page } from '@playwright/test';

const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function create(page: Page, name: string, format: 'svg' | 'png') {
  await page.goto('/');
  if (format === 'png') await seedImage(page, name);
  else {
    await action(page, 'app settings').click();
    await action(page, 'create new file/folder').click();
    await page.getByLabel('name', { exact: true }).fill(name);
    await action(page, 'create svg file').click();
  }
  await action(page, `open: ${name}`).click();
  const canvas = page.getByRole('img', { name: `drawing canvas for ${name}`, exact: true });
  await expect(canvas).toBeVisible();
  // Record the real browser-assigned pointer ID, rather than assuming mouse/pen IDs.
  await canvas.evaluate((svg) => svg.addEventListener('pointerdown', (event) => {
    (svg as SVGSVGElement).dataset.testPointerId = String((event as PointerEvent).pointerId);
  }, true));
  return canvas;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notework:autosave-seconds', '3600'));
});

for (const format of ['svg', 'png'] as const) for (const pointerType of ['pen', 'mouse'] as const) {
  test(`${format} retains ${pointerType} ink across interrupted desktop input and saves it once`, async ({ page, context }) => {
    const name = `remote-${pointerType}.${format}`;
    const canvas = await create(page, name, format);
    const protocol = await context.newCDPSession(page);
    const strokes = canvas.locator(':scope > polyline');
    const ink = async (count:number) => { if(format === 'svg') await expect(strokes).toHaveCount(count); else await expectInk(canvas,[50,110,170,230,290,350],count); };
    const tools = page.getByRole('group', { name: 'drawing toolbar', exact: true });
    const undo = tools.getByRole('button', { name: 'undo', exact: true });
    const coords = (x: number, y: number) => format === 'png' ? rasterPoint(canvas,x,y) : canvas.evaluate((svg, [x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform((svg as SVGSVGElement).getScreenCTM()!);
      return { x: p.x, y: p.y };
    }, [x, y]);
    const down = async (y: number) => {
      await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType, button: 'left', buttons: 1, ...await coords(80, y) });
      await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType, buttons: 1, ...await coords(200, y) });
    };
    const release = async (y: number) => {
      await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType, button: 'left', buttons: 0, ...await coords(200, y) });
    };
    const terminal = (type: string) => canvas.evaluate((svg, { type, pointerType }) => {
      svg.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType,
        pointerId: Number((svg as SVGSVGElement).dataset.testPointerId), buttons: 0, pressure: 0,
        // Capture/cancellation events may have no useful terminal coordinates.
        clientX: 0, clientY: 0 }));
    }, { type, pointerType });

    // Losing capture while still pressed must keep the draft and keep listening
    // when the remote input stream is retargeted outside the SVG element.
    await down(50);
    await canvas.evaluate((svg) => svg.releasePointerCapture(Number((svg as SVGSVGElement).dataset.testPointerId)));
    await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType, buttons: 1, ...await coords(220, 50) });
    await canvas.evaluate((svg, { pointerType, p }) => {
      const pointerId = Number((svg as SVGSVGElement).dataset.testPointerId);
      for (const type of ['pointermove', 'pointerup']) document.body.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId, pointerType, buttons: type === 'pointermove' ? 1 : 0,
        pressure: type === 'pointermove' ? .5 : 0, clientX: p.x, clientY: p.y
      }));
    }, { pointerType, p: await coords(260, 50) });
    await release(50);
    await ink(1);
    await expect(undo).toBeEnabled();
    if(format === 'svg') expect((await strokes.last().getAttribute('points'))!.split(' ').at(-1)).toBe('260,50'); else expect(await alpha(canvas,258,50)).toBeGreaterThan(0);
    await undo.click(); await ink(0);
    await tools.getByRole('button', { name: 'redo', exact: true }).click();
    await ink(1);

    for (const [index, type] of ['pointercancel', 'lostpointercapture', 'pointermove'].entries()) {
      const y = 110 + index * 60;
      await down(y);
      await terminal(type);
      // A terminal cancellation/capture event or a no-buttons hover commits the
      // last contact sample. It must not add a segment to (0, 0).
      await ink(index + 2);
      await undo.click(); await ink(index + 1);
      await tools.getByRole('button', { name: 'redo', exact: true }).click();
      await ink(index + 2);
      if(format === 'svg') expect((await strokes.last().getAttribute('points'))!.split(' ').at(-1)).toBe(`200,${y}`); else expect(await alpha(canvas,199,y)).toBeGreaterThan(0);
      await release(y);
      await ink(index + 2);
    }

    await down(290);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await ink(5);
    if (pointerType === 'pen') {
      // Once the intentional 500 ms palm guard expires, interrupted pen input
      // must not leave the recognizer thinking that the Pencil is still down.
      await page.waitForTimeout(550);
      await canvas.evaluate((svg) => {
        const contacts = [1, 2].map((identifier) => new Touch({ identifier, target: svg, clientX: identifier * 40, clientY: 100 }));
        svg.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: contacts, changedTouches: contacts }));
        svg.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: contacts }));
      });
      await ink(4);
      await tools.getByRole('button', { name: 'redo', exact: true }).click();
    }
    await release(290);
    await undo.click(); await ink(4);
    await tools.getByRole('button', { name: 'redo', exact: true }).click();

    // Explicit cancellation remains different from an interrupted input stream.
    await down(350);
    await page.keyboard.press('Escape');
    await release(350);
    await ink(5);
    await tools.getByRole('button', { name: 'exit', exact: true }).click();
    await expect(action(page, `open: ${name}`)).toBeVisible();
    await page.reload();
    await action(page, name).click();
    await action(page, `open: ${name}`).click();
    if (format === 'svg') await ink(5);
    else {
      await expect(canvas.locator('canvas.visual-canvas')).toBeVisible();
      const pixels = await Promise.all([50,110,170,230,290,350].map(y=>alpha(canvas,140,y)));
      expect(pixels).toEqual([255, 255, 255, 255, 255, 0]);
    }
  });
}

test('a new pen contact recovers a missing release without joining two strokes', async ({ page, context }) => {
  const canvas = await create(page, 'missing-release.svg', 'svg');
  const protocol = await context.newCDPSession(page);
  const coords = await canvas.evaluate((svg) => {
    const matrix = (svg as SVGSVGElement).getScreenCTM()!;
    return [[80, 50], [200, 50], [80, 150], [200, 150]].map(([x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix); return { x: p.x, y: p.y };
    });
  });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, ...coords[0] });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', buttons: 1, ...coords[1] });
  await canvas.evaluate((svg) => svg.releasePointerCapture(Number((svg as SVGSVGElement).dataset.testPointerId)));
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', buttons: 1, ...coords[1] });
  await canvas.evaluate((svg, [start, end]) => {
    const pointerId = Number((svg as SVGSVGElement).dataset.testPointerId);
    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId, pointerType: 'pen', button: 0, buttons: 1, pressure: .5, clientX: start.x, clientY: start.y }));
    svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId, pointerType: 'pen', buttons: 1, pressure: .5, clientX: end.x, clientY: end.y }));
    svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId, pointerType: 'pen', buttons: 0, pressure: 0, clientX: end.x, clientY: end.y }));
  }, coords.slice(2));
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, ...coords[3] });
  await expect(canvas.locator('polyline')).toHaveCount(2);
  const paths = await canvas.locator('polyline').evaluateAll((lines) => lines.map((line) => line.getAttribute('points')));
  expect(paths).toEqual(['80,50 200,50', '80,150 200,150']);
  await page.getByRole('group', { name: 'drawing toolbar' }).getByRole('button', { name: 'undo', exact: true }).click();
  await expect(canvas.locator('polyline')).toHaveCount(1);
});

test('resizing during desktop pen input retains the sampled document coordinates', async ({ page, context }) => {
  const canvas = await create(page, 'resize-pen.svg', 'svg');
  const protocol = await context.newCDPSession(page);
  const coords = await canvas.evaluate((svg) => {
    const matrix = (svg as SVGSVGElement).getScreenCTM()!;
    return [[80, 50], [200, 50]].map(([x, y]) => {
      const p = new DOMPoint(x, y).matrixTransform(matrix); return { x: p.x, y: p.y };
    });
  });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, ...coords[0] });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', buttons: 1, ...coords[1] });
  await canvas.evaluate((svg) => { (svg as SVGSVGElement).style.width = '400px'; });
  const undo = page.getByRole('group', { name: 'drawing toolbar' }).getByRole('button', { name: 'undo', exact: true });
  await expect(undo).toBeEnabled();
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, ...coords[1] });
  await expect(canvas.locator('polyline')).toHaveAttribute('points', '80,50 200,50');
  await undo.click(); await expect(canvas.locator('polyline')).toHaveCount(0);
});

test('touch cancellation still discards a tentative finger stroke', async ({ page, context }) => {
  const canvas = await create(page, 'touch-cancel.svg', 'svg');
  const protocol = await context.newCDPSession(page);
  const { x, y } = (await canvas.boundingBox())!;
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: x + 50, y: y + 50 }] });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: x + 150, y: y + 50 }] });
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect(canvas.locator('polyline')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'drawing toolbar' }).getByRole('button', { name: 'undo', exact: true })).toBeDisabled();
});
