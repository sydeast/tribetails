import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Includes:
    //   - functions/test/**/*.test.ts           — backend callable + dispatcher tests
    //   - functions/src/**/*.test.ts            — colocated unit tests for pure lib
    //                                            modules (PR30: paymentMethods.ts),
    //                                            kept beside the code they cover
    //                                            rather than mirrored under test/
    //   - ../scripts/test/**/*.test.ts          — operator seed-script unit tests
    //                                            (no Firestore deps; pure payload validators)
    include: ['test/**/*.test.ts', 'src/**/*.test.ts', '../scripts/test/**/*.test.ts'],
    exclude: ['node_modules/**', 'test/rules/**'],
    // firebase-admin must be required by Node, not processed by Vite.
    //
    // The scripts tests import `mytribe/scripts/*.ts`, which sits OUTSIDE this
    // project and has no package.json of its own. Importing firebase-admin from
    // there put Vite's CJS interop in charge of a package whose own entry does
    // `require('./default-namespace')`, and that relative require resolved
    // against the importer's cross-boundary location instead of the package's
    // own directory: "Cannot find module './default-namespace'".
    //
    // It only ever passed on a WARM node_modules, where a prior optimize pass
    // had cached a working bundle. Any cold install (CI, a fresh worktree)
    // failed, which is why vitest.ci.config.ts had to drop these suites and why
    // they had never once run green in CI. Externalizing hands resolution back
    // to Node, which resolves relative requires against the package itself.
    server: { deps: { external: [/firebase-admin/] } },
    coverage: { provider: 'v8', reporter: ['text', 'lcov'] },
    testTimeout: 10000,
  },
});
