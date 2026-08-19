// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Invoices } from './Invoices';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';

/**
 * The payInvoice and redeemCredit mutations had no onError handler, so a
 * rejected callable just stopped the button spinner with nothing telling the
 * kinfolk why (the same "swallowed error" bug InvoiceDetail and KinTales'
 * comment-post had before they were fixed). These pin that each surfaces a
 * distinct, visible message.
 */

vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}));

vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'kin-fam-1',
}));

vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));

const payInvoice = vi.fn();
const redeemCredit = vi.fn();

vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: vi.fn(),
    payInvoice: (...args: unknown[]) => payInvoice(...args),
    redeemCredit: (...args: unknown[]) => redeemCredit(...args),
  };
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
  status: 'credit',
  creditAmountCents: 2000,
  creditRedeemedAtMs: null,
  // Issue #409: how this bill can be paid, resolved server-side off the
  // options it was issued with. The card needs nothing configured, so a
  // believable invoice always carries at least this one.
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
};

describe('Invoices — mutation error surfacing', () => {
  it('pay failure shows a visible error instead of just stopping the spinner', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [OPEN_INVOICE],
      paid: [],
      credits: [],
      accountBalanceCents: 0,
    });
    payInvoice.mockRejectedValue(new Error('Card declined by Stripe.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );

    const payButton = await screen.findByRole('button', { name: /Pay now/ });
    await userEvent.click(payButton);

    await waitFor(() => expect(screen.getByText('Card declined by Stripe.')).toBeInTheDocument());
  });

  it('credit redemption failure shows a visible error instead of just stopping the spinner', async () => {
    const invoicesApi = await import('../api/invoicesApi');
    vi.mocked(invoicesApi.getMyInvoices).mockResolvedValue({
      open: [],
      paid: [],
      credits: [CREDIT_INVOICE],
      accountBalanceCents: 0,
    });
    redeemCredit.mockRejectedValue(new Error('Credit already redeemed.'));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <Invoices />
      </QueryClientProvider>,
    );

    const redeemButton = await screen.findByRole('button', { name: /Save to Account Balance/ });
    await userEvent.click(redeemButton);

    await waitFor(() => expect(screen.getByText('Credit already redeemed.')).toBeInTheDocument());
  });
});
