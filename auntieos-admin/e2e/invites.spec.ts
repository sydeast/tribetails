import { expect, test } from '@playwright/test';

/**
 * The admin-wide invites screen, reached from the rail and failing loud.
 *
 * WHAT THIS HARNESS CAN AND CANNOT PROVE HERE. `npm run e2e` starts
 * `--only auth,firestore` (see package.json): there is NO functions emulator,
 * so `listAllInvites` — a callable, not a Firestore query — cannot succeed in
 * this environment and no assertion about seeded invite ROWS is possible. That
 * is a limit of the harness, not of the screen, and inventing a mock callable
 * to fake a green list would prove nothing about either.
 *
 * What it can prove is the half no unit test spans, and it happens to be the
 * half the fail-loud rule is about: with a real bundle, a real router and a
 * real signed-in session, a failing read renders an ERROR that names the
 * callable, and does NOT render an empty shelf reading "No invites have been
 * sent". Those two states say opposite things about the business, and this is
 * the only place the real failure path can be driven.
 *
 * It also proves the rail entry actually resolves. `AppShell.railLinks.test.ts`
 * asserts the slug is in `LIVE_LINKS`; only a browser can show that clicking it
 * lands on a mounted route rather than the router's not-found.
 */

test('the rail entry lands on the invites screen', async ({ page }) => {
  await page.goto('/home');

  await page
    .locator('[aria-label="Primary navigation"]')
    .getByRole('link', { name: /^Invites( \d+)?$/ })
    .click();

  await expect(page).toHaveURL(/\/invites$/);
  await expect(page.getByRole('heading', { name: "Every household's invites." })).toBeVisible();
});

test('a failing read says so and names the callable, instead of an empty shelf', async ({
  page,
}) => {
  await page.goto('/invites');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('listAllInvites failed');
  // The claim an empty list would make, which is the one thing a failed read
  // must never make on the operator's behalf.
  await expect(page.getByText('No invites have been sent from any household yet.')).toHaveCount(0);
  // And no filter chips: counting rows nobody could read would be the same lie
  // in a smaller font.
  await expect(page.getByRole('button', { name: /^Outstanding/ })).toHaveCount(0);
});
