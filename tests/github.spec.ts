import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { serializeDrawing } from '../src/lib/drawing';

const api = 'https://api.github.com/repos/example/notebook';
const action = (page: Page, name: string) => page.locator(`[data-action=${JSON.stringify(name)}] button`);
const editor = (page: Page, file: string) => page.getByRole('textbox', { name: `Edit ${file}`, exact: true });
const exit = (page: Page, group = 'Editor toolbar') => page.getByRole('group', { name: group }).getByRole('button', { name: 'Exit', exact: true });
const sha = (buffer: Buffer) => createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');

async function github(page: Page, initial: Record<string, string>) {
  type Tree = Map<string, string>;
  const blobs = new Map<string, Buffer>();
  const trees = new Map<string, Tree>();
  const commits = new Map<string, { tree: string; parent?: string; message: string }>();
  const messages: string[] = [];
  let sequence = 0;
  let head: string;
  let advanceOnPush: Record<string, string | null> | undefined;
  let refuseWrites = false;

  function blob(content: Buffer) { const id = sha(content); blobs.set(id, content); return id; }
  function tree(files: Tree) { const id = `tree-${++sequence}`; trees.set(id, files); return id; }
  function commit(tree: string, message: string, parent?: string) {
    const id = `commit-${++sequence}`;
    commits.set(id, { tree, parent, message });
    return id;
  }
  const files = () => trees.get(commits.get(head)!.tree)!;
  function upstream(changes: Record<string, string | null>) {
    const next = new Map(head ? files() : undefined);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) next.delete(path);
      else next.set(path, blob(Buffer.from(content)));
    }
    head = commit(tree(next), 'external edit', head);
  }
  upstream(initial);

  await page.route(`${api}**`, async (route) => {
    const request = route.request();
    const path = request.url().slice(api.length).split('?')[0];
    const method = request.method();
    const respond = (json: unknown, status = 200) => route.fulfill({ status, json, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GitHub-Api-Version',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS'
    } });
    if (method === 'OPTIONS') return respond({});
    expect(request.headers().authorization).toMatch(/^Bearer test-token/);
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
    upstream, messages,
    advance(changes: Record<string, string | null>) { advanceOnPush = changes; },
    refuse(value: boolean) { refuseWrites = value; },
    content(path: string) { const value = files().get(path); return value && blobs.get(value)?.toString(); }
  };
}

async function connect(page: Page) {
  await page.goto('/');
  await action(page, 'app settings').click();
  await action(page, 'GitHub repositories').click();
  await page.getByLabel('Repository', { exact: true }).fill('https://github.com/example/notebook');
  await page.getByLabel('Personal access token', { exact: true }).fill('test-token');
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await expect(action(page, 'notebook/')).toBeEnabled();
  await action(page, 'notebook/').click();
}

async function openNote(page: Page, name = 'note.txt') {
  await action(page, name).click();
  await action(page, 'open').click();
}

test('repository syncs on startup and Exit commits only the edit onto the latest branch', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original', 'notes/old.txt': 'Old note', 'image.bin': '\u0000hidden' });
  await connect(page);
  await expect(action(page, 'notes/')).toBeVisible();
  await expect(action(page, 'image.bin')).toHaveCount(0);
  await openNote(page);
  await expect(editor(page, 'note.txt')).toHaveText('Original');
  await editor(page, 'note.txt').fill('First edit\n');
  await expect(page.getByText('draft saved in this browser', { exact: false })).toBeVisible();
  expect(repo.messages).toEqual([]);
  repo.advance({ 'notes/new.txt': 'New upstream file' });
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  expect(repo.messages).toEqual(['edit: note.txt']);
  expect(repo.content('note.txt')).toBe('First edit\n');
  expect(repo.content('notes/new.txt')).toBe('New upstream file');

  repo.upstream({ 'note.txt': 'Updated outside Notework', 'fresh.txt': 'Discovered on startup' });
  await page.reload();
  await action(page, 'notebook/').click();
  await expect(action(page, 'fresh.txt')).toBeVisible();
  await openNote(page);
  await expect(editor(page, 'note.txt')).toHaveText('Updated outside Notework');
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  expect(repo.messages).toEqual(['edit: note.txt']);
});

test('same-file branch race opens two editable versions and publishes the selected variant', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  await editor(page, 'note.txt').fill('My version');
  repo.advance({ 'note.txt': 'Upstream version' });
  await exit(page).click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  const local = dialog.getByRole('textbox', { name: 'Your version' });
  const remote = dialog.getByRole('textbox', { name: 'GitHub version' });
  await expect(local).toHaveValue('My version');
  await expect(remote).toHaveValue('Upstream version');
  await local.fill('Edited local option');
  await remote.fill('Edited upstream option');
  expect(repo.content('note.txt')).toBe('Upstream version');
  await dialog.getByRole('button', { name: 'Keep GitHub version', exact: true }).click();
  await expect(action(page, 'open')).toBeVisible();
  expect(repo.content('note.txt')).toBe('Edited upstream option');
  expect(repo.messages).toEqual(['edit: note.txt']);
});

test('failed writes retain the draft across reload and accept an upstream deletion without recreating it', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Original' });
  await connect(page);
  await openNote(page);
  await editor(page, 'note.txt').fill('Unpublished work');
  repo.refuse(true);
  await exit(page).click();
  await expect(page.getByRole('alert')).toContainText('GitHub refused access');
  expect(repo.content('note.txt')).toBe('Original');
  repo.upstream({ 'note.txt': null });
  repo.refuse(false);

  await page.reload();
  await action(page, 'notebook/').click();
  await openNote(page);
  await expect(editor(page, 'note.txt')).toHaveText('Unpublished work');
  await exit(page).click();
  const dialog = page.getByRole('dialog', { name: 'GitHub conflict' });
  await expect(dialog.getByText('This file was deleted on GitHub.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page, 'note.txt')).toHaveText('Unpublished work');
  await exit(page).click();
  await dialog.getByRole('button', { name: 'Keep GitHub deletion' }).click();
  await expect(action(page, 'notebook/')).toBeVisible();
  expect(repo.content('note.txt')).toBeUndefined();
  expect(repo.messages).toEqual([]);
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
  expect(repo.content('Sketches/idea.txt')).toBeUndefined();
  expect(repo.content('Sketches/renamed.txt')).toBe('');
  await action(page, 'delete this file').click();
  await page.getByRole('dialog', { name: 'Delete renamed.txt?' }).getByRole('button', { name: 'Delete file' }).click();
  await expect(page.getByRole('heading', { name: 'Sketches/', exact: true })).toBeVisible();
  expect(repo.content('Sketches/renamed.txt')).toBeUndefined();
  await action(page, '..').click();
  await openNote(page, 'ink.svg');
  const canvas = page.getByRole('img', { name: 'Drawing canvas for ink.svg' });
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 25, box.y + 30); await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 75, { steps: 6 }); await page.mouse.up();
  await exit(page, 'Drawing toolbar').click();
  await expect(action(page, 'open')).toBeVisible();
  expect(repo.content('ink.svg')).toContain('<polyline');
  expect(repo.messages.at(-1)).toBe('edit: ink.svg');
});

test('a note and the new files it references publish in one commit', async ({ page }) => {
  const repo = await github(page, { 'note.txt': 'Start' });
  await connect(page);
  await openNote(page);
  const draft = '[[sibling.txt]]\n\\svgpage[ink.svg]';
  await editor(page, 'note.txt').fill(draft);
  await exit(page).click();
  await expect(action(page, 'open')).toBeVisible();
  expect(repo.messages).toEqual(['edit: note.txt']);
  expect(repo.content('note.txt')).toBe(draft);
  expect(repo.content('sibling.txt')).toBe('');
  expect(repo.content('ink.svg')).toBe(serializeDrawing([]));
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
  expect(repo.content('note.txt')).toBeUndefined();
  expect(repo.messages).toEqual(['move: note.txt']);
  await action(page, 'open').click();
  await expect(editor(page, 'note.txt')).toHaveText('Keep this content');
});
