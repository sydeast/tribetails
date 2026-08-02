import { expect, test } from '@playwright/test';
import { railEntries } from '../src/lib/nav';

/**
 * The admin's navigation on a phone-shaped viewport.
 *
 * WHY THIS IS NOT A UNIT TEST. The defect was one CSS rule:
 * `styles/shell.css` answered `@media (max-width: 720px)` with
 * `.shell__rail { display: none }` and put nothing in its place, so the element
 * labelled "Primary navigation" was hidden and every screen in the admin was
 * reachable by typing its URL and by nothing else. jsdom has no cascade and no
 * layout, so not one of the suite's unit tests could see that, and none of them
 * can see the fix either. `AppShell.test.tsx` owns the behaviour (the toggle's
 * state, focus, Escape, the destination set); this file owns the only claim
 * that needs a real viewport and a real stylesheet: at 390px the navigation is
 * visible, usable, and gets you to another screen.
 *
 * 390x844 is an iPhone 12/13/14 CSS viewport, comfortably inside the 720px
 * breakpoint and narrow enough that a layout which merely tolerates a tablet
 * still fails here.
 */

test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  // The rail slides in on a transform. Without this the first assertion after a
  // click races the transition and reads a panel that is still off-screen.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/home');
});

const rail = '[aria-label="Primary navigation"]';

test('at phone width the rail is hidden and a toggle stands in its place', async ({ page }) => {
  await expect(page.locator(rail)).toBeHidden();

  const toggle = page.getByRole('button', { name: 'Navigation' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('the toggle opens the drawer, and it holds every rail destination', async ({ page }) => {
  await page.getByRole('button', { name: 'Navigation' }).click();

  const panel = page.locator(rail);
  await expect(panel).toBeVisible();
  // Actually on screen, not merely `visibility: visible` at translateX(-100%).
  const box = await panel.boundingBox();
  expect(box, 'the drawer has no box at all').not.toBeNull();
  expect(box?.x, 'the drawer is still parked off the left edge').toBeGreaterThanOrEqual(0);
  expect(box?.width ?? 0).toBeGreaterThan(200);

  // One navigation landmark, not two: the drawer IS the rail.
  await expect(page.locator(rail)).toHaveCount(1);

  for (const entry of railEntries()) {
    await expect(
      panel.getByRole('link', { name: new RegExp(`^${entry.title}( \\d+)?$`) }),
      `${entry.title} is unreachable on a phone`,
    ).toBeVisible();
  }
});

test('a destination in the drawer actually navigates, and the drawer gets out of the way', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Navigation' }).click();
  await page.locator(rail).getByRole('link', { name: 'Invoices' }).click();

  await page.waitForURL('**/invoices');
  await expect(page.locator(rail)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Navigation' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('Escape closes the drawer and hands focus back to the toggle', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Navigation' });
  await toggle.click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator(rail)).toBeHidden();
  await expect(toggle).toBeFocused();
});

test('the drawer is reachable by keyboard alone, with no pointer at any step', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Navigation' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(rail)).toBeVisible();

  // The page behind the scrim is `inert`, so Tab cannot leave the panel for it.
  await page.keyboard.press('Tab');
  const inPanel = await page.evaluate(
    (sel) => document.querySelector(sel)?.contains(document.activeElement) ?? false,
    rail,
  );
  expect(inPanel, 'Tab escaped the open drawer into the inert page behind it').toBe(true);
});

test('at desktop width the rail is a column again and the toggle is gone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(rail)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Navigation' })).toBeHidden();

  // The rail is the leading column, not an overlay parked on top of the content.
  const railBox = await page.locator(rail).boundingBox();
  const mainBox = await page.locator('main').boundingBox();
  expect(railBox?.x).toBe(0);
  expect(mainBox?.x ?? 0).toBeGreaterThanOrEqual((railBox?.width ?? 0) - 1);
});

test('no screen the drawer reaches scrolls sideways at 390px', async ({ page }) => {
  // Horizontal overflow is what pushed the "New booking" button and half of
  // "Sign out" off the right edge of Bookings before the DenScreenKit heading
  // learned to stack. Measured on every pinned destination, because the heading
  // is on all of them.
  test.setTimeout(300_000);

  // ONE cold boot, then CLIENT-SIDE navigation for the rest.
  //
  // This loop used to `page.goto` every destination, which is a full page load,
  // so it rebooted the app once per rail entry. Each boot re-runs `requireAdmin`
  // (`src/router.tsx:104`) and re-opens the screen's listeners, and on a shared
  // CI runner the eighteenth consecutive boot stopped producing a shell at all:
  // main was red from 2026-08-01 with `/form-schemas never rendered the app
  // shell`, reproducibly at that one position, while four local runs of the same
  // commit passed. Raising the per-assertion budget to 30s did not move it,
  // which is what ruled out slowness. `FormSchemas` itself is sound: it loads
  // through `AsyncRegion`, names the failing callable and offers Retry, so a
  // refused callable renders an error INSIDE main rather than removing main.
  //
  // The cold boot was never what this test is about. It measures layout at
  // 390px, and the router swaps screens in place, which is also how an operator
  // actually moves between them. One boot proves the shell mounts; the rest
  // navigate the way the app does. `signin.spec.ts` covers cold-boot auth.
  await page.goto(`/${railEntries()[0]?.slug ?? 'home'}`);
  await expect(page.locator('main'), 'the shell never mounted').toBeVisible({ timeout: 30_000 });

  const offenders: string[] = [];
  for (const entry of railEntries()) {
    // Client-side: no reload, so the shell stays mounted and only the screen
    // under `<Outlet/>` is replaced.
    await page.evaluate((slug) => {
      window.history.pushState({}, '', `/${slug}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, entry.slug);
    await expect(
      page.locator('main'),
      `/${entry.slug} never rendered the app shell`,
    ).toBeVisible({ timeout: 30_000 });
    // The heading is what the router swaps, so waiting on it proves the NEW
    // screen mounted rather than measuring the previous one still on the page.
    await expect(
      page.locator('.den-heading-kicker, .den-heading h1').first(),
      `/${entry.slug} never rendered a heading`,
    ).toBeVisible({ timeout: 30_000 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    // One pixel of slack for sub-pixel rounding on a fractional layout.
    if (overflow > 1) offenders.push(`${entry.slug} overflows by ${String(overflow)}px`);
  }
  expect(offenders).toEqual([]);
});
