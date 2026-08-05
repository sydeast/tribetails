import { expect, test } from '@playwright/test';

/**
 * The `/signin` half of the two CSS cascade regressions from 2026-07-25,
 * asserted on COMPUTED STYLE.
 *
 * Both were found by reading `dist/assets/index-*.css` by hand, because neither
 * is decidable from the source. A cascade fight between two rules of equal
 * specificity is settled by the order Vite EMITS them in, and emit order is a
 * property of the bundler's module graph, not of any one stylesheet. Reading
 * source CSS tells you what a rule says; only a browser tells you which rule
 * won. Asserting on the source text would have been a test that passed while
 * the app was wrong, which is the state these two shipped in.
 *
 * WHY THE BOOKINGS ROW MOVED OUT, to `cascade-bookings.spec.ts`. This file used
 * to hold both, on the stated grounds that `src/router.tsx` imported every
 * screen eagerly, so `Bookings.css` was in the document on the sign-in route
 * exactly as it is everywhere else. That is no longer true: the screens are
 * code-split, `Bookings.css` ships with the Bookings chunk, and on `/signin`
 * the browser has never seen `.bookings__row-main`. The old test would have
 * failed its own positive control, correctly, because the premise it named is
 * the thing the split deleted. Its replacement asserts the same two rules in
 * the same way, on `/bookings`, where the stylesheet under test is loaded.
 *
 * `GlassSurface.css` is unaffected and stays here: SignIn is one of the two
 * modules deliberately left in the entry chunk, so the glass surface it renders
 * is in the entry stylesheet, on the sign-in route, exactly as before.
 */

/**
 * Resolves a CSS custom property to the same normalized form
 * `getComputedStyle().backgroundColor` returns, by making the browser parse it.
 * Comparing a raw token (`#f4f2ec`) against a computed value (`rgb(244, 242,
 * 236)`) as strings would fail on formatting alone, and comparing them loosely
 * would stop the test from noticing a real colour change.
 */
async function resolveColorToken(page: import('@playwright/test').Page, token: string): Promise<string> {
  return page.evaluate((t: string) => {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    probe.style.backgroundColor = `var(${t})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, token);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/signin');
  await expect(page.locator('.signin__card')).toBeVisible();
});

test('.signin__card fill beats .glass-surface, so no field label sits on the gradient', async ({ page }) => {
  const card = page.locator('.signin__card');

  // Both classes really are on the element. If a refactor drops
  // `.glass-surface` the fight disappears and this test would otherwise pass
  // for the wrong reason.
  await expect(card).toHaveClass(/glass-surface/);
  await expect(card).toHaveClass(/signin__card/);

  const [actual, opaque, glass] = await Promise.all([
    card.evaluate((el) => getComputedStyle(el).backgroundColor),
    resolveColorToken(page, '--color-surface'),
    resolveColorToken(page, '--color-surface-glass'),
  ]);

  expect(
    actual,
    'the card took GlassSurface.css\'s translucent fill, so the Tribe gradient reads through every label and input on this screen',
  ).toBe(opaque);
  expect(actual).not.toBe(glass);
  // Independent of the token values: a translucent card is the defect, whatever
  // colour it happens to be. `--color-surface-glass` is 0.8 alpha in light and
  // 0.6 in dark, so alpha alone separates win from loss in either theme.
  expect(actual, 'the sign-in card must be fully opaque').not.toMatch(/rgba\([^)]*,\s*0?\.\d+\s*\)/);
});
