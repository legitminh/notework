import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

// Resolve upstream once and pin the exact revision in package.json and pnpm-lock.yaml.
const remote = execFileSync('git', ['ls-remote', 'https://github.com/legitminh/keyflow.git', 'HEAD'], { encoding: 'utf8' });
const commit = remote.trim().split(/\s+/)[0];
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Could not resolve the latest Keyflow commit.');
// Approve only the reviewed, pinned revision so clean installs build the package.
const workspacePath = new URL('../pnpm-workspace.yaml', import.meta.url);
const workspace = readFileSync(workspacePath, 'utf8');
const approval = /"@legitminh\/keyflow@https:\/\/codeload\.github\.com\/legitminh\/keyflow\/tar\.gz\/[a-f0-9]{40}": true/;
if (!approval.test(workspace)) throw new Error('Could not find the pinned Keyflow build approval in pnpm-workspace.yaml.');
writeFileSync(workspacePath, workspace.replace(approval,
  `"@legitminh/keyflow@https://codeload.github.com/legitminh/keyflow/tar.gz/${commit}": true`));
console.log(`Updating Keyflow to ${commit}`);
execFileSync('pnpm', ['add', '-w', `@legitminh/keyflow@github:legitminh/keyflow#${commit}`], { stdio: 'inherit' });
