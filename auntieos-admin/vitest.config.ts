import { defineConfig } from 'vitest/config';

// Standalone vitest config (takes precedence over vite.config.ts) so unit tests
// run without the React build plugin. Mirrors MyTribe/web deliberately: the two
// repos should feel the same to work in.

// CI gets a runner to itself and should use all of it. A developer's machine is
// shared with every other suite, agent and compiler running on it, and that is
// the situation the cap below exists for. See the `maxWorkers` note in `test`.
const SHARES_THE_MACHINE = !process.env.CI;

export default defineConfig({
  test: {
    // Default 'node'. Component specs opt into jsdom per-file with a leading
    // `// @vitest-environment jsdom` comment, so plain-logic specs (token
    // parity, formatters, mappers) keep running under the cheaper environment.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./test-setup.ts'],
    // #842: pinned explicitly rather than left to Vitest's own default so a
    // future major version can't silently flip it. This is what clears a
    // module-level `vi.fn()`'s call count and arguments before every test:
    // without it, a test's `toHaveBeenCalledTimes`/`toHaveBeenCalledWith`
    // assertion can pass or fail depending on what the PREVIOUS test in the
    // file called the same mock with. `mockReset`/`restoreMocks` stay off:
    // several mocks across this suite carry a default implementation set
    // once in their `vi.mock(...)` factory that no per-test `beforeEach`
    // re-establishes, and either option wipes that default before the
    // file's own first test.
    clearMocks: true,

    // Bound how much of the machine ONE run takes. See #455.
    //
    // This is the half of the fix that actually holds the tail down, and it
    // has to come first because the timeout below is sized against it.
    //
    // Vitest defaults to one worker per core, so on a 10-core machine each run
    // claims all ten. That is fine alone and ruinous in company: the failure
    // in #455 was six agents running THIS suite at once, which is sixty
    // processes fighting over ten cores. Every test then runs at a fraction of
    // its speed, and the specs that drive wizards through `userEvent`, already
    // the longest in the suite, are the ones that fall off the end.
    //
    // Five is close to free. The suite averages 448% CPU over its 56s unloaded
    // run, so its own natural parallelism is about 4.5; capping at 5 gives up
    // little when the machine is quiet. What it buys is a ceiling when the
    // machine is not: six concurrent runs come to thirty processes rather than
    // sixty, which is the 3x oversubscription the timeout below is measured
    // against.
    //
    // NOT on CI, which is why this is conditional. CI runs on `ubuntu-latest`,
    // which has far fewer than ten cores, and there a flat `maxWorkers: 5`
    // would raise parallelism above the core count rather than cap it, making
    // the exact problem it is meant to prevent. CI also runs this suite alone,
    // so it should have the whole runner.
    //
    // The option is the top-level `maxWorkers`, not the
    // `poolOptions.forks.maxForks` that older Vitest docs and answers give.
    // Vitest 4 removed `poolOptions` entirely, and an unknown key here is
    // ignored at runtime rather than rejected, so that spelling looks like it
    // works and silently does nothing. `npm run typecheck` is what catches it:
    // it fails with "'poolOptions' does not exist in type 'InlineConfig'".
    ...(SHARES_THE_MACHINE ? { maxWorkers: 5 } : {}),

    // A per-test budget sized from measurement, not from taste. See #455.
    //
    // Vitest's 5000ms default was chosen for a suite whose tests take tens of
    // milliseconds. Ours does not: this is 113 jsdom component specs, and the
    // heaviest of them drive a multi-step wizard through `userEvent`, whose
    // every interaction yields to the real event loop. On an unloaded machine
    // that is still comfortable -- the slowest test in all 5224 measures
    // 1677ms, and nothing at all crosses 2s -- so the default looks generous
    // right up until the machine is busy.
    //
    // It very often is. Developers and agents run several suites at once, and
    // the same machine is compiling Kotlin and running `tsc` besides. Measured
    // with three copies of this suite running together, the same tests stretch
    // 3.9x at the median and 13.2x at p95, because a contended event loop
    // delays exactly the timer yields `userEvent` is built on. The tail then
    // lands at 12.1s (p99.9) and 16.8s (slowest), which is how a suite that is
    // green alone produces 7 to 32 `Test timed out in 5000ms` failures in
    // files the change never touched.
    //
    // 30000 clears that measured worst case by 1.8x. It is deliberately not a
    // licence for slow tests: nothing here needs more than 1.7s of real work,
    // and a test that genuinely hangs still reports, just 30s later.
    //
    // This number only means anything BECAUSE of the fork cap above, and that
    // was established the hard way. Raising the budget to 30000 on its own was
    // tried and measured, and on a machine loaded to ten times its core count
    // it still produced twelve `Test timed out in 30000ms` failures, the worst
    // at 33.7s. A budget alone does not bound anything -- it only moves the
    // cliff, because the time a starved test needs grows with the load and the
    // load has no ceiling. The cap is what supplies the ceiling; 30000 is then
    // sized to clear it. Do not raise one without re-measuring the other.
    testTimeout: 30000,
    // `beforeEach` hooks in these specs render and seed the same trees, so they
    // are subject to the same stretch. Keeping the two budgets equal means a
    // slow machine cannot fail in the hook instead of the test.
    hookTimeout: 30000,
  },
});
