import { defineConfig } from 'vite';

/**
 * Builds the ONE artifact this package emits: `__recorder.js`, the
 * self-contained bundle the bookmarklet loads on the live sites.
 *
 * Everything else here is consumed as TypeScript source through each app's own
 * Vite setup, the way `@tribetails/geo` is. This config exists only because a
 * bookmarklet cannot import modules: it needs a single file that runs on
 * insertion, with rrweb inside it.
 *
 * IIFE, not ES. A `<script src>` without `type="module"` is what a bookmarklet
 * can inject on both sites without tripping their CSP, and a module build would
 * also defer execution, which reads as "the bookmark did nothing" for a beat.
 *
 * The output name is fixed rather than hashed. The bookmark is a URL saved in
 * somebody's browser years before the next build, so it has to keep pointing at
 * the same path.
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/bookmarklet.ts',
      formats: ['iife'],
      name: 'TribeTailsIssueRecorder',
      fileName: () => '__recorder.js',
    },
    // Bundled in, deliberately: the file has to stand alone on a site whose CSP
    // allows scripts from nowhere but itself.
    rollupOptions: { external: [] },
    // The apps' own builds write here too; this one owns its package's dist.
    outDir: 'dist',
    emptyOutDir: true,
    // `true`, not `'esbuild'`. Vite 8 bundles with rolldown and minifies with
    // oxc; naming esbuild makes it demand a separate esbuild install that this
    // repo does not have, and the build dies in a transpile plugin rather than
    // anywhere that mentions minification.
    minify: true,
    sourcemap: false,
  },
});
