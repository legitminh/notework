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

Every state starts with non-navigation tools above a divider: **search**, then **app settings** at home or **configure folder/file** elsewhere. Folder views also offer **create new file/folder** above the divider. Below the divider are graph-navigation actions: a house icon for home, **..**, and outgoing state buttons. The state display sits underneath. Selecting a file shows an **open: filename** title button and a separate read-only preview. The preview shows an **open** bar on hover or keyboard focus. Clicking a point in the preview opens the editor at that document or drawing position; the title button opens from the start. Home is the virtual root folder: its children can come from different machine sources and browser storage. Home and other folders share the same creation screen.

In app settings, **add existing folder/file** opens one local chooser. Drop mixed files/folders and the app identifies their handles automatically. Or use **browse location…**, grant read access to a folder in the OS dialog, and select files or folders inside it. Browser APIs do not provide one mixed native OS picker. The browsing location is temporary; only confirmed item handles are remembered. Cancelling adds nothing.

Folders expose their direct children. Existing directed links and hidden-child settings from older versions remain readable. `..` follows the filesystem parent within a granted source, returning home at its boundary; unselected ancestors cannot be discovered by a web app.

The **search** button opens an input-frame menu with **search text in folder children** (Cmd/Ctrl+F), **search file in folder children** (Cmd/Ctrl+P), **search text in all files** (Cmd/Ctrl+Shift+F), and **search file in all files** (Cmd/Ctrl+Shift+P). Folder modes start at the current folder (the containing folder when a file is selected); all-file modes start at Home. All modes are case insensitive. Filename search matches file and folder names/paths across the chosen scope of the active graph, including resources connected through saved links. Removing an item from root excludes it and its descendants from search and link suggestions, even if retained source handles, cached nodes, or old links remain. Reconnecting the item restores searchability. Hidden children stay hidden, cycles are deduplicated, and parent navigation is excluded from traversal. Whole-graph filename results sort by most recent edit, with names and paths breaking ties. Machine and browser files use their modification dates; GitHub files use draft dates or their latest path-specific commit date when available. Search checks names before fetching file contents, and matches composed and decomposed Unicode spellings alike. Folder results navigate normally; file results provide paired **open** and filename actions for either immediate editing or navigation. Search reports progress, supports stopping, and caps traversal at 20,000 states or 1,000 results. Press **Esc** or click **esc · search results** to leave the search field without clearing your query. **Edit search** returns to typing. During relocation, folder results also offer **choose**.

**Search text in folder children** and **Cmd/Ctrl+F** in navigation search literal, case-insensitive text in the current folder's recursive children and directed links. **Search text in all files** and **Cmd/Ctrl+Shift+F** search the entire active graph. When a file is selected, folder modes use its containing folder. Parent navigation, hidden branches, removed root items, images, Notework drawings, undecodable files, and `.git` metadata are excluded. Each matching file shows up to three highlighted previews with line numbers; selecting one opens the editor at that position. In the editor, Cmd/Ctrl+F retains its existing document search behavior.

Content search builds an in-memory substring index in a dedicated Web Worker. One-, two-, and three-character inverted postings narrow candidates before exact verification, so punctuation, spaces, and short queries work without tokenization or stemming. File reads are bounded to four in flight; unchanged size/modification timestamps reuse indexed text. Queries do no filesystem reads. The index survives closing the dialog, but is rebuilt after reloading the tab; no copied file contents or index are persisted or uploaded. Results stream during indexing. **Stop indexing** pauses background work and keeps partial results. **Refresh index** resumes it; otherwise, window focus and a 30-second refresh while the dialog is open pick up external changes. Results initially show 200 matching files, with **show more results** available; discovery has no fixed file-count cutoff. The index stores text and postings in browser memory, so very large collections remain limited by available memory. Esc leaves the query field, then closes the dialog.

## Text editing

Readable files use the plain-text CodeMirror editor unless they are Notework drawings. Supported images open in the image editor. For other files, byte validation accepts valid UTF-8 and BOM-marked UTF-16, including Unicode control characters, and preserves encoding/BOM and line endings on save. Files with undecodable bytes and `.git` metadata stay hidden. An unreadable file keeps its graph links so they work again if the file becomes readable. HTML and ordinary SVG remain inert editable source.

- **Tab** accepts the selected suggestion or indents with **two spaces** when there is no suggestion; **Shift-Tab** outdents.
- Parentheses, brackets, braces, and quotes pair automatically.
- Undo/redo and Ctrl/Cmd-F search use standard editor bindings.
- **App settings → Appearance → Vim mode** enables standard Vim editing keys and is off by default. In Vim mode, `:w` saves and Ctrl+F pages forward; use the magnifying glass for Find and Replace.
- Selecting a file keeps navigation available. Activating its preview switches to an isolated editor whose toolbar stays at the top while the document scrolls beneath it.
- **Exit** (Ctrl+Esc), **Find and replace** (Ctrl+F), **Draw…**, **Insert image**, **Fold**, and **Export** are the text toolbar actions. Command+B inserts an SVG directly. The shortcut labels appear on hover. There is no Save button.
- **Fold** toggles the current line’s indented children. Hover a parent line to show an arrow over its last character and click to toggle. The parent stays visible with `▸` appended while closed; its children, links, images, drawings, and embedded pages disappear. Cursor movement keeps folds closed, and opening a parent preserves any nested folds. Vim supports `zc`, `zo`, `za`, recursive `zC`/`zO`, all-fold `zM`/`zR`, `zf` with a motion, and `:fold`, `:foldopen`, and `:foldclose`. Folds apply to the open editor and do not change the saved text.
- Press **Esc** while editing with Vim off or from Vim's Normal mode to use toolbar shortcuts. Vim Insert and Visual modes still return to Normal first. In tool mode the title becomes **Edit {page name}**; click it or press **Esc** again to resume. Clicking or tapping a toolbar tool keeps the current mode.
- Text and SVG files autosave after changes, at most once per the interval configured in **App settings → Autosave** (4 seconds by default). Exit finishes saving to local storage before returning to navigation. GitHub publishing continues in the background. A machine file only prompts for write permission from an explicit exit or save shortcut; if saving fails, the editor stays open with the edits available for retry or export. Ctrl+S and Vim `:w` remain available as immediate saves.

The editor virtualizes its viewport and streams text reads/writes instead of rendering a collection or converting an entire collection into one string. There is no former 2 MB preview truncation. A multi-megabyte/60,000-line document is covered by browser tests. A single open document still uses editor memory, so capacity is not unlimited.

On its own line, `\prettify` (also `\pretty`) formats the text below it as an outline until `\unpretty`. A line becomes a bold heading when the next line is more indented. Parent text uses Keyflow’s color distributor at `(256, 32, depth)`: the highest parents start at red, and each child level uses the next hue. Text lightness is 25% in light mode and 75% in dark mode, with no background highlight. Non-parent outline text is black. Pretty follows the standard HTML heading scale, using the regular editor font size as its unit. A parent node with no parent is h1, its child parents are h2, and so on, based on actual ancestors rather than the number of indentation spaces. Embedded pages continue the surrounding hierarchy. The h1–h6 font sizes are 2, 1.5, 1.17, 1, 0.83, and 0.67 units. Space above and below each heading is respectively 0.67, 0.83, 1, 1.33, 1.67, and 2.33 times that heading’s size. Deeper headings keep the h6 style. The editor implements this spacing as block padding so CodeMirror measures it correctly.

Leading spaces and tabs keep their normal width. **App settings → Appearance → Pretty font sizing** is on by default. Turn it off to keep a consistent font size while retaining bold headings and their spacing. **Pretty margin** independently toggles the extra space above and below headings.

Inline symbol shorthands display all 24 Greek letters: `\alpha` → α through `\omega` → ω, with an initial capital for uppercase (`\Alpha` → Α, `\Sigma` → Σ, `\Lambda` → Λ, `\Pi` → Π). Variants include `\varsigma` → ς, `\varepsilon` → ϵ, `\vartheta` → ϑ, `\varpi` → ϖ, `\varrho` → ϱ, and `\varphi` → ϕ. Use `\aleph` → ℵ, `\itg` → ∫, and `\sqr` → √ for the other symbols. Autocomplete offers these commands inline with their symbols. Moving the caret into a shorthand reveals its editable source; saved text retains the commands, while previews, embedded pages, and PDF/PNG/JPEG exports show the symbols. Names are case-sensitive; unknown commands and doubled backslashes stay literal.

Use `\pretty1[LINES]` to format a block and then return to regular text, or `\unpretty1[LINES]` to show a block as regular text and turn formatting on afterward. The brackets can enclose multiple lines.

Type `\` on its own line and choose a command from autocomplete. Accepting `\pretty` moves the caret to the start of a new, unindented line. The editor hides the switch lines when the caret leaves them, while keeping their original line numbers in the document.

On its own line, `\page[path]` embeds another connected file as a read-only view. Names, graph paths, resource URIs, and relative paths resolve within the active graph. Leading spaces or tabs indent the referenced contents, and the current pretty mode and hierarchy colors carry into the embedded view. The referenced file’s own formatting switches still apply. Click the view to open that file at the clicked position; press Escape for its toolbar, then Cmd/Ctrl+[ to return. Nested references are supported, with cycle and depth checks. Missing references show a message without creating or changing the target file. Saves record the directed link, and renaming or moving a target updates the directive.

**App settings → appearance → color theme** uses a Keyflow dropdown with **dark**, **light**, and **system**. System is the default and follows OS appearance changes; explicit choices persist.

## Export

**Export** in either editor opens a format dialog for PDF, PNG, or JPEG. It exports the current draft without saving it, including unsaved inline drawing strokes. Every format uses the same one-page layout with configurable margins, the editor’s font/colors/wrapping, formatted wiki links, and SVG strokes. Set each side in **App settings → export margins**, always in min-box units. Left, right, top, and bottom default to 1; zero and fractional values are supported. Margins add space around the content without changing wrapping or SVG proportions, using the current min-box size. Navigation, toolbars, the caret, and line numbers are excluded. PDF preserves SVG strokes as vector paths; PNG and JPEG render the same page as a single image. Very large raster pages are uniformly scaled to safe browser and iOS canvas limits rather than cropped or split.

In a browser, **Download** uses the browser’s regular download destination/settings. In an installed PWA, **Share** opens the OS file-sharing sheet for the selected format when supported; a download fallback is always available. The file is prepared before the final share tap, preserving the user gesture required by iOS. Cancelling sharing does not start a download. Export runs entirely on-device and works offline with the cached app shell; no note contents are uploaded.

## Wiki links and rename

Type `[[` in the editor to see matching files. Use the arrow keys and Enter to pick a file or **create: filename**. You can also type the link directly. Autosave creates any new targets beside the source file and makes the links available as outgoing navigation buttons. Removing a link removes its transition on the next autosave.

Use **Configure file → rename** or **Configure folder → rename** in navigation mode. Folder rename updates descendant paths, resource URIs, graph transitions, and saved links to those descendants. Drawing/image directive filenames are updated when the drawing is renamed. The editor toolbar is reserved for editing. For machine files, grant write access to the containing folder. Creating siblings and updating machine-file backlinks may prompt for write permission.

## Drawings

Choose **Draw… → SVG**, or press Command+B while editing text to insert a movable `\svgpage[filename.svg]` line and immediately enter drawing mode. A new SVG drawing is created beside the text file for convenience, but the directive is a graph resource reference like `[[FILE]]`: it may instead contain a unique name, graph path, or resource URI for a Notework SVG drawing in another folder or storage source. After leaving drawing mode, move the caret off the line to see the drawing and click it to draw inline again. **Delete drawing** removes the directive and its corresponding file after confirmation, including a newly created accidental drawing. The drawing toolbar supports brush, whole-stroke erasing for SVG, undo, redo, autosave, and export. Select the active Brush or Eraser again to open a nested Keyflow frame with a VerticalHoverSlider for its size. Brush widths survive save/reopen and export. Exit saves and returns to the open text draft. Text autosave records the referenced drawing as an outgoing navigation target, where it can also be opened on its own; rename updates the directive even across folders and storage sources.

To link an existing drawing, type `\` on its own line, select `\svgpage` with the arrow keys, and press **Tab**. You can also type `\svgpage[` directly. Inside the brackets, suggestions favor matching names and paths, then nearby drawings. Siblings come first among equally good matches, and downstream paths come before equally short upstream paths. Press **Tab** to insert the selected drawing reference.

Drawings are sibling SVG files in the note’s own storage: a local note creates a local SVG beside it, and a browser note creates an SVG in the same OPFS folder. A local drawing may request write permission when Draw… creates it or when the editor exits. Existing browser drawings from older versions remain accessible through their directed links. Drawing pages fit the available text page width, capped at 32 min-boxes. Both axes and stroke widths scale together when the screen rotates. One extra working page is 16 min-boxes tall at full page width and scales proportionally on smaller screens. Saves contain only the area used.

In a drawing, tap with **two fingers** to undo and **three fingers** to redo. Drag with two fingers to scroll, or pinch to zoom. Adding a second finger cancels the tentative drawing stroke. **App settings → draw with only physical stylus** is disabled by default and persists across reloads. When enabled, fingers use native scrolling/zooming and only pen input draws or erases; toolbar buttons still work with any input device.

Desktop pen and mouse input retains sampled ink if capture is lost or the input stream is interrupted, including during a focus or size change. Missing release events recover without joining the next stroke to the previous one. Finger cancellation still yields to touch gestures, and Escape explicitly discards the tentative stroke.

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

Notework checks connected GitHub branches every four seconds by default. Change **App settings → GitHub updates → GitHub check interval (seconds)** to adjust it. Checks pause while hidden or offline and run serially. Conditional ETag requests avoid spending the primary quota on unchanged branches; `Retry-After`, rate-limit resets, and server poll intervals are respected, with exponential backoff on failures. New snapshots update navigation and previews. Open editors keep their drafts and reconcile against the pulled branch when saved; an upstream deletion cannot evict an open draft. A four-second unconditional poll would cost about 900 requests/hour per repository against GitHub’s typical shared 5,000/hour authenticated budget; 304 responses do not count against that primary budget, but secondary limits can still apply.

The repository appears under Home. Notework checks for upstream changes on startup and when opening a repository folder or file. Autosave, **Cmd/Ctrl+S**, and Vim `:w` keep a draft in the browser. **Exit** publishes the finished edit as one `edit: filename` commit. Exit first saves an immutable sync job in IndexedDB and returns to navigation. The bottom progress bar reports publishing while navigation and editing remain available. Closing the tab leaves the job queued; startup, reconnecting, and periodic retries resume it. Newer autosaves are preserved while an older snapshot publishes. If GitHub has changed the same file since it was opened, the bottom bar offers **Review GitHub conflict** without interrupting the current editor. Open it when convenient, edit either version in the side-by-side dialog, and choose which to keep. Cancel or a failed push leaves the draft and sync job available for retry. Pending publication protects the same file from deletion or rename until sync finishes. Empty folders use a hidden `.gitkeep` file so they persist in Git.

An editor reopened from a pending draft remembers the exact content it started from. When that earlier draft finishes publishing, further edits continue from it without a false conflict. Delayed branch reads cannot replace a snapshot published while they were in flight. Divergent upstream edits still require conflict review.

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

The current dependency is **Keyflow 0.10.0** plus `BoundedText`, the persistent `HorizontalSlider`/`VerticalSlider`, single-line `TextBox` and `NumberBox` from upstream `main`, pinned to commit `53d5233440a93eb72f35e653f9a1d4a5d4468f8a`. It provides input frames, menus, and virtual keyboards, including directional flick keys. Notework defaults to the alphanumeric shortcut alphabet.

Navigation, configuration, picker, dialog, export and editor toolbar buttons use the library through `Control.svelte`. Ordinary buttons retain visibility-based automatic shortcuts, while modal dialog controls use stable persistent shortcuts. Relocate cancellation uses `StaticButton` with Escape; within the search popup, Escape first leaves the field and then closes the popup. The app adapter forwards accessible names, pressed states and existing editor shortcut annotations to the underlying button. Dialog scoping disables background controls and closed-dialog controls through Keyflow's native `disabled` prop, suspending their shortcuts while retaining their button elements.

App settings, file/folder configuration, search choices, and drawing-format choices use Keyflow's `SubKeyframe` through `Menu.svelte`. Theme, shortcut alphabet, keyboard layout, export format, and image-layer choices use the same library menu through `ChoiceMenu.svelte`. Menus support automatic shortcut labels, Up/Down, Home/End, Enter, Back/Escape, outside-click dismissal, and return focus. Nested menus own their shortcuts; Escape dismisses an open dropdown before its enclosing dialog. Focused items scroll into view using native scrolling.

The following remain native or app-owned because Keyflow does not provide equivalent controls or behavior:

- Rename and connection forms retain HTML validation and Enter submission; their Keyflow actions call `requestSubmit()` because library buttons have a fixed `type="button"`.
- Name/search/number inputs and picker checkboxes retain native editing and selection.
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

**Cmd/Ctrl+[** and **Cmd/Ctrl+]** move backward and forward through navigation history. In the editor, the same shortcuts move between previously edited files while the toolbar has focus; active text editing keeps its normal bindings. The two histories are separate, save drafts before changing editors, and discard the forward branch when a new destination is selected after going back.

Flick alpha uses three rows of ten keys. Flicking up on the top row enters digits and down on any letter enters uppercase. Escape's left/right gestures enter Backspace/Tab; its up/down gestures enter tilde/backtick. Space's gestures move the cursor in the corresponding direction. Tapping Escape leaves text entry without clearing the search query.

Holding Command or Ctrl shows shortcut hints for Copy, Paste, Save, and all four search modes. **Cmd/Ctrl+Shift+P** opens whole-graph filename search in a modal from anywhere in the app, with most recently edited files first. Background controls are inert and their shortcuts are masked. **Open** enters the chosen file's editor; selecting its filename navigates to it. Both save an active draft before switching files. Folders open in navigation mode. Escape or **Exit search** closes the overlay; Escape inside the search field first returns to results. Browser clipboard shortcuts retain their native behavior.

**App settings → appearance** can hide line numbers or show zero-based line indices modulo four as viewport edge tabs. The left side is the low bit: gray/gray = 0, white/gray = 1, gray/white = 2, white/white = 3.

## Visual documents

A **visual document** is a layered canvas, separate from the endless SVG page. Raster and vector layers sit in one picture, and it's backed by the [visual.editor](https://github.com/legitminh/visual.editor) engine. Create one with **create new file/folder → create visual document** and enter a canvas size, or with **Draw… → Visual document** in a note, which inserts `\visualpage[name/name.visual]`. A visual document is a page folder:

```
sketch/
  sketch.visual          ← plaintext organizer (open the folder's preview, or "Raw text" in the editor)
  sketch.layer-1.png     ← raster layer (cropped PNG + offset)
  sketch.ink-2.svg       ← vector layer (SVG with editable stroke samples)
```

The organizer lists one layer per line. Lines lower in the file are drawn on top, and each line gives the layer file and its top-left position:

```
\image_editor_config[width=1920, height=1080, history=100, history_mb=256, palette=#202733 #ffffff …]
\image_editor_state[tool=brush, color=#202733, brush=app.asset/editor.visual/brushes/basic-6-details.vbrush, brush_size=5, …]
\image_editor_brushes[app.asset/editor.visual/brushes/basic-1.vbrush, …]
\image_editor_raster[sketch.layer-1.png, 0, 0, name=Layer 1]
\image_editor_vector[sketch.ink-2.svg, 0, 0, name=Ink 2, opacity=0.8, hidden]
```

`\image_editor[\r[…]\v[…]\c[…]\s[…]\b[…]]` is an equivalent compact form. Every layer is a normal asset, so it shows up in the file tree and you can open, move, version or replace it on its own. If a layer file is missing, the editor names it in a notice and keeps its reference, so restoring the file restores the layer. The editor saves your tool, colour, brush, sizes, palette and active layer in the organizer, so the document reopens the way you left it.

When you open a document you get one toolbar above the canvas. It holds the **title**, capped at 16 characters and scrolling sideways when longer, then **Editor**, **Exit**, **Brush**, **Eraser**, **Lasso**, **Transform**, **Undo**, **Redo**, **Layer** and **Export**. The toolbar is a horizontal component stream: items flow left to right and fold onto the next line, like text, instead of scrolling sideways. Menus open over the whole toolbar and lay their controls out left to right, wrapping to a new line only when a row is full, so the canvas below stays as large as possible.

* **Editor**: zoom out, zoom in, pan, fit canvas, **Raw text**, plus the canvas resolution, zoom and save state. You can also pan with the right or middle mouse button, the space bar, or two fingers.
* **Brush / Eraser**: select the active tool again to open its panel. Brush size and opacity use Keyflow's horizontal sliders, whose step buttons get shortcuts that work even when the buttons are scrolled out of view. The brush panel also has a colour wheel (a hue ring around a turning saturation/value triangle, plus HSV and RGB sliders and hex), the palette, recent colours, brush types, and settings for each brush. These panels stay open while you paint; press Back or Escape to close them. Every menu extends down as far as the screen allows and only scrolls when it runs out of room. All settings are Keyflow controls (sliders, toggles, `NumberBox` and single-line `TextBox` fields), so the whole editor works from the keyboard, and every line of its UI is one min-box high.
* **Raster layers** paint with a Krita-style brush engine: opacity, flow, hardness, spacing, and pressure for size, opacity and flow. The eraser removes pixels.
* **Vector layers** store strokes. The eraser removes whole strokes, and the **lasso** selects only strokes that lie entirely inside it.
* **Lasso** draws a high-contrast selection outline. Drag inside it or by its corners to move or resize the selected content. **Clear** deletes it. Press **Lasso** again to go back to the brush or eraser you were using; the selection stays.
* **Transform** acts on the lasso selection, or on the whole active layer if nothing is selected. Turn on **All canvas** to transform every layer at once. Press **Transform** again to apply the transform and turn the tool off.
  * Drag a corner to stretch or shear (perspective).
  * Drag an edge midpoint to scale along that axis.
  * Drag inside to move.
  * While Transform is active, the toolbar also shows a **Rotate** slider and a **Scale** slider. The Scale slider ranges from ½× to 2× and returns to 1× after each adjustment.
  * If content ends up outside the canvas, leaving the tool asks whether to keep it outside, crop it to the canvas, or keep transforming.
  * The whole transform is one undo step.
* **Layer**: active layer, add raster or vector layers, delete, show/hide, raise/lower, an opacity slider, and rename. Layer changes are undoable along with painting. Undo stores only the 128 px tiles each operation touched, capped by `history` frames and `history_mb`.
* **Brush library:** `app.asset/editor.visual/brushes` is created in browser storage at Home the first time you open a visual document, and it's filled with the Krita basic pack. **Import brush…** converts Krita `.kpp`, GIMP `.vbr`, MyPaint `.myb` and `.vbrush` files into the library. Brush references are ordinary file references, so you can move brushes into a cloud folder or a GitHub folder and point documents at them.
* **Raw text** saves your work, then opens `sketch.visual` in the text editor. **Visual editor** in that toolbar saves the text and returns to the canvas.

Navigation previews show SVG files, including vector layers, as pictures rather than code.

PNG, JPEG, HEIC and ORA images open in the same engine and save in their own format.

### Developing with visual.editor

Notework depends on `visual.editor` through `link:../visual.editor`, so clone both repositories side by side:

```sh
git clone https://github.com/legitminh/visual.editor ../visual.editor
pnpm install        # links ../visual.editor; Vite compiles its TypeScript sources directly
pnpm dev
```

Changes to `../visual.editor/src` hot-reload in Notework. CI and the Pages deployment check out both repositories the same way.

## Images and layered drawings

**Draw…** asks for SVG, PNG, JPEG, HEIC, or ORA before creating an inline drawing. **Command+B** remains the direct SVG shortcut; there is no separate +svg toolbar button. **Insert image** copies a user-selected PNG/JPEG/HEIC/ORA image beside the current note, using the note's own storage. The directives are `\svgpage[...]`, `\pngpage[...]`, `\jpegpage[...]`, `\heicpage[...]`, and `\orapage[...]`; autocomplete, outgoing links, global search, and backlink updates support each format. Existing image files can also be connected through the local picker and opened independently. Raster erasers remove pixels from the active layer, including imported or previously saved pixels, rather than deleting whole strokes. Undo/redo restores these edits, and ORA erasing preserves the other layers.

The raster editor paints directly into pixel canvases. Its freehand lasso selects the enclosed pixels on the active layer, including imported content: clear, move, resize, and brush/erase clipping operate on that region. Undo/redo records each operation using changed 128-pixel tiles, with a 96 MB / 100-operation history budget. Layer changes participate in the same history. Unchanged layer PNGs are cached between saves. PNG, JPEG and HEIC save actual encoded images. JPEG flattens transparency onto white. HEIC encoding and decoding run in a bundled WebAssembly worker; no image contents leave the device except files explicitly saved in a GitHub folder. Image export and text exports containing images support PDF, PNG, and JPEG.

ORA saves an OpenRaster ZIP with `mimetype`, `stack.xml`, PNG layers and `mergedimage.png`. Its editor selects, adds, deletes, hides/shows, and reorders layers while retaining opacity. The supported stack uses flat layers and normal (`svg:src-over`) blending; nested groups or other blend modes produce an error rather than silently changing the image. HEIC edits use the primary image. Image edits preserve pixels/layers, not camera metadata. Editor limits are 128 MB encoded, 32 megapixels, 16,384 pixels per side, 100 ORA layers, and 256 MB expanded ORA data.

New raster files and inline raster drawings ask for width and height. The last accepted dimensions are remembered in this browser; the initial default is the viewport size. Imported images keep their original dimensions. Raster workspaces stay inside the editor viewport: wheel or pinch to zoom, use Pan, Space-drag, middle-drag, or a two-finger gesture to pan, and Fit canvas to recenter. Zooming out stops when the longest canvas edge is one Keyflow min-box. Panning always leaves part of the canvas visible. Two-finger and three-finger taps undo and redo; pen input temporarily suppresses palm gestures. SVG keeps its existing page-based workspace.

Keyflow menus own native scroll frames and paging controls. Their visible shortcut pools respect ancestor clipping, the visual viewport, and fixed/sticky overlays such as the virtual keyboard. Notework keeps native scrolling enabled.
