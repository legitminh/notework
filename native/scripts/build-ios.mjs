// Builds the iOS app. By default an unsigned simulator build, which needs no Apple team.
// Set NOTEWORK_IOS_DEVICE=1 for a signed device build (set APPLE_DEVELOPMENT_TEAM or a
// team in tauri.conf.json first).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const native = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: native, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const apple = fileURLToPath(new URL('../src-tauri/gen/apple/', import.meta.url));
if (!existsSync(apple)) run('pnpm', ['exec', 'tauri', 'ios', 'init', '--ci']);

// `tauri ios build` drives xcodebuild itself (Xcode's Rust build phase needs it running).
// A simulator target builds an .app without signing; a device build needs a team.
const device = process.env.NOTEWORK_IOS_DEVICE === '1';
run('pnpm', ['exec', 'tauri', 'ios', 'build', ...(device ? [] : ['--target', 'aarch64-sim'])]);
