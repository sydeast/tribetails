// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Invoices } from './Invoices';
import { InvoiceDetail } from './InvoiceDetail';
import { offersPayment, payBlockedReason } from '../lib/invoiceFormat';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';

/**
 * #2410: AN OPEN BILL THE SERVER SAYS CANNOT TAKE A PAYMENT OFFERS NO PAY.
 *
 * `getMyInvoices` asks `payInvoice`'s own rule for each invoice the screens
 * would otherwise offer Pay on, and ships the answer as `payBlockedReason`: an
 * invoice that states a balance while nothing is owed on its total. A card
 * payment on one is kept off the invoice for the owner to decide on, so the
 * household must not be sent to pay it. The list row carries no Pay now, and
 * the invoice page prints the server's sentence where the pay options were.
 */

vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ invoiceId: 'inv-open-1' }),
}));

vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));

vi.mock('../lib/auth', async () => {
  const actual = await vi.importActual<typeof import('../lib/auth')>('../lib/auth');
  return {
    ...actual,
    useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
    useAuth: () => ({ status: 'signedIn', user: { uid: 'viewer-1' } }),
  };
});

const payInvoice = vi.fn();
vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: vi.fn(),
    payInvoice: (...args: unknown[]) => payInvoice(...args),
    getAccountCreditHistory: vi.fn().mockResolvedValue({ ok: true, kinfolkId: 'kin-fam-1', accountBalanceCents: 0, credits: [], uses: [] }),
  };
});

const CARD = { id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null } as const;

// The business-wide list still names the card. A blocked invoice ships its own
// list empty, and an empty list falls back to this one, so hiding Pay cannot
// rest on the empty list alone.
vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn().mockResolvedValue({ name: 'Tribe Tails', address: '123 Main St', email: 'e2e-admin@tribetails.com' }),
  getMyHome: vi.fn().mockResolvedValue({
    kinfolkId: 'kin-fam-1',
    displayName: 'The Test Family',
    businessLogoUrl: '',
    businessName: 'Tribe Tails',
    portal: { logoUrl: '', themeId: 'default', banner: { enabled: false, message: '', tone: 'info', dismissMode: 'none', id: '' }, home: [], chat: { enabled: true, awayMessage: '', hoursEnabled: false, hours: {}, maxMessageLength: 2000, rateLimitPerHour: 0 } },
    bannerDismissedByUser: false,
    payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
  }),
}));

const SENTENCE = 'This invoice cannot take a payment right now. Please ask your Auntie to check it.';

const OPEN_INVOICE: GetMyInvoicesResult['open'][number] = {
  id: 'inv-open-1', invoiceNumber: '1042',
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
  viewed: true,
  quoteDecision: null,
  quoteDecidedAtMs: null,
  quoteDecidedByUid: null,
  quoteDecidedByName: null,
  creditAmountCents: null,
  creditTarget: null,
  creditRedeemedAtMs: null,
  writtenOffCents: null,
  subtotalCents: null,
  invoiceDiscountCents: null,
  payBlockedReason: null,
  payMethods: [CARD],
};

/** What the server ships for a balance with no total: the sentence, and no pay methods. */
const BLOCKED: GetMyInvoicesResult['open'][number] = {
  ...OPEN_INVOICE,
  total: 0,
  payBlockedReason: SENTENCE,
  payMethods: [],
};

async function show(screenUnderTest: 'list' | 'detail', invoice: GetMyInvoicesResult['open'][number]) {
  const invoicesApi = await import('../api/invoicesApi');
  vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({ open: [invoice], paid: [], credits: [], accountBalanceCents: 0 });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>{screenUnderTest === 'list' ? <Invoices /> : <InvoiceDetail />}</QueryClientProvider>,
  );
}

beforeEach(() => payInvoice.mockReset());

describe('#2410: the pay rule reads the server answer', () => {
  it('offers no payment on an open bill with a balance that carries a reason', () => {
    expect(offersPayment(BLOCKED)).toBe(false);
    expect(payBlockedReason(BLOCKED)).toBe(SENTENCE);
  });

  it('offers payment when the reason is null, and when an older server sends no key at all', () => {
    expect(offersPayment(OPEN_INVOICE)).toBe(true);
    expect(payBlockedReason(OPEN_INVOICE)).toBeNull();
    const { payBlockedReason: _dropped, ...fromOlderServer } = OPEN_INVOICE;
    expect(offersPayment(fromOlderServer)).toBe(true);
    expect(payBlockedReason(fromOlderServer)).toBeNull();
  });

  it('prints a reason only on a bill waiting to be paid', () => {
    expect(payBlockedReason({ ...BLOCKED, status: 'quote' })).toBeNull();
    expect(payBlockedReason({ ...BLOCKED, status: 'credit' })).toBeNull();
    expect(payBlockedReason({ ...BLOCKED, isPaid: true })).toBeNull();
    expect(payBlockedReason({ ...BLOCKED, amountDue: 0 })).toBeNull();
  });
});

describe('#2410: the invoices list', () => {
  it('carries no Pay now on a bill that cannot take a payment, and still opens it', async () => {
    await show('list', BLOCKED);
    expect(await screen.findByText('View')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay now/ })).toBeNull();
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('still carries Pay now on an ordinary open bill', async () => {
    await show('list', OPEN_INVOICE);
    expect(await screen.findByRole('button', { name: /Pay now/ })).toBeInTheDocument();
  });
});

describe('#2410: the invoice page', () => {
  it('prints why in place of the pay options, and keeps the amount and the PDF', async () => {
    await show('detail', BLOCKED);
    expect(await screen.findByTestId('pay-blocked')).toHaveTextContent(SENTENCE);
    expect(screen.queryByRole('button', { name: 'Pay with Credit Card' })).toBeNull();
    expect(screen.getAllByText('$50.00').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Download PDF/ })).toBeInTheDocument();
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('draws no pay option even when a list of them came with the invoice', async () => {
    await show('detail', {
      ...BLOCKED,
      payMethods: [CARD, { id: 'venmo', label: 'Pay with Venmo', kind: 'link', url: 'https://venmo.com/u/auntie', instructions: null }],
    });
    expect(await screen.findByTestId('pay-blocked')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pay with Credit Card' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Pay with Venmo' })).toBeNull();
  });

  it('offers the card and prints no reason on an ordinary open bill', async () => {
    await show('detail', OPEN_INVOICE);
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
    expect(screen.queryByTestId('pay-blocked')).toBeNull();
  });

  it('offers the card when an older server sends no reason key', async () => {
    const { payBlockedReason: _dropped, ...fromOlderServer } = OPEN_INVOICE;
    await show('detail', fromOlderServer as GetMyInvoicesResult['open'][number]);
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
    expect(screen.queryByTestId('pay-blocked')).toBeNull();
  });
});
