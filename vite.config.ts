import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit({ adapter: adapter() })],
  // visual.editor is linked from a sibling checkout (`link:../visual.editor`) and compiled from source.
  // native/ holds the desktop and iOS shells and their large build outputs; the dev server never needs to watch them.
  server: { fs: { allow: ['..'] }, watch: { ignored: ['**/native/**'] } }
});
