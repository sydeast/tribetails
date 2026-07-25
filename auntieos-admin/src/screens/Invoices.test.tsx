// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
const { createInvoice, createQuote, sendInvoiceReminder, markInvoicePaid, generateReceipt } = vi.hoisted(() => ({
  createInvoice: vi.fn(),
  createQuote: vi.fn(),
  sendInvoiceReminder: vi.fn(),
  markInvoicePaid: vi.fn(),
  generateReceipt: vi.fn(),
}));
vi.mock('../api/invoicesWrite', async (orig) => ({
  ...(await orig<typeof import('../api/invoicesWrite')>()),
  createInvoice,
  createQuote,
  sendInvoiceReminder,
  markInvoicePaid,
  generateReceipt,
}));

import { Invoices } from './Invoices';

function fakeTs(iso: string): Timestamp {
  return { toDate: () => new Date(iso) } as unknown as Timestamp;
}

function entry(over: Partial<InvoiceEntry>): InvoiceEntry {
  return {
    _id: 'inv1',
    kinfolkId: 'k1',
    kinfolkName: 'The Whitfields',
    client: '',
    invoiceNumber: '1042',
    date: '',
    dueDate: '',
    total: 40,
    amountDue: 40,
    status: '',
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

  it('AO-12 regression guard: an unredeemed credit renders CREDIT, never PAID', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: 'credit', amountDue: -20, total: -20 })]),
    );
    render(<Invoices />);
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
    expect(screen.queryByText('PAID')).toBeNull();
  });

  it('a redeemed credit renders REDEEMED, distinctly from an unredeemed one', () => {
    usePagedCollection.mockReturnValue(
      paged([
        entry({
          status: 'credit',
          amountDue: -20,
          total: -20,
          creditRedeemedAt: fakeTs('2026-07-15T00:00:00Z'),
        }),
      ]),
    );
    render(<Invoices />);
    expect(screen.getByText('REDEEMED')).toBeInTheDocument();
  });

  it('a settled invoice (amountDue retired, real total, no explicit label) renders PAID', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: '', amountDue: 0, total: 40 })]));
    render(<Invoices />);
    expect(screen.getByText('PAID')).toBeInTheDocument();
  });

  it('a $0 invoice renders ZERO, not a fabricated PAID', () => {
    usePagedCollection.mockReturnValue(paged([entry({ status: '', amountDue: 0, total: 0 })]));
    render(<Invoices />);
    expect(screen.getByText('ZERO')).toBeInTheDocument();
    expect(screen.queryByText('PAID')).toBeNull();
  });

  it('an overdue open invoice shows the OVERDUE chip instead of OPEN', () => {
    usePagedCollection.mockReturnValue(
      paged([entry({ status: '', amountDue: 40, total: 40, dueDate: '2020-01-01' })]),
    );
    render(<Invoices />);
    expect(screen.getByText('OVERDUE')).toBeInTheDocument();
    expect(screen.queryByText('OPEN')).toBeNull();
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
    entry({ _id: 'b', invoiceNumber: 'B', status: '', amountDue: 40, total: 40, kinfolkName: 'The Bakers' }),
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
      paged([entry({ status: '', amountDue: 40, total: 40 })]),
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
        entry({ _id: 'a', amountDue: 40, total: 40, status: '' }),
        entry({ _id: 'b', amountDue: 0, total: 20, status: 'paid' }),
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
