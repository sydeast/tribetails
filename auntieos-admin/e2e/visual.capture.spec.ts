import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest } from './visual/manifest';
import { collisions, mapScreen, type Mapping } from './visual/routes';
import { VISUAL_LOCALE, VISUAL_NOW, VISUAL_OUT_DIR, VISUAL_TIMEZONE } from './visual/fixtures';

/**
 * The REACT surface of the visual harness: capture only.
 *
 * It photographs `auntie.tribetails.com`'s actual application. The other three
 * surfaces (`web`, `desktop`, `android`) all render the superseded Compose app,
 * so until this file existed the harness had zero pixels of the shipped admin.
 *
 * IT ASSERTS NOTHING ABOUT PIXELS, on purpose, and that is the same split
 * `DesktopScreenshotTest` and `AndroidScreenshotTest` already keep. Capture
 * writes `visual/react/<screen>.png`; the comparison is `web/visual/baseline.mjs`
 * verifying react alongside the other three, so there stays ONE tolerance policy
 * and ONE report. A `toHaveScreenshot()` here would be a second golden store
 * with a second threshold under `.artifacts/`, which is exactly the split the
 * runbook says not to create.
 *
 * IT REUSES THE E2E HARNESS RATHER THAN BUILDING A SECOND LOGIN. The emulators,
 * the seed, the vite dev server and the operator session all come from
 * `playwright.config.ts` and `auth.setup.ts` unchanged. The React admin has no
 * `window.__fb` bridge for `capture-web.mjs` to sign in through, and inventing a
 * second credential path was how the Compose surface came to need a `.env`
 * nobody has.
 *
 * IT IS OPT-IN. The project is only registered when `VISUAL_CAPTURE=1`, so a
 * routine `npm run e2e` cannot rewrite 20 tracked PNGs as a side effect. That
 * trap is not hypothetical: `:composeApp:jvmTest` re-captures the whole desktop
 * surface today because `DesktopScreenshotTest` has no opt-out.
 */

const manifest = readManifest();
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', VISUAL_OUT_DIR);
mkdirSync(outDir, { recursive: true });

const mapped = new Map<string, Mapping>(manifest.screens.map((s) => [s.screen, mapScreen(s)]));

/**
 * Viewport and scale match the Compose surfaces (`manifest.viewport` at 2x, so
 * 2880x1800 on disk), which keeps one number in the manifest meaning one thing.
 *
 * The rest of this block is the non-determinism pinning, and every line of it is
 * load-bearing:
 *
 *   reducedMotion  The three Den orbs drift on a 29s `orb-drift` keyframe and
 *                  every screen's blocks fade up on `rise`. Both are CSS
 *                  animations, so no amount of waiting settles them: the orbs
 *                  never stop. `base.css` already answers
 *                  `prefers-reduced-motion: reduce` with a global
 *                  `animation: none !important`, which parks every animation at
 *                  its resting state, so emulating the preference pins them
 *                  without the app learning that a screenshot harness exists.
 *   timezoneId     `lib/time.ts` formats in LOCAL time deliberately (the AO-18
 *                  fix), so the same document renders a different day heading
 *                  and clock time on a laptop in Chicago than on a UTC box.
 *   locale         Pins every Intl call: month names, number grouping, currency.
 *   colorScheme    Nothing in the app reads `prefers-color-scheme` today
 *                  (checked: zero occurrences in src/), and nothing sets
 *                  `data-theme`, so the app is light-mode only. Pinned anyway so
 *                  that adding a dark-mode media query later cannot silently
 *                  reshoot every golden.
 */
test.use({
  viewport: { width: manifest.viewport.width, height: manifest.viewport.height },
  deviceScaleFactor: 2,
  timezoneId: VISUAL_TIMEZONE,
  locale: VISUAL_LOCALE,
  colorScheme: 'light',
});

/**
 * Freezes the page's clock at `VISUAL_NOW`.
 *
 * `setFixedTime`, not `install`/`pauseAt`: it pins what `Date.now()` and
 * `new Date()` READ without pausing timers, so React's scheduler, the Firestore
 * listener and the router all keep running. Pausing the timer loop would stall
 * the app mid-render and photograph a spinner.
 *
 * This is the second half of the relative-timestamp fix. The seed writes its
 * dates against the same instant (`E2E_SEED_NOW`), so "in 3 days" is three days
 * on every run instead of drifting one heading per day until the golden fails.
 */
test.beforeEach(async ({ page }) => {
  // `reducedMotion` is not a top-level test option in this Playwright version, so
  // it is emulated on the page rather than declared in `test.use` above. Same
  // effect: the page reports `prefers-reduced-motion: reduce` from here on.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date(VISUAL_NOW));

  /**
   * Nothing leaves the machine.
   *
   * THE CALLABLE HALF OF THIS IS NOW REDUNDANT, and the comment that used to
   * stand here was wrong as of 2026-08-01. It said `src/lib/firebase.ts` never
   * calls `connectFunctionsEmulator`, so every callable dialled production
   * `us-central1` and failed on a schedule set by the network, giving two
   * different screenshots of one screen. That was true and it was the reason
   * this abort was introduced. `firebase.ts` now pins the Functions SDK at
   * `127.0.0.1:5399` for every e2e run, served by nothing, so a callable cannot
   * resolve to a deployed URL at all and always fails the same way in the same
   * few milliseconds. `e2e/no-production-egress.spec.ts` is what enforces that,
   * for the whole harness rather than for this surface.
   *
   * The abort stays anyway, narrowed to the job it still does: a golden must not
   * be decided by anything outside this machine, and that is a claim about ALL
   * requests, not only callables. A future module reaching an absolute URL by
   * hand, or a webfont escaping Vite's bundling, would each be a slow flake in
   * the screenshots and a silent one here. Blocking them costs a single route
   * handler. Nothing legitimate is blocked today: fonts are bundled and served
   * from the dev server, and the emulators are loopback.
   *
   * Do not read this as the production guard. That is `firebase.ts`, and it
   * applies whether or not a spec remembers to install a route.
   */
  await page.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname;
    const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return local ? route.continue() : route.abort('failed');
  });
});

/**
 * The route verification, run before any capture and reported in full.
 *
 * `manifest.json` was written for the Compose hash router and the React admin
 * uses TanStack paths, so the two disagree. This prints every mapping, every
 * rename, every reshaped detail route and every screen with no React route at
 * all. It fails only on a manifest that is unusable (an unnamed entry, a
 * duplicate name), never on an unmapped screen: "React does not have this
 * screen" is a finding to read, not a broken harness.
 */
test('route map: every manifest screen resolved against the React router', () => {
  const lines: string[] = [
    `manifest: ${manifest.counts.screens} screens` +
      (manifest.counts.pendingRemock > 0
        ? ` + ${manifest.counts.pendingRemock} pendingRemock (captured too: a regression golden needs a shipped screen, not an approved mockup)`
        : ' (no pendingRemock list in this manifest revision)'),
  ];
  for (const entry of manifest.screens) {
    const m = mapped.get(entry.screen);
    if (m === undefined) throw new Error(`unmapped screen ${entry.screen}`);
    const detail =
      m.kind === 'unmapped'
        ? `NO REACT ROUTE  ${m.reason}`
        : m.kind === 'open'
          ? `${m.url} + click "${m.button}"  (${m.note})`
          : `${m.url}${m.note ? `  (${m.note})` : ''}`;
    lines.push(`  ${entry.screen.padEnd(22)} ${entry.webRoute.padEnd(34)} -> ${detail}`);
  }
  for (const [url, screens] of collisions(mapped)) {
    lines.push(`  COLLISION: ${screens.join(', ')} all resolve to ${url}`);
  }
  const unmapped = [...mapped.values()].filter((m) => m.kind === 'unmapped').length;
  lines.push(`  ${mapped.size - unmapped} capturable, ${unmapped} with no React route.`);
  console.log(lines.join('\n'));

  expect(collisions(mapped), 'two manifest screens photographing one React URL').toEqual(new Map());
});

/**
 * Everything on screen that means "still loading".
 *
 * NOT a bare `[role="status"]`, which was the first attempt and was wrong:
 * `Home`, `Inbox`, `ActivityLog` and the Settings sections each keep a PERMANENT
 * `<p role="status">` live region for announcements, so that selector never
 * reaches zero on Home and the capture waited out its whole timeout on a screen
 * that had finished rendering. These three are the transient ones:
 *
 *   div[role=status][aria-live=polite]  AsyncRegion's loading branch, including
 *                                       the screens that pass a custom skeleton
 *                                       instead of the default line.
 *   .async-loading                      that default line, belt and braces.
 *   .den-stat-value--pending            a StatCard whose number has not arrived,
 *                                       which resolves independently of the
 *                                       region below it.
 */
const LOADING = 'div[role="status"][aria-live="polite"], .async-loading, .den-stat-value--pending';

/**
 * Waits until the screen is finished, not merely mounted.
 *
 * The single largest source of a flaky golden is shooting a screen mid-load, so
 * this waits on the app's OWN completion signal rather than on a sleep.
 *
 * A load that never clears FAILS the screen. A golden of a spinner is worse than
 * a missing golden, because the next run's spinner lands elsewhere and the diff
 * blames the UI.
 */
async function settle(page: Page): Promise<void> {
  await expect(page.locator('main')).toBeVisible();
  await expect(
    page.locator(LOADING),
    'something was still loading; capturing would photograph a spinner',
  ).toHaveCount(0, { timeout: 20_000 });
  // Web fonts resolve after first paint, and Fraunces vs the fallback serif is a
  // whole-page metric change. Awaited AFTER the regions settle, because a region
  // that mounts late can pull a face that was not needed before.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  // Two frames, so the last React commit and the font swap have both painted.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

for (const entry of manifest.screens) {
  const m = mapped.get(entry.screen) as Mapping;

  test(`capture ${entry.screen}`, async ({ page }) => {
    test.skip(m.kind === 'unmapped', m.kind === 'unmapped' ? m.reason : '');
    if (m.kind === 'unmapped') return;

    await page.goto(m.url);

    // The guard bounces a session it does not like to /signin, and a capture
    // that silently photographed the sign-in form under the name "invoices"
    // would be a golden of the wrong screen. Assert we are where we asked.
    const expectedPath = new URL(m.url, 'http://x').pathname;
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 15_000 })
      .toBe(expectedPath);

    await settle(page);

    if (m.kind === 'open') {
      const control = page.getByRole('button', { name: m.button, exact: true });
      await expect(control, `"${m.button}" is how this screen is reached`).toBeVisible();
      await control.click();
      await settle(page);
    }

    await page.screenshot({
      path: join(outDir, `${entry.screen}.png`),
      // Belt and braces over `reducedMotion`: Playwright also rewinds any
      // running CSS animation to its first frame before the shot, so an
      // animation added without a reduced-motion guard still lands identically.
      animations: 'disabled',
      // A blinking text cursor is one of the few things that differs between two
      // otherwise identical runs.
      caret: 'hide',
      scale: 'device',
    });
  });
}
