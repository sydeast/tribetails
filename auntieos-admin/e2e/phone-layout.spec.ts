import { expect, test, type Page } from '@playwright/test';

/**
 * The dense parts of each screen at phone width: the row grids and the invoice
 * overlays a row opens.
 *
 * PR #209 fixed the SHELL (a drawer for the rail, a stacking `.den-heading`)
 * and could prove nothing about the rows, because the harness had no rows.
 * Every invoice, notification, activity and KinTale row lived in
 * `seed.visual.ts`, which only runs under `VISUAL_CAPTURE=1`, so the ordinary
 * database held two households and three visits and every list screen rendered
 * its EMPTY state. An empty list cannot overflow. `seed.rows.ts` now belongs to
 * the base seed, and `SEEDED_BOOKINGS.today` was added so Schedule's agenda,
 * which lists the selected day, has anything at all to lay out.
 *
 * WHAT IT MEASURES, and why it is not just overflow. Not one of these screens
 * scrolled the page sideways before the fix. The damage was the opposite
 * shape: a grid with an `auto` trailing column takes that column's min-content
 * first and hands the remainder to the one flexible track, so the row keeps its
 * width and the column carrying the household name is what disappears. On
 * Invoices at 390px `.invoices__row-who` computed **0.0px wide** on two of
 * three rows. So there are three questions here:
 *
 *   - Does the PAGE scroll sideways (`documentElement.scrollWidth` against
 *     `clientWidth`).
 *   - Is content CLIPPED AWAY: an element whose `scrollWidth` exceeds its
 *     `clientWidth` under `overflow-x: hidden` or `clip`. A row that stops
 *     overflowing because an ancestor is `hidden` has not been fixed, it has
 *     been hidden. `auto`/`scroll` is exempt: dense data may scroll inside its
 *     own box, and `text-overflow: ellipsis` truncates on purpose.
 *   - Is the row CRUSHED: the column carrying the household, the message or the
 *     action must hold at least 60 percent of the row. That is the assertion
 *     that would have caught all of this, and it is the one this file exists
 *     for.
 *
 * 390x844 is an iPhone 12/13/14 CSS viewport.
 */

test.use({ viewport: { width: 390, height: 844 }, timezoneId: 'UTC', locale: 'en-US' });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

interface Clipped {
  readonly what: string;
  readonly by: number;
}

interface Measurement {
  readonly page: number;
  readonly clipped: readonly Clipped[];
}

/** Measures the open document. Runs in the browser, so it defines its own helpers. */
async function measure(p: Page): Promise<Measurement> {
  return await p.evaluate(() => {
    const root = document.documentElement;
    const clipped: { what: string; by: number }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('main *'))) {
      const by = el.scrollWidth - el.clientWidth;
      if (by <= 1) continue;
      const style = getComputedStyle(el);
      if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
      if (style.textOverflow === 'ellipsis') continue;
      const cls =
        el.className === '' ? '' : `.${String(el.className).trim().split(/\s+/).join('.')}`;
      clipped.push({ what: `${el.tagName.toLowerCase()}${cls}`, by });
    }
    return { page: root.scrollWidth - root.clientWidth, clipped };
  });
}

/**
 * Goes to a screen, waits for it, then measures it.
 *
 * The wait is on the KICKER, not on the `h1`. Every screen's `h1` is its
 * marketing line ("Getting paid.", "Talk to your kinfolk.") while the kicker is
 * "The Den · Invoices", the screen's actual name. Waiting on the mere presence
 * of an `h1` would not do: the router swaps screens in place, so the previous
 * screen's heading is on the page until the next one mounts.
 */
async function openScreen(p: Page, slug: string, kicker: string): Promise<void> {
  await p.goto(`/${slug}`);
  await expect(p.locator('.den-heading-kicker', { hasText: kicker })).toBeVisible();
}

/** Printed on every run, pass or fail, so the numbers can be quoted. */
function report(name: string, line: string): void {
  console.log(`[phone 390px] ${name}: ${line}`);
}

interface Screen {
  readonly slug: string;
  readonly kicker: string;
  /** The row grid this PR restacked. */
  readonly row: string;
  /** The column inside that row carrying the thing the row is ABOUT. */
  readonly identity: string;
}

const SCREENS: readonly Screen[] = [
  {
    slug: 'invoices',
    kicker: 'The Den · Invoices',
    row: '.invoices__row-main',
    identity: '.invoices__row-who',
  },
  {
    slug: 'sessions',
    kicker: 'The Den · Auntie Time',
    row: '.sessions__row-main',
    identity: '.sessions__row-who',
  },
  {
    slug: 'schedule',
    kicker: 'The Den · Schedule',
    row: '.schedule__row-main',
    identity: '.schedule__row-who',
  },
  // The Inbox rows measured here are the CHANNEL rows (voicemail, call, SMS,
  // email), which read Firestore directly. The thread list above them loads
  // through the `listConversations` callable and renders its error state under
  // this harness, so it shares the fix and not the proof.
  { slug: 'inbox', kicker: 'The Den · Inbox', row: '.inbox__row-main', identity: '.inbox__row-who' },
  { slug: 'activity', kicker: 'The Den · Admin', row: '.log__row', identity: '.log__body' },
  {
    slug: 'notifications',
    kicker: 'The Den · Notifications',
    row: '.notif-row',
    identity: '.notif-row__body',
  },
];

for (const screen of SCREENS) {
  test(`${screen.slug} lays out at 390px with real rows`, async ({ page }) => {
    await openScreen(page, screen.slug, screen.kicker);

    // The kicker renders before the Firestore listener has delivered anything,
    // so waiting on the screen is not waiting on its rows, and measuring here
    // without this measures an empty panel. That is the exact hole this file
    // was written to close.
    const rows = page.locator(screen.row);
    await expect(
      rows.first(),
      `${screen.slug} rendered no rows, so nothing was measured`,
    ).toBeVisible();
    const count = await rows.count();
    const m = await measure(page);

    // The widest row, not the first: one long household name is the whole test.
    let worst = { row: 0, identity: 0, share: 1 };
    for (let i = 0; i < count; i += 1) {
      const rowBox = await rows.nth(i).boundingBox();
      const idBox = await rows.nth(i).locator(screen.identity).first().boundingBox();
      if (rowBox === null || idBox === null) continue;
      const share = idBox.width / rowBox.width;
      if (share < worst.share) worst = { row: rowBox.width, identity: idBox.width, share };
    }

    report(
      screen.slug,
      `page overflow ${String(m.page)}px, ${String(count)} rows, narrowest ${screen.identity} ` +
        `${worst.identity.toFixed(1)}px of a ${worst.row.toFixed(1)}px row (${(worst.share * 100).toFixed(0)}%)` +
        (m.clipped.length === 0
          ? ''
          : `, clipped: ${m.clipped.map((c) => `${c.what} by ${String(c.by)}px`).join('; ')}`),
    );

    expect(m.page, `${screen.slug} scrolls the page sideways`).toBeLessThanOrEqual(1);
    expect(m.clipped, `${screen.slug} clips content away rather than fitting it`).toEqual([]);
    expect(
      worst.share,
      `${screen.slug}: ${screen.identity} has been crushed by the columns beside it`,
    ).toBeGreaterThan(0.6);
  });
}

/**
 * Invoices is the money screen and the row is how an invoice is found, so it
 * gets the claim the others do not: every part an operator needs to identify a
 * row is still ON SCREEN, not merely not-overflowing.
 */
test('an invoice row still shows its number, who, how much and its status', async ({ page }) => {
  await openScreen(page, 'invoices', 'The Den · Invoices');

  const row = page.locator('.invoices__row-main').first();
  await expect(row).toBeVisible();
  const box = await row.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);

  for (const part of [
    '.invoices__row-number',
    '.invoices__row-name',
    '.invoices__row-meta',
    '.invoices__row-amount',
    '.invoices__chip',
  ]) {
    const el = row.locator(part).first();
    await expect(el, `${part} is gone from the row`).toBeVisible();
    const b = await el.boundingBox();
    expect(b!.x, `${part} starts off the left edge`).toBeGreaterThanOrEqual(-1);
    expect(b!.x + b!.width, `${part} runs off the right edge`).toBeLessThanOrEqual(391);
    expect(b!.width, `${part} has no width at all`).toBeGreaterThan(0);
  }
});

/**
 * The invoice detail overlay and the line-item editor inside it, reached from a
 * row rather than from the rail, so #209's pinned sweep never opened either.
 *
 * The LEDGER panel PR #201 added to this overlay is NOT covered: it loads
 * through the `getInvoiceLedger` callable, which this harness has no functions
 * emulator for, so it renders its error state and its real layout is unseen at
 * any viewport.
 */
test('the invoice detail overlay, its line items and its editor fit at 390px', async ({ page }) => {
  await openScreen(page, 'invoices', 'The Den · Invoices');
  await expect(page.locator('.invoices__row-main').first()).toBeVisible();
  await page.locator('.invoices__row-main').first().click();

  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.invoice-lines')).toBeVisible();
  await assertOverlayFits(page, 'invoice detail');

  // The line-item table is dense and may scroll inside its own box; what it may
  // not do is lose a column off the edge of a box that cannot scroll.
  const table = await page.evaluate(() => {
    const t = document.querySelector('.invoice-lines');
    const wrap = t?.parentElement ?? null;
    if (t === null || wrap === null) return null;
    return { table: t.scrollWidth, box: wrap.clientWidth, overflowX: getComputedStyle(wrap).overflowX };
  });
  expect(table, 'the line-item table is not in the document').not.toBeNull();
  report('invoice line items', `table ${String(table!.table)}px in a ${String(table!.box)}px box`);
  if (table!.table > table!.box + 1) {
    expect(table!.overflowX, 'the line-item table overflows a box that cannot scroll').toMatch(
      /auto|scroll/,
    );
  }

  // The editor is the same overlay in its money-editable state: four wrapping
  // fields per line plus a per-line action row. It is where an invoice is
  // actually corrected, and it is two clicks from the rail.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.invoice-lines-editor')).toBeVisible();
  await assertOverlayFits(page, 'invoice line-item editor');
});

/** Nothing inside the open dialog may cross the right edge of the phone. */
async function assertOverlayFits(p: Page, what: string): Promise<void> {
  const m = await p.evaluate(() => {
    const root = document.documentElement;
    const d = document.querySelector('[role="dialog"]');
    const over: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] *'))) {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > 391) {
        over.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}`);
      }
    }
    return {
      page: root.scrollWidth - root.clientWidth,
      dialog: d === null ? 0 : d.getBoundingClientRect().width,
      over,
    };
  });
  report(
    what,
    `page overflow ${String(m.page)}px, dialog ${m.dialog.toFixed(0)}px wide, ${String(m.over.length)} elements past the edge`,
  );
  expect(m.page, `${what} scrolls the page sideways`).toBeLessThanOrEqual(1);
  expect(m.dialog, `${what} is wider than the phone`).toBeLessThanOrEqual(390);
  expect(m.over, `${what} puts content past the right edge`).toEqual([]);
}
