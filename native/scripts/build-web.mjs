// Builds the unchanged web app (`pnpm build` in the repository root) that every native shell wraps.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.env.NOTEWORK_SKIP_WEB_BUILD === '1') {
  if (!existsSync(new URL('../../build/index.html', import.meta.url))) throw new Error('NOTEWORK_SKIP_WEB_BUILD is set but ../build/index.html is missing.');
  console.log('using the existing web build in ../build');
} else {
  const result = spawnSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
