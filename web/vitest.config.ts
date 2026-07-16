import { defineConfig } from 'vitest/config';

// Standalone vitest config (takes precedence over vite.config.ts) so unit
// tests run without the React/PWA build plugins.
export default defineConfig({
  test: {
    environment: 'node',
    // Component specs opt into jsdom per-file via a leading
    // `// @vitest-environment jsdom` comment (see SignedImageUpload.test.tsx /
    // Account.test.tsx) rather than flipping the default here, so every
    // existing plain-logic *.test.ts file keeps running under the cheaper
    // 'node' environment.
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./test-setup.ts'],
  },
});
