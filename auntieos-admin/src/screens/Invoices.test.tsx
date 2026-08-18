// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type InvoiceEntry } from '../api/invoices';
import { type PagedCollection } from '../lib/usePagedCollection';

/**
 * The list is PAGED now, so this file mocks `usePagedCollection`.
 * `useCollection` stays mocked too: the household facet here, and the composer's
 * own household picker, both read the kinfolk directory through it.
 */
const { usePagedCollection } = vi.hoisted(() => ({ usePagedCollection: vi.fn() }));
vi.mock('../lib/usePagedCollection', () => ({ usePagedCollection }));

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// InvoiceDetail / InvoiceCreate (now wired in, see the header comment on
// Invoices.tsx) both reach these callables. Mocked here so nothing under this
// suite ever attempts a real httpsCallable round-trip, matching the
// InvoiceCreate.test.tsx / InvoiceDetail.test.tsx convention.
const { createInvoice, createQuote, sendInvoiceReminder, markInvoicePaid, generateReceipt, recordPayment } =
  vi.hoisted(() => ({
    createInvoice: vi.fn(),
    createQuote: vi.fn(),
    sendInvoiceReminder: vi.fn(),
    markInvoicePaid: vi.fn(),
    generateReceipt: vi.fn(),
    recordPayment: vi.fn(),
  }));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  createInvoice,
  createQuote,
  sendInvoiceReminder,
  markInvoicePaid,
  generateReceipt,
  recordPayment,
}));

import { Invoices } from './Invoices';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

/**
 * Today as the screen's own `localDateIso` reads it. The screen windows on the
 * live clock, so a fixture pinned to a literal day would fall out of the default
 * "Last 7 days" the moment the calendar moved past it.
 */
function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/**
 * The default doc is a STAMPED open invoice (`status: 'open'`,
 * `editScope: 'all'`), which is what the server writes for an unpaid sent
 * bill. Per ADR-0002 the stamp arrives ON the doc; these tests hand the screen
 * stored fields and assert rendered chips/filters/totals, they never rely on
 * the screen deriving a state from the money.
 *
 * IT IS DATED TODAY, and that is not decoration. The screen windows on `date`,
 * and `invoiceWithinWindow` now re-tests every loaded row against the bound
 * because Firestore's string comparison lets free-text dates through. This mock
 * returns rows without consulting the query at all, so a fixture dated `''` was
 * being shown by a dated window that could never have returned it: real
 * Firestore drops a doc with no `date` from `orderBy('date')`, and `'' >= <day>`
 * is false. Dating the fixture makes the fixture match the query, rather than
 * making the screen accept a row it will not be handed. The blank case is
 * asserted where it belongs, under "All (archive)".
 */
function entry(over: Partial<InvoiceEntry>): InvoiceEntry {
  return {
    _id: 'inv1',
    kinfolkId: 'k1',
    kinfolkName: 'The Whitfields',
    client: '',
    invoiceNumber: '1042',
    date: todayIso(),
    dueDate: '',
    total: 40,
    amountDue: 40,
    status: 'open',
    editScope: 'all',
    sessionIds: [],
    createdAt: fakeTs('2026-07-16T09:00:00Z'),
    ...over,
  };
}

const loadMore = vi.fn();
const reload = vi.fn();

/** A settled first page. Overrides cover the in-flight, failed and more-to-come cases. */
function paged(
  rows: InvoiceEntry[],
  over: Partial<PagedCollection<InvoiceEntry>> = {},
): PagedCollection<InvoiceEntry> {
  return {
    state: { status: 'ready', data: rows },
    hasMore: false,
    more: { status: 'ready', data: null },
    loadMore,
    reload,
    ...over,
  };
}

/** The spec the screen most recently asked the hook for. */
function lastSpec(): { pageSize: number; order: [string, string]; filters?: [string, string, unknown][] } {
  return usePagedCollection.mock.calls.at(-1)![0] as {
    pageSize: number;
    order: [string, string];
    filters?: [string, string, unknown][];
  };
}

beforeEach(() => {
  loadMore.mockReset();
  reload.mockReset();
  usePagedCollection.mockReset().mockReturnValue(paged([]));
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] });
  createInvoice.mockReset();
  createQuote.mockReset();
  sendInvoiceReminder.mockReset();
  markInvoicePaid.mockReset();
  generateReceipt.mockReset();
});

describe('Invoices screen', () => {
  it('renders a paged row with its invoice number, household, amount, and status chip', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Invoices />);
    // Scope by the row container: it's a more stable anchor than the button role
    // now that every row is one (see below).
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('#1042')).toBeInTheDocument();
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    // The Outstanding stat card also reads $40.00 here (this is the only open
    // invoice), so the amount is asserted scoped to the row, not page-wide.
    expect(within(row).getByText('$40.00')).toBeInTheDocument();
    expect(within(row).getByText('OPEN')).toBeInTheDocument();
  });

  it('AO-12 regression guard: a stored credit stamp renders CREDIT, never PAID', () => {
    // The precedence table that decides credit-vs-paid is asserted server-side
    // now (ADR-0002); what this list owes AO-12 is rendering the stored verdict
    // verbatim rather than second-guessing it from the money.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'credit', editScope: 'none', amountDue: -20, total: -20 })]),
    );
    render(<Invoices />);
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
    expect(screen.queryByText('PAID')).toBeNull();
  });

  it('a redeemed credit renders REDEEMED, distinctly from an unredeemed one', () => {
    // The server stamps `redeemed` itself once `creditRedeemedAt` lands; the
    // doc carries both, and the chip reads the stamp.
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          status: 'redeemed',
          editScope: 'none',
          amountDue: -20,
          total: -20,
          creditRedeemedAt: fakeTs('2026-07-15T00:00:00Z'),
        }),
      ]),
    );
    render(<Invoices />);
    expect(screen.getByText('REDEEMED')).toBeInTheDocument();
  });

  it('a stamped paid invoice renders PAID', () => {
    // This used to hand the screen a blank status and assert the money-field
    // read (amountDue retired, real total) produced PAID. That derivation is
    // the server's now (ADR-0002): the doc arrives already stamped `paid`.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'paid', editScope: 'none', amountDue: 0, total: 40 })]),
    );
    render(<Invoices />);
    expect(screen.getByText('PAID')).toBeInTheDocument();
  });

  it('a $0 invoice renders ZERO, not a fabricated PAID', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'zero', amountDue: 0, total: 0 })]));
    render(<Invoices />);
    expect(screen.getByText('ZERO')).toBeInTheDocument();
    expect(screen.queryByText('PAID')).toBeNull();
  });

  it('an overdue open invoice shows the OVERDUE chip instead of OPEN', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ amountDue: 40, total: 40, dueDate: '2020-01-01' })]),
    );
    render(<Invoices />);
    expect(screen.getByText('OVERDUE')).toBeInTheDocument();
    expect(screen.queryByText('OPEN')).toBeNull();
  });

  it('a doc with no recognizable stamp gets the neutral chip, and matches only the All tab', async () => {
    // The deliberate fail-soft (ADR-0002 makes this doc impossible; this is
    // what renders if one appears anyway): the chip is the doc's own word,
    // claiming nothing — never an OPEN re-derived from amountDue — and the row
    // belongs to no status bucket.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'sent' as unknown as InvoiceEntry['status'], amountDue: 40, total: 40 })]),
    );
    render(<Invoices />);
    expect(screen.getByText('SENT')).toBeInTheDocument();
    expect(screen.queryByText('OPEN')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Open' }));
    expect(
      screen.getByText('Nothing in the loaded invoices matches this filter.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByText('SENT')).toBeInTheDocument();
  });

  it('a part-paid open invoice shows PART PAID rather than a bare OPEN', () => {
    // Neither paid nor untouched. "OPEN" alone hides the $20 already collected.
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'open', amountDue: 20, total: 40, paidCents: 2000 })]),
    );
    render(<Invoices />);
    expect(screen.getByText('PART PAID')).toBeInTheDocument();
    expect(screen.queryByText('OPEN')).toBeNull();
  });

  it('OVERDUE still outranks PART PAID: an overdue part-paid invoice is, first, overdue', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'open', amountDue: 20, total: 40, paidCents: 2000, dueDate: '2020-01-01' })]),
    );
    render(<Invoices />);
    expect(screen.getByText('OVERDUE')).toBeInTheDocument();
    expect(screen.queryByText('PART PAID')).toBeNull();
  });

  it('does NOT invent a part-paid chip from total minus amountDue', () => {
    // No paidCents on the doc means no record of a payment, so no claim of one.
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open', amountDue: 20, total: 40 })]));
    render(<Invoices />);
    expect(screen.queryByText('PART PAID')).toBeNull();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });

  it('every row is a real interactive button (InvoiceDetail is wired in now, no more static placeholder)', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Invoices />);
    expect(screen.getByRole('button', { name: /1042/i })).toBeInTheDocument();
  });

  it('clicking a row opens InvoiceDetail for that invoice', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'inv-42' })]));
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /1042/i }));
    expect(await screen.findByRole('heading', { name: /invoice #1042/i })).toBeInTheDocument();
    // Scoped: "The Whitfields" also appears in the row underneath the dialog.
    expect(within(screen.getByRole('dialog')).getByText('The Whitfields')).toBeInTheDocument();
  });

  /**
   * Mark 10 of the 2026-08-17 walk. The list normalizes its rows through
   * `normalizeInvoice` before rendering them; the detail sheet was handed the
   * RAW document out of the same page, so one screen's two halves disagreed
   * about the same invoice. On test-kinfolk-001-invoice-open, whose `client`
   * and `invoiceNumber` are simply absent, that reached the server as
   * `{"client":null,"invoiceNumber":null}` and `recordPayment` answered 400.
   * Both fields are optional on the contract. Neither may be null.
   */
  it('hands the detail sheet a normalized invoice, so an absent field never leaves as null', async () => {
    markInvoicePaid.mockResolvedValue({
      paymentId: 'pay1',
      state: 'settled' as const,
      totalCents: 4000,
      paidCents: 4000,
      amountDueCents: 0,
      overpaidCents: 0,
    });
    recordPayment.mockResolvedValue({ ok: true, confirmationEmailSent: false, creditedToAccountCents: 0 });
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          _id: 'inv-42',
          client: null as unknown as string,
          invoiceNumber: null as unknown as string,
        }),
      ]),
    );
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /the whitfields/i }));
    await screen.findByRole('dialog');
    const dialog = within(screen.getByRole('dialog'));
    await userEvent.click(dialog.getByRole('button', { name: /^record payment$/i }));
    await userEvent.click(dialog.getByRole('button', { name: /^record payment$/i }));
    await waitFor(() => expect(recordPayment).toHaveBeenCalled());
    const [args] = recordPayment.mock.calls[0] as [Record<string, unknown>];
    expect(args['client']).toBe('');
    expect(args['invoiceNumber']).toBe('');
    expect(Object.entries(args).filter(([, v]) => v === null)).toEqual([]);
  });
  it('closing InvoiceDetail returns to the list', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'inv-42' })]));
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /1042/i }));
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('New invoice opens InvoiceCreate in invoice mode', async () => {
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /^new invoice$/i }));
    expect(await screen.findByRole('heading', { name: 'New invoice' })).toBeInTheDocument();
  });

  it('New quote opens InvoiceCreate in quote mode', async () => {
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /^new quote$/i }));
    expect(await screen.findByRole('heading', { name: 'New quote' })).toBeInTheDocument();
  });

  // The landing half of the Notifications feed's "Create quote" (issue #20).
  // The feed navigates to /invoices?composeQuoteForKinfolkId=<id>; the router
  // turns that search param into this prop.
  it('composeQuoteForKinfolkId opens the quote composer seeded with that household', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [{ _id: 'k9', firstName: 'Dana', lastName: 'Ruiz' }],
    });
    render(<Invoices composeQuoteForKinfolkId="k9" />);
    expect(await screen.findByRole('heading', { name: 'New quote' })).toBeInTheDocument();
    // Two "Household" comboboxes exist now (the list facet and the composer's
    // own picker), so this is scoped to the dialog.
    expect(
      within(screen.getByRole('dialog')).getByRole('combobox', { name: 'Household' }),
    ).toHaveValue('k9');
  });

  it('opens no composer without the seed', () => {
    render(<Invoices />);
    expect(screen.queryByRole('heading', { name: 'New quote' })).toBeNull();
  });

  it('initialInvoiceId opens that invoice detail on mount', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'inv1' })]));
    render(<Invoices initialInvoiceId="inv1" />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText(/not in the last 7 days/)).toBeNull();
  });

  it('says so when a deep link lands outside the window, instead of opening nothing', () => {
    // The feed's "Open" resolves against the LOADED rows. That used to be the
    // 200 newest and is now one page of one window, so this can miss. A click
    // that produces nothing at all is the dead-control failure in disguise.
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'someone-else' })]));
    render(<Invoices initialInvoiceId="inv-from-2019" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'The invoice this link points at is not in the last 7 days. Try All (archive), clear the household filter, or Load more.',
    );
  });

  it('drops that notice once the operator closes the link, rather than nagging', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ _id: 'inv1' })]));
    render(<Invoices initialInvoiceId="inv1" />);
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('Invoices screen: the date window', () => {
  it('defaults to the last 7 days and asks the server for exactly that', () => {
    render(<Invoices />);
    expect(screen.getByRole('tab', { name: 'Last 7 days' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(lastSpec().filters?.map((f) => [f[0], f[1]])).toEqual([['date', '>=']]);
  });

  it('windows on `date`, NOT on the Timestamp `createdAt`', () => {
    // The failure this pins: Firestore orders every timestamp before every
    // string, so a string bound on the Timestamp `createdAt` matches nothing and
    // empties the screen without erroring.
    render(<Invoices />);
    expect(lastSpec().order[0]).toBe('date');
    expect(lastSpec().filters?.[0]?.[0]).toBe('date');
  });

  it('bounds on a plain YYYY-MM-DD day, which is the shape the field holds', () => {
    render(<Invoices />);
    expect(String(lastSpec().filters?.[0]?.[2])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('drops the predicate entirely for All (archive), never widening to an always-true one', async () => {
    render(<Invoices />);
    await userEvent.click(screen.getByRole('tab', { name: 'All (archive)' }));
    expect(lastSpec().filters).toBeUndefined();
  });

  it('names the WINDOW in the empty state, never the books', () => {
    render(<Invoices />);
    expect(screen.getByText('No invoices in the last 7 days.')).toBeInTheDocument();
    expect(screen.queryByText(/no invoices on the books/i)).toBeNull();
  });

  it('warns that an undated invoice is only reachable under All (archive)', () => {
    render(<Invoices />);
    expect(
      screen.getByText(/Invoices with no date appear only under All \(archive\)\./),
    ).toBeInTheDocument();
  });

  it('drops that warning once All (archive) is the window, where undated rows do appear', async () => {
    render(<Invoices />);
    await userEvent.click(screen.getByRole('tab', { name: 'All (archive)' }));
    expect(screen.queryByText(/Invoices with no date appear only/)).toBeNull();
  });

  // THE BUG THIS WINDOW HAD. `where('date','>=',<day>)` is a STRING comparison
  // in UTF-8 byte order, and every letter outranks every digit, so a stored
  // "Feb 12, 2026" satisfied every ISO cutoff and sorted above every real date.
  // Last 7 days was showing invoices from months ago, at the top of the list.
  it('does not show a row whose stored date is free text, whatever the server returned', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'good', invoiceNumber: 'GOOD' }),
        entry({ _id: 'legacy', invoiceNumber: 'LEGACY', date: 'Feb 12, 2026' }),
      ]),
    );
    render(<Invoices />);
    expect(screen.getByText('#GOOD')).toBeInTheDocument();
    expect(screen.queryByText('#LEGACY')).toBeNull();
  });

  it('counts what it dropped, so a short page reads as bad data and not as thin books', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'good' }), entry({ _id: 'legacy', date: 'Feb 12, 2026' })]),
    );
    render(<Invoices />);
    expect(
      screen.getByText(/1 invoice whose stored date is not a real date was left out/),
    ).toBeInTheDocument();
  });

  it('says nothing at all when every row really is in the window', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Invoices />);
    expect(screen.queryByText(/stored date is not a real date/)).toBeNull();
  });

  it('drops nothing under All (archive), where there is no window to fall outside of', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'legacy', invoiceNumber: 'LEGACY', date: 'Feb 12, 2026' })]),
    );
    render(<Invoices />);
    await userEvent.click(screen.getByRole('tab', { name: 'All (archive)' }));
    expect(screen.getByText('#LEGACY')).toBeInTheDocument();
  });
});

describe('Invoices screen: the household facet composes with the window', () => {
  it('offers the whole household directory rather than only the loaded invoices', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [{ _id: 'k9', firstName: 'Dana', lastName: 'Ruiz' }],
    });
    render(<Invoices />);
    const select = screen.getByLabelText('Household');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All households',
      'Dana Ruiz',
    ]);
  });

  it('sends the facet and the window together, in the deployed index order', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [{ _id: 'k9', firstName: 'Dana', lastName: 'Ruiz' }],
    });
    render(<Invoices />);
    await userEvent.selectOptions(screen.getByLabelText('Household'), 'k9');

    const filters = lastSpec().filters ?? [];
    expect(filters.map((f) => [f[0], f[1]])).toEqual([
      ['kinfolkId', '=='],
      ['date', '>='],
    ]);
    expect(filters[0]?.[2]).toBe('k9');
  });

  it('says so when the household list itself failed, rather than offering an empty dropdown', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<Invoices />);
    expect(screen.getByText(/Household list unavailable: permission-denied/)).toBeInTheDocument();
  });
});

describe('Invoices screen: archived invoices are excluded by default', () => {
  const mixed = [
    entry({ _id: 'live', invoiceNumber: 'LIVE' }),
    entry({ _id: 'gone', invoiceNumber: 'GONE', archivedAt: fakeTs('2026-07-20T00:00:00Z') }),
  ];

  it('sends NO archivedAt predicate to the server, which would return zero rows', () => {
    // STILL TRUE NOW THAT 5.1 ACTUALLY WRITES THE FIELD, which is the whole
    // reason to keep this test rather than retire it. `archiveInvoice` stamping
    // new archives does not retroactively give `archivedAt` to the invoices
    // already in the collection, and Firestore `== null` matches only documents
    // that HAVE the field, so a server-side exclusion would silently empty the
    // screen across essentially the whole collection. It needs a backfill first.
    render(<Invoices />);
    expect((lastSpec().filters ?? []).map((f) => f[0])).not.toContain('archivedAt');
  });

  it('hides an archived invoice from the list without hiding that it did so', () => {
    usePagedCollection.mockReturnValue(paged(mixed));
    render(<Invoices />);
    expect(screen.getByText('#LIVE')).toBeInTheDocument();
    expect(screen.queryByText('#GONE')).toBeNull();
    // The count is scoped to the LOADED page and now says so. A client-side
    // exclusion cannot see archived invoices it never loaded, so a bare
    // "1 archived invoice excluded" reads like a fact about the books.
    expect(
      screen.getByText(
        'These totals cover the 1 invoice in the last 7 days. 1 archived invoice excluded, counted within the invoices loaded here rather than across the books.',
      ),
    ).toBeInTheDocument();
  });

  it('keeps an archived invoice out of the money totals, not just out of the list', () => {
    usePagedCollection.mockReturnValue(paged(mixed));
    render(<Invoices />);
    const billed = screen.getByText('Billed total').closest('.den-stat, button.den-stat--button');
    // $40 for the live invoice alone, never $80.
    expect(within(billed as HTMLElement).getByText('$40.00')).toBeInTheDocument();
  });

  it('includes them on request', async () => {
    usePagedCollection.mockReturnValue(paged(mixed));
    render(<Invoices />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), '');
    expect(screen.getByText('#LIVE')).toBeInTheDocument();
    expect(screen.getByText('#GONE')).toBeInTheDocument();
  });

  it('isolates them on request, so an archived invoice is never unreachable', async () => {
    usePagedCollection.mockReturnValue(paged(mixed));
    render(<Invoices />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    expect(screen.getByText('#GONE')).toBeInTheDocument();
    expect(screen.queryByText('#LIVE')).toBeNull();
  });

  it('says nothing about exclusions when there were none', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Invoices />);
    expect(screen.queryByText(/archived invoice/)).toBeNull();
  });
});

describe('Invoices screen: status tabs, search and the window all compose', () => {
  const three = [
    entry({ _id: 'a', invoiceNumber: 'A', status: 'draft', kinfolkName: 'The Bakers' }),
    entry({ _id: 'b', invoiceNumber: 'B', status: 'open', amountDue: 40, total: 40, kinfolkName: 'The Bakers' }),
    entry({ _id: 'c', invoiceNumber: 'C', status: 'draft', kinfolkName: 'The Chens' }),
  ];

  it('filter tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    usePagedCollection.mockReturnValue(paged(three));
    render(<Invoices />);
    expect(screen.getByText('#A')).toBeInTheDocument();
    expect(screen.getByText('#B')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByText('#A')).toBeInTheDocument();
    expect(screen.queryByText('#B')).toBeNull();
  });

  it('search narrows by number, household and client over the LOADED rows', async () => {
    usePagedCollection.mockReturnValue(paged(three));
    render(<Invoices />);
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search invoices' }), 'chens');
    expect(screen.getByText('#C')).toBeInTheDocument();
    expect(screen.queryByText('#A')).toBeNull();
  });

  it('a tab and a search apply together rather than one replacing the other', async () => {
    usePagedCollection.mockReturnValue(paged(three));
    render(<Invoices />);
    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    await userEvent.type(screen.getByRole('searchbox'), 'bakers');
    expect(document.querySelectorAll('.invoices__row')).toHaveLength(1);
    expect(screen.getByText('#A')).toBeInTheDocument();
  });

  it('shows a "nothing matches" hint (not the window empty state) when a filter excludes every row', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'open', amountDue: 40, total: 40 })]),
    );
    render(<Invoices />);
    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(
      screen.getByText('Nothing in the loaded invoices matches this filter.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No invoices in the last 7 days/)).toBeNull();
  });
});

describe('Invoices screen: the totals say what they cover', () => {
  it('totals outstanding amountDue only across open invoices', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', amountDue: 40, total: 40, status: 'open' }),
        entry({ _id: 'b', amountDue: 0, total: 20, status: 'paid', editScope: 'none' }),
      ]),
    );
    render(<Invoices />);
    const outstanding = screen.getByText('Outstanding').closest('.den-stat, button.den-stat--button');
    expect(outstanding).not.toBeNull();
    expect(within(outstanding as HTMLElement).getByText('$40.00')).toBeInTheDocument();
  });

  it('claims the whole window only once the cursor is exhausted', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Invoices />);
    expect(
      screen.getByText('These totals cover the 1 invoice in the last 7 days.'),
    ).toBeInTheDocument();
  });

  it('refuses to present a partial page as a book figure', () => {
    // "Billed total" over half a window reads like a business number and is not
    // one. This is the assertion that stops it becoming one again.
    usePagedCollection.mockReturnValue(paged([entry({}), entry({ _id: 'b' })], { hasMore: true }));
    render(<Invoices />);
    expect(
      screen.getByText(
        'These totals cover the 2 invoices loaded so far, not all of the last 7 days.',
      ),
    ).toBeInTheDocument();
  });

  it('makes no claim at all while the first page is in flight', () => {
    usePagedCollection.mockReturnValue(paged([], { state: { status: 'loading' } }));
    render(<Invoices />);
    expect(screen.queryByText(/These totals cover/)).toBeNull();
  });
});

describe('Invoices screen: paging', () => {
  it('offers Load more only while the cursor says there may be another page', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    const { unmount } = render(<Invoices />);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    unmount();

    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    render(<Invoices />);
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
  });

  it('asks the hook for the next page, and never re-implements the cursor itself', async () => {
    usePagedCollection.mockReturnValue(paged([entry({})], { hasMore: true }));
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalledOnce();
  });

  it('blocks a second request while one is in flight, and says it is working', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], { hasMore: true, more: { status: 'loading' } }),
    );
    render(<Invoices />);
    expect(screen.getByRole('button', { name: 'Loading more…' })).toBeDisabled();
  });

  it('renders every row of a large accumulated page, with no 200-row cap left anywhere', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      entry({ _id: `i${String(i)}`, invoiceNumber: `N${String(i)}` }),
    );
    usePagedCollection.mockReturnValue(paged(many));
    render(<Invoices />);
    expect(document.querySelectorAll('.invoices__row')).toHaveLength(250);
    expect(screen.getByText('#N249')).toBeInTheDocument();
  });
});

describe('Invoices screen: a failed FIRST page is not a failed LATER page', () => {
  it('replaces the list when the first page fails, and offers a retry', () => {
    usePagedCollection.mockReturnValue(
      paged([], { state: { status: 'error', message: 'permission-denied', retry: reload } }),
    );
    render(<Invoices />);
    // The three summary StatCards ALSO surface this same error honestly (an
    // Async in 'error' status can't claim any number, per lib/async.ts's
    // asyncScalar), so this asserts the main list's own error text specifically
    // rather than an ambiguous page-wide match.
    expect(
      screen.getByText('permission-denied', { selector: '.async-error-detail' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/No invoices in/)).toBeNull();
    expect(document.querySelectorAll('.invoices__row')).toHaveLength(0);
  });

  it('KEEPS the rows when a later page fails, and reports the failure beside them', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ invoiceNumber: 'STILL' })], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    render(<Invoices />);

    expect(screen.getByText('#STILL')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t load more invoices. deadline-exceeded');
    expect(alert).toHaveTextContent('The 1 already listed are unaffected');
    expect(screen.queryByText('Invoices unavailable while the load is failing.')).toBeNull();
  });

  it('retries the failed page from where it stopped, not from the top', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({})], {
        hasMore: true,
        more: { status: 'error', message: 'deadline-exceeded', retry: loadMore },
      }),
    );
    render(<Invoices />);
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: /retry/i }));
    expect(loadMore).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
/**
 * THE ROW'S QUICK ACTION, the parity gap that mattered most against Android.
 *
 * Android's `RowAction` puts one state-appropriate action on every row, drawn
 * from the shared `invoiceActionsFor`, so a list of overdue invoices can be
 * worked without opening each one. The web list had none.
 *
 * The button OPENS THE DETAIL ARMED ON THAT ACTION rather than firing the
 * callable from the row: every one of these reaches a real household, and the
 * confirm step that spells out what it does already exists. These tests pin both
 * halves: that the right action appears per stored state, and that pressing it
 * lands on that confirm step and nothing else.
 */
describe('Invoices row quick action', () => {
  function rowOf(number: string): HTMLElement {
    return screen.getByText(`#${number}`).closest('.invoices__row') as HTMLElement;
  }
  it('offers Send reminder on an open invoice', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open' })]));
    render(<Invoices />);
    expect(within(rowOf('1042')).getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
  });
  it('offers Review and send on a draft', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'draft', editScope: 'all' })]));
    render(<Invoices />);
    expect(
      within(rowOf('1042')).getByRole('button', { name: 'Review and send' }),
    ).toBeInTheDocument();
  });
  it('offers Receipt on a paid invoice, and never Send reminder', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'paid', amountDue: 0, editScope: 'none' })]),
    );
    render(<Invoices />);
    const row = rowOf('1042');
    expect(within(row).getByRole('button', { name: 'Receipt' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Send reminder' })).toBeNull();
  });
  it.each(['quote', 'cancelled', 'credit', 'redeemed', 'zero'] as const)(
    'offers NO row action on a %s invoice, matching the detail panel',
    (status) => {
      usePagedCollection.mockReturnValue(paged([entry({ status, editScope: 'none' })]));
      render(<Invoices />);
      const row = rowOf('1042');
      expect(within(row).queryByRole('button', { name: 'Send reminder' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Receipt' })).toBeNull();
      expect(within(row).queryByRole('button', { name: 'Review and send' })).toBeNull();
    },
  );
  it('offers NO row action on a doc with no recognizable state stamp', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'weird' as InvoiceEntry['status'] })]),
    );
    render(<Invoices />);
    const row = rowOf('1042');
    expect(within(row).getByText('WEIRD')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Send reminder' })).toBeNull();
  });
  it('never offers Record payment from the row: it needs fields the row has no space for', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open' })]));
    render(<Invoices />);
    expect(
      within(rowOf('1042')).queryByRole('button', { name: 'Record payment' }),
    ).toBeNull();
  });
  it('opens the detail already on the reminder confirm step, and sends nothing yet', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open' })]));
    render(<Invoices />);
    await userEvent.click(within(rowOf('1042')).getByRole('button', { name: 'Send reminder' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/sends a real payment-reminder notification/i)).toBeInTheDocument();
    // Armed, not fired. The confirm step is the thing that fires it.
    expect(sendInvoiceReminder).not.toHaveBeenCalled();
  });
  it('fires the callable only once the confirm step is confirmed', async () => {
    sendInvoiceReminder.mockResolvedValue(undefined);
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open' })]));
    render(<Invoices />);
    await userEvent.click(within(rowOf('1042')).getByRole('button', { name: 'Send reminder' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Send reminder' }));
    expect(sendInvoiceReminder).toHaveBeenCalledWith('inv1');
  });
  it('clicking the ROW itself still opens the plain detail, with nothing armed', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open' })]));
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /#1042/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByText(/sends a real payment-reminder notification/i)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Send reminder' })).toBeInTheDocument();
  });
  it('cancelling the armed confirm leaves the operator on the action list, not back on it', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open' })]));
    render(<Invoices />);
    await userEvent.click(within(rowOf('1042')).getByRole('button', { name: 'Send reminder' }));
    const dialog = screen.getByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).queryByText(/sends a real payment-reminder notification/i)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });
});
/**
 * MONEY THE ROW WAS COMPUTING AND THROWING AWAY. The screen already worked out
 * that an invoice was part paid, in order to pick the PART PAID chip, and then
 * printed only the total beside it.
 */
describe('Invoices row, part-paid amounts', () => {
  it('names what came in and what is still owed, beside the total', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'open', total: 40, amountDue: 20, paidCents: 2000 })]),
    );
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('PART PAID')).toBeInTheDocument();
    expect(within(row).getByText(/\$20\.00 paid, \$20\.00 still owed/)).toBeInTheDocument();
    // The big figure is still the TOTAL: these two are the correction to it.
    expect(within(row).getByText('$40.00')).toBeInTheDocument();
  });
  it('says nothing about payments on an invoice with no record of one', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open', total: 40, amountDue: 40 })]));
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).queryByText(/still owed/)).toBeNull();
  });
  it('claims no partial payment on a PAID invoice, whatever paidCents says', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'paid', total: 40, amountDue: 0, paidCents: 4000 })]),
    );
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).queryByText(/still owed/)).toBeNull();
    expect(within(row).getByText('PAID')).toBeInTheDocument();
  });
});
/** Days-overdue on the meta line, the age that decides what to do about it. */
describe('Invoices row, days overdue', () => {
  it('says how many days late an overdue invoice is, instead of just its due date', () => {
    // localDateIso reads the LOCAL calendar date, so the due date is derived
    // from the same clock the screen uses rather than hardcoded.
    const today = new Date();
    const past = new Date(today.getTime() - 12 * 86_400_000);
    const iso = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open', dueDate: iso })]));
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('12 days overdue')).toBeInTheDocument();
    expect(within(row).getByText('OVERDUE')).toBeInTheDocument();
  });
  it('keeps the plain due date on an invoice that is not yet late', () => {
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const iso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, '0')}-${String(soon.getDate()).padStart(2, '0')}`;
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open', dueDate: iso })]));
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText(/^due /)).toBeInTheDocument();
    expect(within(row).queryByText(/overdue/)).toBeNull();
  });
  it('falls back to the due date when the stored value is not a date', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'open', dueDate: 'Net 14' })]));
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('due Net 14')).toBeInTheDocument();
  });
});
/**
 * THE ARCHIVE MARKER. Archived invoices are out of the Outstanding and Billed
 * totals at the top of this screen. Under the Included / Only archived facet
 * they sit among active rows, and without a marker those totals cannot be
 * checked by eye against the list that is supposed to explain them.
 */
describe('Invoices row, archived marker', () => {
  it('marks an archived row once the facet lets it through', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', invoiceNumber: 'ACTIVE' }),
        entry({ _id: 'b', invoiceNumber: 'FILED', archivedAt: fakeTs('2026-07-16T10:00:00Z') }),
      ]),
    );
    render(<Invoices />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), '');
    const filed = screen.getByText('#FILED').closest('.invoices__row') as HTMLElement;
    const active = screen.getByText('#ACTIVE').closest('.invoices__row') as HTMLElement;
    expect(within(filed).getByText('ARCHIVED')).toBeInTheDocument();
    expect(within(active).queryByText('ARCHIVED')).toBeNull();
  });
  it('keeps the state chip beside the marker: archiving is not a state', async () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'open', archivedAt: fakeTs('2026-07-16T10:00:00Z') })]),
    );
    render(<Invoices />);
    await userEvent.selectOptions(screen.getByLabelText('Archived'), 'only');
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('OPEN')).toBeInTheDocument();
    expect(within(row).getByText('ARCHIVED')).toBeInTheDocument();
  });
  it('shows no marker at all under the default facet, which hides them anyway', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ archivedAt: fakeTs('2026-07-16T10:00:00Z') })]),
    );
    render(<Invoices />);
    expect(screen.queryByText('ARCHIVED')).toBeNull();
  });
});
/** The Overdue card's subline: who is worst and by how long, matching Android. */
describe('Invoices Overdue stat subline', () => {
  function daysAgoIso(days: number): string {
    const d = new Date(Date.now() - days * 86_400_000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  it('names the household furthest past due, and how far', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', invoiceNumber: 'A', kinfolkName: 'The Seeds', dueDate: daysAgoIso(6) }),
        entry({ _id: 'b', invoiceNumber: 'B', kinfolkName: 'The Thornes', dueDate: daysAgoIso(21) }),
      ]),
    );
    render(<Invoices />);
    expect(screen.getByText('The Thornes, 21 days past')).toBeInTheDocument();
  });
  it('falls back to the client when the household has no name', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ kinfolkName: '', client: 'Dana Ruiz', dueDate: daysAgoIso(3) })]),
    );
    render(<Invoices />);
    expect(screen.getByText('Dana Ruiz, 3 days past')).toBeInTheDocument();
  });
  it('says "all clear" rather than nothing when there are no overdue invoices', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'paid', amountDue: 0 })]));
    render(<Invoices />);
    expect(screen.getByText('all clear')).toBeInTheDocument();
  });
  it('counts only the invoices the archive facet has left in scope', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', invoiceNumber: 'A', kinfolkName: 'The Seeds', dueDate: daysAgoIso(6) }),
        entry({
          _id: 'b',
          invoiceNumber: 'B',
          kinfolkName: 'The Thornes',
          dueDate: daysAgoIso(21),
          archivedAt: fakeTs('2026-07-16T10:00:00Z'),
        }),
      ]),
    );
    render(<Invoices />);
    // The Thornes invoice is archived, so it is out of the totals and out of
    // this subline; the operator has stopped chasing it.
    expect(screen.getByText('The Seeds, 6 days past')).toBeInTheDocument();
  });
  it('is not overdue at all on free text like "Net 14", so the card stays all clear', () => {
    usePagedCollection.mockReturnValue(paged([entry({ dueDate: 'Net 14' })]));
    render(<Invoices />);
    expect(screen.getByText('all clear')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
  });
  it('names the household with NO number when the date is shaped right but impossible', () => {
    // '2025-13-01' passes the ISO-prefix shape test (digits and dashes in the
    // right places) and sorts BEFORE today, so the row is genuinely overdue by
    // the same lexicographic compare the chip uses. It then fails to parse, so
    // the age is unknowable. The subline names who and stops; "NaN days past" is
    // the failure this branch exists to refuse.
    usePagedCollection.mockReturnValue(
      paged([entry({ kinfolkName: 'The Seeds', dueDate: '2025-13-01' })]),
    );
    render(<Invoices />);
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('OVERDUE')).toBeInTheDocument();
    // Scoped to the stat card, since the household name is also on the row.
    expect(screen.getByText('The Seeds', { selector: '.den-stat-trend' })).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.queryByText(/days past/)).toBeNull();
  });
});
/** The Outstanding card's subline now carries the count, like Android's. */
describe('Invoices Outstanding stat subline', () => {
  it('says how many open invoices the total is spread across', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ _id: 'a', invoiceNumber: 'A' }), entry({ _id: 'b', invoiceNumber: 'B' })]),
    );
    render(<Invoices />);
    expect(screen.getByText('across 2 open invoices')).toBeInTheDocument();
  });
  it('is singular for one', () => {
    usePagedCollection.mockReturnValue(paged([entry({})]));
    render(<Invoices />);
    expect(screen.getByText('across 1 open invoice')).toBeInTheDocument();
  });
  it('says across 0 when nothing is open, rather than dropping the line', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: 'paid', amountDue: 0 })]));
    render(<Invoices />);
    expect(screen.getByText('across 0 open invoices')).toBeInTheDocument();
  });
});
/** Searching by the amount as the row prints it, matching Android. */
describe('Invoices search by amount', () => {
  it('finds an invoice by the figure written on its row', async () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', invoiceNumber: 'FORTY', total: 40 }),
        entry({ _id: 'b', invoiceNumber: 'NINETY', total: 90 }),
      ]),
    );
    render(<Invoices />);
    await userEvent.type(screen.getByLabelText('Search invoices'), '$40');
    expect(screen.getByText('#FORTY')).toBeInTheDocument();
    expect(screen.queryByText('#NINETY')).toBeNull();
  });
  it('says so when the amount matches nothing loaded, rather than silently emptying', async () => {
    usePagedCollection.mockReturnValue(paged([entry({ total: 40 })]));
    render(<Invoices />);
    await userEvent.type(screen.getByLabelText('Search invoices'), '$999');
    expect(screen.getByText(/nothing in the loaded invoices matches this filter/i)).toBeInTheDocument();
  });
});
/**
 * THE LIST MARKER.
 *
 * The list is where "paid" lies loudest: a disputed invoice sits in the PAID
 * chip, inside the Billed total, looking exactly like one whose money is still
 * there. stripeDispute.ts's stated purpose is that "no screen can render 'paid'
 * without also being able to render 'disputed'", and this is a screen.
 *
 * It marks OPEN disputes only. `disputeStatus` is never cleared, so a marker on
 * every once-disputed invoice would be permanent, and a permanent marker on a
 * won dispute is the "everything is on fire" failure the operator ruled out.
 * The won history stays on the detail panel, where it is read on purpose.
 */
describe('Invoices row, dispute marker', () => {
  it('marks a paid row whose money is being clawed back', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'a', invoiceNumber: 'CLEAN', status: 'paid', amountDue: 0 }),
        entry({ _id: 'b', invoiceNumber: 'FIGHT', status: 'paid', amountDue: 0, disputeStatus: 'needs_response' }),
      ]),
    );
    render(<Invoices />);
    const fight = screen.getByText('#FIGHT').closest('.invoices__row') as HTMLElement;
    const clean = screen.getByText('#CLEAN').closest('.invoices__row') as HTMLElement;
    expect(within(fight).getByText('DISPUTED')).toBeInTheDocument();
    // The state chip stays: a dispute is not an invoice state, it sits beside one.
    expect(within(fight).getByText('PAID')).toBeInTheDocument();
    expect(within(clean).queryByText('DISPUTED')).toBeNull();
  });
  it('marks a row whose funds were withdrawn before any status arrived', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'paid', amountDue: 0, disputeFundsState: 'withdrawn' })]),
    );
    render(<Invoices />);
    expect(screen.getByText('DISPUTED')).toBeInTheDocument();
  });
  it('leaves a WON dispute unmarked: it is history, and the flag is never cleared', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'paid', amountDue: 0, disputeStatus: 'won', disputeId: 'dp_1' })]),
    );
    render(<Invoices />);
    expect(screen.queryByText('DISPUTED')).toBeNull();
  });
});
/**
 * A quote the household turned down (issue #385). It keeps `status: 'quote'`
 * server-side, so without a marker it is indistinguishable in the Quote filter
 * from one still waiting for an answer.
 */
describe('Invoices row, declined-quote marker', () => {
  it('marks a declined quote while leaving its QUOTE chip alone', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({ _id: 'q1', invoiceNumber: 'DEAD', status: 'quote', quoteDecision: 'denied' }),
        entry({ _id: 'q2', invoiceNumber: 'LIVE', status: 'quote' }),
      ]),
    );
    render(<Invoices />);
    const dead = screen.getByText('#DEAD').closest('.invoices__row') as HTMLElement;
    const live = screen.getByText('#LIVE').closest('.invoices__row') as HTMLElement;
    expect(within(dead).getByText('DECLINED')).toBeInTheDocument();
    // The doc really is still a quote; the marker sits beside the state chip.
    expect(within(dead).getByText('QUOTE')).toBeInTheDocument();
    expect(within(live).queryByText('DECLINED')).toBeNull();
  });
  it('does not mark an accepted quote, which is an ordinary open invoice by then', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'open', quoteDecision: 'accepted' })]),
    );
    render(<Invoices />);
    expect(screen.queryByText('DECLINED')).toBeNull();
    expect(screen.getByText('OPEN')).toBeInTheDocument();
  });
});
