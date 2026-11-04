# Notework agent instructions

This project uses SvelteKit 3 and Svelte 5, with Vite and TypeScript. Configuration belongs in `vite.config.ts` (SvelteKit 3 does not use `svelte.config.js`). Check installed package types and current official SvelteKit documentation before changing framework configuration.

- Keep filesystem access browser-side. Machine files are limited to user-selected handles; request write permission only from an explicit Save or Rename action. New documents belong in app-owned OPFS. Never add a server endpoint exposing the host filesystem.
- Import Keyflow components and styles from the `@legitminh/keyflow` library dependency. Do not copy library source into this repository; keep app policies such as native scrolling in Notework.
- Scrolling must remain native; do not enable lockstep or honor a saved lockstep preference.
- Root is an empty virtual state. Filesystem direct children and configured directed links define transitions; parent navigation is not part of search traversal.
- Handles, resource URIs, and directed graph metadata are saved in IndexedDB; new document contents live in OPFS. Do not upload file contents. Hide non-text resources and `.git` metadata. Prune confirmed missing resources and all their graph edges; permission denial is not deletion.
- Run `pnpm check`, `pnpm build`, and relevant Playwright tests after functional changes. Browser fixtures must use isolated test storage, not personal filesystem paths.
