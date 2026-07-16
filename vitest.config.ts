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
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./test-setup.ts'],
  },
});
