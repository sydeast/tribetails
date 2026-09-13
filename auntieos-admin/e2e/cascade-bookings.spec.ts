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
 * Resolves a CSS colour expression (a token, or a `color-mix` over one) to the
 * same normalized form `getComputedStyle().borderTopColor` returns, by making
 * the browser parse it. Comparing a raw token against a computed value as
 * strings would fail on formatting alone, and comparing them loosely would
 * stop the test from noticing a real colour change.
 */
async function resolveBorderToken(
  page: import('@playwright/test').Page,
  expression: string,
): Promise<string> {
  return page.evaluate((e: string) => {
    const probe = document.createElement('div');
    probe.style.display = 'none';
    probe.style.borderColor = e;
    document.body.append(probe);
    const value = getComputedStyle(probe).borderTopColor;
    probe.remove();
    return value;
  }, expression);
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

test('a card without `lift` keeps its hairline on hover; a card with it takes the orange', async ({
  page,
}) => {
  /**
   * WHAT THIS PROVES CHANGED WITH #755, and the change is worth stating. This
   * test used to pin an ORDERING fight: `.bookings__row-main--static:hover`
   * had to be emitted after `.bookings__row-main:hover` to cancel a hover fill
   * the two tied on specificity for. The restyle removed the fill. The card
   * is the `<li class="bookings__row">` now, the mock's `.bk`, and its hover
   * treatment is the mock's: the hairline turns brand orange at 30%, applied
   * by base.css's `.lift:hover` through `--lift-border-color`. The static
   * variant is not a cancelling rule any more; it is the card WITHOUT the
   * class, which is the only mechanism (`BookingRow` withholds `lift` when no
   * handler is wired). So the pair below asserts the class is what decides.
   *
   * A PROBE PAIR, mounted into the live document, for the same reason as
   * before: `src/screens/Bookings.tsx` renders the static branch only when no
   * `onSelectBooking` handler is wired, and the router mounts that screen
   * propless, so every card in the running app wears `lift`. The probe
   * carries the exact class lists `BookingRow` writes, against the exact
   * stylesheets the app loaded. What is synthetic is the mounting, not the
   * cascade.
   */
  const hairline = await resolveBorderToken(page, 'var(--color-hairline)');
  const orangeHairline = await resolveBorderToken(
    page,
    'color-mix(in srgb, var(--tt-kinfolk-orange) 30%, transparent)',
  );
  expect(orangeHairline, 'the two hover states must be distinguishable').not.toBe(hairline);

  await page.evaluate(() => {
    const mount = document.createElement('ul');
    mount.id = 'cascade-probe';
    // Pinned over the top-left corner and given real size, because a
    // zero-height element cannot be hovered and the test would then prove
    // nothing while passing.
    mount.style.cssText =
      'position:fixed;top:0;left:0;width:320px;z-index:9999;list-style:none;margin:0;padding:0;';
    mount.innerHTML = `
      <li class="bookings__row" id="probe-static" style="height:60px">static</li>
      <li class="bookings__row lift" id="probe-interactive" style="height:60px">interactive</li>
    `;
    document.body.append(mount);
  });

  const staticCard = page.locator('#probe-static');
  const interactiveCard = page.locator('#probe-interactive');

  // POSITIVE CONTROL FIRST. If the lifted card does not take the orange, then
  // either `page.hover` is not producing a `:hover` match or `Bookings.css`
  // (which sets `--lift-border-color`) never loaded, and the static card's
  // "still the hairline" result below would be a false pass.
  await interactiveCard.hover();
  await expect(interactiveCard).toHaveCSS('border-top-color', orangeHairline);

  await staticCard.hover();
  await expect(staticCard).toHaveCSS('border-top-color', hairline);
});
