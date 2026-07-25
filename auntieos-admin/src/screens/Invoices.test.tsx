// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Timestamp } from 'firebase/firestore';
import { type Async } from '../lib/async';
import { type InvoiceEntry } from '../api/invoices';

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

beforeEach(() => {
  useCollection.mockReset().mockReturnValue({ status: 'ready', data: [] } satisfies Async<InvoiceEntry[]>);
  createInvoice.mockReset();
  createQuote.mockReset();
  sendInvoiceReminder.mockReset();
  markInvoicePaid.mockReset();
  generateReceipt.mockReset();
});

describe('Invoices screen', () => {
  it('renders a streamed row with its invoice number, household, amount, and status chip', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Invoices />);
    // Scope by the row container, not the button: it's a more stable anchor
    // than the button role now that every row is one (see below).
    const row = screen.getByText('#1042').closest('.invoices__row') as HTMLElement;
    expect(within(row).getByText('#1042')).toBeInTheDocument();
    expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
    // The Outstanding stat card also reads $40.00 here (this is the only open
    // invoice), so the amount is asserted scoped to the row, not page-wide.
    expect(within(row).getByText('$40.00')).toBeInTheDocument();
    expect(within(row).getByText('OPEN')).toBeInTheDocument();
  });

  it('AO-12 regression guard: an unredeemed credit renders CREDIT, never PAID', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: 'credit', amountDue: -20, total: -20 })],
    });
    render(<Invoices />);
    expect(screen.getByText('CREDIT')).toBeInTheDocument();
    expect(screen.queryByText('PAID')).toBeNull();
  });

  it('a redeemed credit renders REDEEMED, distinctly from an unredeemed one', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: 'credit', amountDue: -20, total: -20, creditRedeemedAt: fakeTs('2026-07-15T00:00:00Z') })],
    });
    render(<Invoices />);
    expect(screen.getByText('REDEEMED')).toBeInTheDocument();
  });

  it('a settled invoice (amountDue retired, real total, no explicit label) renders PAID', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: '', amountDue: 0, total: 40 })],
    });
    render(<Invoices />);
    expect(screen.getByText('PAID')).toBeInTheDocument();
  });

  it('a $0 invoice renders ZERO, not a fabricated PAID', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: '', amountDue: 0, total: 0 })],
    });
    render(<Invoices />);
    expect(screen.getByText('ZERO')).toBeInTheDocument();
    expect(screen.queryByText('PAID')).toBeNull();
  });

  it('an overdue open invoice shows the OVERDUE chip instead of OPEN', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: '', amountDue: 40, total: 40, dueDate: '2020-01-01' })],
    });
    render(<Invoices />);
    expect(screen.getByText('OVERDUE')).toBeInTheDocument();
    expect(screen.queryByText('OPEN')).toBeNull();
  });

  it('surfaces a listener error, never a false empty', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'permission-denied' });
    render(<Invoices />);
    // The three summary StatCards ALSO surface this same error honestly (an
    // Async in 'error' status can't claim any number, per lib/async.ts's
    // asyncScalar), so this asserts the main list's own error text specifically
    // rather than an ambiguous page-wide match.
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/no invoices on the books yet/i)).toBeNull();
  });

  it('surfaces a load failure with retry, not a silent spinner', () => {
    useCollection.mockReturnValue({ status: 'error', message: 'deadline-exceeded', retry: vi.fn() });
    render(<Invoices />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the stream is ready and genuinely empty', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [] });
    render(<Invoices />);
    expect(screen.getByText(/no invoices on the books yet/i)).toBeInTheDocument();
  });

  it('filter tabs narrow the visible rows without hiding the others behind a false empty', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', invoiceNumber: 'A', status: 'draft' }),
        entry({ _id: 'b', invoiceNumber: 'B', status: '', amountDue: 40, total: 40 }),
      ],
    });
    render(<Invoices />);
    expect(screen.getByText('#A')).toBeInTheDocument();
    expect(screen.getByText('#B')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByText('#A')).toBeInTheDocument();
    expect(screen.queryByText('#B')).toBeNull();
  });

  it('shows a "nothing matches" hint (not the top-level empty state) when a filter excludes every row', async () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [entry({ status: '', amountDue: 40, total: 40 })],
    });
    render(<Invoices />);
    await userEvent.click(screen.getByRole('tab', { name: 'Draft' }));
    expect(screen.getByText(/nothing matches this filter/i)).toBeInTheDocument();
    expect(screen.queryByText(/no invoices on the books yet/i)).toBeNull();
  });

  it('every row is a real interactive button (InvoiceDetail is wired in now, no more static placeholder)', () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({})] });
    render(<Invoices />);
    expect(screen.getByRole('button', { name: /1042/i })).toBeInTheDocument();
  });

  it('clicking a row opens InvoiceDetail for that invoice', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'inv-42' })] });
    render(<Invoices />);
    await userEvent.click(screen.getByRole('button', { name: /1042/i }));
    expect(await screen.findByRole('heading', { name: /invoice #1042/i })).toBeInTheDocument();
    // Scoped: "The Whitfields" also appears in the row underneath the dialog.
    expect(within(screen.getByRole('dialog')).getByText('The Whitfields')).toBeInTheDocument();
  });

  it('closing InvoiceDetail returns to the list', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'inv-42' })] });
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
    useCollection.mockImplementation((spec: { path: string }) =>
      spec.path === 'kinfolk'
        ? { status: 'ready', data: [{ _id: 'k9', firstName: 'Dana', lastName: 'Ruiz' }] }
        : { status: 'ready', data: [] },
    );
    render(<Invoices composeQuoteForKinfolkId="k9" />);
    expect(await screen.findByRole('heading', { name: 'New quote' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Household' })).toHaveValue('k9');
  });

  it('opens no composer without the seed', () => {
    render(<Invoices />);
    expect(screen.queryByRole('heading', { name: 'New quote' })).toBeNull();
  });

  it('initialInvoiceId opens that invoice detail on mount', async () => {
    useCollection.mockReturnValue({ status: 'ready', data: [entry({ _id: 'inv1' })] });
    render(<Invoices initialInvoiceId="inv1" />);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('the summary strip totals outstanding amountDue only across open invoices', () => {
    useCollection.mockReturnValue({
      status: 'ready',
      data: [
        entry({ _id: 'a', amountDue: 40, total: 40, status: '' }),
        entry({ _id: 'b', amountDue: 0, total: 20, status: 'paid' }),
      ],
    });
    render(<Invoices />);
    const outstanding = screen.getByText('Outstanding').closest('.den-stat, button.den-stat--button');
    expect(outstanding).not.toBeNull();
    expect(within(outstanding as HTMLElement).getByText('$40.00')).toBeInTheDocument();
  });
});
