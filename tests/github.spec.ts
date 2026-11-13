import { createHash } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { serializeDrawing } from '../src/lib/drawing';
import { zipSync, strToU8 } from 'fflate';

const api = 'https://api.github.com/repos/example/notebook';
const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
const editor = (page: Page, file: string) => page.getByRole('textbox', { name: `Edit ${file}`, exact: true });
const exit = (page: Page, group = 'Editor toolbar') => page.getByRole('group', { name: group }).getByRole('button', { name: 'Exit', exact: true });
const syncProgress = (page: Page) => page.getByRole('progressbar', { name: 'Syncing to GitHub' });
const sha = (buffer: Buffer) => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
const binaryImage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
type FixtureFiles = Record<string, string | Buffer | null>;

async function github(page: Page, initial: FixtureFiles) {
  type Tree = Map<string, string>;
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Tree>();
  const commits = new Map<string, { tree: string; parent?: string; message: string }>();
  const messages: string[] = [];
  const requests: string[] = [];
  let sequence = 0;
  let head: string;
  let advanceOnPush: FixtureFiles | undefined;
  let refuseWrites = false;
  let loseResponse = false;
  let pause: { arrived: () => void; release: Promise<void> } | undefined;
  let token = 'test-token';

  function blob(content: Buffer) { const id = sha(content); blobs.set(id, content); return id; }
  function tree(files: Tree) { const id = `tree-${++sequence}`; trees.set(id, files); return id; }
  function commit(tree: string, message: string, parent?: string) {
    const id = `commit-${++sequence}`;
    commits.set(id, { tree, parent, message });
    return id;
  }
  const files = () => trees.get(commits.get(head)!.tree)!;
  function upstream(changes: FixtureFiles) {
    const next = new Map(head ? files() : undefined);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) next.delete(path);
      else next.set(path, blob(typeof content === 'string' ? Buffer.from(content) : content));
    }
    head = commit(tree(next), 'external edit', head);
  }
  upstream(initial);

  await page.route(/^https:\/\/api\.github\.com\/(?:repos\/example\/notebook(?:[/?]|$)|graphql$)/, async (route) => {
    const request = route.request();
    const path = request.url().startsWith(api) ? request.url().slice(api.length).split('?')[0] : '/graphql';
    const method = request.method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
    } });
    if (method === 'OPTIONS') return respond({});
    requests.push(`${method} ${path}`);
    expect(request.headers().authorization).toMatch(/^Bearer test-token/);
    if (request.headers().authorization !== `Bearer ${token}`) return respond({}, 401);
    if (method === 'GET' && !path) return respond({ default_branch: 'main', permissions: { push: true } });
    if (method === 'GET' && path === '/git/ref/heads/main') return respond({ object: { sha: head } });
    if (method === 'GET' && path.startsWith('/git/commits/')) {
      const value = commits.get(path.split('/').at(-1)!);
      return value ? respond({ tree: { sha: value.tree } }) : respond({}, 404);
    }
    if (method === 'GET' && path.startsWith('/git/trees/')) {
      const value = trees.get(path.split('/').at(-1)!);
      return value ? respond({ truncated: false, tree: [...value].map(([path, sha]) => ({
        path, sha, type: 'blob', mode: '100644', size: blobs.get(sha)!.length
      })) }) : respond({}, 404);
    }
    if (method === 'GET' && path.startsWith('/git/blobs/')) {
      const value = blobs.get(path.split('/').at(-1)!);
      return value ? respond({ content: value.toString('base64'), encoding: 'base64' }) : respond({}, 404);
    }
    if (refuseWrites) return respond({}, 403);
    if (method === 'POST' && path === '/graphql') {
      if (pause) {
        const waiting = pause;
        pause = undefined;
        waiting.arrived();
        await waiting.release;
      }
      if (advanceOnPush) { upstream(advanceOnPush); advanceOnPush = undefined; }
      const { branch, expectedHeadOid, message, fileChanges } = request.postDataJSON().variables.input;
      expect(branch).toEqual({ repositoryNameWithOwner: 'example/notebook', branchName: 'main' });
      if (expectedHeadOid !== head) return respond({ data: { createCommitOnBranch: null }, errors: [{ type: 'STALE_DATA' }] });
      const next = new Map(files());
      for (const { path, contents } of fileChanges.additions) next.set(path, blob(Buffer.from(contents, 'base64')));
      const treeId = tree(next);
      head = commit(treeId, message.headline, head); messages.push(message.headline);
      if (loseResponse) { loseResponse = false; return route.abort('failed'); }
      return respond({ data: { createCommitOnBranch: { commit: { oid: head, tree: { oid: treeId } } } } });
    }
    if (method === 'POST' && path === '/git/blobs') {
      const body = request.postDataJSON();
      return respond({ sha: blob(Buffer.from(body.content, 'base64')) }, 201);
    }
    if (method === 'POST' && path === '/git/trees') {
      const body = request.postDataJSON();
      const base = trees.get(body.base_tree);
      expect(base).toBeDefined();
      const next = new Map(base);
      for (const { path, sha } of body.tree) if (sha === null) next.delete(path); else next.set(path, sha);
      return respond({ sha: tree(next) }, 201);
    }
    if (method === 'POST' && path === '/git/commits') {
      const { tree, message, parents } = request.postDataJSON();
      return respond({ sha: commit(tree, message, parents[0]) }, 201);
    }
    if (method === 'PATCH' && path === '/git/refs/heads/main') {
      if (advanceOnPush) { upstream(advanceOnPush); advanceOnPush = undefined; }
      const body = request.postDataJSON();
      const next = commits.get(body.sha)!;
      expect(body.force).toBe(false);
      if (next.parent !== head) return respond({}, 422);
      head = body.sha; messages.push(next.message);
      return respond({ object: { sha: head } });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${path}`);
  });

  return {
    upstream, messages, requests,
    holdPublish() {
      let arrived!: () => void, resume!: () => void;
      const started = new Promise<void>((resolve) => { arrived = resolve; });
      pause = { arrived, release: new Promise<void>((resolve) => { resume = resolve; }) };
      return { started, resume };
    },
    loseResponse() { loseResponse = true; },
    advance(changes: FixtureFiles) { advanceOnPush = changes; },
    refuse(value: boolean) { refuseWrites = value; },
    rotateToken(value: string) { token = value; },
    bytes(path: string) { const value = files().get(path); return value && blobs.get(value); },
    content(path: string) { const value = files().get(path); return value && blobs.get(value)?.toString(); }
  };
}

async function pressShortcut(page: Page, button: Locator) {
  const route = button.locator('.pending_route');
  await expect(route).not.toHaveText('');
  for (const key of (await route.innerText()).trim()) await page.keyboard.press(key);
}

async function connect(page: Page, keyboard = false) {
  await page.goto('/');
  await action(page, 'app settings').click();
  await action(page, 'GitHub repositories').click();
  await page.getByLabel('Repository', { exact: true }).fill('https://github.com/example/notebook');
  const token = page.getByLabel('Personal access token', { exact: true });
  const connect = page.getByRole('button', { name: 'Connect repository', exact: true });
  await token.fill('test-token');
  if (keyboard) {
    await token.press('Tab');
    await expect(connect).toBeFocused();
    await pressShortcut(page, connect);
  } else await connect.click();
  await expect(action(page, 'notebook/')).toBeEnabled();
  await action(page, 'notebook/').click();
}

async function openNote(page: Page, name = 'note.txt') {
  await action(page, name).click();
  await action(page, 'open').click();
}

test('setup instructions fit a narrow screen and GitHub form actions have keyboard shortcuts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page, true);
  await action(page, 'home').click();
  await action(page, 'app settings').click();
  await action(page, 'GitHub repositories').click();
  const list = page.getByRole('region', { name: 'GitHub repositories' }).getByRole('list');
  await expect(list).toContainText('Add permissions, select Contents');
  expect(await list.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    const start = list.firstElementChild!.getBoundingClientRect().left;
    return bounds.left >= 0 && bounds.right <= innerWidth && start - bounds.left >= 2 * parseFloat(getComputedStyle(list).fontSize) &&
      list.scrollWidth <= list.clientWidth;
  })).toBe(true);

  repo.rotateToken('test-token-settings');
  await page.getByRole('button', { name: 'Update token', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Reconnect GitHub' });
  const token = dialog.getByLabel('New personal access token');
  const save = dialog.getByRole('button', { name: 'Save token' });
  await token.fill('test-token-settings');
  await token.press('Tab');
  await expect(save).toBeFocused();
  await pressShortcut(page, save);
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(action(page, 'notebook/')).toBeEnabled();
  await expect(page.getByText(/GitHub token is missing/)).toHaveCount(0);
});

test('an expired token can be replaced from the error without losing the open draft', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  await editor(page, 'note.txt').fill('Unpublished edit');
  repo.rotateToken('test-token-renewed');
  await exit(page).click();
  const notice = page.locator('.notice').filter({ hasText: 'The GitHub token is missing, expired, or was rejected.' });
  const reconnect = notice.getByRole('button', { name: 'Reconnect GitHub' });
  await expect(reconnect).toBeVisible();
  await reconnect.focus();
  await pressShortcut(page, reconnect);
  const dialog = page.getByRole('dialog', { name: 'Reconnect GitHub' });
  await expect(dialog).toContainText('example/notebook · main');
  const token = dialog.getByLabel('New personal access token');
  await token.fill('test-token-renewed');
  await token.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(action(page, 'open')).toBeVisible();
  await page.getByRole('button', { name: 'Retry GitHub sync', exact: true }).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
  await expect.poll(() => repo.content('note.txt')).toBe('Unpublished edit');

  repo.rotateToken('test-token-startup');
  await page.reload();
  await expect(reconnect).toBeVisible();
  await reconnect.click();
  await expect(dialog.getByLabel('New personal access token')).toBeFocused();
});

test('repository syncs on startup and Exit commits only the edit onto the latest branch', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notework:autosave-seconds', '1'));
  const repo = await github(page, { 'note.txt': 'Original', 'notes/old.txt': 'Old note', 'image.bin': binaryImage });
  await connect(page);
  await expect(action(page, 'notes/')).toBeVisible();
  await expect(action(page, 'image.bin')).toHaveCount(0);
  await openNote(page);
  await expect(editor(page, 'note.txt')).toHaveText('Original');
  await editor(page, 'note.txt').fill('First edit\n');
  await expect(page.getByText('draft saved in this browser', { exact: false })).toBeVisible();
  await expect.poll(() => repo.messages).toEqual([]);
  repo.advance({ 'notes/new.txt': 'New upstream file' });
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
  await expect.poll(() => repo.content('note.txt')).toBe('First edit\n');
  await expect.poll(() => repo.content('notes/new.txt')).toBe('New upstream file');

  repo.upstream({ 'note.txt': 'Updated outside Notework', 'fresh.txt': 'Discovered on startup' });
  await page.reload();
  await action(page, 'notebook/').click();
  await expect(action(page, 'fresh.txt')).toBeVisible();
  await openNote(page);
  await expect(editor(page, 'note.txt')).toHaveText('Updated outside Notework');
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
});

test('reopening a GitHub folder lists newly added text files without an app reload', async ({ page }) => {
  const folder = 'output.creation/project/viet';
  const repo = await github(page, { [`${folder}/viet.keyboard`]: 'existing text' });
  await connect(page);
  await action(page, 'output.creation/').click();
  await action(page, 'project/').click();
  await action(page, 'viet/').click();
  await expect(action(page, 'viet.keyboard')).toBeVisible();
  await expect(action(page, 'viet.phonetic.basis')).toHaveCount(0);
  await action(page, '..').click();
  repo.upstream({ [`${folder}/viet.phonetic.basis`]: 'Cơ sở ngữ âm tiếng Việt\n', [`${folder}/image.bin`]: binaryImage });
  await action(page, 'viet/').click();
  await expect(action(page, 'viet.phonetic.basis')).toBeVisible();
  await expect(action(page, 'image.bin')).toHaveCount(0);
  await openNote(page, 'viet.phonetic.basis');
  await expect(editor(page, 'viet.phonetic.basis')).toContainText('Cơ sở ngữ âm tiếng Việt');
  await expect.poll(() => repo.messages).toEqual([]);
});

test('Vietnamese and Unicode controls survive autosave, Exit, and reopening the GitHub file', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notework:autosave-seconds', '1'));
  const name = 'viet.phonetic.basis';
  const repo = await github(page, { [name]: 'Original' });
  const input = 'Cơ sở ngữ âm tiếng Việt\n' + 'tiếng Việt'.normalize('NFD') + '\u200b \u{1f5e3}\u001b\u000c\u007f\u0000';
  await connect(page);
  await openNote(page, name);
  await editor(page, name).press('ControlOrMeta+a');
  await page.keyboard.insertText(input);
  await expect(page.getByText(/draft saved in this browser/)).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content(name)).toBe(input);
  await expect.poll(() => repo.messages).toEqual([`edit: ${name}`]);

  await page.reload();
  await action(page, 'notebook/').click();
  await openNote(page, name);
  await expect(editor(page, name)).toContainText('Cơ sở ngữ âm tiếng Việt');
});

test('name search across a GitHub tree reads only matching blobs and normalizes Unicode', async ({ page }) => {
  const name = 'Việt.phonetic.basis';
  const unrelated = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`archive/${i}.txt`, `archive note ${i}`]));
  const repo = await github(page, { ...unrelated, [`project/${name}`]: 'Cơ sở ngữ âm', 'project/Việt.png': binaryImage });
  await connect(page);
  await action(page, 'home').click();
  await expect(action(page, 'app settings')).toBeVisible();
  repo.requests.length = 0;
  await action(page, 'search').click();
  await page.getByRole('searchbox').fill('VIỆT'.normalize('NFD'));
  await expect(page.locator('.search-status')).toHaveText('2 results found');
  await expect(page.locator('.search-result-row').getByRole('button', { name: new RegExp(name) })).toBeVisible();
  expect(repo.requests.filter((request) => request.startsWith('GET /git/blobs/'))).toEqual([
    `GET /git/blobs/${sha(Buffer.from('Cơ sở ngữ âm'))}`
  ]);
});

test('same-file branch race opens two editable versions and publishes the selected variant', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  await editor(page, 'note.txt').fill('My version');
  repo.advance({ 'note.txt': 'Upstream version' });
  await exit(page).click();
  await page.getByRole('button', { name: 'Review GitHub conflict', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  const local = dialog.getByRole('textbox', { name: 'Your version' });
  const remote = dialog.getByRole('textbox', { name: 'GitHub version' });
  await expect(local).toHaveValue('My version');
  await expect(remote).toHaveValue('Upstream version');
  await local.fill('Edited local option');
  await remote.fill('Edited upstream option');
  await expect.poll(() => repo.content('note.txt')).toBe('Upstream version');
  await dialog.getByRole('button', { name: 'Keep GitHub version', exact: true }).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content('note.txt')).toBe('Edited upstream option');
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
});

async function drawVersion(page: Page, canvas: Locator) {
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 75, { steps: 4 }); await page.mouse.up();
}

async function conflictImages(page: Page, format: string) {
  await page.goto('/');
  const images = await page.evaluate(async (format) => {
    const result = [];
    for (const color of ['#ff0000', '#0000ff']) {
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 600;
      const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, 800, 600);
      const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), format === 'jpeg' ? 'image/jpeg' : 'image/png'));
      result.push(Array.from(new Uint8Array(await blob.arrayBuffer())));
    }
    return result;
  }, format);
  return images.map((bytes) => format === 'ora' ? Buffer.from(zipSync({
    mimetype: strToU8('image/openraster'),
    'stack.xml': strToU8('<image w="800" h="600"><stack><layer name="Color" src="data/color.png"/></stack></image>'),
    'data/color.png': new Uint8Array(bytes)
  })) : Buffer.from(bytes));
}

for (const format of ['png', 'jpeg', 'ora']) {
  test(`${format} conflicts show both image editors and publish edits to the chosen image`, async ({ page }) => {
    const name = `picture.${format}`;
    const [original, upstream] = await conflictImages(page, format);
    const repo = await github(page, { [name]: original });
    await connect(page); await openNote(page, name);
    await drawVersion(page, page.getByRole('img', { name: `Drawing canvas for ${name}` }));
    repo.advance({ [name]: upstream });
    await exit(page, 'Drawing toolbar').click();
    await page.getByRole('button', { name: 'Review GitHub conflict', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
    const local = dialog.getByRole('region', { name: 'Your version', exact: true });
    const remote = dialog.getByRole('region', { name: 'GitHub version', exact: true });
    const localCanvas = local.getByRole('img', { name: `Drawing canvas for ${name}` });
    const remoteCanvas = remote.getByRole('img', { name: `Drawing canvas for ${name}` });
    await expect(localCanvas).toBeVisible(); await expect(remoteCanvas).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    for (const [side, color] of [[localCanvas, [255, 0, 0, 255]], [remoteCanvas, [0, 0, 255, 255]]] as const) {
      const pixel = await side.locator('image').first().evaluate(async (image) => {
        const blob = await (await fetch(image.getAttribute('href')!)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
        return Array.from(context.getImageData(790, 590, 1, 1).data);
      });
      // JPEG encoding may round the color channel by one.
      pixel.forEach((channel, index) => expect(Math.abs(channel - color[index])).toBeLessThanOrEqual(1));
    }
    if (format === 'ora') {
      await remote.getByRole('button', { name: 'Add layer', exact: true }).click();
      await expect(remote.getByLabel('active layer').locator('option')).toHaveCount(2);
      await expect(local.getByLabel('active layer').locator('option')).toHaveCount(1);
    }
    await drawVersion(page, remoteCanvas);
    await remoteCanvas.press('ControlOrMeta+z');
    await expect(remoteCanvas.locator('polyline')).toHaveCount(0);
    await remoteCanvas.press('ControlOrMeta+Shift+z');
    await expect(remoteCanvas.locator('polyline')).toHaveCount(1);
    // Keeping a version must flush the unsaved strokes without an extra Save action.
    await remote.getByRole('button', { name: 'Keep GitHub version', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => repo.messages).toEqual([`edit: ${name}`]);
    expect(repo.bytes(name)).not.toEqual(upstream);
    await action(page, 'open').click();
    await expect(page.getByRole('img', { name: `Drawing canvas for ${name}` })).toBeVisible();
    if (format === 'ora') await expect(page.getByLabel('active layer').locator('option')).toHaveCount(2);
  });
}

test('cancel discards conflict image edits and keeping an untouched image preserves its original bytes', async ({ page }) => {
  const name = 'picture.png';
  const [original, upstream] = await conflictImages(page, 'png');
  const repo = await github(page, { [name]: original });
  await connect(page); await openNote(page, name);
  await drawVersion(page, page.getByRole('img', { name: `Drawing canvas for ${name}` }));
  repo.advance({ [name]: upstream });
  await exit(page, 'Drawing toolbar').click();
  const review = page.getByRole('button', { name: 'Review GitHub conflict', exact: true });
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  const remote = dialog.getByRole('region', { name: 'GitHub version', exact: true });
  await drawVersion(page, remote.getByRole('img'));
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(repo.bytes(name)).toEqual(upstream);
  await review.click();
  await expect(remote.getByRole('img')).toBeVisible();
  await expect(remote.locator('polyline')).toHaveCount(0);
  await remote.getByRole('button', { name: 'Keep GitHub version', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.sync-progress')).toHaveCount(0);
  expect(repo.bytes(name)).toEqual(upstream);
  expect(repo.messages).toEqual([]);
});

test('SVG drawing conflicts use drawing editors and keep the selected edited strokes', async ({ page }) => {
  const name = 'ink.svg';
  const repo = await github(page, { [name]: serializeDrawing([]) });
  await connect(page); await openNote(page, name);
  await drawVersion(page, page.getByRole('img', { name: `Drawing canvas for ${name}` }));
  repo.advance({ [name]: serializeDrawing([[[500, 300], [600, 350]]]) });
  await exit(page, 'Drawing toolbar').click();
  await page.getByRole('button', { name: 'Review GitHub conflict', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  const local = dialog.getByRole('region', { name: 'Your version', exact: true });
  const remote = dialog.getByRole('region', { name: 'GitHub version', exact: true });
  await expect(local.getByRole('img')).toBeVisible();
  await expect(remote.locator('polyline')).toHaveAttribute('points', '500,300 600,350');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await drawVersion(page, local.getByRole('img'));
  await local.getByRole('button', { name: 'Keep your version', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => repo.messages).toEqual([`edit: ${name}`]);
  expect(repo.content(name)?.match(/<polyline/g)).toHaveLength(2);
});

test('repeated saves keep a recoverable draft; Exit shows progress and publishes it once', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notework:autosave-seconds', '60'));
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  const text = editor(page, 'note.txt');
  await text.fill('First snapshot');
  repo.requests.length = 0;
  await text.press('Control+s');
  const draft = page.getByText(/draft saved in this browser/);
  await expect(draft).toBeVisible();
  await text.fill('First snapshot plus later edits');
  await text.press('Meta+s');
  await expect(draft).toBeVisible();
  await expect(syncProgress(page)).toHaveCount(0);
  expect(repo.requests).toEqual([]);
  await expect.poll(() => repo.messages).toEqual([]);

  await page.reload();
  await action(page, 'notebook/').click();
  await openNote(page);
  await expect(text).toHaveText('First snapshot plus later edits');
  const held = repo.holdPublish();
  await exit(page).click();
  try {
    await held.started;
    await expect(syncProgress(page)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'in the background' })).toBeVisible();
    const bar = (await syncProgress(page).boundingBox())!;
    expect(bar.y + bar.height).toBeGreaterThan(page.viewportSize()!.height - 20);
    expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
    await expect(action(page, 'open')).toBeVisible();
    await action(page, 'home').click();
    await expect(action(page, 'notebook/')).toBeVisible();
    await action(page, 'notebook/').click();
    await action(page, 'note.txt').click();
    await expect.poll(() => repo.content('note.txt')).toBe('Original');
  } finally { held.resume(); }
  await expect(action(page, 'open')).toBeVisible();
  await expect(syncProgress(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.dispatchEvent(new Event('beforeunload', { cancelable: true })))).toBe(true);
  await expect.poll(() => repo.content('note.txt')).toBe('First snapshot plus later edits');
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
});

test('Vim :w saves a browser draft without publishing', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('notework:vim-mode', 'true');
    localStorage.setItem('notework:autosave-seconds', '60');
  });
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  await expect(editor(page, 'note.txt')).toBeFocused();
  await page.keyboard.press('A');
  await page.keyboard.insertText(' plus Vim edits');
  await page.keyboard.press('Escape');
  await page.keyboard.type(':w');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/draft saved in this browser/)).toBeVisible();
  await expect.poll(() => repo.messages).toEqual([]);
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content('note.txt')).toBe('Original plus Vim edits');
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
});

test('retry after an unconfirmed GitHub response does not duplicate the commit', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  const text = editor(page, 'note.txt');
  await text.fill('Published once');
  repo.loseResponse();
  await exit(page).click();
  await expect(page.locator('.sync-progress')).toContainText('GitHub did not confirm');
  await expect(syncProgress(page)).toHaveCount(0);
  await expect(action(page, 'open')).toBeVisible();
  await page.getByRole('button', { name: 'Retry GitHub sync', exact: true }).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content('note.txt')).toBe('Published once');
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
});

test('drawing saves stay local until Exit publishes all strokes in one commit', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('notework:autosave-seconds', '60'));
  const repo = await github(page, { 'ink.svg': serializeDrawing([]) });
  await connect(page);
  await openNote(page, 'ink.svg');
  const canvas = page.getByRole('img', { name: 'Drawing canvas for ink.svg' });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  async function stroke(offset: number) {
    await page.mouse.move(box.x + 25, box.y + offset); await page.mouse.down();
    await page.mouse.move(box.x + 90, box.y + offset + 20, { steps: 4 }); await page.mouse.up();
  }
  await stroke(25);
  await page.keyboard.press('Control+s');
  const draft = page.getByText(/drawing draft saved in this browser/);
  await expect(draft).toBeVisible();
  await stroke(75);
  await page.keyboard.press('Control+s');
  await expect(draft).toBeVisible();
  await expect.poll(() => repo.messages).toEqual([]);
  const held = repo.holdPublish();
  await exit(page, 'Drawing toolbar').click();
  try {
    await held.started;
    await expect(syncProgress(page)).toBeVisible();
    await expect(action(page, 'open')).toBeVisible();
    await expect(canvas).toHaveCount(0);
  } finally { held.resume(); }
  await expect(action(page, 'open')).toBeVisible();
  await expect(syncProgress(page)).toHaveCount(0);
  await expect.poll(() => repo.messages).toEqual(['edit: ink.svg']);
  await expect.poll(() => repo.content('ink.svg')?.match(/<polyline/g)).toHaveLength(2);
});

test('exiting an inline drawing publishes the asset while the note stays in editing mode', async ({ page }) => {
  const original = '\\svgpage[ink.svg]\nText below';
  const repo = await github(page, { 'note.txt': original, 'ink.svg': serializeDrawing([]) });
  await connect(page);
  await openNote(page);
  const note = editor(page, 'note.txt');
  await note.press('ControlOrMeta+End');
  await page.keyboard.insertText(' with edits');
  await page.getByRole('button', { name: 'Edit drawing ink.svg' }).click();
  const canvas = page.getByRole('img', { name: 'Drawing canvas for ink.svg' });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 75, { steps: 4 }); await page.mouse.up();
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/drawing draft saved in this browser/)).toBeVisible();
  await expect.poll(() => repo.messages).toEqual([]);
  await exit(page, 'Drawing toolbar').click();
  await expect(note).toBeEditable();
  await expect.poll(() => repo.messages).toEqual(['edit: ink.svg']);
  await expect.poll(() => repo.content('ink.svg')).toContain('<polyline');
  await expect.poll(() => repo.content('note.txt')).toBe(original);
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content('note.txt')).toBe(original + ' with edits');
  await expect.poll(() => repo.messages).toEqual(['edit: ink.svg', 'edit: note.txt']);
});

test('failed writes retain the draft across reload and accept an upstream deletion without recreating it', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  await editor(page, 'note.txt').fill('Unpublished work');
  repo.refuse(true);
  await exit(page).click();
  await expect(page.locator('.sync-progress')).toContainText('GitHub refused access');
  await expect.poll(() => repo.content('note.txt')).toBe('Original');
  repo.upstream({ 'note.txt': null });
  repo.refuse(false);

  await page.reload();
  await expect(action(page, 'notebook/')).toBeVisible();
  await page.getByRole('button', { name: 'Review GitHub conflict', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  await expect(dialog.getByText('This file was deleted on GitHub.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(action(page, 'notebook/')).toBeVisible();
  await page.getByRole('button', { name: 'Review GitHub conflict', exact: true }).click();
  await dialog.getByRole('button', { name: 'Keep GitHub deletion' }).click();
  await expect(action(page, 'notebook/')).toBeVisible();
  await expect.poll(() => repo.content('note.txt')).toBeUndefined();
  await expect.poll(() => repo.messages).toEqual([]);
});

test('keeping an unreadable GitHub version hides the file without removing its graph links', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original', 'linked.txt': 'Linked' });
  await connect(page);
  await openNote(page);
  await editor(page, 'note.txt').fill('[[linked.txt]]');
  await exit(page).click();
  await expect(action(page, 'linked.txt')).toBeVisible();

  await action(page, 'open').click();
  await editor(page, 'note.txt').fill('Local edit');
  repo.upstream({ 'note.txt': binaryImage });
  await exit(page).click();
  await page.getByRole('button', { name: 'Review GitHub conflict', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: 'GitHub conflict' });
  await expect(conflict.getByText('The GitHub version cannot be edited as text.')).toBeVisible();
  await conflict.getByRole('button', { name: 'Keep GitHub version' }).click();
  await expect(page.locator('.sync-progress')).toHaveCount(0);
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
  await action(page, 'notebook/').click();
  await expect(action(page, 'linked.txt')).toBeVisible();
  await expect(action(page, 'note.txt')).toHaveCount(0);

  repo.upstream({ 'note.txt': 'Readable again' });
  await page.reload();
  await action(page, 'notebook/').click();
  await action(page, 'note.txt').click();
  await expect(page.getByRole('heading', { name: 'note.txt', exact: true })).toBeVisible();
  await expect(action(page, 'linked.txt')).toBeVisible();
});

test('page folder creation publishes its main text file to GitHub in one commit', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Existing note' });
  await connect(page);
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('math.2999');
  await action(page, 'create page folder').click();
  await expect(page.getByRole('heading', { name: 'math.2999/', exact: true })).toBeVisible();
  await expect(action(page, 'math.2999.main')).toBeVisible();
  await expect.poll(() => repo.content('math.2999/math.2999.main')).toBe('');
  expect(repo.messages).toEqual(['create: math.2999']);
  await action(page, 'open').click();
  await expect(editor(page, 'math.2999.main')).toBeFocused();
  await expect(editor(page, 'math.2999.main')).toHaveText('');
});

test('normal folder actions and drawing editing publish to GitHub', async ({ page }) => {
  const repo = await github(page, { 'ink.svg': serializeDrawing([]) });
  await connect(page);
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('Sketches');
  await action(page, 'create folder').click();
  await expect(page.getByRole('heading', { name: 'Sketches/', exact: true })).toBeVisible();
  await action(page, 'create new file/folder').click();
  await page.getByLabel('name', { exact: true }).fill('idea.txt');
  await action(page, 'create text file').click();
  await action(page, 'configure file').click();
  await action(page, 'rename').click();
  const rename = page.getByRole('dialog', { name: 'Rename file' });
  await rename.getByRole('textbox').fill('renamed.txt');
  await rename.getByRole('button', { name: 'Rename and update links' }).click();
  await expect(page.getByRole('heading', { name: 'renamed.txt', exact: true })).toBeVisible();
  await expect.poll(() => repo.content('Sketches/idea.txt')).toBeUndefined();
  await expect.poll(() => repo.content('Sketches/renamed.txt')).toBe('');
  await action(page, 'delete this file').click();
  await page.getByRole('dialog', { name: 'Delete renamed.txt?' }).getByRole('button', { name: 'Delete file' }).click();
  await expect(page.getByRole('heading', { name: 'Sketches/', exact: true })).toBeVisible();
  await expect.poll(() => repo.content('Sketches/renamed.txt')).toBeUndefined();
  await action(page, '..').click();
  await openNote(page, 'ink.svg');
  const canvas = page.getByRole('img', { name: 'Drawing canvas for ink.svg' });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 75, { steps: 6 }); await page.mouse.up();
  await exit(page, 'Drawing toolbar').click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content('ink.svg')).toContain('<polyline');
  await expect.poll(() => repo.messages.at(-1)).toBe('edit: ink.svg');
});

test('a note and the new files it references publish in one commit', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Start' });
  await connect(page);
  await openNote(page);
  const draft = '[[sibling.txt]]\n\\svgpage[ink.svg]';
  await editor(page, 'note.txt').fill(draft);
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.messages).toEqual(['edit: note.txt']);
  await expect.poll(() => repo.content('note.txt')).toBe(draft);
  await expect.poll(() => repo.content('sibling.txt')).toBe('');
  await expect.poll(() => repo.content('ink.svg')).toBe(serializeDrawing([]));
  await expect(action(page, 'sibling.txt')).toBeVisible();
  await expect(action(page, 'ink.svg')).toBeVisible();
});

test('relocating a GitHub note to Home preserves the file before deleting the remote original', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Keep this content' });
  await connect(page);
  await action(page, 'note.txt').click();
  await action(page, 'configure file').click();
  await action(page, 'relocate this file').click();
  await action(page, 'home').click();
  await page.getByRole('region', { name: 'current state' }).locator('[data-action="choose"] button').click();
  const confirm = page.getByRole('dialog', { name: 'Relocate file to browser storage?' });
  await confirm.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect.poll(() => repo.content('note.txt')).toBeUndefined();
  await expect.poll(() => repo.messages).toEqual(['move: note.txt']);
  await action(page, 'open').click();
  await expect(editor(page, 'note.txt')).toHaveText('Keep this content');
});


test('queued Exit sync resumes after reload without reopening the draft', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page); await openNote(page);
  await editor(page, 'note.txt').fill('Resume this snapshot');
  repo.refuse(true);
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry GitHub sync', exact: true })).toBeVisible();
  repo.refuse(false);
  await page.reload();
  await expect.poll(() => repo.content('note.txt')).toBe('Resume this snapshot');
  await expect(page.locator('.sync-progress')).toHaveCount(0);
  expect(repo.messages).toEqual(['edit: note.txt']);
});

test('a newer autosave survives publication of the earlier Exit snapshot', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page); await openNote(page);
  await editor(page, 'note.txt').fill('First snapshot');
  const held = repo.holdPublish();
  await exit(page).click();
  try {
    await held.started;
    await expect(action(page, 'open')).toBeVisible();
    await action(page, 'open').click();
    await editor(page, 'note.txt').fill('Newer autosave');
    await editor(page, 'note.txt').press('Control+s');
    await expect(page.getByText('draft saved in this browser · Exit to sync to GitHub', { exact: true })).toBeVisible();
  } finally { held.resume(); }
  await expect.poll(() => repo.content('note.txt')).toBe('First snapshot');
  await expect(syncProgress(page)).toHaveCount(0);
  await expect(editor(page, 'note.txt')).toHaveText('Newer autosave');
  await exit(page).click();
  await expect.poll(() => repo.content('note.txt')).toBe('Newer autosave');
  expect(repo.messages).toEqual(['edit: note.txt', 'edit: note.txt']);
  await expect(page.getByRole('button', { name: 'Review GitHub conflict', exact: true })).toHaveCount(0);
});


test('choosing upstream during conflict review preserves a newer draft’s original base', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page); await openNote(page);
  await editor(page, 'note.txt').fill('First local snapshot');
  repo.upstream({ 'note.txt': 'Chosen upstream' });
  await exit(page).click();
  const review = page.getByRole('button', { name: 'Review GitHub conflict', exact: true });
  await expect(review).toBeVisible();
  await action(page, 'open').click();
  await editor(page, 'note.txt').fill('Newer local draft');
  await editor(page, 'note.txt').press('Control+s');
  await expect(page.getByText('draft saved in this browser · Exit to sync to GitHub', { exact: true })).toBeVisible();
  await review.click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  await dialog.getByRole('button', { name: 'Keep GitHub version', exact: true }).click();
  await expect(page.locator('.sync-progress')).toHaveCount(0);
  await expect(editor(page, 'note.txt')).toHaveText('Newer local draft');
  await exit(page).click();
  await expect(review).toBeVisible();
  expect(repo.content('note.txt')).toBe('Chosen upstream');
  await review.click();
  await expect(dialog.getByRole('textbox', { name: 'Your version' })).toHaveValue('Newer local draft');
  await dialog.getByRole('button', { name: 'Keep your version', exact: true }).click();
  await expect.poll(() => repo.content('note.txt')).toBe('Newer local draft');
});
