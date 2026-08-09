import { expect, test } from '@playwright/test';
import { SEEDED_BOOKINGS } from './fixtures/accounts';

/**
 * One authenticated data screen, end to end: a real operator session, real
 * security rules, a real Firestore listener, real rows.
 *
 * This is the spec that proves the harness is worth having. Everything it
 * touches is a join between layers that no unit test spans: the `isAuntie()`
 * rule admitting the claim `auth.setup.ts` signed in with, `BOOKINGS_QUERY`
 * ordering on `createdAt` (a real Timestamp) while `startTime` is an ISO
 * string, and `bookingFormat`'s state mapping run over documents Firestore
 * actually returned rather than over a literal in a test file.
 *
 * A permission-denied here reads as an empty list, not as an error, which is
 * exactly why asserting on seeded rows by name is the assertion that means
 * something.
 */

test.beforeEach(async ({ page }) => {
  await page.goto('/bookings');
  await expect(page.getByRole('tablist', { name: 'Filter bookings' })).toBeVisible();
});

test('the seeded visits arrive through the real rules and listener', async ({ page }) => {
  const list = page.locator('.bookings__list');
  // The two finished visits sit in History, which opens on request, so they are
  // not in the DOM until this press. Everything after it is the same assertion
  // this test has always made.
  await page.getByRole('button', { name: 'Show 2 finished' }).click();

  // Four since 2026-08-01, when `SEEDED_BOOKINGS.today` was added so that
  // Schedule's agenda (which lists the SELECTED day, defaulting to today) has a
  // row to render at all. The loop below is what carries the weight; the count
  // is here so an unexpected EXTRA row is a failure too.
  await expect(list.locator('li')).toHaveCount(4);

  for (const seeded of Object.values(SEEDED_BOOKINGS)) {
    await expect(page.getByText(seeded.kinfolkName, { exact: true })).toBeVisible();
  }
});

test('the three status sections count the real rows they hold', async ({ page }) => {
  // The browser-side half of `groupBookingsByStatus`. The unit tests classify
  // literals written in a test file; this classifies documents Firestore
  // returned, through the real listener, with production's mixed status casing
  // in them ('SCHEDULED', 'completed', 'CANCELLED').
  const pending = page.getByRole('group', { name: /^Pending approval/ });
  const scheduled = page.getByRole('group', { name: /^Scheduled/ });
  const history = page.getByRole('group', { name: /^History/ });

  // Nothing seeded is DRAFT or PENDING, so this section proves the empty case:
  // it keeps its heading and says what it is waiting for.
  await expect(pending.locator('.bookings__section-count')).toHaveText('0');
  await expect(pending.getByText('Nothing is waiting on a reply.')).toBeVisible();

  await expect(scheduled.locator('.bookings__section-count')).toHaveText('2');
  await expect(scheduled.locator('li')).toHaveCount(2);

  // The count is honest while the rows are still collapsed: that is the whole
  // point of putting it in the heading.
  await expect(history.locator('.bookings__section-count')).toHaveText('2');
  await expect(history.locator('li')).toHaveCount(0);
  await history.getByRole('button', { name: 'Show 2 finished' }).click();
  await expect(history.locator('li')).toHaveCount(2);
});

test('a status chip collapses the screen to that one section', async ({ page }) => {
  await page.getByRole('tab', { name: 'Cancelled' }).click();
  await expect(page.getByRole('group', { name: /^History/ })).toBeVisible();
  await expect(page.getByRole('group', { name: /^Pending approval/ })).toHaveCount(0);
  await expect(page.getByRole('group', { name: /^Scheduled/ })).toHaveCount(0);
  // Asked for by name, so History is open: a second press to see what the chip
  // already named would be asking twice.
  await expect(page.getByText(SEEDED_BOOKINGS.cancelled.kinfolkName, { exact: true })).toBeVisible();
});

test('a lowercase status is still classified as completed', async ({ page }) => {
  // `kin_care_sessions.status` casing is UNENFORCED: the seed writes
  // 'SCHEDULED', 'completed' and 'CANCELLED' because production holds all
  // three shapes. A filter that compared raw strings would drop the lowercase
  // visit silently, and on the invoicing path that means not billing for work
  // that was done. This is the browser-side half of that guarantee.
  await page.getByRole('tab', { name: 'Completed' }).click();

  const list = page.locator('.bookings__list');
  await expect(list.locator('li')).toHaveCount(1);
  await expect(page.getByText(SEEDED_BOOKINGS.completed.kinfolkName, { exact: true })).toBeVisible();
});

test('a filter that matches nothing says so instead of showing an empty panel', async ({ page }) => {
  await page.getByRole('tab', { name: 'Draft' }).click();
  await expect(page.getByText('Nothing matches this filter.')).toBeVisible();
});

test('a real booking row takes the hover fill', async ({ page }) => {
  // The counterpart to `cascade-bookings.spec.ts`'s probe pair, on a row the app truly
  // rendered. That spec proves the static override wins its ordering fight
  // against a mounted probe; this one proves the rule it overrides is live on
  // a real screen, so neither half can rot into a test of nothing.
  const row = page.locator('.bookings__row-main').first();
  await expect(row).toHaveClass(/lift/);

  const surface2 = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    probe.style.backgroundColor = 'var(--color-surface-2)';
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  });

  await row.hover();
  await expect(row).toHaveCSS('background-color', surface2);
});
