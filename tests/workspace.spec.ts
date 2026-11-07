import { test, expect, type Locator, type Page } from '@playwright/test';
import type { WorkspaceData } from '../src/lib/workspace';

declare global {
  interface FileSystemHandle {
    queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
    requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  }
}

// Exact data attributes avoid including Keyflow's dynamically assigned shortcuts in locators.
const button = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
const errors = new WeakMap<Page, string[]>();
const toolbar = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Editor toolbar' }).getByRole('button', { name, exact: true });
const openEditor = (page: Page) => button(page, 'open').click();
const forceSave = (page: Page) => page.keyboard.press('ControlOrMeta+s');
async function pressShortcut(page: Page, control: Locator) {
  const route = control.locator('.pending_route');
  await expect(route).not.toHaveText('');
  for (const key of (await route.innerText()).trim()) await page.keyboard.press(key);
}

async function startCreate(page: Page) {
  await page.locator('[data-action="configure folder"] button, [data-action="app settings"] button').click();
  await button(page, 'create new file/folder').click();
}


test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)!.push(error.message));
  await page.addInitScript(() => {
    if (typeof FileSystemHandle === 'undefined') return;
    const original = FileSystemHandle.prototype.queryPermission;
    FileSystemHandle.prototype.queryPermission = async function (options) {
      if (localStorage.getItem('test-permission') === 'prompt') return 'prompt';
      if (options.mode === 'readwrite' && localStorage.getItem('test-write-granted') !== 'yes') return 'prompt';
      return original.call(this, options);
    };
    FileSystemHandle.prototype.requestPermission = async function (options) {
      if (localStorage.getItem('test-deny') === 'yes' || (options.mode === 'readwrite' && localStorage.getItem('test-deny-write') === 'yes')) return 'denied';
      if (options.mode === 'readwrite') localStorage.setItem('test-write-granted', 'yes');
      localStorage.removeItem('test-permission');
      return 'granted';
    };
    let fixtures: Promise<FileSystemDirectoryHandle> | undefined;
    const setup = () => fixtures ??= (async () => {
      const root = await navigator.storage.getDirectory();
      const documents = await root.getDirectoryHandle('Documents', { create: true });
      const adobe = await documents.getDirectoryHandle('Adobe', { create: true });
      const notes = await adobe.getFileHandle('notes.txt', { create: true });
      const write = async (handle: FileSystemFileHandle, content: string) => {
        const stream = await handle.createWritable(); await stream.write(content); await stream.close();
      };
      await write(notes, 'A nested note about semantic roles.');
      await write(await documents.getFileHandle('semantic proto-role inferences.pdf', { create: true }), '%PDF-1.4\n%%EOF');
      await write(await documents.getFileHandle('readme.txt', { create: true }), 'Welcome to Notework.\nYour files stay local.');
      await write(await root.getFileHandle('text.bin', { create: true }), 'Text with a binary-looking extension.');
      const git = await root.getDirectoryHandle('.git', { create: true });
      await write(await git.getFileHandle('HEAD', { create: true }), 'ref: refs/heads/main');
      const binary = await root.getFileHandle('binary.txt', { create: true });
      const binaryStream = await binary.createWritable(); await binaryStream.write(new Uint8Array([0, 1, 2, 255])); await binaryStream.close();
      const utf16 = await root.getFileHandle('utf16.txt', { create: true });
      const utf16Stream = await utf16.createWritable();
      const utf16Data = new Uint8Array([255, 254, 72, 0, 105, 0, 13, 0, 10, 0]);
      await utf16Stream.write(utf16Data); await utf16Stream.close();
      await write(await root.getFileHandle('outside.txt', { create: true }), 'Outside the Documents folder.');
      await write(await root.getFileHandle('unsafe.html', { create: true }), '<script>window.previewExecuted = true</script>');
      await write(await root.getFileHandle('image.svg', { create: true }), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" /></svg>');
      const image = await root.getFileHandle('image.png', { create: true });
      const imageStream = await image.createWritable();
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jEioAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
      await imageStream.write(png); await imageStream.close();
      return root;
    })();
    window.showDirectoryPicker = async () => {
      if (localStorage.getItem('test-cancel') === 'yes') throw new DOMException('Cancelled', 'AbortError');
      if (localStorage.getItem('test-picker-denied') === 'yes') throw new DOMException('Denied', 'NotAllowedError');
      const root = await setup();
      return root;
    };

  });
  await page.goto('/');
  await expect(button(page, 'app settings')).toBeEnabled();
});

test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

async function connectDocuments(page: Page) {
  await button(page, 'app settings').click();
  await chooseItems(page, ['Documents/']);
  await expect(button(page, 'Documents/')).toBeVisible();
  await button(page, 'close app settings').click();
}

async function chooseItems(page: Page, names: string[]) {
  await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog', { name: 'add existing folder/file' });
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  for (const name of names) {
    const folder = name.endsWith('/');
    const label = folder ? name.slice(0, -1) : name;
    await picker.getByRole('checkbox', { name: `Select ${label} ${folder ? 'folder' : 'file'}`, exact: true }).check();
  }
  await picker.getByRole('button', { name: /^observe selection/ }).click();
  await expect(picker).not.toBeVisible();
}

async function chooseFile(page: Page) {
  const name = await page.evaluate(() => localStorage.getItem('test-file') || 'outside.txt');
  await chooseItems(page, [name]);
}

async function seedLegacyGraph(page: Page, options: { hideAdobe?: boolean; cycle?: boolean }) {
  // Unmount the app before changing its persisted graph; its focus/poll saves
  // otherwise race the fixture transaction and can overwrite the seeded data.
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.goto('about:blank');
  await page.goto('/manifest.webmanifest');
  await page.evaluate(async (options) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notework', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const data = await new Promise<WorkspaceData>((resolve, reject) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const documents = data.sources.find((source) => source.handle.name === 'Documents')!;
    const folder = JSON.stringify([documents.id]);
    if (options.hideAdobe) data.hidden[folder] = [JSON.stringify([documents.id, 'Adobe'])];
    if (options.cycle) {
      const outside = data.sources.find((source) => source.handle.name === 'outside.txt')!;
      const file = JSON.stringify([outside.id]);
      data.links[folder] = [file]; data.links[file] = [folder];
    }
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('workspace', 'readwrite');
      transaction.objectStore('workspace').put(data, 'current');
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, options);
  await page.goto('/');
  await expect(button(page, 'app settings')).toBeEnabled();
}

test('empty home, exact navigation order, native scrolling, and keyboard activation', async ({ page }) => {
  expect(await page.locator('nav [data-action]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-action')))).toEqual(['search', 'app settings']);
  await expect(page.locator('nav hr')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'current state' }).getByRole('heading', { name: 'home' })).toBeVisible();
  await expect(button(page, 'create new file/folder')).toHaveCount(0);
  await expect(page.locator('.viewport')).toHaveCSS('overflow-y', 'auto');
  const shortcut = await button(page, 'app settings').locator('.pending_route').textContent();
  await page.keyboard.press(shortcut!.trim());
  await expect(page.getByRole('heading', { name: 'app settings' })).toBeVisible();
  await expect(button(page, 'create new file/folder')).toBeEnabled();
  await page.evaluate(() => sessionStorage.setItem('notework:keyflow:lockstep_scrolling', 'true'));
  await page.reload();
  await expect(button(page, 'app settings')).toBeEnabled();
  await expect(page.locator('.viewport')).toHaveCSS('overflow-y', 'auto');
  expect(await page.evaluate(() => sessionStorage.getItem('notework:keyflow:lockstep_scrolling'))).toBe('false');
});

test('folder direct children, file display, parent navigation, and browser back', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await expect(button(page, 'Adobe/')).toBeVisible();
  expect(await page.locator('nav [data-action]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-action')))).toEqual(['search', 'configure folder', 'home', '..', 'Adobe/', 'open', 'readme.txt', 'open', 'semantic proto-role inferences.pdf']);
  await expect(button(page, 'home').locator('svg')).toHaveCount(1);
  await expect(button(page, 'home')).toHaveAccessibleName(/home$/);
  await button(page, 'home').click();
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await button(page, 'Documents/').click();
  await button(page, 'Adobe/').click();
  await expect(button(page, 'notes.txt')).toBeVisible();
  await button(page, 'notes.txt').click();
  await expect(button(page, 'open')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await openEditor(page);
  await expect(page.locator('.cm-content')).toHaveText('A nested note about semantic roles.');
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Adobe/' })).toBeVisible();
  await page.goBack();
  await expect(button(page, 'open')).toBeVisible();
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Adobe/' })).toBeVisible();
});

test('direct child files pair open and filename actions only in their parent folder', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  const readmeRow = page.locator('.file-navigation-row').filter({ has: button(page, 'readme.txt') });
  await expect(readmeRow).toBeVisible();
  expect(await readmeRow.locator(':scope > [data-action]').evaluateAll((actions) =>
    actions.map((action) => action.getAttribute('data-action')))).toEqual(['open', 'readme.txt']);
  await readmeRow.locator('[data-action="open"] button').click();
  await expect(page.getByRole('textbox', { name: 'Edit readme.txt', exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await expect(page.locator('.file-navigation-row')).toHaveCount(0);
  await expect(button(page, 'open')).toHaveCount(1);
});

test('file editing keeps only the toolbar above a dedicated content scroller', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('long-note.txt');
  await button(page, 'create text file').click();
  await openEditor(page);

  const editor = page.getByRole('textbox', { name: 'Edit long-note.txt', exact: true });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText(Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n'));

  const before = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>('.document-editor')!;
    const toolbar = document.querySelector<HTMLElement>('.editor-toolbar-slot')!;
    const content = document.querySelector<HTMLElement>('.editor-scroll')!;
    const toolbarBox = toolbar.getBoundingClientRect();
    const contentBox = content.getBoundingClientRect();
    return {
      shellHeight: shell.clientHeight, toolbarHeight: toolbar.offsetHeight, contentHeight: content.clientHeight,
      toolbarTop: toolbarBox.top, toolbarBottom: toolbarBox.bottom, contentTop: contentBox.top,
      scrollHeight: content.scrollHeight, viewportScroll: document.querySelector<HTMLElement>('.viewport')!.scrollTop
    };
  });
  expect(before.contentTop).toBeGreaterThanOrEqual(before.toolbarBottom - 1);
  expect(before.contentHeight + before.toolbarHeight).toBeLessThanOrEqual(before.shellHeight + 1);
  expect(before.scrollHeight).toBeGreaterThan(before.contentHeight);
  expect(before.viewportScroll).toBe(0);

  await page.locator('.editor-scroll').evaluate((content) => content.scrollTo({ top: content.scrollHeight }));
  const after = await page.evaluate(() => ({
    toolbarTop: document.querySelector<HTMLElement>('.editor-toolbar-slot')!.getBoundingClientRect().top,
    contentScroll: document.querySelector<HTMLElement>('.editor-scroll')!.scrollTop,
    titleBottom: document.querySelector<HTMLElement>('.editor-scroll h1')!.getBoundingClientRect().bottom,
    toolbarBottom: document.querySelector<HTMLElement>('.editor-toolbar-slot')!.getBoundingClientRect().bottom,
    viewportScroll: document.querySelector<HTMLElement>('.viewport')!.scrollTop
  }));
  expect(after.toolbarTop).toBeCloseTo(before.toolbarTop, 0);
  expect(after.contentScroll).toBeGreaterThan(0);
  expect(after.titleBottom).toBeLessThan(after.toolbarBottom);
  expect(after.viewportScroll).toBe(0);
});

test('root connections and legacy hidden children persist without Configure', async ({ page }) => {
  await connectDocuments(page);
  await seedLegacyGraph(page, { hideAdobe: true });
  await expect(button(page, 'Documents/')).toBeVisible();
  await button(page, 'Documents/').click();
  await expect(button(page, 'Adobe/')).toHaveCount(0);
  await expect(button(page, 'configure')).toHaveCount(0);
});

test('search traverses descendants, respects hidden children, and stays scoped', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'app settings').click();
  await chooseFile(page);
  await button(page, 'close app settings').click();
  await button(page, 'Documents/').click();
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('notes');
  await expect(page.locator('.search-status')).toContainText('1 result found');
  await button(page, 'notes.txt').click();
  await expect(button(page, 'open')).toBeVisible();
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('readme');
  await expect(page.locator('.search-status')).toContainText('0 results found');
  await button(page, 'close search').click();
  await button(page, '..').click(); await button(page, '..').click();
  await seedLegacyGraph(page, { hideAdobe: true });
  await button(page, 'Documents/').click();
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('notes');
  await expect(page.locator('.search-status')).toContainText('0 results found');
  await page.getByRole('searchbox').fill('outside');
  await expect(page.locator('.search-status')).toContainText('0 results found');
});

test('search includes folders and gives every file result a quick-open action', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await button(page, 'search').click();
  const panel = page.locator('section[aria-labelledby="search-heading"]');
  const field = panel.getByRole('searchbox');
  await field.fill('Adobe');
  await expect(panel.locator('.search-status')).toContainText('2 results found');
  await panel.locator('[data-action="Adobe/"] button').click();
  await expect(page.getByRole('heading', { name: 'Adobe/', exact: true })).toBeVisible();

  await button(page, 'search').click();
  const nextPanel = page.locator('section[aria-labelledby="search-heading"]');
  await nextPanel.getByRole('searchbox').fill('notes');
  await expect(nextPanel.locator('.search-status')).toContainText('1 result found');
  const row = nextPanel.locator('.search-result-row').filter({ has: button(page, 'notes.txt') });
  expect(await row.locator(':scope > [data-action]').evaluateAll((actions) =>
    actions.map((action) => action.getAttribute('data-action')))).toEqual(['open', 'notes.txt']);
  await row.locator('[data-action="open"] button').click();
  await expect(page.getByRole('textbox', { name: 'Edit notes.txt', exact: true })).toBeVisible();
});

test.describe('search field modes', () => {
  test.use({ hasTouch: true });

  for (const exit of ['Escape', 'button'] as const) {
    test(`${exit} leaves the field, preserves results, and restores keyboard navigation`, async ({ page }) => {
      if (exit === 'button') await page.setViewportSize({ width: 390, height: 844 });
      await connectDocuments(page);
      await button(page, 'search').click();
      const field = page.getByRole('searchbox');
      const heading = page.getByRole('heading', { name: 'search reachable files and folders' });
      await expect(field).toBeFocused();
      await field.fill('notes');
      await expect(page.locator('.search-status')).toContainText('1 result found');
      const leaveField = page.getByRole('button', { name: /esc.*search results/ });
      await expect(leaveField).toBeVisible();
      if (exit === 'Escape') await field.press('Escape');
      else await leaveField.tap();
      await expect(heading).toBeFocused();
      await expect(field).toHaveValue('notes');
      await expect(page.locator('.search-status')).toContainText('1 result found');

      const edit = button(page, 'edit search');
      await expect(edit.locator('.pending_route')).not.toHaveText('');
      await page.keyboard.press((await edit.locator('.pending_route').textContent())!.trim());
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('notes');
      await field.press('Escape');

      const result = button(page, 'notes.txt');
      await expect(result.locator('.pending_route')).not.toHaveText('');
      await page.keyboard.press((await result.locator('.pending_route').textContent())!.trim());
      await expect(button(page, 'open')).toBeVisible();
    });
  }
});

test('legacy directed links and cycles remain readable without Configure', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'app settings').click();
  await chooseFile(page);
  await seedLegacyGraph(page, { cycle: true });
  const rootFile = page.locator('.file-navigation-row').filter({ has: button(page, 'outside.txt') });
  await expect(rootFile.locator('[data-action="open"]')).toHaveCount(1);
  await button(page, 'Documents/').click();
  await expect(button(page, 'outside.txt')).toBeVisible();
  await expect(page.locator('.file-navigation-row').filter({ has: button(page, 'outside.txt') })).toHaveCount(0);
  await button(page, 'home').click();
  await button(page, 'outside.txt').click();
  await expect(button(page, 'configure')).toHaveCount(0);
  await expect(button(page, 'Documents/')).toBeVisible();
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('.txt');
  await expect(page.locator('.search-status')).toContainText('3 results found');
});

test('restored grants request permission only on explicit reconnect and handle denial', async ({ page }) => {
  await connectDocuments(page);
  await page.evaluate(() => { localStorage.setItem('test-permission', 'prompt'); localStorage.setItem('test-deny', 'yes'); });
  await page.reload();
  await button(page, 'app settings').click();
  await expect(page.getByText('Documents · needs permission')).toBeVisible();
  await button(page, 'reconnect Documents').click();
  await expect(page.getByRole('alert')).toContainText('was not granted');
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['Documents']);
  await page.evaluate(() => localStorage.removeItem('test-deny'));
  await button(page, 'reconnect Documents').click();
  await expect(page.getByText('Documents · read access granted')).toBeVisible();
});

test('picker cancellation and denial keep home empty', async ({ page }) => {
  await button(page, 'app settings').click();
  await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog');
  await page.evaluate(() => localStorage.setItem('test-cancel', 'yes'));
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  await expect(picker.getByRole('button', { name: 'browse location…', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => { localStorage.removeItem('test-cancel'); localStorage.setItem('test-picker-denied', 'yes'); });
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  await expect(picker.getByRole('alert')).toContainText('Access is not available');
  await picker.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(page.getByText('Home has no items. Connect a source here or create an item from home.')).toBeVisible();
});

test('one chooser observes mixed files/folders without storing or uploading contents', async ({ page }) => {
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' || new URL(request.url()).origin !== new URL(page.url()).origin) uploads.push(request.url());
  });
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.getFile;
    sessionStorage.setItem('test-content-reads', '0');
    FileSystemFileHandle.prototype.getFile = function () {
      sessionStorage.setItem('test-content-reads', String(Number(sessionStorage.getItem('test-content-reads')) + 1));
      return original.call(this);
    };
  });
  await button(page, 'app settings').click();
  await expect(button(page, 'add existing folder/file')).toHaveCount(1);
  await expect(button(page, 'add existing folder to root')).toHaveCount(0);
  await expect(button(page, 'add existing file to root')).toHaveCount(0);
  await chooseItems(page, ['Documents/', 'outside.txt']);
  expect(Number(await page.evaluate(() => sessionStorage.getItem('test-content-reads')))).toBeGreaterThan(0);
  expect(uploads).toEqual([]);
  const stored = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('notework', 1); request.onsuccess = () => resolve(request.result);
    });
    const data = await new Promise<WorkspaceData>((resolve) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current'); request.onsuccess = () => resolve(request.result);
    });
    const containsContents = (value: unknown): boolean => {
      if (value instanceof Blob) return true;
      if (value instanceof FileSystemHandle) return false;
      if (value && typeof value === 'object') return Object.values(value).some(containsContents);
      return false;
    };
    db.close();
    return { sources: data.sources.map((source) => ({ name: source.handle.name, kind: source.handle.kind, handle: source.handle instanceof FileSystemHandle })), roots: data.rootIds.length, contents: containsContents(data) };
  });
  expect(stored).toEqual({
    sources: [{ name: 'Documents', kind: 'directory', handle: true }, { name: 'outside.txt', kind: 'file', handle: true }],
    roots: 2, contents: false
  });
  await button(page, 'outside.txt').click();
  await openEditor(page);
  await expect(page.locator('.cm-content')).toHaveText('Outside the Documents folder.');
});

test('dropped handles identify mixed selections automatically and cancel remembers nothing', async ({ page }) => {
  await button(page, 'app settings').click();
  await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: 'Select Documents folder', exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handles = [await root.getDirectoryHandle('Documents'), await root.getFileHandle('outside.txt')];
    const transfer = new DataTransfer();
    const prototype = DataTransferItem.prototype as DataTransferItem & { getAsFileSystemHandle: () => Promise<FileSystemHandle | null> };
    const original = prototype.getAsFileSystemHandle;
    let synchronous = true;
    queueMicrotask(() => { synchronous = false; });
    for (const handle of handles) {
      transfer.items.add(new File([], handle.name));
    }
    prototype.getAsFileSystemHandle = function () {
      if (!synchronous) throw new Error('Handle extraction must happen synchronously during drop.');
      return Promise.resolve(handles.find((handle) => handle.name === this.getAsFile()?.name) ?? null);
    };
    try {
      document.querySelector('[aria-label="drop files or folders"]')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    } finally { prototype.getAsFileSystemHandle = original; }
  });
  await expect(picker.getByRole('button', { name: 'observe selection (2)', exact: true })).toBeEnabled();
  // Background actions are unregistered while this modal owns Keyflow shortcuts.
  await expect(button(page, 'close app settings').locator('.pending_route')).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect(page.locator('#settings-heading')).toBeVisible();
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker).not.toBeVisible();
  await expect(button(page, 'Documents/')).toHaveCount(0);
  await expect(button(page, 'outside.txt')).toHaveCount(0);
  await page.reload();
  await expect(button(page, 'app settings')).toBeEnabled();
  await expect(button(page, 'Documents/')).toHaveCount(0);
  await expect(button(page, 'outside.txt')).toHaveCount(0);
});

test('chooser navigates folders and remembers the selected file rather than its browsing location', async ({ page }) => {
  await button(page, 'app settings').click();
  await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  await picker.getByRole('button', { name: 'Documents/', exact: true }).click();
  await picker.getByRole('button', { name: 'Adobe/', exact: true }).click();
  await picker.getByRole('checkbox', { name: 'Select notes.txt file', exact: true }).check();
  await picker.getByRole('button', { name: /^observe selection/ }).click();
  await expect(picker).not.toBeVisible();
  await expect(button(page, 'notes.txt')).toBeVisible();
  await expect(button(page, 'Documents/')).toHaveCount(0);
  await expect(button(page, 'Adobe/')).toHaveCount(0);
  await page.reload();
  await button(page, 'notes.txt').click();
  await openEditor(page);
  await expect(page.locator('.cm-content')).toContainText('A nested note');
  await expect(button(page, 'configure')).toHaveCount(0);
});

test('removing root transitions keeps local files intact', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'app settings').click();
  await page.getByRole('button', { name: 'Remove Documents from root', exact: true }).click();
  await expect(button(page, 'Documents/')).toHaveCount(0);
  const exists = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const documents = await root.getDirectoryHandle('Documents');
    return (await (await documents.getFileHandle('readme.txt')).getFile()).text();
  });
  expect(exists).toContain('Welcome to Notework');
  await page.reload();
  await expect(button(page, 'Documents/')).toHaveCount(0);
});

test('HTML and SVG previews render as inert source', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('test-file', 'unsafe.html'));
  await button(page, 'app settings').click();
  await chooseFile(page);
  await button(page, 'unsafe.html').click();
  await openEditor(page);
  await expect(page.locator('.cm-content')).toContainText('<script>window.previewExecuted = true</script>');
  expect(await page.evaluate(() => 'previewExecuted' in window)).toBe(false);
  await expect(toolbar(page, 'Export')).toBeEnabled();
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();
  await button(page, 'app settings').click();
  await page.evaluate(() => localStorage.setItem('test-file', 'image.svg'));
  await chooseFile(page);
  await button(page, 'image.svg').click();
  await openEditor(page);
  await expect(page.locator('.cm-content')).toContainText('<svg');
  await expect(page.locator('.image-preview')).toHaveCount(0);
});

test('unsupported browser explains filesystem requirements', async ({ page }) => {
  await page.addInitScript(() => { window.showDirectoryPicker = undefined; });
  await page.reload();
  await expect(page.getByText('Local filesystem access needs Chrome or Edge', { exact: false })).toBeVisible();
  await button(page, 'app settings').click();
  await expect(button(page, 'add existing folder/file')).toBeDisabled();
});

test('file content decides text visibility, including PDF source and hidden binary images', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await button(page, 'semantic proto-role inferences.pdf').click();
  await openEditor(page);
  await expect(page.locator('.cm-content')).toContainText('%PDF-1.4');
  await expect(page.locator('iframe, video, audio, .image-preview')).toHaveCount(0);
  await toolbar(page, 'Exit').click();
  await button(page, '..').click(); await button(page, '..').click();
  await button(page, 'app settings').click();
  await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: 'Select outside.txt file', exact: true })).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: 'Select image.png file', exact: true })).toHaveCount(0);
  await picker.getByRole('button', { name: 'cancel', exact: true }).click();
});

test('missing files show recovery feedback and folder refresh discovers changes', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await expect(button(page, 'readme.txt')).toBeVisible();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const documents = await root.getDirectoryHandle('Documents');
    await documents.removeEntry('readme.txt');
    await documents.getDirectoryHandle('New folder', { create: true });
  });
  await button(page, 'configure folder').click();
  await button(page, 'refresh folder').click();
  await expect(button(page, 'New folder/')).toBeVisible();
  await expect(button(page, 'readme.txt')).toHaveCount(0);
});

test('mobile layout fits, scrolling remains native, and text entry does not trigger shortcuts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await expect(page.locator('.viewport')).toHaveCSS('overflow-y', 'auto');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/private/tmp/notework-mobile.png' });
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('1234qwerasdf');
  await expect(page.getByRole('searchbox')).toHaveValue('1234qwerasdf');
  await expect(page.getByRole('heading', { name: 'search reachable files and folders' })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await button(page, 'close search').click();
  await button(page, 'readme.txt').click();
  await openEditor(page);
  await page.screenshot({ path: '/private/tmp/notework-desktop.png' });
});

test('storage failure stays usable and reports that connections are not saved', async ({ page }) => {
  await page.addInitScript(() => {
    indexedDB.open = () => { throw new DOMException('Storage unavailable', 'SecurityError'); };
  });
  await page.reload();
  await expect(button(page, 'app settings')).toBeEnabled();
  await expect(page.getByText('Browser storage is unavailable.', { exact: false })).toBeVisible();
  await button(page, 'app settings').click();
  await chooseFile(page);
  await expect(button(page, 'outside.txt')).toBeVisible();
  await expect(page.getByText('Changes work in this tab but could not be saved.', { exact: false })).toBeVisible();
});

async function createNote(page: Page, name: string) {
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill(name);
  await button(page, 'create text file').click();
  await openEditor(page);
  await expect(page.getByRole('textbox', { name: `Edit ${name}`, exact: true })).toBeVisible();
}

async function storedGraph(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('notework', 1); request.onsuccess = () => resolve(request.result);
    });
    const data = await new Promise<WorkspaceData>((resolve) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current'); request.onsuccess = () => resolve(request.result);
    });
    db.close();
    return { roots: data.rootIds, sources: data.sources.map((source) => ({ id: source.id, uri: source.uri, name: source.handle?.name ?? decodeURIComponent(new URL(source.uri!).pathname.split('/').at(-1)!), storage: source.storage })), links: data.links, hidden: data.hidden, wiki: data.wiki };
  });
}

test('new notes have OPFS URIs, code-style tabs/brackets, save on exit, and reload persistence', async ({ page }) => {
  await createNote(page, 'ideas.txt');
  const field = page.getByRole('textbox', { name: 'Edit ideas.txt', exact: true });
  await field.click();
  await page.keyboard.type('(');
  await expect(field).toHaveText('()');
  await page.keyboard.type('idea)');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.type('nested');
  await page.keyboard.press('Control+Escape');
  await expect(button(page, 'open')).toBeVisible();
  await button(page, '..').click();
  await expect(button(page, 'ideas.txt')).toBeVisible();
  const graph = await storedGraph(page);
  expect(graph.sources[0].storage).toBe('browser');
  expect(graph.sources[0].uri).toMatch(/^opfs:\/\/notework\/documents\/[a-f0-9-]+\/ideas\.txt$/);
  expect(graph.roots).toEqual([JSON.stringify([graph.sources[0].id])]);
  await page.reload();
  await button(page, 'ideas.txt').click();
  await openEditor(page);
  await expect(field).toContainText('nested');
  const contents = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents');
    const folder = await documents.getDirectoryHandle(id);
    return (await (await folder.getFileHandle('ideas.txt')).getFile()).text();
  }, graph.sources[0].id);
  expect(contents).toBe('(idea)\n  nested');
});

test('long lines wrap by default without changing saved text, and settings can turn wrapping off', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createNote(page, 'wrap.txt');
  const editor = page.getByRole('textbox', { name: 'Edit wrap.txt', exact: true });
  const scroller = page.locator('.cm-scroller');
  const line = 'unbroken'.repeat(120);
  await page.keyboard.insertText(line);
  await expect(editor).toHaveClass(/cm-lineWrapping/);
  const overflows = () => scroller.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  await expect.poll(overflows).toBe(false);
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();
  await button(page, 'app settings').click();
  await button(page, 'wrap long lines: on').click();
  await expect(button(page, 'wrap long lines: off')).toBeVisible();
  await page.reload();
  await button(page, 'wrap.txt').click();
  await openEditor(page);
  await expect(editor).not.toHaveClass(/cm-lineWrapping/);
  await expect.poll(overflows).toBe(true);
  await expect(editor).toHaveText(line);
});

test('optional Vim mode persists, handles normal commands, and saves with :w', async ({ page }) => {
  await button(page, 'app settings').click();
  const setting = button(page, 'Vim mode: off');
  await setting.scrollIntoViewIfNeeded();
  const shortcut = setting.locator('.pending_route');
  await expect(shortcut).not.toHaveText('');
  for (const key of (await shortcut.innerText()).trim()) await page.keyboard.press(key);
  await expect(button(page, 'Vim mode: on')).toBeVisible();
  await page.reload();
  await createNote(page, 'vim.txt');
  const editor = page.getByRole('textbox', { name: 'Edit vim.txt', exact: true });
  await expect(editor).toBeFocused();
  await page.keyboard.press('i');
  await page.keyboard.insertText('remove me\nkeep me');
  await page.keyboard.press('Escape');
  await page.keyboard.type('ggdd');
  await expect(editor).toHaveText('keep me');
  await page.keyboard.press('Control+f');
  await expect(page.locator('.cm-search')).toHaveCount(0);
  await page.keyboard.type(':w');
  await page.keyboard.press('Enter');
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Find and replace').click();
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.keyboard.press('Control+Escape');
  await expect(button(page, 'open')).toBeVisible();
  await page.reload();
  await button(page, 'vim.txt').click();
  await openEditor(page);
  await expect(editor).toHaveText('keep me');
  await page.keyboard.press('o');
  await page.keyboard.type('[[vim sibling.txt');
  await expect(page.getByRole('option', { name: 'create: vim sibling.txt' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor.locator('.cm-line').last()).toHaveText('[[vim sibling.txt]]');
  await page.keyboard.press('Escape');
  await page.keyboard.type(':w');
  await page.keyboard.press('Enter');
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'vim sibling.txt')).toBeVisible();
});

test('editor toolbar omits Save, isolates navigation, and supports find, replace, and saving exit', async ({ page }) => {
  await createNote(page, 'toolbar.txt');
  await expect(page.getByRole('navigation', { name: 'state navigation' })).toHaveCount(0);
  await expect(toolbar(page, 'Save')).toHaveCount(0);
  for (const [name, shortcut] of [['Exit', 'Ctrl+Esc'], ['Find and replace', 'Ctrl+F']]) {
    const control = toolbar(page, name);
    const hint = control.getByText(shortcut, { exact: true });
    await expect(hint).toBeHidden();
    await control.hover();
    await expect(hint).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(hint).toBeHidden();
  }
  await page.keyboard.insertText('alpha alpha');
  await page.keyboard.press('Control+f');
  const search = page.locator('.cm-search');
  await search.getByRole('textbox', { name: 'Find', exact: true }).fill('alpha');
  await search.getByRole('textbox', { name: 'Replace', exact: true }).fill('beta');
  await search.getByRole('button', { name: 'replace all', exact: true }).click();
  await expect(page.locator('.cm-content')).toHaveText('beta beta');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+Escape');
  await expect(button(page, 'open')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'toolbar.txt' })).toBeVisible();
});

test('Escape moves plain text focus to the toolbar so shortcuts do not edit the draft', async ({ page }) => {
  await createNote(page, 'draft.txt');
  const editor = page.getByRole('textbox', { name: 'Edit draft.txt' });
  const tools = page.getByRole('group', { name: 'Editor toolbar' });
  await expect(editor).toBeFocused();
  await page.keyboard.insertText('my draft');
  await page.keyboard.press('Escape');
  await expect(tools).toBeFocused();
  await pressShortcut(page, toolbar(page, 'Export'));
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(editor).toHaveText('my draft');

  await editor.click();
  await expect(editor).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' continues');
  await expect(editor).toHaveText('my draft continues');
});

test('Vim Escape keeps Insert and Normal mode in the editor, and hands Visual mode to the toolbar', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('notework:vim-mode', 'true'));
  await page.reload();
  await createNote(page, 'visual.txt');
  const editor = page.getByRole('textbox', { name: 'Edit visual.txt' });
  await expect(editor).toBeFocused();
  await page.keyboard.press('i');
  await page.keyboard.insertText('first line\nsecond line');
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toBeFocused();
  await page.keyboard.type('gg0vll');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Editor toolbar' })).toBeFocused();
  await pressShortcut(page, toolbar(page, 'Export'));
  const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(editor.locator('.cm-line')).toHaveText(['first line', 'second line']);
  await editor.click();
  await page.keyboard.type('ggdd');
  await expect(editor).toHaveText('second line');
});

for (const kind of ['inline', 'standalone']) {
  test(`Escape cancels a stroke and focuses the ${kind} SVG drawing toolbar`, async ({ page }) => {
    if (kind === 'inline') {
      await createNote(page, 'sketch.txt');
      await toolbar(page, 'Brush').click();
      await page.getByRole('button', { name: /^Edit drawing drawing-/ }).click();
    } else {
      await startCreate(page);
      await page.getByLabel('name', { exact: true }).fill('sketch.svg');
      await button(page, 'create svg file').click();
      await openEditor(page);
    }
    const tools = page.getByRole('group', { name: 'Drawing toolbar' });
    const canvas = page.getByRole('img', { name: /^Drawing canvas for / });
    const strokes = canvas.locator('polyline');
    await expect(canvas).toBeVisible();
    const { x, y } = (await canvas.boundingBox())!;
    await page.mouse.click(x + 40, y + 40);
    await expect(strokes).toHaveCount(1);
    await page.mouse.move(x + 60, y + 60);
    await page.mouse.down();
    await page.mouse.move(x + 100, y + 80);
    await expect(strokes).toHaveCount(2);
    await expect(canvas).toBeFocused();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(tools).toBeFocused();
    await expect(strokes).toHaveCount(1);
    await pressShortcut(page, tools.getByRole('button', { name: 'Export', exact: true }));
    const dialog = page.getByRole('dialog', { name: 'Export', exact: true });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await page.mouse.click(x + 100, y + 80);
    await expect(strokes).toHaveCount(2);
  });
}

test('text and SVG files autosave at the configured maximum frequency', async ({ page }) => {
  await button(page, 'app settings').click();
  const interval = page.getByLabel('autosave at most every (seconds)', { exact: true });
  await expect(interval).toHaveValue('4');
  await interval.fill('1');
  await button(page, 'close app settings').click();

  await createNote(page, 'automatic.txt');
  await expect(toolbar(page, 'Save')).toHaveCount(0);
  await page.keyboard.insertText('saved by timer');
  await expect(page.getByText('unsaved changes', { exact: true })).toBeVisible();
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible({ timeout: 2500 });
  await toolbar(page, 'Exit').click(); await button(page, '..').click();

  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('automatic.svg');
  await button(page, 'create svg file').click(); await openEditor(page);
  const tools = page.getByRole('group', { name: 'Drawing toolbar' });
  await expect(tools.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  const canvas = page.getByRole('img', { name: 'Drawing canvas for automatic.svg' });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 30, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 130, box.y + 90); await page.mouse.up();
  await expect(page.getByText('unsaved drawing changes', { exact: true })).toBeVisible();
  await expect(page.getByText('drawing saved', { exact: true })).toBeVisible({ timeout: 2500 });
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await page.reload(); await button(page, 'automatic.svg').click(); await openEditor(page);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await button(page, '..').click(); await button(page, 'app settings').click();
  await expect(interval).toHaveValue('1');
});

test('machine text files can request write access from the save shortcut and preserve UTF-16', async ({ page }) => {
  await button(page, 'app settings').click();
  await chooseItems(page, ['utf16.txt']);
  await button(page, 'utf16.txt').click();
  await openEditor(page);
  const field = page.getByRole('textbox', { name: 'Edit utf16.txt', exact: true });
  await expect(field).toContainText('Hi');
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('world');
  await expect(page.getByText('unsaved changes', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('test-write-granted'))).toBeNull();
  await forceSave(page);
  await expect(page.getByText('saved on your computer', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('test-write-granted'))).toBe('yes');
  const bytes = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle('utf16.txt')).getFile();
    return Array.from(new Uint8Array(await file.arrayBuffer()));
  });
  expect(bytes.slice(0, 2)).toEqual([255, 254]);
  expect(new TextDecoder('utf-16le').decode(new Uint8Array(bytes))).toBe('Hi\r\nworld');
});

test('machine-file autosave never prompts in the background and saving Exit acquires permission', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('notework:autosave-seconds', '1'));
  await page.reload();
  await connectDocuments(page); await button(page, 'Documents/').click(); await button(page, 'readme.txt').click();
  await openEditor(page);
  const field = page.getByRole('textbox', { name: 'Edit readme.txt', exact: true });
  await field.press('ControlOrMeta+End'); await page.keyboard.insertText(' autosaved on exit');
  await expect(page.getByText('autosave is waiting for write permission; exit to save', { exact: true })).toBeVisible({ timeout: 2500 });
  expect(await page.evaluate(() => localStorage.getItem('test-write-granted'))).toBeNull();
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'open')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('test-write-granted'))).toBe('yes');
  await openEditor(page);
  await expect(field).toContainText('autosaved on exit');
});

test('write denial keeps edits open for export and a later saving exit', async ({ page }) => {
  await connectDocuments(page); await button(page, 'Documents/').click(); await button(page, 'readme.txt').click();
  await openEditor(page);
  const field = page.getByRole('textbox', { name: 'Edit readme.txt', exact: true });
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText(' unsaved');
  await page.evaluate(() => localStorage.setItem('test-deny-write', 'yes'));
  await forceSave(page);
  await expect(page.getByRole('alert')).toContainText('Write permission was not granted');
  await expect(field).toContainText('unsaved');
  await expect(toolbar(page, 'Export')).toBeEnabled();
  await toolbar(page, 'Exit').click();
  await expect(page.getByRole('dialog', { name: /Save changes/ })).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Write permission was not granted');
  await expect(field).toContainText('unsaved');
  await page.evaluate(() => localStorage.removeItem('test-deny-write'));
  await field.press('ControlOrMeta+z');
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'open')).toBeVisible();
  await openEditor(page);
  await expect(field).not.toContainText('unsaved');
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();
  await expect(button(page, 'readme.txt')).toBeVisible();
});

test('non-text bytes and .git are hidden while text with any extension remains editable', async ({ page }) => {
  await button(page, 'app settings').click(); await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('button', { name: 'browse location…', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: 'Select text.bin file', exact: true })).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: 'Select binary.txt file', exact: true })).toHaveCount(0);
  await expect(picker.getByRole('checkbox', { name: 'Select .git folder', exact: true })).toHaveCount(0);
  await picker.getByRole('checkbox', { name: 'Select text.bin file', exact: true }).check();
  await picker.getByRole('button', { name: /^observe selection/ }).click();
  await button(page, 'text.bin').click();
  await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit text.bin', exact: true })).toContainText('Text with a binary-looking extension.');
});

test('missing source and all incoming/outgoing graph edges are pruned and stay gone after reload', async ({ page }) => {
  await connectDocuments(page); await button(page, 'app settings').click(); await chooseFile(page);
  await seedLegacyGraph(page, { cycle: true });
  await button(page, 'Documents/').click(); await expect(button(page, 'Adobe/')).toBeVisible();
  const before = await storedGraph(page);
  const removed = before.sources.find((source) => source.name === 'Documents')!;
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory(); await root.removeEntry('Documents', { recursive: true });
    window.dispatchEvent(new Event('focus'));
  });
  await expect(button(page, 'app settings')).toBeVisible();
  await expect(button(page, 'Documents/')).toHaveCount(0);
  await expect.poll(async () => (await storedGraph(page)).sources.map((source) => source.name)).toEqual(['outside.txt']);
  const after = await storedGraph(page);
  expect(JSON.stringify({ roots: after.roots, links: after.links, hidden: after.hidden })).not.toContain(removed.id);
  await page.reload(); await expect(button(page, 'outside.txt')).toBeVisible();
  await expect(button(page, 'Documents/')).toHaveCount(0);
});

test('large notes load without truncation and render only a virtualized viewport', async ({ page }) => {
  await createNote(page, 'large.txt'); await toolbar(page, 'Exit').click(); await button(page, '..').click();
  const graph = await storedGraph(page);
  await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework'); const documents = await app.getDirectoryHandle('documents');
    const folder = await documents.getDirectoryHandle(id); const stream = await (await folder.getFileHandle('large.txt')).createWritable();
    const chunk = 'A substantial plain-text note with some detail.\n'.repeat(2000);
    for (let i = 0; i < 30; i++) await stream.write(chunk);
    await stream.close();
  }, graph.sources[0].id);
  await button(page, 'large.txt').click();
  await openEditor(page);
  const field = page.getByRole('textbox', { name: 'Edit large.txt', exact: true });
  await expect(field).toBeVisible();
  expect(await page.locator('.cm-line').count()).toBeLessThan(1000);
  await field.click(); await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.insertText('THE END');
  await expect(page.getByRole('group', { name: 'Editor toolbar' })).toBeInViewport();
  expect(await page.locator('.editor-scroll').evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.locator('.viewport').evaluate((element) => element.scrollTop)).toBe(0);
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  const file = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory(); const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents'); const folder = await documents.getDirectoryHandle(id);
    const file = await (await folder.getFileHandle('large.txt')).getFile();
    return { size: file.size, tail: await file.slice(-7).text() };
  }, graph.sources[0].id);
  expect(file.size).toBeGreaterThan(2 * 1024 * 1024); expect(file.tail).toBe('THE END');
});

test('quota errors preserve edits and graph resources, then saving can be retried', async ({ page }) => {
  await createNote(page, 'quota.txt');
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = function (options) {
      if (localStorage.getItem('test-quota-full') === 'yes') return Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
      return original.call(this, options);
    };
    localStorage.setItem('test-quota-full', 'yes');
  });
  const field = page.getByRole('textbox', { name: 'Edit quota.txt', exact: true });
  await field.click(); await page.keyboard.insertText('Keep these edits.'); await forceSave(page);
  await expect(page.getByRole('alert')).toContainText('Browser storage is full');
  await expect(field).toHaveText('Keep these edits.');
  expect((await storedGraph(page)).sources[0].name).toBe('quota.txt');
  await expect(toolbar(page, 'Export')).toBeEnabled();
  await page.evaluate(() => localStorage.removeItem('test-quota-full'));
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await page.reload(); await button(page, 'quota.txt').click(); await openEditor(page); await expect(field).toHaveText('Keep these edits.');
});

test('a deleted browser document is pruned instead of being recreated', async ({ page }) => {
  await createNote(page, 'temporary.txt');
  const graph = await storedGraph(page);
  await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory(); const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents'); await documents.removeEntry(id, { recursive: true });
    window.dispatchEvent(new Event('focus'));
  }, graph.sources[0].id);
  await expect(button(page, 'app settings')).toBeVisible();
  await expect.poll(async () => (await storedGraph(page)).sources.length).toBe(0);
  await page.reload(); await expect(button(page, 'temporary.txt')).toHaveCount(0);
});

test('wiki suggestions create a sibling on save and rename updates saved backlinks', async ({ page }) => {
  await createNote(page, 'origin.txt');
  const editor = page.getByRole('textbox', { name: 'Edit origin.txt' });
  await page.keyboard.type('[[');
  await expect(editor).toHaveText('[[]]');
  await page.keyboard.type('linked.txt');
  await expect(page.getByRole('option', { name: 'create: linked.txt' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(editor).toHaveText('[[linked.txt]]');
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['origin.txt']);
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  const graph = await storedGraph(page);
  const origin = graph.sources.find((source) => source.name === 'origin.txt')!;
  const target = graph.sources.find((source) => source.name === 'linked.txt')!;
  expect(origin.uri?.split('/').slice(0, -1)).toEqual(target.uri?.split('/').slice(0, -1));
  expect(graph.links[JSON.stringify([origin.id])]).toEqual([JSON.stringify([target.id])]);

  await toolbar(page, 'Exit').click();
  await button(page, 'linked.txt').click();
  await expect(button(page, 'origin.txt')).toHaveCount(0);
  await openEditor(page);
  await toolbar(page, 'Exit').click();
  await button(page, 'configure file').click();
  await button(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename file' });
  await dialog.getByRole('textbox').fill('origin.txt');
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await dialog.getByRole('textbox').fill('renamed.txt');
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'renamed.txt', exact: true })).toBeVisible();
  await page.reload();
  await button(page, 'origin.txt').click();
  await expect(button(page, 'renamed.txt')).toBeVisible();
  await expect(button(page, 'linked.txt')).toHaveCount(0);
  await openEditor(page);
  await expect(editor).toHaveText('[[renamed.txt]]');
  await editor.fill('');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'renamed.txt')).toHaveCount(0);
});

test('wiki links become clickable outside the caret and save edits before opening', async ({ page }) => {
  await createNote(page, 'click origin.txt');
  const editor = page.getByRole('textbox', { name: 'Edit click origin.txt' });
  const link = editor.locator('.cm-wiki-link');
  await page.keyboard.insertText('[[click target.txt]]\nend');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await expect(link).toHaveText('[[click target.txt]]');
  await expect(link).toHaveCSS('cursor', 'pointer');
  await editor.press('ControlOrMeta+Home');
  await editor.press('ArrowRight');
  await expect(link).toHaveCount(0);
  await editor.press('ControlOrMeta+End');
  await expect(link).toBeVisible();
  await page.keyboard.insertText(' edited');
  await link.click();
  await expect(page.getByRole('textbox', { name: 'Edit click target.txt' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'state navigation' })).toHaveCount(0);
});

test('wiki completion uses arrow selection and creates machine-file siblings in the containing folder', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await button(page, 'Adobe/').click();
  await button(page, 'notes.txt').click();
  await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Edit notes.txt' });
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[readm');
  const list = page.getByRole('listbox');
  await expect(list.getByRole('option', { name: /readme\.txt/ })).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { name: 'create: readm' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(editor).toContainText('[[Documents/readme.txt]]');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('[[sibling.txt]]');
  await forceSave(page);
  await expect(page.getByText('saved on your computer', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'sibling.txt')).toBeVisible();
  await expect(button(page, 'readme.txt')).toBeVisible();
  await button(page, 'sibling.txt').click();
  await expect(button(page, 'notes.txt')).toHaveCount(0);
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Adobe/' })).toBeVisible();
  await expect(button(page, 'notes.txt')).toBeVisible();
  await expect(button(page, 'sibling.txt')).toBeVisible();
  await button(page, 'sibling.txt').click();
  await openEditor(page);
  await toolbar(page, 'Exit').click();
  await button(page, 'configure file').click();
  await button(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename file' });
  await dialog.getByRole('textbox').fill('renamed sibling.txt');
  await page.evaluate(() => {
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) {
      if (name === 'sibling.txt' && sessionStorage.getItem('test-block-removal')) {
        return Promise.reject(new DOMException('Original could not be removed.', 'NotAllowedError'));
      }
      return remove.call(this, name, options);
    };
    sessionStorage.setItem('test-block-removal', 'true');
  });
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Original could not be removed.');
  const state = await storedGraph(page);
  expect(JSON.stringify(state.links)).toContain('sibling.txt');
  expect(JSON.stringify(state.links)).not.toContain('renamed sibling.txt');
  await page.evaluate(() => sessionStorage.removeItem('test-block-removal'));
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'renamed sibling.txt', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(button(page, 'sibling.txt')).toHaveCount(0);
  await expect(button(page, 'renamed sibling.txt')).toBeVisible();
  await button(page, 'notes.txt').click();
  await expect(button(page, 'renamed sibling.txt')).toBeVisible();
  await openEditor(page);
  await expect(editor).toContainText('[[renamed sibling.txt]]');
});

test('brush inserts a movable SVG page, swaps the inline toolbar, and saves an exact drawing extent', async ({ page }) => {
  await page.setViewportSize({ width: 1050, height: 1500 });
  await createNote(page, 'sketch.txt');
  const editor = page.getByRole('textbox', { name: 'Edit sketch.txt' });
  await page.keyboard.insertText('before');
  await toolbar(page, 'Brush').hover();
  await expect(toolbar(page, 'Brush').getByText('Command+B', { exact: true })).toBeVisible();
  await page.keyboard.press('Meta+b');
  await page.keyboard.insertText('after');
  const preview = page.getByRole('button', { name: /^Edit drawing drawing-/ });
  await expect(preview).toBeVisible();
  const name = (await preview.getAttribute('aria-label'))!.slice('Edit drawing '.length);
  await expect(editor.locator('.cm-line').first()).toHaveText('before');
  await expect(editor.locator('.cm-line').last()).toHaveText('after');
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['sketch.txt']);

  await preview.click();
  const tools = page.getByRole('group', { name: 'Drawing toolbar' });
  const canvas = page.getByRole('img', { name: `Drawing canvas for ${name}` });
  await expect(tools).toBeVisible();
  await expect(page.getByRole('group', { name: 'Editor toolbar' })).toHaveCount(0);
  await expect(editor).not.toBeEditable();
  await expect(editor.locator('.cm-line').last()).toHaveText('after');
  const box = (await canvas.boundingBox())!;
  const pageHeight = await canvas.evaluate((el) => (el as SVGSVGElement).viewBox.baseVal.height);
  expect(box.height).toBeCloseTo(box.width * pageHeight / 1024, 1);
  await page.mouse.move(box.x + 40, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + box.height + 30, { steps: 8 });
  await page.mouse.up();
  await expect(canvas.locator('polyline')).toHaveCount(1);
  const stroke = (await canvas.locator('polyline').getAttribute('points'))!.split(' ').map((pair) => Number(pair.split(',')[1]));
  expect(Math.max(...stroke)).toBe(pageHeight);
  await expect.poll(async () => (await canvas.boundingBox())!.height).toBeGreaterThan(box.height);

  await page.keyboard.press('Meta+z');
  await expect(canvas.locator('polyline')).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+z');
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await tools.getByRole('button', { name: 'Eraser' }).click();
  const erased = (await canvas.boundingBox())!;
  await page.mouse.click(erased.x + 40, erased.y + 50);
  await expect(canvas.locator('polyline')).toHaveCount(0);
  await tools.getByRole('button', { name: 'Undo' }).click();
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await forceSave(page);
  await expect.poll(async () => (await storedGraph(page)).sources.some((source) => source.name === name)).toBe(true);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(toolbar(page, 'Brush')).toBeVisible();
  await expect(editor).toBeEditable();
  await expect(tools).toHaveCount(0);
  await expect(preview.locator('polyline')).toHaveCount(1);
  expect(Math.abs((await preview.boundingBox())!.width - box.width)).toBeLessThan(3);
  await preview.click();
  await expect(tools).toHaveCount(1);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(tools).toHaveCount(0);
  expect((await preview.locator('svg').boundingBox())!.height).toBeLessThan(box.height + 4);

  // Move the directive as source text, and keep text after it.
  await editor.fill(`after\n\\svgpage[${name}]\nbefore`);
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  const graph = await storedGraph(page);
  const note = graph.sources.find((source) => source.name === 'sketch.txt')!;
  const drawing = graph.sources.find((source) => source.name === name)!;
  expect(drawing.uri?.slice(0, drawing.uri.lastIndexOf('/'))).toBe(note.uri?.slice(0, note.uri.lastIndexOf('/')));
  expect(graph.links[JSON.stringify([note.id])]).toEqual([JSON.stringify([drawing.id])]);
  const svg = await page.evaluate(async ({ uri, name }) => {
    let folder = await navigator.storage.getDirectory();
    for (const part of new URL(uri!).pathname.split('/').filter(Boolean).slice(0, -1).map(decodeURIComponent)) {
      // The opfs URI's host is the first path component.
      if (part === 'documents') folder = await folder.getDirectoryHandle('notework');
      folder = await folder.getDirectoryHandle(part);
    }
    return (await (await folder.getFileHandle(name)).getFile()).text();
  }, drawing);
  expect(svg).toContain('data-notework-drawing="1"');
  expect(svg).toContain(`height="${Math.ceil(pageHeight + 1.5)}"`);
  expect(svg.match(/<polyline/g)).toHaveLength(1);

  await page.reload();
  await button(page, 'sketch.txt').click();
  await expect(button(page, name)).toBeVisible();
  await openEditor(page);
  await expect(preview.locator('polyline')).toHaveCount(1);
  await expect(editor.locator('.cm-line').first()).toHaveText('after');
  await expect(editor.locator('.cm-line').last()).toHaveText('before');
  await toolbar(page, 'Exit').click();
  await button(page, name).click();
  await openEditor(page);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await expect(editor).toHaveCount(0);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await expect(button(page, 'open')).toBeVisible();
  await expect(page.getByRole('heading', { name })).toBeVisible();
});

test('saving a drawing for a machine note creates and edits a real local SVG sibling', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await button(page, 'readme.txt').click();
  await openEditor(page);
  await page.keyboard.press('ControlOrMeta+End');
  await toolbar(page, 'Brush').click();
  const preview = page.getByRole('button', { name: /^Edit drawing drawing-/ });
  const name = (await preview.getAttribute('aria-label'))!.slice('Edit drawing '.length);
  await forceSave(page);
  await expect(page.getByText('saved on your computer', { exact: true })).toBeVisible();
  const svg = await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('Documents');
    return (await (await folder.getFileHandle(name)).getFile()).text();
  }, name);
  expect(svg).toContain('height="1"');
  expect(svg).not.toContain('<polyline');
  await toolbar(page, 'Exit').click();
  await expect(button(page, name)).toBeVisible();
  await button(page, name).click(); await openEditor(page);
  const canvas = page.getByRole('img', { name: 'Drawing canvas for ' + name });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 100); await page.mouse.up();
  const tools = page.getByRole('group', { name: 'Drawing toolbar' });
  await forceSave(page);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await button(page, '..').click();
  await expect(button(page, 'readme.txt')).toBeVisible();
  await expect(button(page, name)).toBeVisible();
  await page.reload(); await button(page, 'Documents/').click();
  await button(page, name).click(); await openEditor(page);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  const graph = await storedGraph(page);
  expect(graph.sources.map((source) => [source.name, source.storage])).toEqual([['Documents', 'local']]);
});

test('Vim j and k land on SVG directives and let you edit them', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('notework:vim-mode', 'true'));
  await page.reload();
  await createNote(page, 'vim-sketch.txt');
  await page.keyboard.press('i');
  await page.keyboard.insertText('before\n\\svgpage[sketch.svg]\nafter');
  await page.keyboard.press('Escape');
  const editor = page.getByRole('textbox', { name: 'Edit vim-sketch.txt' });
  const preview = page.getByRole('button', { name: 'Edit drawing sketch.svg' });
  await expect(preview).toBeVisible();
  await page.keyboard.press('k');
  await expect(preview).toHaveCount(0);
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('\\svgpage[sketch.svg]');
  await page.keyboard.press('k');
  await expect(preview).toBeVisible();
  await page.keyboard.press('j');
  await expect(preview).toHaveCount(0);
  await page.keyboard.type('0ix');
  await page.keyboard.press('Escape');
  await expect(editor.locator('.cm-line').nth(1)).toHaveText('x\\svgpage[sketch.svg]');
});

test('configure deletes local files and folders through their physical parent handles', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await button(page, 'readme.txt').click(); await button(page, 'configure file').click();
  await expect(button(page, 'delete this file')).toBeEnabled();
  await button(page, 'delete this file').click();
  let dialog = page.getByRole('dialog', { name: 'Delete readme.txt?' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(button(page, 'open')).toBeVisible();
  await button(page, 'delete this file').click();
  await dialog.getByRole('button', { name: 'Delete file' }).click();
  await expect(page.getByRole('heading', { name: 'Documents/', exact: true })).toBeVisible();
  await expect(button(page, 'readme.txt')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const documents = await root.getDirectoryHandle('Documents');
    return documents.getFileHandle('readme.txt').then(() => false, (error: DOMException) => error.name === 'NotFoundError');
  })).toBe(true);

  await button(page, 'Adobe/').click(); await button(page, 'configure folder').click();
  await expect(button(page, 'delete this folder')).toBeEnabled();
  await button(page, 'delete this folder').click();
  dialog = page.getByRole('dialog', { name: 'Delete Adobe?' });
  await dialog.getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.getByRole('heading', { name: 'Documents/', exact: true })).toBeVisible();
  await expect(button(page, 'Adobe/')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const documents = await root.getDirectoryHandle('Documents');
    return documents.getDirectoryHandle('Adobe').then(() => false, (error: DOMException) => error.name === 'NotFoundError');
  })).toBe(true);
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['Documents']);
});

test('a directly connected local file retains its parent across reload and can be deleted', async ({ page }) => {
  await button(page, 'app settings').click(); await chooseFile(page);
  await page.reload(); await button(page, 'outside.txt').click(); await button(page, 'configure file').click();
  await expect(button(page, 'delete this file')).toBeEnabled();
  await page.evaluate(() => localStorage.setItem('test-deny-write', 'yes'));
  await button(page, 'delete this file').click();
  let dialog = page.getByRole('dialog', { name: 'Delete outside.txt?' });
  await dialog.getByRole('button', { name: 'Delete file' }).click();
  await expect(page.getByRole('alert')).toContainText('Write permission was not granted');
  await expect(button(page, 'open')).toBeVisible();
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['outside.txt']);
  await page.evaluate(() => localStorage.removeItem('test-deny-write'));
  await button(page, 'delete this file').click();
  dialog = page.getByRole('dialog', { name: 'Delete outside.txt?' });
  await dialog.getByRole('button', { name: 'Delete file' }).click();
  await expect(button(page, 'app settings')).toBeVisible();
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return root.getFileHandle('outside.txt').then(() => false, (error: DOMException) => error.name === 'NotFoundError');
  })).toBe(true);
  await expect.poll(async () => (await storedGraph(page)).sources).toEqual([]);
});

test('a directly connected local folder can be recursively deleted after reload', async ({ page }) => {
  await connectDocuments(page);
  await page.reload(); await button(page, 'Documents/').click(); await button(page, 'configure folder').click();
  await expect(button(page, 'delete this folder')).toBeEnabled();
  await button(page, 'delete this folder').click();
  await page.getByRole('dialog', { name: 'Delete Documents?' }).getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await expect(button(page, 'Documents/')).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle('Documents').then(() => false, (error: DOMException) => error.name === 'NotFoundError');
  })).toBe(true);
  const graph = await storedGraph(page);
  expect(graph.sources).toEqual([]); expect(graph.roots).toEqual([]);
  expect(Object.values(graph.links).flat()).toEqual([]);
});

test('configure deletes browser files after confirmation', async ({ page }) => {
  await createNote(page, 'delete-me.txt');
  await toolbar(page, 'Exit').click();
  await button(page, 'configure file').click();
  await button(page, 'delete this file').click();
  const dialog = page.getByRole('dialog', { name: 'Delete delete-me.txt?' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(button(page, 'open')).toBeVisible();
  await button(page, 'delete this file').click();
  await dialog.getByRole('button', { name: 'Delete file' }).click();
  await expect(button(page, 'app settings')).toBeVisible();
  await expect(button(page, 'delete-me.txt')).toHaveCount(0);
  await expect.poll(async () => (await storedGraph(page)).sources).toEqual([]);
});

test('configure recursively deletes a browser folder and prunes descendant links', async ({ page }) => {
  await createNote(page, 'keep.txt');
  await toolbar(page, 'Exit').click();
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents');
    const folder = await documents.getDirectoryHandle('delete-folder', { create: true });
    const nested = await folder.getDirectoryHandle('nested', { create: true });
    await nested.getFileHandle('child.txt', { create: true });
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('notework', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite');
      const store = tx.objectStore('workspace');
      const request = store.get('current');
      request.onsuccess = () => {
        const data: WorkspaceData = request.result;
        data.links[data.rootIds[0]] = [JSON.stringify(['folder', 'nested', 'child.txt'])];
        data.sources.push({ id: 'folder', storage: 'browser', uri: 'opfs://notework/documents/delete-folder', handle: folder as unknown as WorkspaceData['sources'][number]['handle'] });
        data.rootIds.push(JSON.stringify(['folder']));
        store.put(data, 'current');
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await button(page, 'delete-folder/').click();
  await expect(button(page, 'nested/')).toBeVisible();
  await button(page, 'configure folder').click();
  await button(page, 'delete this folder').click();
  await page.getByRole('dialog', { name: 'Delete delete-folder?' }).getByRole('button', { name: 'Delete folder' }).click();
  await expect(button(page, 'app settings')).toBeVisible();
  await expect(button(page, 'delete-folder/')).toHaveCount(0);
  await expect.poll(async () => Object.values((await storedGraph(page)).links).flat()).toEqual([]);
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents');
    return documents.getDirectoryHandle('delete-folder').then(() => false, (error: DOMException) => error.name === 'NotFoundError');
  })).toBe(true);
});

test('folder creation previews paths and opens new folders, text files, and SVG states', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await startCreate(page);
  await expect(page.getByRole('navigation', { name: 'state navigation' })).toHaveCount(0);
  await expect(button(page, 'create folder')).toBeDisabled();
  const name = page.getByLabel('name', { exact: true });
  await name.fill('Research');
  await expect(page.getByLabel('Path for folder', { exact: true })).toHaveText('Documents/Research/');
  await expect(page.getByLabel('Path for svg file', { exact: true })).toHaveText('Documents/Research.svg');
  await button(page, 'create folder').click();
  await expect(page.getByRole('heading', { name: 'Research/', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(button(page, 'Research/')).toBeVisible();
  await button(page, 'Research/').click();

  await startCreate(page);
  await name.fill('notes.txt');
  await expect(page.getByLabel('Path for text file', { exact: true })).toHaveText('Documents/Research/notes.txt');
  await button(page, 'create text file').click();
  await expect(page.getByRole('heading', { name: 'notes.txt', exact: true })).toBeVisible();
  await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit notes.txt' })).toBeFocused();
  await page.keyboard.insertText('A new note');
  await forceSave(page);
  await expect(page.getByText('saved on your computer', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();

  await startCreate(page);
  await name.fill('diagram');
  await button(page, 'create svg file').click();
  await expect(page.getByRole('heading', { name: 'diagram.svg', exact: true })).toBeVisible();
  await openEditor(page);
  await expect(page.getByRole('group', { name: 'Drawing toolbar' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Drawing canvas for diagram.svg' })).toBeVisible();
  await page.getByRole('group', { name: 'Drawing toolbar' }).getByRole('button', { name: 'Exit', exact: true }).click();
  await button(page, '..').click();
  await expect(button(page, 'notes.txt')).toBeVisible();
  await expect(button(page, 'diagram.svg')).toBeVisible();
  const diagramRow = page.locator('.file-navigation-row').filter({ has: button(page, 'diagram.svg') });
  expect(await diagramRow.locator(':scope > [data-action]').evaluateAll((actions) =>
    actions.map((action) => action.getAttribute('data-action')))).toEqual(['open', 'diagram.svg']);
  await diagramRow.locator('[data-action="open"] button').click();
  await expect(page.getByRole('group', { name: 'Drawing toolbar' })).toBeVisible();
  await page.getByRole('group', { name: 'Drawing toolbar' }).getByRole('button', { name: 'Exit', exact: true }).click();
  await button(page, '..').click();
  expect(await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const documents = await root.getDirectoryHandle('Documents');
    const research = await documents.getDirectoryHandle('Research');
    return (await (await research.getFileHandle('notes.txt')).getFile()).text();
  })).toBe('A new note');
  await page.reload();
  await button(page, 'Documents/').click();
  await button(page, 'Research/').click();
  await button(page, 'notes.txt').click();
  await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit notes.txt' })).toHaveText('A new note');
});

test('creation rejects invalid and duplicate names without overwriting existing resources', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await startCreate(page);
  const name = page.getByLabel('name', { exact: true });
  for (const invalid of ['..', 'one/two', '.git']) {
    await name.fill(invalid);
    await expect(button(page, 'create folder')).toBeDisabled();
  }
  await name.fill('readme.txt');
  await button(page, 'create text file').click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await name.fill('Cancelled');
  await button(page, 'cancel creation').click();
  await expect(button(page, 'Cancelled/')).toHaveCount(0);
  await expect(button(page, 'readme.txt')).toBeVisible();
});

test('Safari-style non-cloneable OPFS handles support creation, rename, save, and reload', async ({ page }) => {
  await page.addInitScript(() => {
    const hasHandle = (value: unknown, seen = new Set<unknown>()): boolean => {
      if (!value || typeof value !== 'object' || seen.has(value)) return false;
      if (value instanceof FileSystemHandle) return true;
      seen.add(value);
      return Object.values(value).some((item) => hasHandle(item, seen));
    };
    const clone = window.structuredClone.bind(window);
    window.structuredClone = (value, options) => {
      if (hasHandle(value)) throw new DOMException('The object can not be cloned', 'DataCloneError');
      return clone(value, options);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (hasHandle(value)) throw new DOMException('The object can not be cloned', 'DataCloneError');
      return put.call(this, value, key);
    };
    window.showDirectoryPicker = undefined;
  });
  await page.reload();
  await createNote(page, 'ipad-first.txt');
  await page.keyboard.insertText('iPad notes');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();
  await createNote(page, 'ipad-second.txt'); // Also exercises metadata snapshots with live handles.
  await toolbar(page, 'Exit').click();
  await page.reload();
  await button(page, 'ipad-first.txt').click();
  await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit ipad-first.txt' })).toHaveText('iPad notes');
  await toolbar(page, 'Exit').click();
  await button(page, 'configure file').click();
  await button(page, 'rename').click();
  await page.getByRole('dialog').getByRole('textbox').fill('ipad-renamed.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'Rename and update links', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ipad-renamed.txt' })).toBeVisible();
  await page.reload();
  await expect(button(page, 'ipad-renamed.txt')).toBeVisible();
  await expect(button(page, 'ipad-second.txt')).toBeVisible();
});

test('folder configuration rename moves descendants and rewrites links through root and nested renames', async ({ page }) => {
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('Project');
  await button(page, 'create folder').click();
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('Nested');
  await button(page, 'create folder').click();
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('note.txt');
  await button(page, 'create text file').click();
  await openEditor(page);
  const note = page.getByRole('textbox', { name: 'Edit note.txt' });
  await expect(note).toBeVisible();
  await note.fill('Keep this content');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await button(page, '..').click(); // Nested
  await button(page, '..').click(); // Project
  await button(page, '..').click(); // Home
  await createNote(page, 'index.txt');
  const index = page.getByRole('textbox', { name: 'Edit index.txt' });
  await index.fill('[[Project/Nested/note.txt]]');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await expect(toolbar(page, 'Rename')).toHaveCount(0);
  await toolbar(page, 'Exit').click();
  await button(page, '..').click();
  await button(page, 'Project/').click();
  await button(page, 'configure folder').click();
  await button(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename folder' });
  await dialog.getByRole('textbox').fill('Renamed');
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'Renamed/', exact: true })).toBeVisible();
  await button(page, 'Nested/').click();
  await button(page, 'configure folder').click();
  await button(page, 'rename').click();
  await dialog.getByRole('textbox').fill('Child');
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'Child/', exact: true })).toBeVisible();
  await button(page, 'note.txt').click();
  await openEditor(page);
  await expect(note).toHaveText('Keep this content');
  await page.reload();
  await button(page, 'index.txt').click();
  await expect(button(page, 'note.txt')).toBeVisible();
  await openEditor(page);
  await expect(index).toHaveText('[[Renamed/Child/note.txt]]');
  await toolbar(page, 'Exit').click();
  await button(page, 'note.txt').click();
  await expect(page.getByRole('heading', { name: 'note.txt', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Child/', exact: true })).toBeVisible();
});

test('machine folder rename requests permission and updates all descendant navigation', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'Documents/').click();
  await button(page, 'Adobe/').click();
  await button(page, 'configure folder').click();
  await button(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename folder' });
  await dialog.getByRole('textbox').fill('Sketches');
  await page.evaluate(() => localStorage.setItem('test-deny-write', 'yes'));
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Write permission was not granted');
  await page.evaluate(() => localStorage.removeItem('test-deny-write'));
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'Sketches/', exact: true })).toBeVisible();
  await button(page, 'notes.txt').click();
  await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit notes.txt' })).toHaveText('A nested note about semantic roles.');
  await page.reload();
  await button(page, 'Documents/').click();
  await expect(button(page, 'Adobe/')).toHaveCount(0);
  await button(page, 'Sketches/').click();
  await expect(button(page, 'notes.txt')).toBeVisible();
});

test('SVG rename in configuration updates the inline directive and its graph target', async ({ page }) => {
  await createNote(page, 'drawing-note.txt');
  const editor = page.getByRole('textbox', { name: 'Edit drawing-note.txt' });
  await editor.fill('\\svgpage[ink.svg]\nText below');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await button(page, 'ink.svg').click();
  await button(page, 'configure file').click();
  await button(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename file' });
  await dialog.getByRole('textbox').fill('renamed.svg');
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'renamed.svg', exact: true })).toBeVisible();
  await page.reload();
  await button(page, 'drawing-note.txt').click();
  await expect(button(page, 'ink.svg')).toHaveCount(0);
  await button(page, 'open').click();
  await expect(editor.locator('.cm-line').last()).toHaveText('Text below');
  await editor.press('ControlOrMeta+End');
  await expect(page.getByRole('button', { name: 'Edit drawing renamed.svg' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit drawing ink.svg' })).toHaveCount(0);
  await expect(editor.locator('.cm-line').last()).toHaveText('Text below');
});

test('SVG page references resolve and rename drawings across folders and storage sources', async ({ page }) => {
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('Art');
  await button(page, 'create folder').click();
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('shared');
  await button(page, 'create svg file').click();
  await openEditor(page);
  const canvas = page.getByRole('img', { name: 'Drawing canvas for shared.svg' });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 100); await page.mouse.up();
  await forceSave(page);
  await page.getByRole('group', { name: 'Drawing toolbar' }).getByRole('button', { name: 'Exit', exact: true }).click();
  await button(page, 'home').click();

  await connectDocuments(page);
  await button(page, 'Documents/').click(); await button(page, 'readme.txt').click(); await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Edit readme.txt' });
  await editor.fill('before\n\\svgpage[Art/shared.svg]\nafter');
  const preview = page.getByRole('button', { name: 'Edit drawing Art/shared.svg', exact: true });
  await expect(preview.locator('polyline')).toHaveCount(1);
  await forceSave(page);
  await expect(page.getByText('saved on your computer', { exact: true })).toBeVisible();
  const graph = await storedGraph(page);
  const documents = graph.sources.find((source) => source.name === 'Documents')!;
  const art = graph.sources.find((source) => source.name === 'Art')!;
  const noteId = JSON.stringify([documents.id, 'readme.txt']);
  const drawingId = JSON.stringify([art.id, 'shared.svg']);
  expect(graph.wiki?.[noteId]?.['Art/shared.svg']).toBe(drawingId);
  expect(graph.links[noteId]).toContain(drawingId);
  expect(await page.evaluate(async () => {
    const documents = await (await navigator.storage.getDirectory()).getDirectoryHandle('Documents');
    return documents.getFileHandle('shared.svg').then(() => true, () => false);
  })).toBe(false);

  await toolbar(page, 'Exit').click();
  await button(page, 'shared.svg').click();
  await button(page, 'configure file').click(); await button(page, 'rename').click();
  const dialog = page.getByRole('dialog', { name: 'Rename file' });
  await dialog.getByRole('textbox').fill('renamed.svg');
  await dialog.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'renamed.svg', exact: true })).toBeVisible();

  await page.reload(); await button(page, 'Documents/').click(); await button(page, 'readme.txt').click(); await openEditor(page);
  const renamed = page.getByRole('button', { name: 'Edit drawing Art/renamed.svg', exact: true });
  await expect(renamed.locator('polyline')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Edit drawing Art/shared.svg', exact: true })).toHaveCount(0);
  expect(await page.evaluate(async () => {
    const documents = await (await navigator.storage.getDirectory()).getDirectoryHandle('Documents');
    return (await (await documents.getFileHandle('readme.txt')).getFile()).text();
  })).toContain('\\svgpage[Art/renamed.svg]');
});

test('home is a virtual folder with mixed sources and the shared creation screen', async ({ page }) => {
  await connectDocuments(page);
  await button(page, 'app settings').click();
  const settings = page.getByRole('region', { name: 'app settings' });
  await expect(settings.getByText('create document', { exact: true })).toHaveCount(0);
  await expect(settings.locator('[data-action="create new file/folder"]')).toHaveCount(1);
  await expect(page.getByLabel('document name', { exact: true })).toHaveCount(0);
  await button(page, 'close app settings').click();

  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('Notebook');
  await expect(page.getByLabel('Path for folder', { exact: true })).toHaveText('home/Notebook/');
  await button(page, 'create folder').click();
  await expect(page.getByRole('heading', { name: 'Notebook/', exact: true })).toBeVisible();
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('entry.txt');
  await button(page, 'create text file').click();
  await expect(page.getByRole('heading', { name: 'entry.txt', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Notebook/', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await expect(button(page, 'Documents/')).toBeVisible();
  await expect(button(page, 'Notebook/')).toBeVisible();
  const graph = await storedGraph(page);
  expect(graph.sources.map((source) => [source.name, source.storage])).toEqual([
    ['Documents', 'local'], ['Notebook', 'browser']
  ]);
  expect(graph.roots).toHaveLength(2);
  await page.reload();
  await button(page, 'Notebook/').click();
  await expect(button(page, 'entry.txt')).toBeVisible();
  await button(page, '..').click();
  await button(page, 'Documents/').click();
  await expect(button(page, 'Adobe/')).toBeVisible();
});

test('drawing pages preserve geometry through rotation, inline preview, and standalone editing', async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await createNote(page, 'rotation.txt');
  await toolbar(page, 'Brush').click();
  await page.keyboard.insertText('Below the drawing');
  const preview = page.getByRole('button', { name: /^Edit drawing drawing-/ });
  const name = (await preview.getAttribute('aria-label'))!.slice('Edit drawing '.length);
  await preview.click();
  const canvas = page.getByRole('img', { name: `Drawing canvas for ${name}` });
  const tools = page.getByRole('group', { name: 'Drawing toolbar' });
  const matrix = await canvas.evaluate((el) => {
    const m = (el as SVGSVGElement).getScreenCTM()!;
    return { a: m.a, d: m.d, e: m.e, f: m.f };
  });
  expect(matrix.a).toBeCloseTo(matrix.d, 5);
  await page.mouse.move(matrix.e + 200 * matrix.a, matrix.f + 100 * matrix.d);
  await page.mouse.down();
  for (const [x, y] of [[400, 100], [400, 300], [200, 300], [200, 100]]) {
    await page.mouse.move(matrix.e + x * matrix.a, matrix.f + y * matrix.d);
  }
  await page.mouse.up();
  const points = await canvas.locator('polyline').getAttribute('points');
  async function squareFits(svg: ReturnType<Page['locator']>) {
    await expect.poll(() => svg.evaluate((el) => {
      const m = (el as SVGSVGElement).getScreenCTM()!;
      return Math.abs(m.a - m.d);
    })).toBeLessThan(.0001);
    await expect.poll(async () => (await svg.boundingBox())!.width - (await page.locator('main.app').boundingBox())!.width).toBeLessThanOrEqual(0);
    const square = (await svg.locator('polyline').boundingBox())!;
    const originalRatio = await svg.locator('polyline').evaluate((el) => {
      const box = (el as SVGGraphicsElement).getBBox();
      return box.width / box.height;
    });
    expect(square.width / square.height).toBeCloseTo(originalRatio, 3);
    const box = (await svg.boundingBox())!;
    const model = await svg.evaluate((el) => ({ width: (el as SVGSVGElement).viewBox.baseVal.width, height: (el as SVGSVGElement).viewBox.baseVal.height }));
    expect(box.width / box.height).toBeCloseTo(model.width / model.height, 2);
  }
  for (const viewport of [{ width: 1180, height: 820 }, { width: 2048, height: 1200 }, { width: 820, height: 1180 }]) {
    await page.setViewportSize(viewport);
    await squareFits(canvas);
    await expect(canvas.locator('polyline')).toHaveAttribute('points', points!);
  }
  await forceSave(page);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  for (const viewport of [{ width: 1180, height: 820 }, { width: 820, height: 1180 }]) {
    await page.setViewportSize(viewport);
    await squareFits(preview.locator('svg'));
  }
  await toolbar(page, 'Exit').click();
  await button(page, name).click(); await openEditor(page);
  await expect(canvas.locator('polyline')).toHaveAttribute('points', points!);
  await page.setViewportSize({ width: 1180, height: 820 });
  await squareFits(canvas);
});

test('drawing touch gestures undo, redo, pan and zoom; stylus-only mode persists and rejects fingers', async ({ page, context }) => {
  await page.setViewportSize({ width: 820, height: 620 });
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('gestures.svg');
  await button(page, 'create svg file').click(); await openEditor(page);
  const canvas = page.getByRole('img', { name: 'Drawing canvas for gestures.svg' });
  const tools = page.getByRole('group', { name: 'Drawing toolbar' });
  await expect(canvas).toBeVisible();
  let box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 50); await page.mouse.down();
  await page.mouse.move(box.x + 100, box.y + box.height - 20); await page.mouse.up();
  await expect(canvas.locator('polyline')).toHaveCount(1);
  const protocol = await context.newCDPSession(page);
  const contacts = (count: number, y: number, distance = 40) => Array.from({ length: count }, (_, id) => ({
    id, x: 300 + (id - (count - 1) / 2) * distance, y, radiusX: 5, radiusY: 5, force: 1
  }));
  const tap = async (count: number) => {
    const b = (await canvas.boundingBox())!;
    const y = Math.max(80, b.y + 60);
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contacts(count, y) });
    await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await tap(2); await expect(canvas.locator('polyline')).toHaveCount(0);
  await tap(3); await expect(canvas.locator('polyline')).toHaveCount(1);
  const drawingScroll = page.locator('.standalone-drawing-editor > .drawing-surface');
  const beforeScroll = await drawingScroll.evaluate((el) => el.scrollTop);
  box = (await canvas.boundingBox())!;
  const y = Math.max(160, box.y + 180);
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contacts(2, y) });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: contacts(2, y - 80) });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => drawingScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(beforeScroll);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  const beforeWidth = (await canvas.boundingBox())!.width;
  const top = Math.max(100, (await canvas.boundingBox())!.y + 140);
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: contacts(2, top, 60) });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: contacts(2, top, 120) });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(beforeWidth * 1.5);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await forceSave(page);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  await button(page, '..').click(); await button(page, 'app settings').click();
  await button(page, 'draw with only physical stylus: disabled').click();
  await expect(button(page, 'draw with only physical stylus: enabled')).toBeVisible();
  await page.reload();
  await button(page, 'gestures.svg').click(); await openEditor(page);
  await expect(canvas).toHaveCSS('touch-action', 'manipulation');
  box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 50); await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 100); await page.mouse.up();
  await expect(canvas.locator('polyline')).toHaveCount(1);
  const scroll = await drawingScroll.evaluate((el) => el.scrollTop);
  const finger = [{ id: 0, x: box.x + 200, y: Math.max(180, box.y + 180) }];
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...finger[0], y: finger[0].y - 100 }] });
  await protocol.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => drawingScroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(scroll);
  await expect(canvas.locator('polyline')).toHaveCount(1);
  await canvas.scrollIntoViewIfNeeded();
  box = (await canvas.boundingBox())!;
  const penY = Math.max(80, box.y + 70);
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, x: box.x + 300, y: penY });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseMoved', pointerType: 'pen', buttons: 1, x: box.x + 350, y: penY + 30 });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, x: box.x + 350, y: penY + 30 });
  await expect(canvas.locator('polyline')).toHaveCount(2);
  const erasePoint = (await canvas.locator('polyline').last().getAttribute('points'))!.split(' ')[0].split(',').map(Number);
  await tools.getByRole('button', { name: 'Eraser' }).click();
  const erase = await canvas.evaluate((el, point) => {
    const m = (el as SVGSVGElement).getScreenCTM()!;
    const p = new DOMPoint(point[0], point[1]).matrixTransform(m);
    return { x: p.x, y: p.y };
  }, erasePoint);
  await protocol.send('Input.dispatchMouseEvent', { type: 'mousePressed', pointerType: 'pen', button: 'left', buttons: 1, ...erase });
  await protocol.send('Input.dispatchMouseEvent', { type: 'mouseReleased', pointerType: 'pen', button: 'left', buttons: 0, ...erase });
  await expect(canvas.locator('polyline')).toHaveCount(1);
});

test('local creation denial and failed metadata saves leave no child or browser fallback', async ({ page }) => {
  await connectDocuments(page); await button(page, 'Documents/').click();
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill('denied.txt');
  await page.evaluate(() => localStorage.setItem('test-deny-write', 'yes'));
  await button(page, 'create text file').click();
  await expect(page.getByRole('alert')).toContainText('Write permission was not granted');
  async function exists(name: string) {
    return page.evaluate(async (name) => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('Documents');
      return folder.getFileHandle(name).then(() => true, () => false);
    }, name);
  }
  expect(await exists('denied.txt')).toBe(false);
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['Documents']);
  await page.evaluate(() => {
    localStorage.removeItem('test-deny-write');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (sessionStorage.getItem('test-fail-create-save')) throw new Error('Metadata save failed');
      return put.call(this, value, key);
    };
    sessionStorage.setItem('test-fail-create-save', 'yes');
  });
  await page.getByLabel('name', { exact: true }).fill('rolled-back.txt');
  await button(page, 'create text file').click();
  await expect(page.getByRole('alert')).toContainText('Metadata save failed');
  expect(await exists('rolled-back.txt')).toBe(false);
  await page.evaluate(() => sessionStorage.removeItem('test-fail-create-save'));
  await button(page, 'cancel creation').click();
  await expect(button(page, 'rolled-back.txt')).toHaveCount(0);
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['Documents']);
  await expect(button(page, 'readme.txt')).toBeVisible();
});

test('cross-storage wiki links do not change physical children or parent navigation', async ({ page }) => {
  await createNote(page, 'browser-target.txt');
  await page.keyboard.insertText('Browser resource');
  await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click(); await button(page, '..').click();
  await connectDocuments(page); await button(page, 'Documents/').click();
  await button(page, 'readme.txt').click(); await openEditor(page);
  const editor = page.getByRole('textbox', { name: 'Edit readme.txt' });
  await editor.fill('[[browser-target.txt]]'); await forceSave(page);
  await expect(page.getByText('saved on your computer', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'browser-target.txt')).toBeVisible();
  await button(page, '..').click();
  await expect(button(page, 'browser-target.txt')).toHaveCount(0);
  await expect(page.getByText('3 direct children', { exact: false })).toBeVisible();
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('browser-target');
  await expect(page.locator('.search-status')).toContainText('1 result found');
  await button(page, 'browser-target.txt').click();
  await expect(page.getByRole('heading', { name: 'browser-target.txt', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  expect((await storedGraph(page)).sources.map((source) => [source.name, source.storage])).toEqual([
    ['browser-target.txt', 'browser'], ['Documents', 'local']
  ]);
});

test('legacy browser-backed children become links and retain their original resources', async ({ page }) => {
  await connectDocuments(page);
  await createNote(page, 'legacy.txt');
  await page.keyboard.insertText('Preserve browser bytes'); await forceSave(page);
  await expect(page.getByText('saved in browser storage', { exact: true })).toBeVisible();
  await toolbar(page, 'Exit').click(); await expect(button(page, 'open')).toBeVisible();
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.goto('about:blank'); await page.goto('/manifest.webmanifest');
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('notework', 1); request.onsuccess = () => resolve(request.result);
    });
    const data = await new Promise<WorkspaceData>((resolve) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current'); request.onsuccess = () => resolve(request.result);
    });
    const local = data.sources.find((source) => source.storage === 'local')!;
    const browser = data.sources.find((source) => source.storage === 'browser')!;
    browser.parent = JSON.stringify([local.id]);
    data.rootIds = data.rootIds.filter((id) => id !== JSON.stringify([browser.id]));
    const root = await navigator.storage.getDirectory();
    const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents');
    const bucket = await documents.getDirectoryHandle('legacy-drawing', { create: true });
    const drawing = await bucket.getFileHandle('legacy.svg', { create: true });
    const writer = await drawing.createWritable();
    await writer.write('<svg xmlns="http://www.w3.org/2000/svg" data-notework-drawing="1" width="1024" height="1" viewBox="0 0 1024 1"><g/></svg>');
    await writer.close();
    data.sources.push({ id: 'legacy-svg', storage: 'browser', uri: 'opfs://notework/documents/legacy-drawing/legacy.svg',
      drawingScope: JSON.stringify([local.id]) } as WorkspaceData['sources'][number]);
    const folder = local.handle as unknown as FileSystemDirectoryHandle;
    const readme = await folder.getFileHandle('readme.txt');
    const readmeWriter = await readme.createWritable();
    await readmeWriter.write('\\svgpage[legacy.svg]\nLegacy drawing below'); await readmeWriter.close();
    const note = JSON.stringify([local.id, 'readme.txt']);
    (data.wiki ??= {})[note] = { 'legacy.svg': JSON.stringify(['legacy-svg']) };
    data.links[note] = [JSON.stringify(['legacy-svg'])];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(data, 'current');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto('/'); await button(page, 'Documents/').click();
  await expect(button(page, 'legacy.txt')).toBeVisible();
  await expect(page.getByText('3 direct children · 5 reachable states', { exact: true })).toBeVisible();
  await button(page, 'legacy.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit legacy.txt' })).toHaveText('Preserve browser bytes');
  await toolbar(page, 'Exit').click(); await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await expect(button(page, 'legacy.txt')).toHaveCount(0);
  const graph = await storedGraph(page);
  const local = graph.sources.find((source) => source.storage === 'local')!;
  const browser = graph.sources.find((source) => source.name === 'legacy.txt')!;
  expect(browser.storage).toBe('browser'); expect(browser.uri).toMatch(/^opfs:\/\//);
  expect(graph.links[JSON.stringify([local.id])]).toContain(JSON.stringify([browser.id]));
  await page.reload(); await button(page, 'Documents/').click();
  await expect(page.getByText('3 direct children · 5 reachable states', { exact: true })).toBeVisible();
  await button(page, 'readme.txt').click(); await openEditor(page);
  await page.getByRole('textbox', { name: 'Edit readme.txt' }).press('ControlOrMeta+End');
  await page.getByRole('button', { name: 'Edit drawing legacy.svg', exact: true }).click();
  const canvas = page.getByRole('img', { name: 'Drawing canvas for legacy.svg' });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 100); await page.mouse.up();
  const tools = page.getByRole('group', { name: 'Drawing toolbar' });
  await forceSave(page);
  await tools.getByRole('button', { name: 'Exit', exact: true }).click();
  const resource = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const local = await root.getDirectoryHandle('Documents');
    const inLocal = await local.getFileHandle('legacy.svg').then(() => true, () => false);
    const app = await root.getDirectoryHandle('notework');
    const documents = await app.getDirectoryHandle('documents');
    const bucket = await documents.getDirectoryHandle('legacy-drawing');
    return { inLocal, content: await (await (await bucket.getFileHandle('legacy.svg')).getFile()).text() };
  });
  expect(resource.inLocal).toBe(false); expect(resource.content).toContain('<polyline');
});

async function createFolder(page: Page, name: string) {
  await startCreate(page);
  await page.getByLabel('name', { exact: true }).fill(name);
  await button(page, 'create folder').click();
  await expect(page.getByRole('heading', { name: name + '/', exact: true })).toBeVisible();
}

async function startRelocate(page: Page, kind: 'file' | 'folder' = 'file') {
  await button(page, `configure ${kind}`).click();
  await button(page, `relocate this ${kind}`).click();
  await expect(page.getByRole('complementary', { name: 'relocate' })).toBeVisible();
  await expect(page.getByRole('heading', { name: `configure ${kind}`, exact: true })).toHaveCount(0);
}

const chooseHere = (page: Page) => page.getByRole('region', { name: 'current state' }).locator('[data-action="choose"] button');

test('relocate mode chooses folders only, cancels with Escape, and creates a destination before choosing it', async ({ page }) => {
  await createNote(page, 'travel.txt');
  await page.getByRole('textbox', { name: 'Edit travel.txt' }).fill('Keep these bytes');
  await toolbar(page, 'Exit').click();
  await startRelocate(page);
  await expect(page.getByText('choose location for travel.txt', { exact: true })).toBeVisible();
  await expect(button(page, 'open')).toHaveCount(0);
  await expect(button(page, 'choose')).toHaveCount(0);
  await button(page, '..').click();
  await button(page, 'search').click();
  await page.getByRole('searchbox').fill('travel');
  await expect(page.locator('.search-status')).toContainText('1 result found');
  await expect(button(page, 'open')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'relocate' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'travel.txt', exact: true })).toBeVisible();
  await startRelocate(page);
  await button(page, '..').click();
  await createFolder(page, 'Archive');
  await expect(page.getByText('choose location for travel.txt', { exact: true })).toBeVisible();
  await chooseHere(page).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('complementary', { name: 'relocate' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'travel.txt', exact: true })).toBeVisible();
  await expect(page.locator('.path')).toContainText('Archive/travel.txt');
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Archive/', exact: true })).toBeVisible();
  await button(page, 'home').click();
  await expect(button(page, 'travel.txt')).toHaveCount(0);
  await page.reload();
  await button(page, 'Archive/').click(); await button(page, 'travel.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit travel.txt' })).toHaveText('Keep these bytes');
  await toolbar(page, 'Exit').click();
  await startRelocate(page); await button(page, 'home').click(); await chooseHere(page).click();
  await expect(page.getByRole('heading', { name: 'travel.txt', exact: true })).toBeVisible();
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'home', exact: true })).toBeVisible();
  await page.reload();
  await expect(button(page, 'travel.txt')).toBeVisible();
  await button(page, 'Archive/').click(); await expect(button(page, 'travel.txt')).toHaveCount(0);
});

test('relocate within computer storage moves the file without confirmation', async ({ page }) => {
  await connectDocuments(page); await button(page, 'Documents/').click(); await button(page, 'readme.txt').click();
  await startRelocate(page); await button(page, '..').click();
  const adobe = page.locator('.file-navigation-row').filter({ has: button(page, 'Adobe/') });
  await adobe.locator('[data-action="choose"] button').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'readme.txt', exact: true })).toBeVisible();
  await expect(page.locator('.path')).toContainText('Documents/Adobe/readme.txt');
  await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Adobe/', exact: true })).toBeVisible();
  await page.reload(); await button(page, 'Documents/').click();
  await expect(button(page, 'readme.txt')).toHaveCount(0);
  await button(page, 'Adobe/').click(); await button(page, 'readme.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit readme.txt' })).toContainText('Welcome to Notework.');
});

test('relocate across storage sources requires Yes and supports moving back to home', async ({ page }) => {
  await connectDocuments(page);
  await createNote(page, 'crossing.txt');
  await page.getByRole('textbox', { name: 'Edit crossing.txt' }).fill('Move across storage');
  await toolbar(page, 'Exit').click();
  await startRelocate(page); await button(page, 'home').click(); await button(page, 'Documents/').click();
  await chooseHere(page).click();
  let dialog = page.getByRole('dialog', { name: 'Relocate file to computer storage?' });
  await expect(dialog).toContainText('creates “crossing.txt” in computer storage at Documents, then deletes the original from browser storage');
  await dialog.getByRole('button', { name: 'No', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'relocate' })).toBeVisible();
  expect(await page.evaluate(async () => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('Documents');
    return folder.getFileHandle('crossing.txt').then(() => true, () => false);
  })).toBe(false);
  await chooseHere(page).click(); await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'crossing.txt', exact: true })).toBeVisible();
  await expect(page.locator('.path')).toContainText('computer');
  expect((await storedGraph(page)).sources.map((source) => source.name)).toEqual(['Documents']);
  await startRelocate(page); await button(page, 'home').click(); await chooseHere(page).click();
  dialog = page.getByRole('dialog', { name: 'Relocate file to browser storage?' });
  await expect(dialog).toContainText('then deletes the original from computer storage');
  await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'crossing.txt', exact: true })).toBeVisible();
  await expect(page.locator('.path')).toContainText('browser storage');
  await page.reload(); await button(page, 'Documents/').click();
  await expect(button(page, 'crossing.txt')).toHaveCount(0);
  await button(page, 'home').click(); await button(page, 'crossing.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit crossing.txt' })).toHaveText('Move across storage');
});

test('relocate folders through search preserves descendants and rewrites saved backlinks', async ({ page }) => {
  await createFolder(page, 'Archive'); await button(page, 'home').click();
  await createFolder(page, 'Project'); await createFolder(page, 'Nested');
  await startCreate(page); await page.getByLabel('name', { exact: true }).fill('note.txt'); await button(page, 'create text file').click();
  await openEditor(page); await page.getByRole('textbox', { name: 'Edit note.txt' }).fill('Folder content');
  await toolbar(page, 'Exit').click(); await button(page, 'home').click();
  await createNote(page, 'index.txt');
  await page.getByRole('textbox', { name: 'Edit index.txt' }).fill('[[Project/Nested/note.txt]]');
  await toolbar(page, 'Exit').click(); await button(page, 'home').click(); await button(page, 'Project/').click();
  await startRelocate(page, 'folder'); await button(page, 'home').click(); await button(page, 'search').click();
  await page.getByRole('searchbox').fill('Archive');
  await expect(page.locator('.search-status')).toContainText('1 result found');
  await page.locator('.search-result-row [data-action="choose"] button').click();
  await expect(page.getByRole('heading', { name: 'Project/', exact: true })).toBeVisible();
  await expect(page.locator('.path')).toContainText('Archive/Project');
  await button(page, '..').click(); await expect(page.getByRole('heading', { name: 'Archive/', exact: true })).toBeVisible();
  await page.reload(); await expect(button(page, 'Project/')).toHaveCount(0);
  await button(page, 'index.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit index.txt' })).toHaveText('[[Archive/Project/Nested/note.txt]]');
  await toolbar(page, 'Exit').click(); await button(page, 'note.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit note.txt' })).toHaveText('Folder content');
  await toolbar(page, 'Exit').click(); await button(page, '..').click();
  await expect(page.getByRole('heading', { name: 'Nested/', exact: true })).toBeVisible();
});

test('relocate rejects self and descendant folders and existing destination names', async ({ page }) => {
  await createFolder(page, 'Project'); await createFolder(page, 'Nested');
  await button(page, '..').click(); await startRelocate(page, 'folder'); await chooseHere(page).click();
  await expect(page.getByRole('alert')).toContainText('cannot be relocated into itself');
  await button(page, 'Nested/').click(); await chooseHere(page).click();
  await expect(page.getByRole('alert')).toContainText('cannot be relocated into itself');
  await page.getByRole('button', { name: /cancel relocate/ }).click();
  await expect(page.getByRole('heading', { name: 'Project/', exact: true })).toBeVisible();
  await button(page, 'home').click(); await connectDocuments(page);
  await createNote(page, 'readme.txt'); await toolbar(page, 'Exit').click(); await startRelocate(page);
  await button(page, 'home').click(); await button(page, 'Documents/').click(); await chooseHere(page).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already exists');
  await page.getByRole('button', { name: /cancel relocate/ }).click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit readme.txt' })).toHaveText('');
});

test('relocate permission denial and metadata failure preserve the original and remove the partial copy', async ({ page }) => {
  await connectDocuments(page); await button(page, 'Documents/').click(); await button(page, 'readme.txt').click();
  await startRelocate(page); await button(page, '..').click(); await button(page, 'Adobe/').click();
  await page.evaluate(() => localStorage.setItem('test-deny-write', 'yes'));
  await chooseHere(page).click();
  await expect(page.getByRole('alert')).toContainText('Write permission was not granted');
  await page.evaluate(() => {
    localStorage.removeItem('test-deny-write');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (sessionStorage.getItem('test-fail-relocate-save')) throw new Error('Relocate metadata save failed');
      return put.call(this, value, key);
    };
    sessionStorage.setItem('test-fail-relocate-save', 'yes');
  });
  await chooseHere(page).click();
  await expect(page.getByRole('alert')).toContainText('Relocate metadata save failed');
  expect(await page.evaluate(async () => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('Documents');
    const adobe = await folder.getDirectoryHandle('Adobe');
    return { original: await (await folder.getFileHandle('readme.txt')).getFile().then((file) => file.text()),
      copy: await adobe.getFileHandle('readme.txt').then(() => true, () => false) };
  })).toEqual({ original: 'Welcome to Notework.\nYour files stay local.', copy: false });
  await page.evaluate(() => sessionStorage.removeItem('test-fail-relocate-save'));
  await chooseHere(page).click();
  await expect(page.getByRole('heading', { name: 'readme.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'relocate' })).toHaveCount(0);
});

test('relocate rolls back backlink rewrites when the original file cannot be removed', async ({ page }) => {
  await connectDocuments(page);
  await createNote(page, 'index.txt');
  await page.getByRole('textbox', { name: 'Edit index.txt' }).fill('[[Documents/readme.txt]]');
  await toolbar(page, 'Exit').click(); await button(page, 'readme.txt').click();
  await startRelocate(page); await button(page, '..').click(); await button(page, 'Adobe/').click();
  await page.evaluate(() => {
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function(name, options) {
      if (this.name === 'Documents' && name === 'readme.txt') return Promise.reject(new Error('Original removal failed'));
      return remove.call(this, name, options);
    };
  });
  await chooseHere(page).click();
  await expect(page.getByRole('alert')).toContainText('Original removal failed');
  await page.getByRole('button', { name: /cancel relocate/ }).click();
  await expect(page.locator('.path')).toContainText('Documents/readme.txt');
  await button(page, 'home').click(); await button(page, 'index.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit index.txt' })).toHaveText('[[Documents/readme.txt]]');
  await page.reload(); await button(page, 'Documents/').click();
  await expect(button(page, 'readme.txt')).toBeVisible();
  await button(page, 'Adobe/').click(); await expect(button(page, 'readme.txt')).toHaveCount(0);
});

test('relocate a separately connected folder updates ancestor-grant references across storage', async ({ page }) => {
  await connectDocuments(page);
  await createFolder(page, 'Archive'); await button(page, 'home').click();
  await createNote(page, 'index.txt');
  await page.getByRole('textbox', { name: 'Edit index.txt' }).fill('[[Documents/Adobe/notes.txt]]');
  await toolbar(page, 'Exit').click();
  await expect(button(page, 'open')).toBeVisible();
  await page.evaluate(async () => {
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.goto('about:blank'); await page.goto('/manifest.webmanifest');
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('notework', 1); request.onsuccess = () => resolve(request.result);
    });
    const data = await new Promise<WorkspaceData>((resolve) => {
      const request = db.transaction('workspace').objectStore('workspace').get('current'); request.onsuccess = () => resolve(request.result);
    });
    const parent = data.sources.find((source) => source.storage === 'local')!.handle;
    if (parent.kind !== 'directory') throw new Error('Expected fixture folder');
    data.sources.push({ id: 'adobe-alias', handle: await parent.getDirectoryHandle('Adobe'), storage: 'local',
      uri: 'notework-local://adobe-alias/Adobe', physicalParent: parent });
    data.rootIds.push(JSON.stringify(['adobe-alias']));
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite'); tx.objectStore('workspace').put(data, 'current');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.goto('/'); await button(page, 'Adobe/').click();
  await startRelocate(page, 'folder'); await button(page, 'home').click(); await button(page, 'Archive/').click();
  await chooseHere(page).click();
  const dialog = page.getByRole('dialog', { name: 'Relocate folder to browser storage?' });
  await expect(dialog).toContainText('and all its contents');
  await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Adobe/', exact: true })).toBeVisible();
  await button(page, '..').click(); await expect(page.getByRole('heading', { name: 'Archive/', exact: true })).toBeVisible();
  await page.reload(); await button(page, 'Documents/').click(); await expect(button(page, 'Adobe/')).toHaveCount(0);
  await button(page, 'home').click(); await button(page, 'index.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit index.txt' })).toHaveText('[[Archive/Adobe/notes.txt]]');
  await toolbar(page, 'Exit').click(); await button(page, 'notes.txt').click(); await openEditor(page);
  await expect(page.getByRole('textbox', { name: 'Edit notes.txt' })).toHaveText('A nested note about semantic roles.');
  expect((await storedGraph(page)).sources.some((source) => source.id === 'adobe-alias')).toBe(false);
});


test('Keyflow picker shortcuts are scoped, disabled actions stay unregistered, and background routes return', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await button(page, 'app settings').click();
  await button(page, 'add existing folder/file').click();
  const picker = page.getByRole('dialog', { name: 'add existing folder/file' });
  const observe = picker.getByRole('button', { name: 'observe selection', exact: true });
  await expect(observe).toBeDisabled();
  await expect(observe.locator('.pending_route')).toHaveCount(0);
  await expect(button(page, 'close app settings').locator('.pending_route')).toHaveCount(0);
  const browse = picker.getByRole('button', { name: 'browse location…', exact: true });
  await expect(browse.locator('.pending_route')).not.toHaveText('');
  for (const key of (await browse.locator('.pending_route').innerText()).trim()) await page.keyboard.press(key);
  await expect(picker.getByRole('checkbox', { name: 'Select Documents folder', exact: true })).toBeVisible();
  const cancel = picker.getByRole('button', { name: 'cancel', exact: true });
  await cancel.scrollIntoViewIfNeeded();
  await expect(cancel.locator('.pending_route')).not.toHaveText('');
  for (const key of (await cancel.locator('.pending_route').innerText()).trim()) await page.keyboard.press(key);
  await expect(picker).not.toBeVisible();
  await expect(button(page, 'close app settings').locator('.pending_route')).not.toHaveText('');
  expect(errors).toEqual([]);
});

test('Keyflow drawing buttons retain accessible toggle states and keyboard actions', async ({ page }) => {
  await button(page, 'app settings').click();
  await button(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('keyflow-drawing');
  await button(page, 'create svg file').click();
  await button(page, 'open').click();
  const toolbar = page.getByRole('group', { name: 'Drawing toolbar' });
  const brush = toolbar.getByRole('button', { name: 'Brush', exact: true });
  const eraser = toolbar.getByRole('button', { name: 'Eraser', exact: true });
  await expect(brush).toHaveAttribute('aria-pressed', 'true');
  await expect(eraser).toHaveAttribute('aria-pressed', 'false');
  await expect(eraser.locator('.pending_route')).not.toHaveText('');
  for (const key of (await eraser.locator('.pending_route').innerText()).trim()) await page.keyboard.press(key);
  await expect(brush).toHaveAttribute('aria-pressed', 'false');
  await expect(eraser).toHaveAttribute('aria-pressed', 'true');
  await expect(toolbar.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});
