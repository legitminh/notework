// Builds the iOS app. By default an unsigned simulator build with xcodebuild, which
// needs no Apple team. Set NOTEWORK_IOS_DEVICE=1 for a signed device build through
// `tauri ios build` (set APPLE_DEVELOPMENT_TEAM or a team in tauri.conf.json first).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const native = fileURLToPath(new URL('..', import.meta.url));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: native, stdio: 'inherit', ...options });
  if (result.status !== 0) process.exit(result.status ?? 1);
};
const apple = fileURLToPath(new URL('../src-tauri/gen/apple/', import.meta.url));
if (!existsSync(apple)) run('pnpm', ['exec', 'tauri', 'ios', 'init', '--ci']);

if (process.env.NOTEWORK_IOS_DEVICE === '1') {
  run('pnpm', ['exec', 'tauri', 'ios', 'build']);
} else {
  run('node', ['scripts/build-web.mjs']);
  const project = readdirSync(apple).find((name) => name.endsWith('.xcodeproj'));
  if (!project) throw new Error('no Xcode project in src-tauri/gen/apple');
  const scheme = `${project.replace(/\.xcodeproj$/, '')}_iOS`;
  run('xcodebuild', [
    '-project', project, '-scheme', scheme, '-configuration', 'Release',
    '-sdk', 'iphonesimulator', '-arch', 'arm64',
    '-derivedDataPath', fileURLToPath(new URL('../dist/ios', import.meta.url)),
    'CODE_SIGNING_ALLOWED=NO', 'build'
  ], { cwd: apple });
}
