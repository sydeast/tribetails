import { defineConfig } from 'vitest/config';

// Pure-logic package, no DOM: the moved routeMap tests never needed jsdom or
// jest-dom setup in mytribe/web, so this mirrors that rather than adding
// either back.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
