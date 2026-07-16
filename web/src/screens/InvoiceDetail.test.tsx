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
  originalPaymentIntentId: null,
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

    await userEvent.click(await screen.findByRole('button', { name: /Redeem Credit/ }));
    await waitFor(() => expect(screen.getByText(/Credit already redeemed\./)).toBeInTheDocument());
  });
});
