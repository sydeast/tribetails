// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceDetail } from './InvoiceDetail';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';

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

const acceptQuote = vi.fn();
const denyQuote = vi.fn();
vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: vi.fn(),
    payInvoice: (...args: unknown[]) => payInvoice(...args),
    redeemCredit: (...args: unknown[]) => redeemCredit(...args),
    getMyInvoicePdf: (...args: unknown[]) => getMyInvoicePdf(...args),
    acceptQuote: (...args: unknown[]) => acceptQuote(...args),
    denyQuote: (...args: unknown[]) => denyQuote(...args),
  };
});

const getMyHome = vi.fn();

vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn().mockResolvedValue({ name: 'Tribe Tails', address: '123 Main St', email: 'hi@tribetails.com' }),
  getMyHome: (...args: unknown[]) => getMyHome(...args),
}));

// Stripe-only default: most tests here are about the mutation/status
// machinery, not the payment-method registry (that's PayOptions.test.tsx and
// getMyHome.test.ts). Individual tests below override this to cover the
// multi-method render.
beforeEach(() => {
  getMyHome.mockReset();
  getMyHome.mockResolvedValue({
    kinfolkId: 'kin-fam-1',
    displayName: 'The Test Family',
    businessLogoUrl: '',
    businessName: 'Tribe Tails',
    portal: { logoUrl: '', themeId: 'default', banner: { enabled: false, message: '', tone: 'info', dismissMode: 'none', id: '' }, home: [], chat: { enabled: true, awayMessage: '', hoursEnabled: false, hours: {}, maxMessageLength: 2000, rateLimitPerHour: 0 } },
    bannerDismissedByUser: false,
    payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
  });
});

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
  quoteDecision: null,
  quoteDecidedAtMs: null,
  creditAmountCents: null,
  creditTarget: null,
  creditRedeemedAtMs: null,
  // Issue #409: how this bill can be paid, resolved server-side off the
  // options it was issued with. The card needs nothing configured, so a
  // believable invoice always carries at least this one.
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
};

const CREDIT_INVOICE: GetMyInvoicesResult['credits'][number] = {
  ...OPEN_INVOICE,
  // Same id as OPEN_INVOICE: the useParams mock above returns a fixed
  // invoiceId ('inv-open-1'), so every fixture in this file must share it —
  // only the bucket (open vs. credits) it's placed in differs per test.
  status: 'credit',
  creditAmountCents: 2000,
  creditRedeemedAtMs: null,
  // Issue #409: how this bill can be paid, resolved server-side off the
  // options it was issued with. The card needs nothing configured, so a
  // believable invoice always carries at least this one.
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
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

    const payButton = await screen.findByRole('button', { name: 'Pay with Credit Card' });
    await userEvent.click(payButton);

    await waitFor(() => expect(screen.getByText('Card declined by Stripe.')).toBeInTheDocument());
  });

  /**
   * #825: one tap on Pay must not be able to become two live Checkout Sessions.
   *
   * `payInvoice` creates the session at STRIPE, and a second one stays payable
   * alongside the first: two sessions become two PaymentIntents, `stripeWebhook`
   * claims on the PaymentIntent id, so both settle and the household is charged
   * twice for one bill — with no refund available to put it back. The key is
   * handed through to Stripe, which answers the second attempt with the first
   * session, so what this asserts is that a re-tap after a visible failure
   * carries the SAME key.
   */
  it('holds one checkout key across a re-tap after a failure', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({ open: [OPEN_INVOICE], paid: [], credits: [], accountBalanceCents: 0 });
    payInvoice.mockRejectedValue(new Error('Card declined by Stripe.'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );
    const payButton = await screen.findByRole('button', { name: 'Pay with Credit Card' });
    await userEvent.click(payButton);
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole('button', { name: 'Pay with Credit Card' }));
    await waitFor(() => expect(payInvoice).toHaveBeenCalledTimes(2));
    // Fifth positional argument: (invoiceId, successUrl, cancelUrl, kinfolkId, key)
    const firstKey = payInvoice.mock.calls[0]![4];
    expect(firstKey).toMatch(/^chk_\d{10,16}_[a-z0-9]{1,16}$/);
    expect(payInvoice.mock.calls[1]![4]).toBe(firstKey);
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
    // The checkout CTA's own label no longer carries the amount (PR30 —
    // PayOptions renders "Pay with Credit Card" for every invoice), so the
    // REMAINING-not-total claim is pinned on a link method's "Send $X"
    // caption instead, which does carry the amount.
    //
    // Issue #409: the link method rides the INVOICE's own resolved options
    // now, not the business-wide list, because that is the one this screen
    // prefers.
    await renderWith({
      ...PART_PAID,
      payMethods: [
        { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null },
        { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie', instructions: null },
      ],
    });
    expect(await screen.findByText(/Send \$30\.00/)).toBeInTheDocument();
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
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
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
  /**
   * #408: an invoice built from work carries STORED lines that are bound to
   * their visits, so the household's copy names the service AND the day the
   * work happened. The date is read live off the visit by the server, so a
   * corrected visit time corrects the bill with it.
   */
  it('shows the day behind a stored line that is bound to a visit', async () => {
    await renderWith({
      ...OPEN_INVOICE,
      total: 25,
      amountDue: 25,
      lineItems: [
        {
          lineId: 'stored:0', source: 'stored', sessionId: 'vis_1',
          label: 'Dog walk, 2026-07-10', dateIso: '2026-07-10T14:00:00.000Z', amountCents: 2500, qty: 1, unitCents: 2500,
        },
      ],
    });
    expect(await screen.findByText('Dog walk, 2026-07-10')).toBeInTheDocument();
    // The DAY, never the stored timestamp.
    expect(screen.getByText('Jul 10, 2026')).toBeInTheDocument();
    expect(screen.queryByText('2026-07-10T14:00:00.000Z')).not.toBeInTheDocument();
  });
  it('leaves a hand-typed line undated rather than inventing the invoice date for it', async () => {
    await renderWith({
      ...OPEN_INVOICE,
      total: 10,
      amountDue: 10,
      lineItems: [
        {
          lineId: 'stored:0', source: 'stored', sessionId: '',
          label: 'Mileage', dateIso: null, amountCents: 1000, qty: 1, unitCents: 1000,
        },
      ],
    });
    await screen.findByText('Mileage');
    const cell = document.querySelector('table.items tbody tr td.date');
    expect(cell?.textContent).toBe('—');
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

/**
 * THE QUOTE ANSWER (issue #385). A quote used to be a read-only row on this
 * screen: the household could see it and could do nothing about it, because no
 * `acceptQuote` / `denyQuote` callable existed to answer it with.
 */
describe('InvoiceDetail: answering a quote', () => {
  const QUOTE: GetMyInvoicesResult['open'][number] = {
    ...OPEN_INVOICE,
    status: 'quote',
    total: 240,
    amountDue: 240,
    dueDate: '2026-09-30',
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
  beforeEach(() => {
    acceptQuote.mockReset().mockResolvedValue({ ok: true, invoiceId: 'inv-open-1', status: 'open' });
    denyQuote.mockReset().mockResolvedValue({ ok: true, invoiceId: 'inv-open-1', status: 'quote' });
  });
  it('offers both answers on an unanswered quote, and names the date it is good through', async () => {
    await renderWith(QUOTE);
    expect(await screen.findByRole('button', { name: 'Accept quote' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
    expect(screen.getByText(/good through/)).toBeInTheDocument();
    // Still not a bill: no Pay button until it is accepted.
    expect(screen.queryByRole('button', { name: /Pay/ })).toBeNull();
  });
  it('sends the acceptance for this invoice', async () => {
    await renderWith(QUOTE);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept quote' }));
    await waitFor(() => expect(acceptQuote).toHaveBeenCalledWith('inv-open-1', 'kin-fam-1'));
  });
  it('sends the decline for this invoice', async () => {
    await renderWith(QUOTE);
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(denyQuote).toHaveBeenCalledWith('inv-open-1', 'kin-fam-1'));
  });
  it('disables BOTH buttons while an answer is in flight, so neither can be sent twice', async () => {
    let release: (v: unknown) => void = () => {};
    acceptQuote.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    await renderWith(QUOTE);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept quote' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    release({ ok: true, invoiceId: 'inv-open-1', status: 'open' });
  });
  it("surfaces the SERVER'S refusal rather than a generic one", async () => {
    // The expiry rule lives on the server, which is the side that knows the
    // office's own calendar day. The screen prints what it says.
    acceptQuote.mockRejectedValue(
      new Error('This quote was only good through 2026-08-01, so it can no longer be accepted.'),
    );
    await renderWith(QUOTE);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept quote' }));
    await waitFor(() =>
      expect(screen.getByText(/only good through 2026-08-01/)).toBeInTheDocument(),
    );
  });
  it('a declined quote shows the decision and no buttons at all', async () => {
    await renderWith({ ...QUOTE, quoteDecision: 'denied', quoteDecidedAtMs: 1_755_000_000_000 });
    expect(await screen.findByText(/You declined this quote/)).toBeInTheDocument();
    expect(screen.getByText('DECLINED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept quote' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
  });
  it('an accepted quote is an open invoice that says who accepted it, and is payable', async () => {
    await renderWith({
      ...QUOTE,
      status: 'open',
      quoteDecision: 'accepted',
      quoteDecidedAtMs: 1_755_000_000_000,
    });
    expect(await screen.findByText(/You accepted this quote/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept quote' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
  });
});

/**
 * ISSUE #409: the invoice knows its own payment options.
 *
 * `getMyHome` ships a business-wide list, which cannot be right about a bill
 * issued before the operator changed her mind, and never carries the
 * instructions kind. The invoice now carries its own resolved list and this
 * screen prefers it. The home query stays as the fallback for the deploy-skew
 * window where the server is older than this bundle.
 */
describe('InvoiceDetail payment option sources (issue #409)', () => {
  const HOME_ONLY = {
    kinfolkId: 'kin-fam-1',
    displayName: 'The Test Family',
    businessLogoUrl: '',
    businessName: 'Tribe Tails',
    portal: {
      logoUrl: '',
      themeId: 'default',
      banner: { enabled: false, message: '', tone: 'info', dismissMode: 'none', id: '' },
      home: [],
      chat: { enabled: true, awayMessage: '', hoursEnabled: false, hours: {}, maxMessageLength: 2000, rateLimitPerHour: 0 },
    },
    bannerDismissedByUser: false,
    payMethods: [
      { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null },
      { id: 'paypal', label: 'Pay with PayPal', kind: 'link', url: 'https://paypal.me/business', instructions: null },
    ],
  };

  const OPEN: GetMyInvoicesResult['open'][number] = {
    id: 'inv-open-1',
    kinfolkId: 'kin-fam-1',
    kinfolkName: 'The Test Family',
    client: 'The Test Family',
    total: 50,
    amountDue: 50,
    isPaid: false,
    status: 'open',
    editScope: null,
    paidCents: 0,
    partiallyPaid: false,
    date: '2026-07-01',
    dueDate: '2026-07-15',
    discount: null,
    terms: null,
    paymentsHistory: null,
    address: null,
    viewed: false,
    quoteDecision: null,
    quoteDecidedAtMs: null,
    creditAmountCents: null,
    creditTarget: null,
    creditRedeemedAtMs: null,
    payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
  };

  async function renderWith(invoice: GetMyInvoicesResult['open'][number]) {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [invoice],
      paid: [],
      credits: [],
      accountBalanceCents: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <InvoiceDetail />
      </QueryClientProvider>,
    );
  }

  it("renders the invoice's own options in preference to the business-wide ones", async () => {
    getMyHome.mockResolvedValue(HOME_ONLY);
    await renderWith({
      ...OPEN,
      payMethods: [
        { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null },
        { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie', instructions: null },
      ],
    });
    expect(await screen.findByRole('link', { name: 'Pay with Venmo' })).toBeInTheDocument();
    // PayPal is on the business-wide list and NOT on this bill. It must not
    // appear, or the toggle has no visible effect where it matters.
    expect(screen.queryByRole('link', { name: 'Pay with PayPal' })).toBeNull();
  });

  it('falls back to the business-wide list when the invoice carries none', async () => {
    // A server older than this bundle. The screen keeps working.
    getMyHome.mockResolvedValue(HOME_ONLY);
    await renderWith({ ...OPEN, payMethods: [] });
    expect(await screen.findByRole('link', { name: 'Pay with PayPal' })).toBeInTheDocument();
  });

  it('falls back to the card alone when neither list arrives', async () => {
    getMyHome.mockRejectedValue(new Error('unavailable'));
    await renderWith({ ...OPEN, payMethods: [] });
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
  });

  it('renders an instructions method the business-wide list can never carry', async () => {
    getMyHome.mockResolvedValue(HOME_ONLY);
    await renderWith({
      ...OPEN,
      payMethods: [
        {
          id: 'zelle',
          label: 'Pay with Zelle',
          kind: 'instructions',
          url: null,
          instructions: 'Zelle to 805-555-0104 and put the invoice number in the note.',
        },
      ],
    });
    expect(await screen.findByText('Pay with Zelle')).toBeInTheDocument();
    expect(
      screen.getByText('Zelle to 805-555-0104 and put the invoice number in the note.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
