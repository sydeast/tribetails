import { defineConfig } from 'vitest/config';

// Standalone vitest config (takes precedence over vite.config.ts) so unit tests
// run without the React build plugin. Mirrors MyTribe/web deliberately: the two
// repos should feel the same to work in.
export default defineConfig({
  test: {
    // Default 'node'. Component specs opt into jsdom per-file with a leading
    // `// @vitest-environment jsdom` comment, so plain-logic specs (token
    // parity, formatters, mappers) keep running under the cheaper environment.
    environment: 'node',
    // `web/visual/**` is here for one file: the visual gate's verify step, `baseline.mjs`.
    // It is a build-time script rather than app code, so it has no home under `src/`, and
    // until #405 it had no runner anywhere in the repo, which is how the CI job around it
    // grew a step that deleted the goldens a branch committed, with nothing to notice.
    include: ['src/**/*.test.{ts,tsx}', 'web/visual/**/*.test.mjs'],
    setupFiles: ['./test-setup.ts'],
  },
});
