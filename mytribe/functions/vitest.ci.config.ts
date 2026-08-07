import { defineConfig } from 'vitest/config';

/**
 * CI config: the backend suite plus the operator seed-script tests.
 *
 * HISTORY, because the exclusion here was load-bearing for a while. The default
 * `vitest.config.ts` also globs `../scripts/test/**`, which reaches OUTSIDE this
 * project into `mytribe/scripts/`, a directory with no package.json of its own.
 * Importing firebase-admin from there handed Vite's CJS interop a package whose
 * entry does `require('./default-namespace')`, and that relative require
 * resolved against the importer's cross-boundary location rather than the
 * package's own directory. It passed on a warm local `node_modules`, where an
 * earlier optimize pass had cached a working bundle, and failed on every cold
 * install. So this config dropped those 7 suites, 175 tests, and they had never
 * once run green in CI.
 *
 * `vitest.config.ts` now externalizes firebase-admin, handing resolution back to
 * Node, which resolves a package's relative requires against the package itself.
 * That holds cold, so the scripts tests come back here where a regression in the
 * seed and backfill scripts is actually caught before it ships.
 *
 * Kept separate from the default config only to keep `test/rules/**` (which needs
 * the Firestore emulator) out of the plain CI job.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // src/**/*.test.ts: colocated unit tests for pure lib modules (PR30:
    // paymentMethods.ts) — see vitest.config.ts for the full rationale.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', '../scripts/test/**/*.test.ts'],
    exclude: ['node_modules/**', 'test/rules/**'],
    server: { deps: { external: [/firebase-admin/] } },
    testTimeout: 10000,
  },
});
