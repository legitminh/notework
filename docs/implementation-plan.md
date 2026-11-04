# Notework implementation plan

## Current scope

A SvelteKit application presenting a directed graph of text-file and folder resources, using the external Keyflow library with native scrolling.

1. Replace the Next.js starter with SvelteKit 3 / Svelte 5 / Vite / TypeScript and a static build.
2. Import `@legitminh/keyflow` and its CSS from a pinned GitHub dependency. Remove copied source and provide `pnpm update:keyflow`. Keep the forced native-scroll policy in Notework.
3. Render search, a divider, app settings or parent, and one button per outgoing state; display state content underneath. Remove Configure.
4. Use one **add existing folder/file** chooser with automatic mixed-handle drop detection and folder-based native browsing. Keep only confirmed handles, never upload/copy observed files, and discard the temporary browsing location.
5. Keep graph handles/location URIs/edges in IndexedDB. Use app-managed local-handle URIs and OPFS URIs instead of pretending browsers expose absolute machine paths.
6. Create new text documents in OPFS before adding their nodes. Roll back creation if the graph cannot be committed. Show storage quota/persistence controls.
7. Use CodeMirror for all decodable text: two-space Tab indentation, Shift-Tab, bracket pairs, undo/redo, find/replace, isolated editing, explicit save, unsaved-exit confirmation, write grants for machine files, export, and safe failure recovery. Stream I/O and virtualize the editor viewport for large notes. Preserve UTF-8/UTF-16 encodings and line endings.
8. Hide non-text/binary resources and `.git` metadata by inspecting content, not extensions. Search outgoing reachable text states with cycle detection and cancellation; exclude the parent control.
9. Prune confirmed missing resources and descendants, all incident graph edges, shortcuts, and caches. Check at startup, navigation/refresh, focus, and periodically. Never confuse permission loss or quota exhaustion with deletion.
10. Provide an installable/offline production shell with a web manifest and service worker; keep note contents in OPFS, outside HTTP caches.
11. Verify Svelte/TypeScript, production builds, browser workflows, multi-megabyte notes, safe write failure, graph cleanup, and offline editing.

## Limits

The web platform has separate native file and directory dialogs, so one app chooser supports mixed drops or choosing a folder to browse for either kind. Machine filesystem grants remain user-selected and read-only until an explicit Save requests writing. No server endpoint exposes the host filesystem.

Browser storage is origin/profile-specific and quota-limited. Persistence can be requested but does not protect against manual clearing. Export backups remain necessary. Installation does not provide unlimited storage. Filesystem changes between checks are discovered at the next check.

OPFS is suitable for large text or binary data; the current app deliberately presents only decodable text. Existing graph metadata is migrated without discarding valid observations or saved directed links.
