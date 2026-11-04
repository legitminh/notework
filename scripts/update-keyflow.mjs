import { execFileSync } from 'node:child_process';

// Resolve upstream once and pin the exact revision in package.json and pnpm-lock.yaml.
const remote = execFileSync('git', ['ls-remote', 'https://github.com/legitminh/keyflow.git', 'HEAD'], { encoding: 'utf8' });
const commit = remote.trim().split(/\s+/)[0];
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Could not resolve the latest Keyflow commit.');
console.log(`Updating Keyflow to ${commit}`);
execFileSync('pnpm', ['add', '-w', `@legitminh/keyflow@github:legitminh/keyflow#${commit}`], { stdio: 'inherit' });
