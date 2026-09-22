import { defineConfig } from 'vitest/config';

/**
 * The backfill and sweep emulator tests (issue #870).
 *
 * `mytribe/scripts/test/*.emulator.test.ts` are the only tests that prove a
 * backfill's real WRITE path against Firestore. The default and CI configs
 * include them too, but every one is `describe.runIf(FIRESTORE_EMULATOR_HOST)`,
 * so without an emulator they report skipped, and for a long time nothing
 * started one for them. Run this config only through
 * `npm run test:scripts:emulator`, whose `firebase emulators:exec` wrapper
 * exports FIRESTORE_EMULATOR_HOST into the child.
 *
 * The guard below fails the run outright when that variable is missing. A
 * suite made entirely of `runIf` blocks would otherwise pass while running
 * nothing, which is exactly how these tests went unrun.
 */
if (!process.env['FIRESTORE_EMULATOR_HOST']) {
  throw new Error(
    'vitest.scripts-emulator.config.ts: FIRESTORE_EMULATOR_HOST is not set, so every ' +
      'emulator test would skip and report green. Run `npm run test:scripts:emulator` instead.',
  );
}

export default defineConfig({
  test: {
    environment: 'node',
    // #871: `test/**/*.emulator.test.ts` adds the functions-side emulator tests
    // (the overdue cron over a real Firestore). They take firebase-admin through
    // src/lib/firestoreAdmin, which resolves from this package's node_modules.
    include: ['../scripts/test/**/*.emulator.test.ts', 'test/**/*.emulator.test.ts'],
    // Same reason as vitest.config.ts: firebase-admin must be required by Node,
    // not processed by Vite. The tests import it only through
    // ../scripts/lib/firebaseAdmin.ts, so they share the one copy the scripts
    // write with.
    server: { deps: { external: [/firebase-admin/] } },
    // The first Firestore call in a fresh process pays for the admin SDK's gRPC
    // channel coming up against a just-started emulator.
    testTimeout: 30000,
    // One emulator, several files that seed the same collection names. Each file
    // uses its own projectId, but running them one at a time keeps a failure in
    // one file from ever reading as a failure in another.
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
  },
});
