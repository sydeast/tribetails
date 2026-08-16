import { defineConfig } from 'vitest/config';

/**
 * jsdom for the WHOLE package, which is a deliberate divergence from
 * mytribe/web and auntieos-admin.
 *
 * Both apps default to `environment: 'node'` and let a component spec opt into
 * jsdom per file with a `// @vitest-environment jsdom` comment, because the
 * great majority of their specs are plain logic and jsdom costs a few hundred
 * milliseconds of setup per file. This package is the other way round: every
 * module in it exists to reach into a running browser page. capture.ts replaces
 * `window.fetch`, `window.XMLHttpRequest` and `console`; overlay.ts builds a
 * shadow root; store.ts talks to IndexedDB. A node default here would mean
 * every file starting with the same opt-in comment, which is a rule that gets
 * forgotten exactly once and then produces a spec that cannot see the DOM it is
 * about.
 *
 * No setupFiles: the two apps load jest-dom matchers in theirs, and nothing
 * here asserts on rendered appearance. Adding one would be a dependency this
 * package does not otherwise have.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
