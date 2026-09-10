import { expect, test } from '@playwright/test';

/**
 * The `/bookings` half of the 2026-07-25 CSS cascade regressions, asserted on
 * COMPUTED STYLE. Read `cascade.spec.ts` first; the reasoning is there and this
 * file is the same test on a different page.
 *
 * IT RUNS SIGNED IN, ON `/bookings`, and the move is the whole point. It used
 * to run on `/signin` because `src/router.tsx` imported every screen eagerly,
 * which put `Bookings.css` in the document on every route. The screens are now
 * code-split, so `Bookings.css` arrives with the Bookings chunk and `/signin`
 * has never parsed a `.bookings__row-main` rule. Asserting there would prove
 * nothing about a rule the browser has not read.
 *
 * The page the rules apply to is where they are now checked, which is stricter
 * than before: this also fails if the Bookings chunk's stylesheet stops being
 * loaded at all.
 */

/**
 * Resolves a CSS custom property to the same normalized form
 * `getComputedStyle().backgroundColor` returns, by making the browser parse it.
 * Comparing a raw token (`#f4f2ec`) against a computed value (`rgb(244, 242,
 * 236)`) as strings would fail on formatting alone, and comparing them loosely
 * would stop the test from noticing a real colour change.
 */
async function resolveColorToken(
  page: import('@playwright/test').Page,
  token: string,
): Promise<string> {
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
  await page.goto('/bookings');
  // Not just "the URL changed": the route's chunk and ITS STYLESHEET have to
  // have landed before any rule below can win or lose anything. The list
  // toolbar is the same signal `bookings.spec.ts` waits on now that the
  // filter tab row is gone (#704), and it is rendered by the Bookings chunk,
  // so seeing it means the chunk arrived.
  await expect(page.getByRole('group', { name: 'Bookings list' })).toBeVisible();
});

test('.bookings__row-main--static:hover cancels the hover fill it is declared to cancel', async ({
  page,
}) => {
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
    // Pinned over the top-left corner and given real size, because a
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
  // then either `page.hover` is not producing a `:hover` match or `Bookings.css`
  // never loaded, and the static row's "no fill" result below would be a false
  // pass. This orders the two assertions so that failure mode is impossible to
  // mistake for a success.
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
