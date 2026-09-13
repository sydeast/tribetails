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
  // The three status sections are the filter now (#704): there is no tab row
  // to wait on. This waits on the list toolbar they render under instead, the
  // same "the Bookings chunk's markup has landed" signal the tablist used to
  // give.
  await expect(page.getByRole('group', { name: 'Bookings list' })).toBeVisible();
});

test('the seeded visits arrive through the real rules and listener', async ({ page }) => {
  // All three sections are open at once (#704), so every seeded row is
  // already in the DOM with no section to open first. Same total assertion
  // this test has always made, summed across the three section lists rather
  // than read off one flat list.
  await expect(page.locator('.bookings__list li')).toHaveCount(4);

  for (const seeded of Object.values(SEEDED_BOOKINGS)) {
    await expect(page.getByText(seeded.kinfolkName, { exact: true })).toBeVisible();
  }
});

test('the three status sections count the real rows they hold', async ({ page }) => {
  // The browser-side half of `groupBookingsByStatus`. The unit tests classify
  // literals written in a test file; this classifies documents Firestore
  // returned, through the real listener, with production's mixed status
  // casing in them ('SCHEDULED', 'completed', 'CANCELLED'). The count lives in
  // the section's own heading chip now, not a stat card above the list
  // (#704).
  const pending = page.getByRole('group', { name: /^Pending approval/ });
  const scheduled = page.getByRole('group', { name: /^Scheduled/ });
  const history = page.getByRole('group', { name: /^History/ });

  // Nothing seeded is DRAFT or PENDING, so this section proves the empty
  // case honestly: a zero count, no rows.
  await expect(pending.locator('.bookings__section-count')).toHaveText('0');

  await expect(scheduled.locator('.bookings__section-count')).toHaveText('2');
  await expect(scheduled.locator('li')).toHaveCount(2);

  // History is open like the other two now (#704): its rows sit on screen
  // immediately, not behind a "Show N finished" press, and its heading count
  // matches them with no interaction first.
  await expect(history.locator('.bookings__section-count')).toHaveText('2');
  await expect(history.locator('li')).toHaveCount(2);
});

test('the section toolbar Select enters select mode', async ({ page }) => {
  // #701: Select sits on the list toolbar now, immediately above the sections
  // whose rows it picks, not only in the page header. Pressing it is what
  // reveals a real row's checkbox.
  const listBar = page.getByRole('group', { name: 'Bookings list' });
  const toggle = listBar.getByRole('button', { name: 'Select', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('checkbox')).toHaveCount(0);

  await toggle.click();

  // Both controls report the one mode, because there is only one mode (#701).
  for (const control of await page.getByRole('button', { name: 'Select', exact: true }).all()) {
    await expect(control).toHaveAttribute('aria-pressed', 'true');
  }
  await expect(
    page.getByRole('checkbox', {
      name: new RegExp(`Select ${SEEDED_BOOKINGS.scheduled.kinfolkName}`),
    }),
  ).toBeVisible();
});

test('a lowercase status is still classified as completed', async ({ page }) => {
  // `kin_care_sessions.status` casing is UNENFORCED: the seed writes
  // 'SCHEDULED', 'completed' and 'CANCELLED' because production holds all
  // three shapes. A classifier that compared raw strings would drop the
  // lowercase visit silently, and on the invoicing path that means not
  // billing for work that was done. This is the browser-side half of that
  // guarantee, read straight off the always-open History section.
  const history = page.getByRole('group', { name: /^History/ });
  const row = history
    .locator('.bookings__row')
    .filter({ hasText: SEEDED_BOOKINGS.completed.kinfolkName });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('COMPLETED', { exact: true })).toBeVisible();
});

test('the empty-section copy names what the section is waiting for', async ({ page }) => {
  // Nothing seeded is DRAFT or PENDING, so Pending approval is the section
  // that proves the empty case: it keeps its heading and its own honest
  // count, and says what it is waiting for instead of an empty panel with no
  // explanation.
  const pending = page.getByRole('group', { name: /^Pending approval/ });
  await expect(pending.locator('.bookings__section-count')).toHaveText('0');
  await expect(pending.locator('li')).toHaveCount(0);
  await expect(pending.getByText('Nothing is waiting on a reply.')).toBeVisible();
});

test('a real booking card takes the hover hairline, and its row button takes no fill', async ({
  page,
}) => {
  // The counterpart to `cascade-bookings.spec.ts`'s probe pair, on a card the
  // app truly rendered. Since #755 the card is the mock's `.bk` (the `<li>`),
  // and its hover treatment is the mock's own: the hairline turns brand orange
  // at 30%, through `lift`'s `--lift-border-color`. There is no hover FILL on
  // the row any more, on the card or on the button inside it, so this proves
  // both halves: the border changes, the button does not paint.
  const card = page.locator('.bookings__row').first();
  await expect(card).toHaveClass(/lift/);

  const orangeHairline = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    probe.style.borderColor = 'color-mix(in srgb, var(--tt-kinfolk-orange) 30%, transparent)';
    document.body.append(probe);
    const value = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return value;
  });

  await card.hover();
  await expect(card).toHaveCSS('border-top-color', orangeHairline);
  // `background: none` on the row button computes to a transparent colour.
  await expect(card.locator('.bookings__row-main')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
});