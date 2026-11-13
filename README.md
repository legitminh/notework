# Notework

A local-first network of text documents and folders, built with SvelteKit 3, Svelte 5, TypeScript, Vite, CodeMirror, and the [Keyflow](https://github.com/legitminh/keyflow) library. You can also connect a GitHub repository as a folder.

## Run

Use Node 24, pnpm 11, and HTTPS or localhost:

```sh
pnpm install
pnpm dev
```

New browser documents work in browsers with OPFS support. Connecting existing machine files requires Chrome/Edge's File System Access API. A fresh workspace has no sample files.

## Navigation and selection

Every state starts with non-navigation tools above a divider: **search**, then **app settings** at home or **configure folder/file** elsewhere. Folder views also offer **create new file/folder** above the divider. Below the divider are graph-navigation actions: a house icon for home, **..**, and outgoing state buttons. The state display sits underneath. Home is the virtual root folder: its children can come from different machine sources and browser storage. Home and other folders share the same creation screen.

In app settings, **add existing folder/file** opens one local chooser. Drop mixed files/folders and the app identifies their handles automatically. Or use **browse location…**, grant read access to a folder in the OS dialog, and select files or folders inside it. Browser APIs do not provide one mixed native OS picker. The browsing location is temporary; only confirmed item handles are remembered. Cancelling adds nothing.

Folders expose their direct children. Existing directed links and hidden-child settings from older versions remain readable. `..` follows the filesystem parent within a granted source, returning home at its boundary; unselected ancestors cannot be discovered by a web app.

The **search** button and **Cmd/Ctrl+P** open the same popup. Search matches file and folder names/paths across all connected sources, including resources connected only through saved links. Hidden children stay hidden, cycles are deduplicated, and parent navigation is excluded from traversal. Results are grouped by name; for the same name, direct children of the current folder precede deeper descendants and files elsewhere, including parent folders. When searching from a file, its containing folder supplies that priority. Search checks names before fetching file contents, and matches composed and decomposed Unicode spellings alike. Folder results navigate normally; file results provide paired **open** and filename actions for either immediate editing or navigation. Search reports progress, supports stopping, and caps traversal at 20,000 states or 1,000 results. Press **Esc** or click **esc · search results** to leave the search field without clearing your query. **Edit search** returns to typing. During relocation, folder results also offer **choose**.

## Text editing

Readable files use the plain-text CodeMirror editor unless they are Notework drawings. Supported images open in the image editor. For other files, byte validation accepts valid UTF-8 and BOM-marked UTF-16, including Unicode control characters, and preserves encoding/BOM and line endings on save. Files with undecodable bytes and `.git` metadata stay hidden. An unreadable file keeps its graph links so they work again if the file becomes readable. HTML and ordinary SVG remain inert editable source.

- **Tab** accepts the selected suggestion or indents with **two spaces** when there is no suggestion; **Shift-Tab** outdents.
- Parentheses, brackets, braces, and quotes pair automatically.
- Undo/redo and Ctrl/Cmd-F search use standard editor bindings.
- **App settings → Appearance → Vim mode** enables standard Vim editing keys and is off by default. In Vim mode, `:w` saves and Ctrl+F pages forward; use the magnifying glass for Find and Replace.
- Selecting a file keeps navigation available. **Open** switches to an isolated editor whose toolbar stays at the top while the document scrolls beneath it.
- **Exit** (Ctrl+Esc), **Find and replace** (Ctrl+F), **+svg**, and **Export** are the text toolbar actions. The shortcut labels appear on hover. There is no Save button.
- Press **Esc** while editing with Vim off or from Vim's Normal mode to use toolbar shortcuts. Vim Insert and Visual modes still return to Normal first. In tool mode the title becomes **Edit {page name}**; click it or press **Esc** again to resume. Clicking or tapping a toolbar tool keeps the current mode.
- Text and SVG files autosave after changes, at most once per the interval configured in **App settings → Autosave** (4 seconds by default). Exit finishes saving to local storage before returning to navigation. GitHub publishing continues in the background. A machine file only prompts for write permission from an explicit exit or save shortcut; if saving fails, the editor stays open with the edits available for retry or export. Ctrl+S and Vim `:w` remain available as immediate saves.

The editor virtualizes its viewport and streams text reads/writes instead of rendering a collection or converting an entire collection into one string. There is no former 2 MB preview truncation. A multi-megabyte/60,000-line document is covered by browser tests. A single open document still uses editor memory, so capacity is not unlimited.

On its own line, `\pretty` formats the text below it as an outline until `\unpretty`. A line becomes a bold heading when the next line is more indented. Pretty uses the regular editor font size as its unit. An unindented heading has a font size of four units and three units of space above it. Each indentation level subtracts a quarter unit from both, down to a font size of 1.25 units and no extra space.

Leading spaces and tabs keep their normal width. **App settings → Appearance → Pretty font sizing** is on by default. Turn it off to keep a consistent font size while retaining bold headings and extra space above them.

Use `\pretty1[LINES]` to format a block and then return to regular text, or `\unpretty1[LINES]` to show a block as regular text and turn formatting on afterward. The brackets can enclose multiple lines.

Type `\` on its own line and choose a command from autocomplete. Accepting `\pretty` moves the caret to the start of a new, unindented line. The editor hides the switch lines when the caret leaves them, while keeping their original line numbers in the document.

## Export

**Export** in either editor opens a format dialog for PDF, PNG, or JPEG. It exports the current draft without saving it, including unsaved inline drawing strokes. Every format uses the same one-page layout with configurable margins, the editor’s font/colors/wrapping, formatted wiki links, and SVG strokes. Set each side in **App settings → export margins**, always in min-box units. Left, right, top, and bottom default to 1; zero and fractional values are supported. Margins add space around the content without changing wrapping or SVG proportions, using the current min-box size. Navigation, toolbars, the caret, and line numbers are excluded. PDF preserves SVG strokes as vector paths; PNG and JPEG render the same page as a single image. Very large raster pages are uniformly scaled to safe browser and iOS canvas limits rather than cropped or split.

In a browser, **Download** uses the browser’s regular download destination/settings. In an installed PWA, **Share** opens the OS file-sharing sheet for the selected format when supported; a download fallback is always available. The file is prepared before the final share tap, preserving the user gesture required by iOS. Cancelling sharing does not start a download. Export runs entirely on-device and works offline with the cached app shell; no note contents are uploaded.

## Wiki links and rename

Type `[[` in the editor to see matching files. Use the arrow keys and Enter to pick a file or **create: filename**. You can also type the link directly. Autosave creates any new targets beside the source file and makes the links available as outgoing navigation buttons. Removing a link removes its transition on the next autosave.

Use **Configure file → rename** or **Configure folder → rename** in navigation mode. Folder rename updates descendant paths, resource URIs, graph transitions, and saved links to those descendants. Drawing/image directive filenames are updated when the drawing is renamed. The editor toolbar is reserved for editing. For machine files, grant write access to the containing folder. Creating siblings and updating machine-file backlinks may prompt for write permission.

## Drawings

Use **+svg** (Command+B) while editing text to insert a movable `\svgpage[filename.svg]` line and immediately enter drawing mode. A new SVG drawing is created beside the text file for convenience, but the directive is a graph resource reference like `[[FILE]]`: it may instead contain a unique name, graph path, or resource URI for a Notework SVG drawing in another folder or storage source. After leaving drawing mode, move the caret off the line to see the drawing and click it to draw inline again. **Delete drawing** removes the directive and its corresponding file after confirmation, including a newly created accidental drawing. The drawing toolbar supports brush, whole-stroke erasing, undo, redo, autosave, and export. Exit saves and returns to the open text draft. Text autosave records the referenced drawing as an outgoing navigation target, where it can also be opened on its own; rename updates the directive even across folders and storage sources.

To link an existing drawing, type `\` on its own line, select `\svgpage` with the arrow keys, and press **Tab**. You can also type `\svgpage[` directly. Inside the brackets, suggestions favor matching names and paths, then nearby drawings. Siblings come first among equally good matches, and downstream paths come before equally short upstream paths. Press **Tab** to insert the selected drawing reference.

Drawings are sibling SVG files in the note’s own storage: a local note creates a local SVG beside it, and a browser note creates an SVG in the same OPFS folder. A local drawing may request write permission when +svg creates it or when the editor exits. Existing browser drawings from older versions remain accessible through their directed links. Drawing pages fit the available text page width, capped at 32 min-boxes. Both axes and stroke widths scale together when the screen rotates. One extra working page is 16 min-boxes tall at full page width and scales proportionally on smaller screens. Saves contain only the area used.

In a drawing, tap with **two fingers** to undo and **three fingers** to redo. Drag with two fingers to scroll, or pinch to zoom. Adding a second finger cancels the tentative drawing stroke. **App settings → draw with only physical stylus** is disabled by default and persists across reloads. When enabled, fingers use native scrolling/zooming and only pen input draws or erases; toolbar buttons still work with any input device.

Press **Esc** in an inline or standalone drawing to cancel any stroke in progress and switch to tool mode. Press **Esc** again, choose **Edit {page name}**, or start another stroke on the canvas to resume drawing.

## Create files and folders

Home exposes **create new file/folder** inside app settings. Computer, browser, and GitHub folders expose it directly in the folder view. Home is a virtual parent that holds items from multiple sources, with no filesystem folder of its own. App settings manages connected sources and preferences. The separate creation screen accepts a name and previews the path for each available type: page folder, folder, text file, SVG drawing, or PNG/JPEG/HEIC/ORA image. The first option, **create page folder**, creates the named folder with an empty `[foldername].main` text file inside it: `math.2999/math.2999.main`. Creation finishes in the folder view, where the file's **open** action enters its editor. Choose any other creation action to open that new state in navigation mode. Existing names are rejected without changing their contents.

New assets inherit the parent folder’s storage. Inside a selected machine folder, Create requests write permission and writes directly into that folder. Inside a browser folder, Create writes an actual OPFS child. Root has no backing folder, so new root assets use OPFS. Denied local write access never falls back to browser storage. Directed links may point across storage sources; they do not create child or parent relationships. Older browser-backed virtual children are preserved as explicit links without moving their files. The available actions come from `src/lib/asset-types.ts`; adding a supported type there adds its creation action and initializer.

## Graph and storage

IndexedDB stores machine source handles, resource locations, root edges, and directed-link metadata. Browser resources are stored as OPFS paths and types, then reopened from those paths on startup; their handles are never structured-cloned or stored in IndexedDB. Older handle-based browser records are migrated on the next save. Files/folders are identified by a source ID and a path inside that source. Folder edges are resolved lazily from the live filesystem. Each node has an app-managed resource URI:

- `notework-local://SOURCE_ID/name/path` identifies a user-selected machine handle. It is an opaque app identifier, not an invented `file://` path; browsers do not expose arbitrary absolute machine paths.
- `opfs://notework/documents/DOCUMENT_ID/name` identifies an app-created document in browser-owned OPFS storage.

Creating a resource at home allocates its contents in OPFS before committing a child node under the virtual root. Failed metadata commits roll the new resource back. Existing machine files are tracked by handle. Text classification reads bytes in the browser to hide binary resources. Files on your computer and in browser storage stay there unless you explicitly move them into a GitHub folder.

## GitHub folders

Open **App settings → GitHub repositories** and enter a repository and an optional branch. [Create a fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) and limit it to that repository. Under repository permissions, click **Add permissions**, select **Contents**, then choose **Read and write**. The repository needs an initial commit and a branch that accepts direct pushes. Notework saves the token in this browser and sends it only to GitHub's API. If credentials stop working, use **Reconnect GitHub** in the error message to replace the token.

The repository appears under Home. Notework checks for upstream changes on startup and when opening a repository folder or file. Autosave, **Cmd/Ctrl+S**, and Vim `:w` keep a draft in the browser. **Exit** publishes the finished edit as one `edit: filename` commit. Exit first saves an immutable sync job in IndexedDB and returns to navigation. The bottom progress bar reports publishing while navigation and editing remain available. Closing the tab leaves the job queued; startup, reconnecting, and periodic retries resume it. Newer autosaves are preserved while an older snapshot publishes. If GitHub has changed the same file since it was opened, the bottom bar offers **Review GitHub conflict** without interrupting the current editor. Open it when convenient, edit either version in the side-by-side dialog, and choose which to keep. Cancel or a failed push leaves the draft and sync job available for retry. Pending publication protects the same file from deletion or rename until sync finishes. Empty folders use a hidden `.gitkeep` file so they persist in Git.

Missing resources are checked on startup, navigation/refresh, window focus, and every five seconds while the app is visible. Confirmed missing files/folders, descendants, incoming/outgoing edges, root shortcuts, and caches are pruned and the cleaned graph is saved. If the active resource disappears, navigation returns home. A denied permission or quota error does not count as deletion. OS changes between checks can only be discovered at the next check.

**Configure file** and **Configure folder** permanently delete browser or machine resources after confirmation. For machine resources, Notework requests write permission on the explicit Delete action and removes the entry through its retained physical parent; folder deletion is recursive. Parent handles selected through the picker persist across reloads. If an older or dropped top-level handle has neither a retained parent nor direct-removal support, reconnect it through its containing folder first. Filesystem deletion completes before descendants, incoming/outgoing edges, formats, and cached handles are pruned from the graph; a denial or failure leaves graph metadata intact. Removing a root shortcut never deletes the original resource. Clearing site data removes the browser graph and OPFS documents. Data belongs to the current browser profile and origin (scheme, host, and port); it does not automatically sync to another device or origin.

## Installed/offline app

The production build includes a web manifest and service worker for an installable offline app shell. After its first successful online load, browser documents can be opened, created, edited, and saved offline. The service worker caches only app assets, not user file contents. Development mode does not build a service worker.

App settings shows estimated usage/quota and a **keep browser storage** action using `navigator.storage.persist()`. Persistence may be denied. Installing a PWA does not create unlimited storage or protect against manual clearing. Keep exported backups of important notes. Writes report quota errors without discarding the open buffer.

OPFS supports streamed text/binary storage. The UI exposes decodable text, Notework SVG drawings, and PNG/JPEG/HEIC/ORA images.

## Keyflow dependency

Components and CSS are imported from `@legitminh/keyflow`, installed directly from GitHub at a pinned commit. No library source is copied here. When working on the integration or keyboard UI, check for a newer upstream version and update if available after reviewing its changes. The update command also replaces the exact Keyflow tarball URL in `pnpm-workspace.yaml`'s `allowBuilds` entry so its build script can run on a clean install.

To update to upstream HEAD after approving that revision:

```sh
pnpm update:keyflow
pnpm check
pnpm build
pnpm test
```

The update command resolves upstream HEAD and pins that commit in `package.json` and `pnpm-lock.yaml`. Commit both files along with the matching `pnpm-workspace.yaml` approval. To target a revision manually: `pnpm add -w '@legitminh/keyflow@github:legitminh/keyflow#COMMIT'`.

The current dependency is **Keyflow 0.4.0**, pinned to release commit `a2271a8d0ddcb171e9e80dec9b0eb761e59a9020`. It provides input frames and virtual keyboards, including directional flick keys. Notework defaults to the alphanumeric shortcut alphabet.

Navigation, configuration, picker, dialog, export and editor toolbar buttons use the library through `Control.svelte`. Ordinary buttons retain visibility-based automatic shortcuts, while modal dialog controls use stable persistent shortcuts. Relocate cancellation uses `StaticButton` with Escape; within the search popup, Escape first leaves the field and then closes the popup. The app adapter forwards accessible names, pressed states and existing editor shortcut annotations to the underlying button. Dialog scoping unregisters background controls and closed-dialog controls, then restores them after closing. Disabled controls render native disabled buttons without shortcut registration because Keyflow buttons have no native disabled prop.

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


## Keyboard and global search

**App settings → keyboard** chooses the shortcut alphabet (alphanumeric by default), toggles the virtual keyboard (off by default), and selects its layout (ASCII by default). Available Keyflow layouts include flick alpha, alpha, alphanumeric, 60%, ortholinear, 16-key, and 32-key. The enabled keyboard replaces the system text keyboard on supported fields and edits CodeMirror through its selection and undo history. Flick directions enter their displayed characters or editing keys. Shift latches for one character; Caps toggles case. Outside text entry, virtual keys route to the active Keyflow controls. Scrolling stays native.

Flick alpha uses three rows of ten keys. Flicking up on the top row enters digits and down on any letter enters uppercase. Escape's left/right gestures enter Backspace/Tab; its up/down gestures enter tilde/backtick. Space's gestures move the cursor in the corresponding direction. Tapping Escape leaves text entry without clearing the search query.

Holding Command or Ctrl shows shortcut hints for Copy, Paste, Search, and Save. **Cmd/Ctrl+P** opens the same system-wide search in a modal from anywhere in the app, with the current folder's child-file priority. Background controls are inert and their shortcuts are masked. **Open** enters the chosen file's editor; selecting its filename navigates to it. Both save an active draft before switching files. Folders open in navigation mode. Escape or **Exit search** closes the overlay; Escape inside the search field first returns to results. Browser clipboard shortcuts retain their native behavior.

**App settings → appearance** can hide line numbers or show zero-based line indices modulo four as viewport edge tabs. The left side is the low bit: gray/gray = 0, white/gray = 1, gray/white = 2, white/white = 3.

## Images and layered drawings

**Draw…** asks for SVG, PNG, JPEG, HEIC, or ORA before creating an inline drawing. **+svg** is the direct SVG shortcut. **Insert image** copies a user-selected PNG/JPEG/HEIC/ORA image beside the current note, using the note's own storage. The directives are `\svgpage[...]`, `\pngpage[...]`, `\jpegpage[...]`, `\heicpage[...]`, and `\orapage[...]`; autocomplete, outgoing links, global search, and backlink updates support each format. Existing image files can also be connected through the local picker and opened independently.

The image editor draws strokes over the original pixels. PNG, JPEG and HEIC save actual encoded images. JPEG flattens transparency onto white. HEIC encoding and decoding run in a bundled WebAssembly worker; no image contents leave the device except files explicitly saved in a GitHub folder. Image export and text exports containing images support PDF, PNG, and JPEG.

ORA saves an OpenRaster ZIP with `mimetype`, `stack.xml`, PNG layers and `mergedimage.png`. Its editor selects, adds, deletes, hides/shows, and reorders layers while retaining opacity. The supported stack uses flat layers and normal (`svg:src-over`) blending; nested groups or other blend modes produce an error rather than silently changing the image. HEIC edits use the primary image. Image edits preserve pixels/layers, not camera metadata. Editor limits are 128 MB encoded, 32 megapixels, 16,384 pixels per side, 100 ORA layers, and 256 MB expanded ORA data.
