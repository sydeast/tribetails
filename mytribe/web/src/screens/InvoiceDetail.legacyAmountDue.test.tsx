// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { InvoiceDetail } from './InvoiceDetail';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';

/**
 * READER 5, CLIENT HALF (#902): what the kinfolk portal shows for a MIGRATED
 * invoice — one carrying a `total` and no `amountDue` at all.
 *
 * WHAT THE HOUSEHOLD USED TO SEE. `getMyInvoices` read the missing balance as 0
 * and shipped `amountDue: 0`, so this screen rendered "Amount Due" not at all,
 * offered no way to pay, and — because the Paid row falls back to
 * `total - amountDue` when no `paidCents` was ever recorded — announced the
 * whole $40 as PAID. A bill the office was still owed looked settled to the
 * only party who could settle it.
 *
 * WHERE THE FIX LIVES. Not here. The clients do not classify (CONTEXT.md, and
 * `getMyInvoices.ts#statusFromStamp` says it again): the shared rule
 * (`functions/src/lib/amountDueRule.ts`) runs server-side, on the raw document,
 * where a missing field can still be told from a zero one. The DTO below is what
 * that handler now ships for `{ status: 'sent', total: 40 }`, pinned by
 * `functions/test/amountDueRule.test.ts` ("reader 5 — getMyInvoicesHandler"),
 * and this file is the other half of that pair: given that DTO, the screen shows
 * an owed bill. The two together are the guarantee, and each fails for its own
 * reason.
 */

vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ invoiceId: 'inv-legacy' }),
}));

vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));

vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: vi.fn(),
    payInvoice: vi.fn(),
    redeemCredit: vi.fn(),
    getMyInvoicePdf: vi.fn(),
    acceptQuote: vi.fn(),
    denyQuote: vi.fn(),
  };
});

vi.mock('../api/portal', () => ({
  getBusinessContact: vi.fn().mockResolvedValue({ name: 'Tribe Tails', address: '123 Main St', email: 'hi@tribetails.com' }),
  getMyHome: vi.fn().mockResolvedValue({
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
    payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
  }),
}));

/**
 * The DTO `getMyInvoicesHandler` ships for a migrated `{ status: 'sent',
 * total: 40 }`: `amountDue` DERIVED at the full total, `paidCents` 0 because no
 * settlement pass ever ran on it, and `open` from the unstamped fail-soft.
 *
 * Before #902 the same document arrived here with `amountDue: 0`.
 */
const LEGACY_INVOICE: GetMyInvoicesResult['open'][number] = {
  id: 'inv-legacy',
  kinfolkId: 'kin-fam-1',
  kinfolkName: 'The Test Family',
  client: 'The Test Family',
  total: 40,
  amountDue: 40,
  isPaid: false,
  status: 'open',
  editScope: null,
  paidCents: 0,
  partiallyPaid: false,
  date: '2024-03-02',
  dueDate: '2024-03-16',
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

beforeEach(() => vi.clearAllMocks());

describe('the portal shows a migrated invoice as the bill it is (#902)', () => {
  it('renders the derived balance as Amount Due', async () => {
    await renderWith(LEGACY_INVOICE);
    const dueRow = (await screen.findByText('Amount Due')).closest('.row')!;
    expect(dueRow.textContent).toContain('$40.00');
  });

  it('DOES NOT CALL IT PAID: the total-minus-balance fallback reports nothing collected', async () => {
    // This is the render the old DTO produced: `amountDue: 0` with `total: 40`
    // and no `paidCents` made `Math.max(0, total - amountDue)` report the whole
    // bill as money the household had already handed over.
    await renderWith(LEGACY_INVOICE);
    await screen.findByText('Amount Due');
    expect(screen.queryByText('Paid')).toBeNull();
  });

  it('offers a way to pay it', async () => {
    await renderWith(LEGACY_INVOICE);
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
  });

  it('and still reports a part-collected migrated bill honestly', async () => {
    // The same document with one $15 payment row: the rule subtracts it, and the
    // screen shows both halves rather than rounding the story either way.
    await renderWith({ ...LEGACY_INVOICE, amountDue: 25, paidCents: 1500, partiallyPaid: true });
    const dueRow = (await screen.findByText('Amount Due')).closest('.row')!;
    expect(dueRow.textContent).toContain('$25.00');
    const paidRow = screen.getByText('Paid').closest('.row')!;
    expect(paidRow.textContent).toContain('$15.00');
  });
});
