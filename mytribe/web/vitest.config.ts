import { defineConfig } from 'vitest/config';
// Standalone vitest config (takes precedence over vite.config.ts) so unit
// tests run without the React/PWA build plugins.
// CI gets a runner to itself and should use all of it. A developer's machine is
// shared with every other suite, agent and compiler running on it, and that is
// the situation the cap below exists for. Mirrors auntieos-admin, which
// established both the shape and the reasoning (#455).
const SHARES_THE_MACHINE = !process.env.CI;
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
    // #842: pinned explicitly rather than left to Vitest's own default so a
    // future major version can't silently flip it. This is what clears a
    // module-level `vi.fn()`'s call count and arguments before every test:
    // without it, a test's `toHaveBeenCalledTimes`/`toHaveBeenCalledWith`
    // assertion can pass or fail depending on what the PREVIOUS test in the
    // file called the same mock with. `mockReset`/`restoreMocks` stay off:
    // several mocks across this suite carry a default implementation set
    // once in their `vi.mock(...)` factory (e.g. `getBusinessContact` in
    // InvoiceDetail.test.tsx) that no per-test `beforeEach` re-establishes,
    // and either option wipes that default before the file's own first test.
    clearMocks: true,
    // Bound how much of the machine ONE run takes. See #492, which is #455
    // applied here: the admin suite got this treatment and this one, with the
    // same shape of specs, did not.
    //
    // The cap is the half that actually holds the tail down, and it has to come
    // first because the timeout below is sized against it.
    //
    // Measured on this suite, on a 10-core machine. Alone: 560 tests in 6.2s,
    // p95 138ms, slowest test 365ms, nothing anywhere near a deadline. With six
    // copies of it running at once -- the #455 situation, several agents in
    // several worktrees -- p95 goes to 5.2s and the slowest test to 11.3s, and
    // each run fails 32 to 36 tests. Nothing about the tests changed; they were
    // starved of the event loop that `userEvent` yields to at every interaction.
    //
    // Five, the same number the admin suite settled on. This suite's own
    // natural parallelism is 6.5 (40.2s of CPU over a 6.2s wall clock), so a
    // cap of five gives up very little on a quiet machine. What it buys is a
    // ceiling on a busy one: six concurrent runs become thirty processes rather
    // than the sixty that produced the numbers above.
    //
    // NOT on CI, and the carve-out is load-bearing rather than tidiness. CI
    // runs on `ubuntu-latest`, which has fewer than ten cores, so a flat
    // `maxWorkers: 5` there would RAISE parallelism above the core count --
    // causing the exact problem it exists to prevent. CI also runs this suite
    // alone and should have the whole runner.
    //
    // The option is the top-level `maxWorkers`, not the
    // `poolOptions.forks.maxForks` that older Vitest docs give: Vitest 4
    // removed `poolOptions` entirely and ignores it silently at runtime, so
    // that spelling looks like it works and does nothing. `npm run typecheck`
    // is what catches it -- it fails with "'poolOptions' does not exist in type
    // 'InlineConfig'".
    ...(SHARES_THE_MACHINE ? { maxWorkers: 5 } : {}),
    // A per-test budget sized from measurement, not from taste.
    //
    // Vitest's 5000ms default was chosen for suites whose tests take tens of
    // milliseconds. This one is 23 jsdom component files, 18 of them driving
    // forms and wizards through `userEvent`, and unloaded it clears the default
    // by more than 13x. Loaded, it does not: 5.2s is this suite's p95 under six
    // concurrent copies, which is to say the default deadline lands exactly in
    // the middle of the distribution and cuts a third of the run.
    //
    // 30000 clears the measured worst case, 11.3s, by 2.7x, and matches the
    // admin suite so the two behave the same way for anyone moving between
    // them. It is not a licence for slow tests: nothing here needs more than
    // 365ms of real work, and a test that genuinely hangs still reports, just
    // 30s later.
    //
    // This number only means anything BECAUSE of the cap above. Raising the
    // budget alone was tried on the admin suite and measured to fail -- with
    // 30000 and no cap it still produced twelve timeouts, worst at 33.7s --
    // because the time a starved test needs grows with the load and the load
    // has no ceiling. Do not raise one without re-measuring the other.
    testTimeout: 30000,
    // `beforeEach` hooks in these specs render and seed the same trees, so they
    // are subject to the same stretch. Keeping the two budgets equal means a
    // slow machine cannot fail in the hook instead of the test.
    hookTimeout: 30000,
  },
});
