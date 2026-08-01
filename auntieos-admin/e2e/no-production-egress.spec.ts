import { expect, test } from '@playwright/test';

/**
 * The one spec that is about the harness rather than about the app: an e2e run
 * must not be able to talk to anything but the emulators and its own dev server.
 *
 * WHY IT EXISTS. Until 2026-08-01 `src/lib/firebase.ts` connected the auth and
 * Firestore emulators and left `functions` on its default resolver, so every
 * `httpsCallable` in a run resolved to
 * `https://us-central1-auntieos-ttpc.cloudfunctions.net/<name>`. Loading `/home`
 * fired ten POSTs at production per visit. Nothing came back (an emulator token
 * is an unsigned `alg:none` JWT and production rejects it before the handler,
 * and production's CORS preflight does not allow the dev-server origin), so the
 * suite still reported green while sending real traffic to a real backend on
 * every run. Nobody noticed for the same reason nobody would notice again: the
 * only symptom was widgets rendering their error state on a screen no assertion
 * looked at.
 *
 * A comment cannot enforce that. This can. The fix is
 * `connectFunctionsEmulator`, and this spec is what fails if it is removed,
 * bypassed, or if some new module reaches an absolute URL by hand.
 *
 * IT ASSERTS ON REQUESTS, NOT RESPONSES. A request that is blocked by CORS or
 * refused by a firewall has still left the machine, still carried an
 * Authorization header, and still resolved a production hostname. "It failed
 * anyway" is not the property being defended.
 *
 * The allowlist is two entries, both loopback, and it is deliberately not
 * "anything on localhost": naming the ports is what would catch the app dialling
 * a real emulator port somebody left running (9099, 8085, 5001) instead of the
 * e2e ones.
 */

/** Dev server 5174, auth 9399, firestore 8385, functions 5399 (reserved, unserved). */
const ALLOWED = /^http:\/\/127\.0\.0\.1:(5174|9399|8385|5399)(\/|$)/;

/** Not network traffic: the page's own inline and generated resources. */
const NOT_NETWORK = /^(data|blob|about|chrome-error|chrome):/;

test('no request in an authenticated run leaves the emulator', async ({ page }) => {
  const escaped: string[] = [];

  page.on('request', (request) => {
    const url = request.url();
    if (NOT_NETWORK.test(url) || ALLOWED.test(url)) return;
    escaped.push(`${request.method()} ${url}`);
  });

  // `/home` is the screen that carried the defect: five widgets, five callables
  // on first paint. If the pin is ever lost this is where it shows.
  await page.goto('/home');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Callables are fired from effects, and a failed one is retried. Settle past
  // both rather than sampling the first paint, which the pre-fix code would
  // also have passed.
  await page.waitForTimeout(5000);

  await page.goto('/bookings');
  await expect(page.getByRole('tablist', { name: 'Filter bookings' })).toBeVisible();
  await page.waitForTimeout(2000);

  expect(
    escaped,
    'an e2e run reached a host outside the emulator; see src/lib/firebase.ts',
  ).toEqual([]);
});

/**
 * The other half of the ruling. Blocking the traffic is worth little if the
 * resulting failure reads as `FirebaseError: internal`, which is what a
 * production outage reads as too. `lib/fns.ts` turns the refused localhost
 * connection into a sentence that names the callable and says what to do, and
 * `AsyncRegion` puts it on screen. This asserts the whole chain, so nobody can
 * quietly widen the catch in `fns.ts` back to a generic rethrow.
 */
test('an unstubbed callable fails loud, on screen, naming itself', async ({ page }) => {
  await page.goto('/home');

  const panel = page.locator('.den-panel', { hasText: 'Supplies tracker' });
  const alert = panel.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('listSupplies was called in e2e emulator mode');
  await expect(alert).toContainText('e2e runs never reach production callables');
});

/**
 * And the escape hatch works. A spec that genuinely needs a callable stubs it
 * against the localhost URL the SDK now dials, which is only possible BECAUSE it
 * dials localhost: `page.route` cannot intercept what the browser sends to
 * production before CORS kills it, and could not have been used before this fix.
 *
 * This is the pattern `docs/runbooks/e2e.md` points new specs at, kept honest by
 * being executed rather than only written down.
 */
test('a spec that needs a callable can stub it against the pinned localhost port', async ({
  page,
}) => {
  await page.route('**/127.0.0.1:5399/**/listSupplies', async (route) => {
    await route.fulfill({
      // The callable wire format: the payload lives under `result`.
      json: {
        result: {
          lowCount: 1,
          supplies: [{ _id: 'e2e-supply-1', name: 'Poop bags', onHand: 2, par: 10, unit: 'rolls' }],
        },
      },
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  });

  await page.goto('/home');

  const panel = page.locator('.den-panel', { hasText: 'Supplies tracker' });
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByText('Poop bags')).toBeVisible();
});
