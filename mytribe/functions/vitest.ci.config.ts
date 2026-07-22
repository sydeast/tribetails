import { defineConfig } from 'vitest/config';

/**
 * CI config: the in-project functions suite only.
 *
 * The default `vitest.config.ts` also globs `../scripts/test/**`, the operator
 * seed-script tests. Those reach OUTSIDE this project into `mytribe/scripts/`,
 * which has no package.json of its own and relies on `functions/node_modules`
 * through tsconfig paths. On a warm local `node_modules` they resolve and pass,
 * but under a clean-install CI run firebase-admin's internal CommonJS require
 * (`./default-namespace`) fails to resolve from that cross-boundary location, so
 * the whole "MyTribe functions" job went red the first time a `mytribe/functions`
 * change triggered it. Those tests have never actually run green in CI.
 *
 * This config gates what the job name means: the backend callable + dispatcher
 * tests, including the AO-8 callable-contract drift guard. The scripts tests keep
 * running under `npm test` locally; giving them a working CI home (their own
 * install or a resolve fix) is tracked as a separate follow-up rather than
 * blocking every functions PR on orphaned infra.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'test/rules/**'],
    testTimeout: 10000,
  },
});
