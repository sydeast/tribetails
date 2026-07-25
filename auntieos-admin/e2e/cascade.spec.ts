import { expect, test } from '@playwright/test';

/**
 * The two CSS cascade regressions from 2026-07-25, asserted on COMPUTED STYLE.
 *
 * Both were found by reading `dist/assets/index-*.css` by hand, because neither
 * is decidable from the source. A cascade fight between two rules of equal
 * specificity is settled by the order Vite EMITS them in, and emit order is a
 * property of the bundler's module graph, not of any one stylesheet. Reading
 * source CSS tells you what a rule says; only a browser tells you which rule
 * won. Asserting on the source text would have been a test that passed while
 * the app was wrong, which is the state these two shipped in.
 *
 * Everything here runs on `/signin`, unauthenticated, and that is not a
 * shortcut: `src/router.tsx` imports every screen eagerly, so `Bookings.css`
 * and `GlassSurface.css` are in the document on the sign-in route exactly as
 * they are everywhere else. The cascade under test is the real one.
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

test('.bookings__row-main--static:hover cancels the hover fill it is declared to cancel', async ({ page }) => {
  const surface2 = await resolveColorToken(page, '--color-surface-2');

  /**
   * A PROBE PAIR, mounted into the live document, and the reason is worth
   * stating rather than hiding. `src/screens/Bookings.tsx` renders the static
   * branch only when no `onSelectBooking` handler is wired, and the router
   * mounts that screen propless, so the screen supplies its own handler and
   * every row in the running app is the interactive `<button>`. The static
   * class combination is therefore not reachable by clicking through the app
   * today, while the rule that governs it is still emitted, still one class
   * plus a pseudo-class, and still one edit away from losing its ordering
   * again.
   *
   * So the probe carries the exact class list `BookingRow` writes, against the
   * exact stylesheet the app loaded. What is synthetic here is the mounting,
   * not the cascade: the rules, their order and the engine resolving them are
   * all the real ones.
   */
  await page.evaluate(() => {
    const mount = document.createElement('div');
    mount.id = 'cascade-probe';
    // Off to one side of the sign-in card and given real size, because a
    // zero-height element cannot be hovered and the test would then prove
    // nothing while passing.
    mount.style.cssText = 'position:fixed;top:0;left:0;width:320px;z-index:9999;';
    mount.innerHTML = `
      <div class="bookings__row-main bookings__row-main--static" id="probe-static" style="height:60px">static</div>
      <div class="bookings__row-main" id="probe-interactive" style="height:60px">interactive</div>
    `;
    document.body.append(mount);
  });

  const staticRow = page.locator('#probe-static');
  const interactiveRow = page.locator('#probe-interactive');

  // POSITIVE CONTROL FIRST. If the hover fill does not apply to the plain row,
  // then `page.hover` is not producing a `:hover` match at all, and the static
  // row's "no fill" result below would be a false pass. This orders the two
  // assertions so that failure mode is impossible to mistake for a success.
  await interactiveRow.hover();
  await expect(interactiveRow).toHaveCSS('background-color', surface2);

  await staticRow.hover();
  const staticHovered = await staticRow.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(
    staticHovered,
    'the static row took the interactive hover fill: `.bookings__row-main--static:hover` is emitted BEFORE `.bookings__row-main:hover` again, and ties on specificity',
  ).not.toBe(surface2);
  // `background: none` computes to a transparent background-color.
  expect(staticHovered).toBe('rgba(0, 0, 0, 0)');
});
