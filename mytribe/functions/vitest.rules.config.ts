import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/rules/**/*.test.ts'],
    // firebase-admin must be required by Node, not processed by Vite — the same
    // reason spelled out at length in vitest.config.ts:16-30, where letting Vite's
    // CJS interop own the package produced tests that only ever passed on a warm
    // node_modules and had never once run green in CI.
    //
    // notificationPrefsRoundTrip.test.ts:2-3 is the only file under test/rules/
    // that imports firebase-admin directly; every other one goes through
    // @firebase/rules-unit-testing. So this config had no reason to carry the line
    // until that file existed, and now it does.
    server: { deps: { external: [/firebase-admin/] } },
    testTimeout: 30000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
