// Builds the iOS app with xcodebuild. Unsigned simulator build by default;
// set NOTEWORK_IOS_DEVICE=1 (and a signing team in Xcode) for a device build.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../ios/App/App.xcodeproj', import.meta.url));
const device = process.env.NOTEWORK_IOS_DEVICE === '1';
const args = [
  '-project', project, '-scheme', 'App', '-configuration', device ? 'Release' : 'Debug',
  '-destination', device ? 'generic/platform=iOS' : 'generic/platform=iOS Simulator',
  '-derivedDataPath', fileURLToPath(new URL('../dist/ios', import.meta.url)),
  ...(device ? [] : ['CODE_SIGNING_ALLOWED=NO']),
  'build'
];
const result = spawnSync('xcodebuild', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
