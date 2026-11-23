import { test, expect, type Locator, type Page } from '@playwright/test';

// The native app's machine folders go through Tauri commands. This fixture stands in
// for them with an in-memory filesystem in isolated test storage (localStorage).
const button = (scope: Page | ReturnType<Page['getByRole']>, name: string) =>
  scope.locator(`[data-action=${JSON.stringify(name)}] button`);

async function pressShortcut(page: Page, control: Locator) {
  const route = control.locator('.pending_route');
  await expect(route).not.toHaveText('');
  for (const key of (await route.innerText()).trim()) await page.keyboard.press(key);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  test.info().annotations.push({ type: 'errors', description: '' });
  (page as Page & { errors?: string[] }).errors = errors;
  await page.addInitScript(() => {
    type Item = { kind: 'file' | 'directory'; content?: string };
    const seed: Record<string, Item> = {
      '/home/test': { kind: 'directory' },
      '/home/test/notes': { kind: 'directory' },
      '/home/test/notes/idea.md': { kind: 'file', content: '# idea\nnative notes' },
      '/home/test/notes/deep': { kind: 'directory' },
      '/home/test/notes/deep/plan idea.txt': { kind: 'file', content: 'plan' },
      '/home/test/photo.bin': { kind: 'file', content: '\u0000binary' },
      '/home/test/.hidden': { kind: 'directory' },
      '/home/test/outside.txt': { kind: 'file', content: 'not granted' }
    };
    const load = (): Record<string, Item> => JSON.parse(localStorage.getItem('native-fs') ?? 'null') ?? seed;
    const save = (fs: Record<string, Item>) => localStorage.setItem('native-fs', JSON.stringify(fs));
    const grants = (): string[] => JSON.parse(localStorage.getItem('native-grants') ?? '[]');
    const name = (path: string) => path.split('/').at(-1)!;
    const parent = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
    const covered = (path: string) => grants().some((root) => path === root || path.startsWith(root + '/'));
    const fail = (kind: string, message: string) => { throw `${kind}: ${message}`; };
    const need = (path: string) => { if (!covered(path)) fail('NotAllowedError', 'not granted'); };
    const entry = (fs: Record<string, Item>, path: string) => ({
      name: name(path), path, kind: fs[path].kind, text: fs[path].kind === 'file' && !fs[path].content!.includes('\u0000')
    });
    const children = (fs: Record<string, Item>, path: string, hidden = false) => Object.keys(fs)
      .filter((item) => parent(item) === path && item !== path && (hidden || !name(item).startsWith('.')))
      .sort().map((item) => entry(fs, item));
    const calls: string[] = [];
    (window as unknown as { nativeCalls: string[] }).nativeCalls = calls;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      async invoke(command: string, args: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) {
        calls.push(command);
        const fs = load();
        const path = args instanceof Uint8Array ? decodeURIComponent(options!.headers!['notework-path']) : args?.path as string;
        switch (command) {
          case 'fs_places': return [{ name: 'home', path: '/home/test' }];
          case 'fs_browse': return children(fs, path);
          case 'fs_parent': return path === '/' ? null : parent(path);
          case 'fs_search': {
            const query = (args as { query: string }).query.toLowerCase();
            return Object.keys(fs).filter((item) => item.startsWith(path + '/') && !item.includes('/.') && name(item).toLowerCase().includes(query)).sort().map((item) => entry(fs, item));
          }
          case 'fs_grant': localStorage.setItem('native-grants', JSON.stringify([...grants(), path])); return null;
          case 'fs_granted': return covered(path);
          case 'fs_list': need(path); return children(fs, path, true);
          case 'fs_stat': need(path); if (!fs[path]) fail('NotFoundError', 'missing'); return { kind: fs[path].kind, size: 1, modified: 1 };
          case 'fs_read': need(path); if (!fs[path]) fail('NotFoundError', 'missing'); return new TextEncoder().encode(fs[path].content).buffer;
          case 'fs_write': need(path); fs[path] = { kind: 'file', content: new TextDecoder().decode(args as Uint8Array) }; save(fs); return null;
          case 'fs_create': need(path); fs[path] = { kind: 'file', content: '' }; save(fs); return null;
          case 'fs_mkdir': need(path); fs[path] = { kind: 'directory' }; save(fs); return null;
          case 'fs_remove': need(path); for (const item of Object.keys(fs)) if (item === path || item.startsWith(path + '/')) delete fs[item]; save(fs); return null;
        }
        fail('NotSupportedError', command);
      }
    };
  });
});

test.afterEach(async ({ page }) => {
  expect((page as Page & { errors?: string[] }).errors).toEqual([]);
});

test('native app chooses machine folders in Notework’s own folder browser, with search', async ({ page }) => {
  await page.goto('/');
  await button(page, 'app settings').click();
  await button(page, 'link resource').click(); await button(page, 'local filesystem').click();
  const browser = page.getByRole('dialog', { name: 'link from local filesystem' });
  await expect(browser.getByRole('button', { name: 'browse location…' })).toHaveCount(0);

  // Keyboard navigation works in the browser like everywhere else in Notework.
  await pressShortcut(page, button(browser, 'home/'));
  const contents = browser.getByRole('navigation', { name: 'folder contents' });
  await expect(button(contents, 'notes/')).toBeVisible();
  await expect(button(contents, 'outside.txt')).toBeVisible();
  // Binary and hidden entries stay out of the browser, like the browser picker.
  await expect(button(contents, 'photo.bin')).toHaveCount(0);
  await expect(button(contents, '.hidden/')).toHaveCount(0);

  await browser.getByRole('searchbox').fill('idea');
  const results = browser.getByRole('navigation', { name: 'search results' });
  await expect(button(results, 'idea.md')).toBeVisible();
  await expect(button(results, 'plan idea.txt')).toContainText('notes/deep/plan idea.txt');
  await button(results, 'notes/').count().then((count) => expect(count).toBe(0));
  await browser.getByRole('searchbox').fill('');

  await button(contents, 'notes/').click();
  await expect(browser.getByRole('heading', { name: 'notes/' })).toBeVisible();
  await button(browser, '..').click();
  await expect(browser.getByRole('heading', { name: 'home/' })).toBeVisible();
  await contents.locator('.file-navigation-row', { has: page.locator('[data-action="notes/"]') }).locator('[data-action="select"] button').click();
  await expect(browser.getByText('selected to observe')).toBeVisible();
  // Nothing is readable until the person confirms the selection.
  expect(await page.evaluate(() => localStorage.getItem('native-grants'))).toBeNull();
  await browser.getByRole('button', { name: 'observe selection (1)' }).click();
  await expect(browser).not.toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('native-grants')!))).toEqual(['/home/test/notes']);

  await button(page, 'notes/').click();
  await expect(page.getByRole('heading', { name: 'notes/' })).toBeVisible();
  await expect(page.locator('.path').first()).toContainText('computer');
  await button(page, 'idea.md').click();
  await expect(page.getByText('native notes')).toBeVisible();

  // Handles survive a reload as paths and stay readable through the saved grant.
  await page.reload();
  await button(page, 'notes/').click();
  await expect(button(page, 'idea.md')).toBeVisible();
  await expect(button(page, 'deep/')).toBeVisible();
});

test('native folders create and save machine files through the app', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('native-grants', JSON.stringify(['/home/test/notes'])));
  await button(page, 'app settings').click();
  await button(page, 'link resource').click(); await button(page, 'local filesystem').click();
  const browser = page.getByRole('dialog', { name: 'link from local filesystem' });
  await button(browser, 'home/').click();
  await button(browser, 'notes/').click();
  await browser.locator('.file-navigation-row', { hasText: 'this folder: notes/' }).locator('[data-action="select"] button').click();
  await browser.getByRole('button', { name: 'observe selection (1)' }).click();
  await button(page, 'notes/').click();
  await button(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('fresh.txt');
  await button(page, 'create text file').click();
  const file = () => page.evaluate(() => JSON.parse(localStorage.getItem('native-fs') ?? '{}')['/home/test/notes/fresh.txt']);
  await expect.poll(file).toEqual({ kind: 'file', content: '' });
  await button(page, 'open').click();
  await page.keyboard.type('saved on this computer');
  await page.keyboard.press('ControlOrMeta+s');
  await expect.poll(async () => (await file())?.content).toContain('saved on this computer');
});
