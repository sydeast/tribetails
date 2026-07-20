import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Includes:
    //   - functions/test/**/*.test.ts           — backend callable + dispatcher tests
    //   - ../scripts/test/**/*.test.ts          — operator seed-script unit tests
    //                                            (no Firestore deps; pure payload validators)
    include: ['test/**/*.test.ts', '../scripts/test/**/*.test.ts'],
    exclude: ['node_modules/**', 'test/rules/**'],
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
    testTimeout: 10000,
  },
});
