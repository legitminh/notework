# Notework native app

A [Tauri v2](https://v2.tauri.app) app around the unchanged Notework web build:

| Target | Web engine | Output |
| --- | --- | --- |
| macOS | WebKit (WKWebView) | universal `Notework.app` and `.dmg` |
| Windows | Chromium (WebView2) | NSIS installer `.exe` |
| Linux | WebKitGTK | `.AppImage` and `.deb` |
| iOS / iPadOS | WebKit (WKWebView) | Xcode project generated in `src-tauri/gen/apple` |

Everything here is isolated from the web app. `native/` is its own pnpm workspace with its own lockfile, plus a Rust crate in `src-tauri/`. The root `pnpm install`, `pnpm build`, `pnpm dev`, tests and the GitHub Pages deploy never touch it, and the only change outside this folder is that the Vite dev server ignores `native/`. Each native build first runs the root `pnpm build` and bundles its `build/` output as is.

## Prerequisites

- Everything the web app needs: Node 24, pnpm 11, and the sibling `../visual.editor` checkout (see the root README).
- Rust (stable) from [rustup](https://rustup.rs), plus the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS:
  - macOS: Xcode Command Line Tools. For the universal build, `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.
  - Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 10 and 11).
  - Linux: `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf` (Debian and Ubuntu names).
  - iOS: Xcode, XcodeGen (`brew install xcodegen`), and `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.

Install once from the repository root:

```sh
pnpm install                 # web app, as before
pnpm --dir native install    # Tauri CLI
```

## Desktop (macOS, Windows, Linux)

Run from `native/`:

```sh
pnpm desktop        # dev window on the Vite dev server, with hot reload
pnpm build:mac      # src-tauri/target/universal-apple-darwin/release/bundle/{macos,dmg}
pnpm build:win      # src-tauri/target/release/bundle/nsis/*.exe
pnpm build:linux    # src-tauri/target/release/bundle/{appimage,deb}
```

Set `NOTEWORK_SKIP_WEB_BUILD=1` to bundle an existing `../build` without rebuilding it. On a Mac, `pnpm build:desktop` builds for the current architecture only, which is faster.

To install the macOS build locally, open the `.dmg` and drag Notework into Applications, or copy `src-tauri/target/universal-apple-darwin/release/bundle/macos/Notework.app` to `/Applications`.

How it works: `src-tauri/src/lib.rs` opens one window on the bundled web build at Tauri's app origin (`tauri://localhost`, or `https://tauri.localhost` on Windows). Its only commands are the machine folder ones in `src-tauri/src/fs.rs`, used by `src/lib/native-fs.ts` and the folder browser in `src/lib/components/NativeFolderBrowser.svelte`. Links to other sites open in the system browser. On Windows and Linux there is no app menu, so every Ctrl shortcut reaches Notework (Vim's Ctrl+R and Ctrl+W included). On macOS the menu has only the app, Edit (cut, copy, paste, select all), View and Window menus; undo and redo stay with the editor.

## iOS

Run from `native/` on a Mac:

```sh
pnpm ios:init       # generate the Xcode project in src-tauri/gen/apple (once)
pnpm ios:dev        # run on a simulator against the Vite dev server
pnpm build:ios      # unsigned simulator build (.app under src-tauri/gen/apple)
NOTEWORK_IOS_DEVICE=1 pnpm build:ios   # signed device build (.ipa)
```

`src-tauri/gen/` is generated and not committed. The bundle id is `io.github.legitminh.notework`. For devices and TestFlight, set your team with `APPLE_DEVELOPMENT_TEAM` or `bundle.iOS.developmentTeam` in `tauri.conf.json`.

## Platform differences

Tauri uses each platform's own web engine, so features depend on it:

- **Machine folders** work on every platform. The app has no system folder dialog: **add existing folder/file** opens Notework's own folder browser, which lists the computer's places (home, desktop, documents, downloads, drives or volumes), navigates with `..` like Notework itself, works with keyboard navigation, and searches names below the current folder. Notework reads and saves files only below the folders and files you select there; the grants are kept in the app's data folder. On iOS the browser shows the app's own documents folder, which is also visible in the Files app.
- **Browser documents (OPFS)** work everywhere. WebKitGTK ships the Storage API and OPFS turned off, so the Linux app turns them on before the page loads. On macOS and iOS, saving needs WebKit's writable file streams, so use macOS 26 / iOS 26 or newer.
- **Storage is per app.** Each native app has its own browser storage, separate from the PWA in your browser. Browser documents made in the PWA do not appear in the app; export them or keep them in a GitHub folder to share them.
- **Offline**: every file is bundled in the app, so it works offline without the service worker.

## Signing and distribution

Local and CI builds are unsigned or ad hoc signed, which is enough to test:

- macOS builds are ad hoc signed (`bundle.macOS.signingIdentity: "-"`). A copy you built yourself opens normally. A copy downloaded from CI is quarantined by Gatekeeper; right-click and choose Open, or run `xattr -dr com.apple.quarantine /Applications/Notework.app`. To distribute, set `APPLE_SIGNING_IDENTITY` to a Developer ID and the notarization variables described in the [Tauri macOS signing guide](https://v2.tauri.app/distribute/sign/macos/).
- Windows installers are unsigned, so SmartScreen warns on first run until you add a code signing certificate.
- iOS needs an Apple Developer team for devices and the App Store.

## CI

`.github/workflows/native.yml` builds all four targets on macOS, Windows and Ubuntu runners and uploads them as workflow artifacts (`notework-mac`, `notework-win`, `notework-linux`, `notework-ios-simulator`). It runs on pull requests that change `native/`, on `v*` tags, and on demand from the Actions tab. The existing web CI and Pages deploy are unchanged.

## Updating

- Update the Tauri CLI with `pnpm --dir native update --latest` and the Rust crates with `cargo update` in `src-tauri/`, then rebuild.
- The app icon source is `resources/icon.png` (1024×1024, rendered from `static/favicon.svg`). Regenerate the icon set with `pnpm tauri icon resources/icon.png -o src-tauri/icons`.
