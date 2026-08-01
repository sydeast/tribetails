import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the AuntieOS admin e2e harness.
 *
 * Run it with `npm run e2e` from `auntieos-admin/`, never with a bare
 * `npx playwright test`: the emulators have to be up first, and the npm script
 * is what wraps this in `firebase emulators:exec`. A bare run fails in
 * globalSetup with a connection refused, which is the correct failure but a
 * confusing one.
 *
 * WHY THIS EXISTS, given 3270 passing unit tests: jsdom has no cascade, no font
 * loading and no layout, so two of last week's defects were invisible to every
 * one of those tests. Fraunces had never rendered since the port, because
 * `tokens.css` named a family that no `@font-face` declares. And two rules lost
 * a cascade fight that is only decidable once Vite has emitted the bundle, in
 * emit order. `typography.spec.ts` and `cascade.spec.ts` are aimed straight at
 * those two failure classes. Everything else here exists to get a real browser
 * past the Firebase auth gate, which is what stopped anyone driving these
 * screens before.
 */

const PORT = 5174; // matches vite.config.ts's dev port
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The react VISUAL surface is opt-in, and the gate is not a convenience.
 *
 * Capture rewrites 20 git-tracked PNGs under `visual/react/`. The runbook's
 * standing complaint about the desktop surface is that `DesktopScreenshotTest`
 * is an ordinary member of `jvmTest` and so re-captures everything as a side
 * effect of an unrelated gradle run. Registering the project only when
 * `VISUAL_CAPTURE=1` means `npm run e2e` can never do that here, and the spec
 * file simply matches no project the rest of the time.
 *
 * It also swaps the seed. `seed.visual.ts` layers extra fixed-date rows on top
 * of `seed.ts` so the screenshots have content; the ordinary suite keeps the
 * exact database it has always had, counts included.
 */
const CAPTURING_VISUALS = process.env.VISUAL_CAPTURE === '1';

export default defineConfig({
  testDir: '.',
  // Relative to this file, so artifacts land in e2e/.artifacts (gitignored
  // there) rather than in the package root next to dist/.
  outputDir: './.artifacts',
  // The emulator is one shared database with one seed, so parallel workers
  // would race each other's reads and writes. Serial is not a limitation to
  // lift later, it is what makes an assertion about a seeded row mean anything.
  workers: 1,
  fullyParallel: false,
  // A stray `.only` silently narrows CI to one test and still reports green.
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI === undefined ? [['list']] : [['list'], ['html', { open: 'never' }]],
  globalSetup: CAPTURING_VISUALS ? './seed.visual.ts' : './seed.ts',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // Signs in once through the real form and saves storageState. Specs that
    // need an operator session depend on this rather than each re-typing a
    // password, which would put the sign-in round trip in front of every
    // assertion in the suite.
    { name: 'setup', testMatch: /auth\.setup\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'signed-out',
      testMatch: /(typography|cascade|signin)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'operator',
      testMatch: /(bookings|no-production-egress|mobile-nav|phone-layout)\.spec\.ts/,
      dependencies: ['setup'],
      use: { ...devices['Desktop Chrome'], storageState: './e2e/.auth/operator.json' },
    },
    // Capture-only, and only when asked for. Viewport, scale, timezone, locale
    // and reduced motion are set by the spec's own `test.use`, next to the
    // reasons for each.
    ...(CAPTURING_VISUALS
      ? [
          {
            name: 'visual',
            testMatch: /visual\.capture\.spec\.ts/,
            dependencies: ['setup'],
            use: { ...devices['Desktop Chrome'], storageState: './e2e/.auth/operator.json' },
          },
        ]
      : []),
  ],

  webServer: {
    // `--strictPort`: without it vite silently walks to 5175 when 5174 is busy,
    // and every spec then drives whatever app is already on 5174. Refusing to
    // start is the honest outcome.
    //
    // `--host 127.0.0.1`: vite's default bind is `localhost`, which on a
    // dual-stack machine listens on ::1 only. The dev server then comes up,
    // prints its banner, and every request to 127.0.0.1 is refused, so the run
    // dies on a webServer timeout that says nothing about the cause. Binding
    // the same literal address the specs dial removes the resolution step
    // entirely. The emulators bind 127.0.0.1 too, so the app, the browser and
    // Firebase all agree on one address family.
    command: `npm run dev -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    // The one variable that puts src/lib/firebase.ts on the emulator. Nothing
    // in the deploy path sets it.
    env: { VITE_E2E_EMULATOR: '127.0.0.1' },
    // Never reuse: a dev server that was already running was started WITHOUT
    // that variable, so it points at production Firebase, and the suite would
    // sign in against real data.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 120_000,
  },
});
