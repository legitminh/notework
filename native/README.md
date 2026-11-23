# Notework native apps

Native shells around the unchanged Notework web build:

| Target | Shell | Web engine | Output |
| --- | --- | --- | --- |
| macOS | Electron | Chromium | universal `.dmg` and `.zip` |
| Windows | Electron | Chromium | NSIS installer `.exe` (x64 and arm64) |
| Linux | Electron | Chromium | `.AppImage` and `.deb` (x64) |
| iOS / iPadOS | Capacitor | WebKit (WKWebView) | Xcode project in `ios/` |

Everything here is isolated from the web app. `native/` is its own pnpm workspace with its own lockfile, the root `pnpm install`, `pnpm build`, `pnpm dev`, tests and the GitHub Pages deploy never touch it, and the only change outside this folder is that the Vite dev server ignores `native/`. Each native build first runs the root `pnpm build` and packages its `build/` output as is.

## Prerequisites

- Everything the web app needs: Node 24, pnpm 11, and the sibling `../visual.editor` checkout (see the root README).
- macOS builds: a Mac. iOS builds: a Mac with Xcode 16 or newer.
- Windows builds: Windows (or CI). Linux builds: Linux (or CI).

Install once from the repository root:

```sh
pnpm install                 # web app, as before
pnpm --dir native install    # native shells (Electron, electron-builder, Capacitor)
```

## Desktop (macOS, Windows, Linux)

Run from `native/`:

```sh
pnpm desktop        # build the web app and open it in an Electron window
pnpm build:mac      # dist/Notework-<version>-mac-universal.dmg and .zip
pnpm build:win      # dist/Notework-<version>-win-<arch>.exe
pnpm build:linux    # dist/Notework-<version>-linux-x86_64.AppImage and .deb
```

Set `NOTEWORK_SKIP_WEB_BUILD=1` to package an existing `../build` without rebuilding it. `pnpm desktop:run` opens the current build without rebuilding.

To install the macOS build locally, open the `.dmg` and drag Notework into Applications, or copy `dist/mac-universal/Notework.app` to `/Applications`.

How it works: `electron/main.cjs` serves the web build from a private `notework://app/` origin that is standard and secure, so OPFS, IndexedDB, the File System Access API (machine folders) and the service worker work as in Chrome. The window has no preload, IPC or Node access, and the protocol serves only files inside the bundled web build, so nothing exposes the host filesystem. Links to other sites open in the system browser. On Windows and Linux there is no app menu, so every Ctrl shortcut reaches Notework (Vim's Ctrl+R and Ctrl+W included). On macOS the menu has only the app, Edit (cut, copy, paste, select all), View and Window menus; undo and redo stay with the editor.

## iOS

Run from `native/`:

```sh
pnpm ios:sync       # build the web app and copy it into ios/App/App/public
pnpm ios:open       # sync, then open the project in Xcode to run on a simulator or device
pnpm build:ios      # sync, then an unsigned simulator build with xcodebuild
NOTEWORK_IOS_DEVICE=1 pnpm build:ios   # device build (set a signing team in Xcode first)
```

The bundle id is `io.github.legitminh.notework`. To run on a device or ship to TestFlight, open the project in Xcode, choose your team under Signing & Capabilities, and archive.

## Platform differences

- **Storage is per app.** Each native app has its own browser storage, separate from the PWA in your browser. Browser documents made in the PWA do not appear in the app; export them or keep them in a machine or GitHub folder to share them.
- **Machine folders** work on macOS, Windows and Linux through the standard folder picker. iOS WebKit has no folder picker, so on iOS Notework offers browser documents (OPFS) and GitHub folders only. Saving browser documents needs WebKit's writable file streams, so use iOS 26 or newer.
- **Offline**: the desktop apps also register the service worker; the iOS app has no service worker, which it does not need because every file is bundled.

## Signing and distribution

Local and CI builds are unsigned or ad hoc signed, which is enough to test:

- macOS builds are ad hoc signed. A copy you built yourself opens normally. A copy downloaded from CI is quarantined by Gatekeeper; right-click and choose Open, or run `xattr -dr com.apple.quarantine /Applications/Notework.app`. To distribute, build with a Developer ID identity (`pnpm build:mac -c.mac.identity="Developer ID Application: …"`) and notarize.
- Windows installers are unsigned, so SmartScreen warns on first run until you add a code signing certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`).
- iOS needs an Apple Developer team for devices and the App Store.

## CI

`.github/workflows/native.yml` builds all four targets on macOS, Windows and Ubuntu runners and uploads them as workflow artifacts (`notework-mac`, `notework-win`, `notework-linux`, `notework-ios-simulator`). It runs on pull requests that change `native/`, on `v*` tags, and on demand from the Actions tab. The existing web CI and Pages deploy are unchanged.

## Updating

- Electron, electron-builder and Capacitor versions are pinned in `package.json`; update them here with `pnpm --dir native update --latest` and rebuild.
- `ios/` is a normal Capacitor project; after updating Capacitor run `pnpm exec cap sync ios`.
- The app icon is `resources/icon.png` (1024×1024, rendered from `static/favicon.svg`). The iOS icon and splash images are in `ios/App/App/Assets.xcassets`.
