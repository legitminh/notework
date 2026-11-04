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

Every state starts with **search**, a divider, then **app settings** at home or **..** elsewhere, followed by its outgoing state buttons. The state display sits underneath. Root's display starts empty. There is no Configure button.

In app settings, **add existing folder/file** opens one local chooser. Drop mixed files/folders and the app identifies their handles automatically. Or use **browse location…**, grant read access to a folder in the OS dialog, and select files or folders inside it. Browser APIs do not provide one mixed native OS picker. The browsing location is temporary; only confirmed item handles are remembered. Cancelling adds nothing.

Folders expose their direct children. Existing directed links and hidden-child settings from older versions remain readable. `..` follows the filesystem parent within a granted source, returning home at its boundary; unselected ancestors cannot be discovered by a web app.

Search matches names/paths along outgoing graph transitions, including folder descendants and saved links, and handles cycles. Parent navigation is excluded. Search reports progress, supports stopping, and caps traversal at 20,000 states or 1,000 results. Press **Esc** or click **esc · search results** to leave the search field without clearing your query. **Edit search** returns to typing.

## Text editing

Readable files use the plain-text CodeMirror editor unless they are Notework drawings. Byte validation accepts UTF-8 and BOM-marked UTF-16, preserves encoding/BOM and line endings on save, and hides invalid Unicode, binary control-byte data, and `.git` directories. HTML and ordinary SVG remain inert editable source.

- **Tab** indents with **two spaces**; **Shift-Tab** outdents.
- Parentheses, brackets, braces, and quotes pair automatically.
- Undo/redo and Ctrl/Cmd-F search use standard editor bindings.
- **App settings → Appearance → Vim mode** enables standard Vim editing keys and is off by default. In Vim mode, `:w` saves, Esc returns to Normal mode, and Ctrl+F pages forward; use the magnifying glass for Find and Replace.
- Selecting a file keeps navigation available. **Open** switches to an isolated editor with a horizontal toolbar that scrolls with the page.
- **Exit** (Ctrl+Esc), **Save** (Ctrl+S), **Find and replace** (Ctrl+F), and **Export** are the toolbar actions. The shortcut labels appear on hover.
- Saves are explicit. Machine files request write permission on Save. Leaving with unsaved changes offers **Save and exit**, **Don’t save**, or **Cancel**. If saving fails, the editor keeps your edits so you can retry or export them.

The editor virtualizes its viewport and streams text reads/writes instead of rendering a collection or converting an entire collection into one string. There is no former 2 MB preview truncation. A multi-megabyte/60,000-line document is covered by browser tests. A single open document still uses editor memory, so capacity is not unlimited.

## Wiki links and rename

Type `[[` in the editor to see matching files. Use the arrow keys and Enter to pick a file or **create: filename**. You can also type the link directly. Save creates any new targets beside the source file and makes the links available as outgoing navigation buttons. Removing a link and saving removes its transition. Discarding edits creates no files or transitions.

Use **Rename** in the editor after saving your edits. It renames the file and rewrites saved Notework links to it, including their navigation targets. For machine files, grant write access to the containing folder. Creating siblings and updating machine-file backlinks may prompt for write permission.

## Drawings

Use **Brush** (Command+B) while editing text to insert a movable `\svgpage[filename.svg]` line. Move the caret off the line to see the drawing, then click it to draw inline. The drawing toolbar supports brush, whole-stroke erasing, undo, redo, and explicit save. Exit returns to the open text draft. Save the text to make the drawing an outgoing navigation target, where it can also be opened on its own.

Drawings for browser notes are SVG files in the same OPFS folder. For a machine note, the drawing lives in OPFS and is listed beside the note if the parent folder is in the graph. Notework does not create an SVG on the machine. The editor offers up to 16 min-box units of extra space beneath the drawing and saves only the area used.

## Graph and storage

IndexedDB stores source handles, resource locations, root edges, and directed-link metadata. Files/folders are identified by a source ID and a path inside that source. Folder edges are resolved lazily from the live filesystem. Each node has an app-managed resource URI:

- `notework-local://SOURCE_ID/name/path` identifies a user-selected machine handle. It is an opaque app identifier, not an invented `file://` path; browsers do not expose arbitrary absolute machine paths.
- `opfs://notework/documents/DOCUMENT_ID/name` identifies an app-created document in browser-owned OPFS storage.

**Create document** in app settings creates an empty resource in OPFS before committing its graph node. Failed metadata commits roll the new resource back. Existing machine files are tracked by handle, never copied into browser storage. Text classification reads bytes locally to hide binary resources; neither these reads nor editor saves upload anything.

Missing resources are checked on startup, navigation/refresh, window focus, and every five seconds while the app is visible. Confirmed missing files/folders, descendants, incoming/outgoing edges, root shortcuts, and caches are pruned and the cleaned graph is saved. If the active resource disappears, navigation returns home. A denied permission or quota error does not count as deletion. OS changes between checks can only be discovered at the next check.

**Configure file** and **Configure folder** let you permanently delete browser-stored resources after confirmation. Deleting a browser folder removes its contents and their graph entries. Use your system file manager to delete machine resources. Removing a root shortcut never deletes the original resource. Clearing site data removes the browser graph and OPFS documents. Data belongs to the current browser profile and origin (scheme, host, and port); it does not automatically sync to another device or origin.

## Installed/offline app

The production build includes a web manifest and service worker for an installable offline app shell. After its first successful online load, browser documents can be opened, created, edited, and saved offline. The service worker caches only app assets, not user file contents. Development mode does not build a service worker.

App settings shows estimated usage/quota and a **keep browser storage** action using `navigator.storage.persist()`. Persistence may be denied. Installing a PWA does not create unlimited storage or protect against manual clearing. Keep exported backups of important notes. Writes report quota errors without discarding the open buffer.

OPFS supports streamed text/binary storage, but the current UI exposes decodable text and Notework drawings.

## Keyflow dependency

Components and CSS are imported from `@legitminh/keyflow`, installed directly from GitHub at a pinned commit. No library source is copied here. Update it after pushing library changes:

```sh
pnpm update:keyflow
pnpm check
pnpm build
pnpm test
```

The update command resolves upstream HEAD and pins that commit in `package.json` and `pnpm-lock.yaml`. Commit both. To target a revision manually: `pnpm add -w '@legitminh/keyflow@github:legitminh/keyflow#COMMIT'`.

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
