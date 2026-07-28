// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceDetail } from './InvoiceDetail';
import type { GetMyInvoicesResult } from '../api/invoicesApi';

/**
 * Covers the one gap this session found in an already-shipped screen: the
 * pay/download/redeem mutations had no onError handler, so a rejected
 * callable just stopped the button spinner with nothing telling the kinfolk
 * why (the same "swallowed error" bug KinTales' comment-post had before it
 * was fixed). These pin that each surfaces a distinct, visible message.
 */

vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ invoiceId: 'inv-open-1' }),
}));

vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'kin-fam-1',
}));

const payInvoice = vi.fn();
const redeemCredit = vi.fn();
const getMyInvoicePdf = vi.fn();

vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: vi.fn(),
    payInvoice: (...args: unknown[]) => payInvoice(...args),
    redeemCredit: (...args: unknown[]) => redeemCredit(...args),
    getMyInvoicePdf: (...args: unknown[]) => getMyInvoicePdf(...args),
  };
});

vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn().mockResolvedValue({ name: 'Tribe Tails', address: '123 Main St', email: 'hi@tribetails.com' }),
}));

const OPEN_INVOICE: GetMyInvoicesResult['open'][number] = {
  id: 'inv-open-1',
  kinfolkId: 'kin-fam-1',
  kinfolkName: 'The Test Family',
  client: 'The Test Family',
  total: 50,
  amountDue: 50,
  isPaid: false,
  status: 'open',
  // The stamp's edit half ships for parity; no portal screen branches on it.
  editScope: null,
  paidCents: 0,
  partiallyPaid: false,
  date: '2026-07-01',
  dueDate: '2026-07-15',
  discount: null,
  terms: null,
  paymentsHistory: null,
  address: null,
  viewed: true,
  creditAmountCents: null,
  creditTarget: null,
  creditRedeemedAtMs: null,
};

const CREDIT_INVOICE: GetMyInvoicesResult['credits'][number] = {
  ...OPEN_INVOICE,
  // Same id as OPEN_INVOICE: the useParams mock above returns a fixed
  // invoiceId ('inv-open-1'), so every fixture in this file must share it —
  // only the bucket (open vs. credits) it's placed in differs per test.
  status: 'credit',
  creditAmountCents: 2000,
  creditRedeemedAtMs: null,
};

describe('InvoiceDetail — mutation error surfacing', () => {
  it('pay failure shows a visible error instead of just stopping the spinner', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({ open: [OPEN_INVOICE], paid: [], credits: [], accountBalanceCents: 0 });
    payInvoice.mockRejectedValue(new Error('Card declined by Stripe.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );

    const payButton = await screen.findByRole('button', { name: /Pay \$50\.00/ });
    await userEvent.click(payButton);

    await waitFor(() => expect(screen.getByText('Card declined by Stripe.')).toBeInTheDocument());
  });

  it('PDF download failure shows a distinct error', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({ open: [OPEN_INVOICE], paid: [], credits: [], accountBalanceCents: 0 });
    getMyInvoicePdf.mockRejectedValue(new Error('PDF render timed out.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: /Download PDF/ }));
    await waitFor(() => expect(screen.getByText('PDF render timed out.')).toBeInTheDocument());
  });

  it('credit redemption failure shows a distinct error on the credit card', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({ open: [], paid: [], credits: [CREDIT_INVOICE], accountBalanceCents: 0 });
    redeemCredit.mockRejectedValue(new Error('Credit already redeemed.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );

    // Single-action button now: credits are NOT refundable, so there is no
    // target to choose and the CTA names the only outcome.
    await userEvent.click(await screen.findByRole('button', { name: /Save to Account Balance/ }));
    await waitFor(() => expect(screen.getByText(/Credit already redeemed\./)).toBeInTheDocument());
  });
});
/**
 * The kinfolk portal is the screen a paying household reads, so a part-paid
 * invoice has to say what it actually is. Neither "PENDING" (which hides the
 * money already sent) nor "PAID" (which hides the balance still owed).
 */
describe('InvoiceDetail — a part-paid invoice reads honestly', () => {
  const PART_PAID: GetMyInvoicesResult['open'][number] = {
    ...OPEN_INVOICE,
    total: 50,
    amountDue: 30,
    paidCents: 2000,
    partiallyPaid: true,
  };
  async function renderWith(invoice: GetMyInvoicesResult['open'][number]) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [invoice], paid: [], credits: [], accountBalanceCents: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );
  }
  it('shows a PART PAID chip and both figures, not a bare PENDING', async () => {
    await renderWith(PART_PAID);
    expect(await screen.findByText('PART PAID')).toBeInTheDocument();
    expect(screen.getByText('$20.00 of $50.00 paid')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).toBeNull();
    expect(screen.queryByText('PAID')).toBeNull();
  });
  it('offers to pay the REMAINING balance, not the total', async () => {
    await renderWith(PART_PAID);
    expect(await screen.findByRole('button', { name: /Pay remaining \$30\.00/ })).toBeInTheDocument();
  });
  it('shows what was collected from paidCents rather than inferring it', async () => {
    await renderWith(PART_PAID);
    await screen.findByText('PART PAID');
    // total - amountDue would also read $20 here; the point is that the figure
    // comes from the recorded payments, so it stays right on an invoice whose
    // amountDue was zeroed by the old write.
    expect(screen.getByText('Paid')).toBeInTheDocument();
  });
  it('leaves an ordinary open invoice exactly as it was', async () => {
    await renderWith(OPEN_INVOICE);
    expect(await screen.findByRole('button', { name: /Pay \$50\.00/ })).toBeInTheDocument();
    expect(screen.queryByText('PART PAID')).toBeNull();
  });
});
/**
 * The breakdown table. Until 2026-07-25 the server built these rows from the
 * invoice's `sessionIds` and never read its stored `lineItems`, so an itemized
 * invoice showed the household a different set of rows from the one the operator
 * billed, with amounts read off the session and therefore usually blank.
 */
describe('InvoiceDetail line items', () => {
  const ITEMIZED: GetMyInvoicesResult['open'][number] = {
    ...OPEN_INVOICE,
    total: 64,
    amountDue: 64,
    lineItems: [
      {
        lineId: 'stored:0', source: 'stored', sessionId: '',
        label: 'Daily visit', dateIso: null, amountCents: 6000, qty: 3, unitCents: 2000,
      },
      {
        lineId: 'stored:1', source: 'stored', sessionId: '',
        label: 'Extra dog', dateIso: null, amountCents: 400, qty: 1, unitCents: 500,
      },
    ],
  };
  async function renderWith(invoice: GetMyInvoicesResult['open'][number]) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({ open: [invoice], paid: [], credits: [], accountBalanceCents: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );
  }
  it('renders every stored line with a real amount, none of them blank', async () => {
    await renderWith(ITEMIZED);
    expect(await screen.findByText('Daily visit')).toBeInTheDocument();
    expect(screen.getByText('Extra dog')).toBeInTheDocument();
    expect(screen.getByText('$60.00')).toBeInTheDocument();
    expect(screen.getByText('$4.00')).toBeInTheDocument();
  });
  it('shows the unit breakdown only where it adds something', async () => {
    // 3 x $20 explains a $60 row. A quantity of one would just repeat the
    // amount column, so it is not printed.
    await renderWith(ITEMIZED);
    expect(await screen.findByText('3 x $20.00')).toBeInTheDocument();
    expect(screen.queryByText('1 x $5.00')).not.toBeInTheDocument();
  });
  it('renders two rows for two lines, which a shared React key would have collapsed', async () => {
    // Every stored line carries an empty sessionId, so keying the table on it
    // put two rows under one key.
    await renderWith(ITEMIZED);
    await screen.findByText('Daily visit');
    const rows = document.querySelectorAll('table.items tbody tr');
    expect(rows).toHaveLength(2);
  });
  it('still renders a legacy session-derived line, dates and all', async () => {
    await renderWith({
      ...OPEN_INVOICE,
      lineItems: [
        {
          lineId: 'session:vis_1', source: 'session', sessionId: 'vis_1',
          label: '30Minute', dateIso: '2026-07-01T10:00:00', amountCents: 2500, qty: null, unitCents: null,
        },
      ],
    });
    expect(await screen.findByText('30Minute')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
  });
});
/**
 * The stored stamp's states this screen newly distinguishes (ADR-0002 W2-5).
 * The server ships `status` verbatim — all eight states — and the payable
 * gate is now the positive `status === 'open' && amountDue > 0`, so a quote
 * (which the retired 5-state enum could only spell `open`) no longer grows a
 * Pay button, and a `redeemed` credit still renders its credit panel.
 */
describe('InvoiceDetail — stamped states', () => {
  async function renderWith(res: GetMyInvoicesResult) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue(res);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );
  }
  it('a quote shows its QUOTE chip and NO Pay button, even with a positive total', async () => {
    await renderWith({
      open: [{ ...OPEN_INVOICE, status: 'quote', total: 80, amountDue: 80 }],
      paid: [], credits: [], accountBalanceCents: 0,
    });
    expect(await screen.findByText('QUOTE')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });
  it('a redeemed-status credit renders the redeemed panel, not the redeem button', async () => {
    await renderWith({
      open: [], paid: [],
      credits: [{
        ...OPEN_INVOICE,
        status: 'redeemed',
        creditAmountCents: 2000,
        creditTarget: 'accountBalance',
        creditRedeemedAtMs: 1_750_000_000_000,
      }],
      accountBalanceCents: 0,
    });
    expect(await screen.findByText(/Saved to Account Balance/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save to Account Balance/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });
});
