// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Invoices } from './Invoices';
import { InvoiceDetail } from './InvoiceDetail';
import type { GetMyInvoicesResult } from '../contracts/invoiceContracts.generated';

/**
 * #1906 (operator ruling 2026-11-11): an invoice the office has not sent is not
 * listed, counted or openable for the Kinfolk.
 *
 * The server leaves drafts out of `getMyInvoices`; these pin that the portal
 * holds the same line when an answer still carries one (a server on the
 * earlier rule). Only the callables choke point is replaced, so the real
 * `invoicesApi` wrapper and both real screens run.
 */

const fns = vi.hoisted(() => ({ answer: null as unknown }));
vi.mock('../lib/fns', () => ({
  call: vi.fn(async (name: string) => {
    if (name === 'getMyInvoices') return fns.answer;
    if (name === 'getAccountCreditHistory') {
      return { ok: true, kinfolkId: 'kin-fam-1', accountBalanceCents: 0, credits: [], uses: [] };
    }
    throw new Error(`unexpected callable ${name}`);
  }),
}));

vi.mock('../api/portal', () => ({
  getMyHome: vi.fn().mockResolvedValue({ businessName: '', payMethods: [] }),
  getBusinessContact: vi.fn().mockResolvedValue({ name: 'Tribe Tails', address: '', email: '' }),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));

const route = vi.hoisted(() => ({ invoiceId: 'inv-draft-1' }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
  useParams: () => ({ invoiceId: route.invoiceId }),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'kin-fam-1' }));
vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
  useAuth: () => ({ status: 'signedIn', user: { uid: 'viewer-1' } }),
}));

const OPEN_INVOICE: GetMyInvoicesResult['open'][number] = {
  id: 'inv-open-1',
  kinfolkId: 'kin-fam-1',
  kinfolkName: 'The Test Family',
  client: 'The Test Family',
  total: 19.5,
  amountDue: 19.5,
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
  payMethods: [{ id: 'stripe', label: 'Pay with Credit Card', kind: 'checkout', url: null, instructions: null }],
};

const DRAFT_INVOICE: GetMyInvoicesResult['open'][number] = {
  ...OPEN_INVOICE,
  id: 'inv-draft-1',
  total: 28,
  amountDue: 28,
  status: 'draft',
};

function renderWith(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

describe('#1906 an unsent draft is hidden on the portal', () => {
  it('is not listed and not counted in the open total', async () => {
    // The balance card, which carries the open total, shows with credit on the account.
    fns.answer = { open: [OPEN_INVOICE, DRAFT_INVOICE], paid: [], credits: [], accountBalanceCents: 500 };
    renderWith(<Invoices />);
    const openCell = (await screen.findByText('Open invoices')).closest('.bcell');
    expect(openCell?.querySelector('b')?.textContent).toBe('$19.50');
    expect(screen.queryByText('$47.50')).toBeNull();
    expect(screen.queryByText('$28.00')).toBeNull();
    expect(screen.queryByText('Not sent yet')).toBeNull();
    expect(screen.queryByText('DRAFT')).toBeNull();
  });

  it('a link straight to the draft finds nothing to open', async () => {
    fns.answer = { open: [OPEN_INVOICE, DRAFT_INVOICE], paid: [], credits: [], accountBalanceCents: 0 };
    route.invoiceId = 'inv-draft-1';
    renderWith(<InvoiceDetail />);
    expect(await screen.findByText(/We couldn.t find that invoice\./)).toBeInTheDocument();
    expect(screen.queryByText('$28.00')).toBeNull();
    expect(screen.queryByRole('button', { name: /Download PDF/i })).toBeNull();
  });

  it('a sent invoice beside it still opens', async () => {
    fns.answer = { open: [OPEN_INVOICE, DRAFT_INVOICE], paid: [], credits: [], accountBalanceCents: 0 };
    route.invoiceId = 'inv-open-1';
    renderWith(<InvoiceDetail />);
    expect(await screen.findByRole('button', { name: 'Pay with Credit Card' })).toBeInTheDocument();
    expect(screen.queryByText(/We couldn.t find that invoice\./)).toBeNull();
  });
});
