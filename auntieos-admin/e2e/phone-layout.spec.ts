import { expect, test, type Page } from '@playwright/test';
import type { GetInvoiceLedgerResult } from '../src/contracts/invoiceContracts.generated';
import { installCallableStubs } from './visual/callableStubs';

/**
 * The dense parts of each screen at phone width: the row grids and the invoice
 * overlays a row opens.
 *
 * PR #209 fixed the SHELL (a drawer for the rail, a stacking `.den-heading`)
 * and could prove nothing about the rows, because the harness had no rows.
 * Every invoice, notification, activity and KinTale row lived in
 * `seed.visual.ts`, the seed for a capture run the ordinary suite never made, so
 * the ordinary database held two households and three visits and every list screen rendered
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
  // Same cold-boot budget as `mobile-nav.spec.ts`, for the same reason: `goto`
  // reboots the app, and nothing renders until `requireAdmin`
  // (`src/router.tsx:104`) has awaited `waitForAuthReady()` and then
  // `resolveAccess()` against the emulator. Playwright's default 5s ceiling is
  // comfortable on a developer machine and marginal on a shared runner.
  await expect(p.locator('.den-heading-kicker', { hasText: kicker })).toBeVisible({
    timeout: 30_000,
  });
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
  // Auntie Time is a board of action CARDS since #703, not a row grid. The
  // measurement is the same either way: the header carrying the visit's
  // identity, and the column inside it that has to keep room to ellipsise.
  {
    slug: 'sessions',
    kicker: 'The Den · Auntie Time',
    row: '.sessions__card-head',
    identity: '.sessions__card-id',
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
  // The Activity log row is the disclosure button since #755 (time, glyph
  // tile, meta, and a seq column the phone rule hides); the meta column is the
  // one carrying the action and its context.
  {
    slug: 'activity',
    kicker: 'The Den · Activity log',
    row: '.activity__summary',
    identity: '.activity__meta',
  },
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
 * The LEDGER panel PR #201 added to this overlay is not covered HERE, and the
 * test below this one is why it now is anywhere: it loads through the
 * `getInvoiceLedger` callable, which this harness has no functions emulator for,
 * so in this test it renders its error state and nothing about its layout is
 * measured. That blind spot is what let a five-day layout regression through, so
 * it is stubbed and measured next door rather than folded in here: this test's
 * `assertOverlayFits` forbids the very overflow a scroll box exists to allow.
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

/**
 * THE LEDGER PANEL, which the overlay test above says in writing it cannot see.
 *
 * It could not because `getInvoiceLedger` has no functions emulator under this
 * harness and renders its error banner, so Payments, Payment History and Linked
 * visits have never been laid out at any width by any test. That blind spot cost
 * five days: on 2026-08-04 `.invoice-ledger__table` was given `display: block;
 * overflow-x: auto` so Payment History's eight columns could scroll, and a table
 * set to `display: block` stops generating a table box: its rows fall into an
 * anonymous shrink-to-fit table. BOTH ledger tables quietly stopped spanning
 * their panel and shrank to the width of their own text. Nothing in the suite
 * measured either table, so nothing reported it for five days.
 *
 * So this test asks the three questions that fix answers, and it stubs the
 * callable to do it, with a ledger carrying settlement rows. A row there trips
 * an anomaly banner, which is why the shared seed does not carry one, and which
 * is exactly the state this measurement wants.
 *
 *   - IS THE TABLE STILL A TABLE. `display: table` and a box that fills its
 *     panel. This is the regression itself and the reason the file was opened.
 *   - DOES PAYMENT HISTORY STILL SCROLL. Eight columns genuinely exceed 390px,
 *     the wrapper round them is a real scroll container, and `scrollLeft` moves.
 *   - DOES THE PAGE STAY PUT. Nothing sideways on the document, nothing wider
 *     than the phone on the dialog.
 *
 * It does NOT call `assertOverlayFits`. That helper fails any dialog descendant
 * whose right edge passes 391px, which is precisely what a table inside a scroll
 * box is supposed to do: it is clipped and reachable, not off the screen. Running
 * it here would forbid the fix.
 */
test('the invoice ledger tables span their panel at 390px, and only Payment History scrolls', async ({
  page,
}) => {
  await installCallableStubs(page, {
    // Echoes whichever invoice the first row opens, so this does not depend on
    // the list's sort order. Everything else is a literal: a layout measurement
    // has to mean the same thing on every run.
    getInvoiceLedger: (payload): GetInvoiceLedgerResult => ({
      invoiceId: String(payload['invoiceId']),
      // The settlement rows and the invoice's own figures, exactly as
      // `seed.rows.ts` states them for `vis-invoice-001`: $240.00 billed,
      // $60.00 collected, $180.00 still owed.
      payments: [
        {
          paymentId: 'phone-payment-001',
          amountCents: 4000,
          method: 'Check',
          reference: '2041',
          paidAt: '2026-08-01T15:20:00.000Z',
          recordedBy: 'e2e-admin',
          sourcePaymentId: null,
        },
        {
          paymentId: 'phone-payment-002',
          amountCents: 2000,
          method: 'Cash',
          reference: null,
          paidAt: '2026-08-03T18:05:00.000Z',
          recordedBy: 'e2e-admin',
          sourcePaymentId: null,
        },
      ],
      paidCents: 6000,
      totalCents: 24000,
      amountDueCents: 18000,
      // The eight-column table, in the widest state it honestly reaches: a
      // reference string the operator's processor really produces, an "Applied
      // to" cell carrying an invoice number with a second line under it, and six
      // mono money cells, every one of them `white-space: nowrap`.
      //
      // The first row is invoice #1029's own arithmetic, which is what the fee
      // field was added for: $137.50 collected = $127.50 applied plus a $10.00
      // GROSS tip, with $2.71 of processor fee taken out of the proceeds.
      //
      // BOTH ROWS RECONCILE, AND THEY DO NOT COVER THE BALANCE. The sum
      // `ledgerCoversBalance` takes is `amountCents + tipCents` per row, so it
      // is ($137.50 + $10.00) + ($30.00 + $0.00) = $177.50 of ledger against
      // $180.00 owed. Under it by $2.50, which keeps the per-row caveat banner
      // and the "the ledger shows money this balance does not" banner both off
      // the screen: what is measured below is the table, not a banner standing
      // beside it.
      ledgerPayments: [
        {
          paymentId: 'phone-ledger-001',
          amountCents: 13750,
          amountResolved: true,
          tipCents: 1000,
          feeCents: 271,
          tipBasis: 'gross',
          reconciles: true,
          appliedCents: 12750,
          unappliedCents: 0,
          proceedsCents: 13479,
          autoApply: false,
          appliedInvoiceId: 'vis-invoice-001',
          appliedInvoiceNumber: 'AO-2026-0184',
          method: 'Venmo',
          reference: 'VEN-3948172065',
          date: '2026-08-01',
          notes: '',
          recordedBy: 'e2e-admin',
        },
        {
          paymentId: 'phone-ledger-002',
          amountCents: 3000,
          amountResolved: true,
          tipCents: 0,
          feeCents: 0,
          tipBasis: 'gross',
          reconciles: true,
          appliedCents: 3000,
          unappliedCents: 0,
          proceedsCents: 3000,
          autoApply: false,
          appliedInvoiceId: 'vis-invoice-002',
          appliedInvoiceNumber: 'AO-2026-0183',
          method: 'PayPal',
          reference: 'PP-7C4419820K',
          date: '2026-07-28',
          notes: '',
          recordedBy: 'e2e-admin',
        },
      ],
      unlinkedKinfolkPayments: [],
      unresolvedAmountCount: 0,
      sessions: [
        {
          sessionId: 'e2e-sess-completed',
          serviceType: 'Overnight stay',
          status: 'completed',
          startTime: '2026-07-31T12:00:00.000Z',
          completedAt: '2026-07-31T12:00:00.000Z',
          durationMinutes: null,
          linkedBack: true,
        },
      ],
      missingSessionIds: [],
      orphanSessionIds: [],
      truncated: false,
    }),
  });

  await openScreen(page, 'invoices', 'The Den · Invoices');
  await expect(page.locator('.invoices__row-main').first()).toBeVisible();
  await page.locator('.invoices__row-main').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Three tables: Payments, Payment History, Linked visits. Waiting on the
  // count, not on the first one, because the panel renders its loading line and
  // then its tables, and measuring in between measures nothing.
  const tables = page.locator('.invoice-ledger__table');
  await expect(tables, 'the ledger panel did not render its three tables').toHaveCount(3);

  const measured = await page.evaluate(() => {
    const out: {
      caption: string;
      display: string;
      table: number;
      panel: number;
      content: number;
      boxOverflowX: string;
      box: number;
    }[] = [];
    for (const t of Array.from(document.querySelectorAll<HTMLTableElement>('.invoice-ledger__table'))) {
      // The panel is the flex column the table is laid out in, whether or not a
      // scroll box sits between them.
      const box = t.parentElement!;
      const panel = box.closest('.invoice-ledger')!;
      out.push({
        caption: (t.querySelector('caption')?.textContent ?? t.querySelector('th')?.textContent ?? '')
          .trim()
          .slice(0, 40),
        display: getComputedStyle(t).display,
        table: t.getBoundingClientRect().width,
        panel: panel.clientWidth,
        content: t.scrollWidth,
        boxOverflowX: getComputedStyle(box).overflowX,
        box: box.clientWidth,
      });
    }
    return out;
  });

  for (const m of measured) {
    report(
      'ledger table',
      `"${m.caption}…" display:${m.display}, ${m.table.toFixed(1)}px wide in a ` +
        `${String(m.panel)}px panel, ${String(m.content)}px of content in a ${String(m.box)}px box ` +
        `(overflow-x: ${m.boxOverflowX})`,
    );
  }

  // THE REGRESSION, asserted directly. A table that is not `display: table`
  // generates no table box, and every one of these must fill its panel.
  for (const m of measured) {
    expect(m.display, `"${m.caption}" is not rendering as a table`).toBe('table');
    expect(
      m.table,
      `"${m.caption}" has shrunk to its content instead of spanning its ${String(m.panel)}px panel`,
    ).toBeGreaterThanOrEqual(m.panel - 1);
  }

  // EXACTLY ONE of them needs a scroll box, and it is Payment History. Anything
  // that overflows a box it cannot scroll has lost a column off the edge.
  const scrolling = measured.filter((m) => m.content > m.box + 1);
  expect(
    scrolling.length,
    `expected only Payment History to overflow, got: ${scrolling.map((m) => m.caption).join('; ')}`,
  ).toBe(1);
  expect(scrolling[0]!.caption).toContain('Payment history');
  expect(
    scrolling[0]!.boxOverflowX,
    'Payment History overflows a box that cannot scroll',
  ).toMatch(/auto|scroll/);

  // "It scrolls" as an observation rather than a computed style: push the box
  // sideways and it stays pushed.
  const wrapper = page.locator('.invoice-ledger__scroll');
  await expect(wrapper).toHaveCount(1);
  const moved = await wrapper.evaluate((el) => {
    el.scrollLeft = 200;
    return el.scrollLeft;
  });
  report('payment history scroll', `scrollLeft came to rest at ${String(moved)}px`);
  expect(moved, 'the Payment History box did not scroll sideways').toBeGreaterThan(0);

  // And none of it moved the page or the overlay.
  const frame = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    dialog: document.querySelector('[role="dialog"]')!.getBoundingClientRect().width,
  }));
  report(
    'invoice detail with a ledger',
    `page overflow ${String(frame.page)}px, dialog ${frame.dialog.toFixed(0)}px wide`,
  );
  expect(frame.page, 'the ledger scrolls the page sideways').toBeLessThanOrEqual(1);
  expect(frame.dialog, 'the ledger made the overlay wider than the phone').toBeLessThanOrEqual(390);
});

/**
 * The form-schema editor as a workflow modal at phone width.
 *
 * A step rail that only fits a desktop would make the whole wizard a
 * desktop-only feature, so this is the claim that it is not: the rail is still
 * one strip of real controls, every pill is on screen, and the "Step 1 of 3"
 * line that answers "where am I" is visible without scrolling the rail.
 *
 * `assertOverlayFits` is deliberately strict about the rail: the strip may
 * scroll, but three steps at this width must not need it. A future editor with
 * enough steps to overflow will fail here, and that failure is the honest
 * signal that the count line has become the only wayfinding left.
 */
test('the form-schema wizard, its rail and its footer fit at 390px', async ({ page }) => {
  await openScreen(page, 'form-schemas', 'The Den · Admin');
  await page.getByRole('button', { name: 'New schema', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'New Form Schema steps' });
  await expect(rail, 'the rail did not survive the phone breakpoint').toBeVisible();
  await expect(page.getByText('Step 1 of 3')).toBeVisible();
  await expect(rail.getByRole('button')).toHaveCount(3);
  await assertOverlayFits(page, 'form-schema wizard step 1');
  // The Sections step is the tall one: a new schema seeds one section card,
  // and a field card inside it carries eight controls, the step the length
  // complaint was actually about.
  await page.getByRole('button', { name: /^2 Sections/ }).click();
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByLabel('Helper text')).toBeVisible();
  await assertOverlayFits(page, 'form-schema wizard step 2 with a field card');
});

/**
 * The KinTale template editor as a workflow modal at phone width, and the wider
 * of the two claims: this rail carries FIVE steps, not three, because the
 * built-in default a new template starts from has both the checklist and the Kin
 * mood section switched on.
 *
 * Five numbered pills is where the strip stops being comfortable, which is
 * exactly why it is worth measuring. `assertOverlayFits` checks every descendant
 * of the dialog against the right edge, so an overflowing pill, a checklist item
 * card's action row, or a condition row's two side-by-side selects each fail
 * here rather than in an operator's hand.
 *
 * The Per-Kin step is the tall one, and the reason the 2026-08-06 review named
 * this screen the tallest in the set: the built-in default carries eight
 * per-Kin items, each an item card with its own two toggles and a conditions
 * editor.
 *
 * THE COUNT TRACKS ANDROID'S `DefaultKinTaleTemplate`, so do not "restore" it to
 * six. It was six while `lib/kinTale/model.ts` mirrored the Compose desktop's
 * built-in; issue #397 item L20 corrected it to Android's, because the kinfolk
 * portal resolves a blank `templateId` against Android's list alone and DROPS
 * any checked key it cannot label. The two extra rows are Android's
 * `litter_scooped` and `walk_water_refill`, which the desktop list never had.
 * `KinTaleTemplates.test.tsx` names all eight, so if this count ever moves
 * again, read that test before changing this number.
 *
 * The editor draws every authored item regardless of its conditions (conditions
 * are AUTHORED here and evaluated in the composer), so this count is the raw
 * per-Kin list length, not a filtered view of it.
 */
test('the KinTale template wizard, its five-step rail and its item cards fit at 390px', async ({
  page,
}) => {
  // Since the #755 KinTale sweep this screen is nested under KinTales and
  // carries the trail (KinTales / Templates) in the kicker's place, so the
  // cold-boot wait is on the current crumb rather than on `openScreen`'s
  // kicker. Same 30s budget, for the reason `openScreen` gives.
  await page.goto('/kintale-templates');
  await expect(
    page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Templates'),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'New template', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  const rail = page.getByRole('navigation', { name: 'New KinTale template steps' });
  await expect(rail, 'the rail did not survive the phone breakpoint').toBeVisible();
  await expect(page.getByText('Step 1 of 5')).toBeVisible();
  await expect(rail.getByRole('button')).toHaveCount(5);
  await assertOverlayFits(page, 'KinTale wizard step 1 (basic settings)');

  await rail.getByRole('button', { name: /^2 Display sections/ }).click();
  await assertOverlayFits(page, 'KinTale wizard step 2 (display sections)');

  await rail.getByRole('button', { name: /^3 Per-Kin items/ }).click();
  // Eight items, drawn in full: this is the step the length complaint was about,
  // so a step that rendered fewer would make the rest of the check meaningless.
  // Eight is Android's per-Kin list; see this test's own header before editing it.
  await expect(page.locator('.ktt__item')).toHaveCount(8);
  await assertOverlayFits(page, 'KinTale wizard step 3 (eight per-Kin item cards)');

  // A condition row puts two selects side by side, the densest thing this editor
  // draws, and it is drawn in full rather than behind any disclosure.
  await page.getByRole('button', { name: 'Add condition' }).first().click();
  await assertOverlayFits(page, 'KinTale wizard step 3 with a condition row');

  await rail.getByRole('button', { name: /^5 Mood options/ }).click();
  // An emoji field, a label field and three icon buttons per row, eight rows.
  await expect(page.locator('.ktt__mood')).toHaveCount(8);
  await assertOverlayFits(page, 'KinTale wizard step 5 (eight mood rows)');
});
