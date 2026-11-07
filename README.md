# Notework

A local network of text documents and folders, built with SvelteKit 3, Svelte 5, TypeScript, Vite, CodeMirror, and the [Keyflow](https://github.com/legitminh/keyflow) library. Nothing is uploaded.

## Run

Use Node 24, pnpm 11, and HTTPS or localhost:

```sh
pnpm install
pnpm dev
```

New browser documents work in browsers with OPFS support. Connecting existing machine files requires Chrome/Edge's File System Access API. A fresh workspace has no sample files.

## Navigation and selection

Every state starts with non-navigation tools above a divider: **search**, then **app settings** at home or **configure folder/file** elsewhere. Below the divider are graph-navigation actions: a house icon for home, **..**, and outgoing state buttons. The state display sits underneath. Home is the virtual root folder: its children can come from different machine sources and browser storage. Home and other folders share the same creation screen.

In app settings, **add existing folder/file** opens one local chooser. Drop mixed files/folders and the app identifies their handles automatically. Or use **browse location…**, grant read access to a folder in the OS dialog, and select files or folders inside it. Browser APIs do not provide one mixed native OS picker. The browsing location is temporary; only confirmed item handles are remembered. Cancelling adds nothing.

Folders expose their direct children. Existing directed links and hidden-child settings from older versions remain readable. `..` follows the filesystem parent within a granted source, returning home at its boundary; unselected ancestors cannot be discovered by a web app.

Search matches file and folder names/paths along outgoing graph transitions, including folder descendants and saved links, and handles cycles. Parent navigation is excluded. Folder results navigate normally; file results provide paired **open** and filename actions for either immediate editing or navigation. Search reports progress, supports stopping, and caps traversal at 20,000 states or 1,000 results. Press **Esc** or click **esc · search results** to leave the search field without clearing your query. **Edit search** returns to typing.

## Text editing

Readable files use the plain-text CodeMirror editor unless they are Notework drawings. Byte validation accepts UTF-8 and BOM-marked UTF-16, preserves encoding/BOM and line endings on save, and hides invalid Unicode, binary control-byte data, and `.git` directories. HTML and ordinary SVG remain inert editable source.

- **Tab** indents with **two spaces**; **Shift-Tab** outdents.
- Parentheses, brackets, braces, and quotes pair automatically.
- Undo/redo and Ctrl/Cmd-F search use standard editor bindings.
- **App settings → Appearance → Vim mode** enables standard Vim editing keys and is off by default. In Vim mode, `:w` saves, Esc returns to Normal mode, and Ctrl+F pages forward; use the magnifying glass for Find and Replace.
- Selecting a file keeps navigation available. **Open** switches to an isolated editor whose toolbar stays at the top while the document scrolls beneath it.
- **Exit** (Ctrl+Esc), **Find and replace** (Ctrl+F), **Brush**, and **Export** are the text toolbar actions. The shortcut labels appear on hover. There is no Save button.
- Press **Esc** while typing with Vim off, or from Vim's Visual mode, to move focus to the toolbar and use its shortcuts. In Vim Insert mode, Esc still returns to Normal mode in the editor. Click the document to resume editing.
- Text and SVG files autosave after changes, at most once per the interval configured in **App settings → Autosave** (4 seconds by default). Exit always finishes saving before returning to navigation. A machine file only prompts for write permission from an explicit exit or save shortcut; if saving fails, the editor stays open with the edits available for retry or export. Ctrl+S and Vim `:w` remain available as immediate saves.

The editor virtualizes its viewport and streams text reads/writes instead of rendering a collection or converting an entire collection into one string. There is no former 2 MB preview truncation. A multi-megabyte/60,000-line document is covered by browser tests. A single open document still uses editor memory, so capacity is not unlimited.

## Export

**Export** in either editor opens a format dialog for PDF, PNG, or JPEG. It exports the current draft without saving it, including unsaved inline drawing strokes. Every format uses the same one-page layout with configurable margins, the editor’s font/colors/wrapping, formatted wiki links, and SVG strokes. Set each side in **App settings → export margins**, always in min-box units. Left, right, top, and bottom default to 1; zero and fractional values are supported. Margins add space around the content without changing wrapping or SVG proportions, using the current min-box size. Navigation, toolbars, the caret, and line numbers are excluded. PDF preserves SVG strokes as vector paths; PNG and JPEG render the same page as a single image. Very large raster pages are uniformly scaled to safe browser and iOS canvas limits rather than cropped or split.

In a browser, **Download** uses the browser’s regular download destination/settings. In an installed PWA, **Share** opens the OS file-sharing sheet for the selected format when supported; a download fallback is always available. The file is prepared before the final share tap, preserving the user gesture required by iOS. Cancelling sharing does not start a download. Export runs entirely on-device and works offline with the cached app shell; no note contents are uploaded.

## Wiki links and rename

Type `[[` in the editor to see matching files. Use the arrow keys and Enter to pick a file or **create: filename**. You can also type the link directly. Autosave creates any new targets beside the source file and makes the links available as outgoing navigation buttons. Removing a link removes its transition on the next autosave.

Use **Configure file → rename** or **Configure folder → rename** in navigation mode. Folder rename updates descendant paths, resource URIs, graph transitions, and saved links to those descendants. SVG directive filenames are updated when the drawing is renamed. The editor toolbar is reserved for editing. For machine files, grant write access to the containing folder. Creating siblings and updating machine-file backlinks may prompt for write permission.

## Drawings

Use **Brush** (Command+B) while editing text to insert a movable `\svgpage[filename.svg]` line. A new Brush drawing is created beside the text file for convenience, but the directive is a graph resource reference like `[[FILE]]`: it may instead contain a unique name, graph path, or resource URI for a Notework SVG drawing in another folder or storage source. Move the caret off the line to see the drawing, then click it to draw inline. The drawing toolbar supports brush, whole-stroke erasing, undo, redo, autosave, and export. Exit saves and returns to the open text draft. Text autosave records the referenced drawing as an outgoing navigation target, where it can also be opened on its own; rename updates the directive even across folders and storage sources.

Drawings are sibling SVG files in the note’s own storage: a local note creates a local SVG beside it, and a browser note creates an SVG in the same OPFS folder. A local drawing may request write permission when Brush creates it or when the editor exits. Existing browser drawings from older versions remain accessible through their directed links. Drawing pages fit the available text page width, capped at 32 min-boxes. Both axes and stroke widths scale together when the screen rotates. One extra working page is 16 min-boxes tall at full page width and scales proportionally on smaller screens. Saves contain only the area used.

In a drawing, tap with **two fingers** to undo and **three fingers** to redo. Drag with two fingers to scroll, or pinch to zoom. Adding a second finger cancels the tentative drawing stroke. **App settings → draw with only physical stylus** is disabled by default and persists across reloads. When enabled, fingers use native scrolling/zooming and only pen input draws or erases; toolbar buttons still work with any input device.

Press **Esc** on an inline or standalone drawing canvas to cancel any stroke in progress and move focus to the drawing toolbar. Start another stroke on the canvas to resume drawing.

## Create files and folders

Home exposes **create new file/folder** inside app settings; physical and browser folders expose it inside **configure folder**, alongside **refresh folder**. Home is a virtual parent that holds items from multiple sources, with no filesystem folder of its own. App settings manages connected sources and preferences. The separate creation screen accepts a name and previews the path for each available type: folder, text file, or SVG drawing. Choose a creation action to open the new state in navigation mode. Existing names are rejected without changing their contents.

New assets inherit the parent folder’s storage. Inside a selected machine folder, Create requests write permission and writes directly into that folder. Inside a browser folder, Create writes an actual OPFS child. Root has no backing folder, so new root assets use OPFS. Denied local write access never falls back to browser storage. Directed links may point across storage sources; they do not create child or parent relationships. Older browser-backed virtual children are preserved as explicit links without moving their files. The available actions come from `src/lib/asset-types.ts`; adding a supported type there adds its creation action and initializer.

## Graph and storage

IndexedDB stores machine source handles, resource locations, root edges, and directed-link metadata. Browser resources are stored as OPFS paths and types, then reopened from those paths on startup; their handles are never structured-cloned or stored in IndexedDB. Older handle-based browser records are migrated on the next save. Files/folders are identified by a source ID and a path inside that source. Folder edges are resolved lazily from the live filesystem. Each node has an app-managed resource URI:

- `notework-local://SOURCE_ID/name/path` identifies a user-selected machine handle. It is an opaque app identifier, not an invented `file://` path; browsers do not expose arbitrary absolute machine paths.
- `opfs://notework/documents/DOCUMENT_ID/name` identifies an app-created document in browser-owned OPFS storage.

Creating a resource at home allocates its contents in OPFS before committing a child node under the virtual root. Failed metadata commits roll the new resource back. Existing machine files are tracked by handle, never copied into browser storage. Text classification reads bytes locally to hide binary resources; neither these reads nor editor saves upload anything.

Missing resources are checked on startup, navigation/refresh, window focus, and every five seconds while the app is visible. Confirmed missing files/folders, descendants, incoming/outgoing edges, root shortcuts, and caches are pruned and the cleaned graph is saved. If the active resource disappears, navigation returns home. A denied permission or quota error does not count as deletion. OS changes between checks can only be discovered at the next check.

**Configure file** and **Configure folder** permanently delete browser or machine resources after confirmation. For machine resources, Notework requests write permission on the explicit Delete action and removes the entry through its retained physical parent; folder deletion is recursive. Parent handles selected through the picker persist across reloads. If an older or dropped top-level handle has neither a retained parent nor direct-removal support, reconnect it through its containing folder first. Filesystem deletion completes before descendants, incoming/outgoing edges, formats, and cached handles are pruned from the graph; a denial or failure leaves graph metadata intact. Removing a root shortcut never deletes the original resource. Clearing site data removes the browser graph and OPFS documents. Data belongs to the current browser profile and origin (scheme, host, and port); it does not automatically sync to another device or origin.

## Installed/offline app

The production build includes a web manifest and service worker for an installable offline app shell. After its first successful online load, browser documents can be opened, created, edited, and saved offline. The service worker caches only app assets, not user file contents. Development mode does not build a service worker.

App settings shows estimated usage/quota and a **keep browser storage** action using `navigator.storage.persist()`. Persistence may be denied. Installing a PWA does not create unlimited storage or protect against manual clearing. Keep exported backups of important notes. Writes report quota errors without discarding the open buffer.

OPFS supports streamed text/binary storage, but the current UI exposes decodable text and Notework drawings.

## Keyflow dependency

Components and CSS are imported from `@legitminh/keyflow`, installed directly from GitHub at a pinned commit. No library source is copied here. When updating Keyflow, review the new revision and replace the commit in its `allowBuilds` entry in `pnpm-workspace.yaml` before installing it. pnpm needs that exact tarball URL to allow Keyflow's build script to run on a clean install.

To update to upstream HEAD after approving that revision:

```sh
pnpm update:keyflow
pnpm check
pnpm build
pnpm test
```

The update command resolves upstream HEAD and pins that commit in `package.json` and `pnpm-lock.yaml`. Commit both files along with the matching `pnpm-workspace.yaml` approval. To target a revision manually: `pnpm add -w '@legitminh/keyflow@github:legitminh/keyflow#COMMIT'`.

The current dependency is **Keyflow 0.2.0**, pinned to release commit `60f46f819449906e615ef0b6d3a61acf25e07b40` (upgraded from 0.1.1). Its update adds fixed shortcuts, persistent positional controls, OS-aware shortcut symbols, and shortcut key presets.

Navigation, configuration, picker, dialog, export and editor toolbar buttons use the library through `Control.svelte`. Ordinary buttons retain visibility-based automatic shortcuts; search-field exit and relocate cancellation use `StaticButton` with Escape. The app adapter forwards accessible names, pressed states and existing editor shortcut annotations to the underlying button. Dialog scoping unregisters background controls and closed-dialog controls, then restores them after closing. Disabled controls render native disabled buttons without shortcut registration because Keyflow 0.2.0 has no disabled prop.

The following remain native or app-owned because Keyflow does not provide equivalent controls or behavior:

- Rename's submit button retains HTML form validation and Enter submission; library buttons have a fixed `type="button"`.
- Name/search/number inputs, picker checkboxes, and the export-format select retain native editing and selection.
- CodeMirror owns its text area, find/replace controls, completions, wiki-link interactions, and SVG preview widgets. Editor modifier shortcuts and field-specific Enter/Escape handlers remain in Notework because Keyflow ignores events from editable fields.
- Drawing pointer/touch gestures, drag-and-drop, native modal dialogs, OS filesystem pickers, permission prompts, downloads and share sheets remain browser/app features. Their ordinary app action buttons use Keyflow.

Keyflow supports native scrolling with `options={{ lockstep: false }}`. Since its saved preference overrides that initial option, Notework additionally forces the exported `lockstep_scrolling` state to false in app code. The library remains unmodified. Theme and type size are in app settings.

## Validate and build

```sh
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm test
PLAYWRIGHT_PRODUCTION=1 pnpm test
```

An installed Chrome can be used instead of Playwright's Chromium:

```sh
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' pnpm test
```

Browser tests use real filesystem handles in isolated browser-private storage. OS dialogs, drop events, and permission responses are simulated; native OS picker dialogs require a manual check. Coverage includes navigation, search/shortcuts, mixed selection, source-only observation with zero uploads, graph cleanup, text validation/encodings, safe writes, two-space indentation/brackets, explicit save/reload, large files, quota errors, and offline PWA editing. `pnpm build` writes a static site to `build/`; `pnpm preview` serves it locally.

WebKit storage regression (uses a temporary persistent profile, because ephemeral WebKit contexts cannot open OPFS):

```sh
pnpm exec playwright install webkit
PLAYWRIGHT_PRODUCTION=1 pnpm exec playwright test tests/webkit.spec.ts --browser=webkit
```
