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
  await expect(list.locator('li')).toHaveCount(3);

  for (const seeded of Object.values(SEEDED_BOOKINGS)) {
    await expect(page.getByText(seeded.kinfolkName, { exact: true })).toBeVisible();
  }
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
  // The counterpart to `cascade.spec.ts`'s probe pair, on a row the app truly
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
