// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';

import { billingAccessOf, isPermissionDenied } from '../lib/billingAccess';

/**
 * #1005. A SECONDARY without billing access must not see the household's bills
 * or balance. The server refuses; the portal hides every billing entry point
 * and says nothing about it. Who has access comes from `getMyHome.billingAccess`.
 */

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getMyHome: vi.fn(),
  getMyBookings: vi.fn(),
  getMyKin: vi.fn(),
  getMyKinTales: vi.fn(),
  getMyInvoices: vi.fn(),
  // The Invoices screen also reads the household's account credit (Q6).
  // Unmocked, it posted to production (#1138).
  getAccountCreditHistory: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...rest }: { children?: ReactNode; to?: string } & Record<string, unknown>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ invoiceId: 'inv1' }),
}));
vi.mock('../api/portal', () => ({
  getMyHome: (...a: unknown[]) => mocks.getMyHome(...a),
  getMyBookings: (...a: unknown[]) => mocks.getMyBookings(...a),
  getMyKin: (...a: unknown[]) => mocks.getMyKin(...a),
  getMyKinTales: (...a: unknown[]) => mocks.getMyKinTales(...a),
  getBusinessContact: vi.fn().mockResolvedValue({}),
}));
vi.mock('../api/invoicesApi', async () => {
  const actual = await vi.importActual<typeof import('../api/invoicesApi')>('../api/invoicesApi');
  return {
    ...actual,
    getMyInvoices: (...a: unknown[]) => mocks.getMyInvoices(...a),
    getAccountCreditHistory: (...a: unknown[]) => mocks.getAccountCreditHistory(...a),
  };
});
vi.mock('../lib/activeTribe', () => ({
  getActiveKinfolkId: () => 'fam1',
  useAccessState: () => ({ isOperator: false }),
}));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1', email: 'sk@example.com' } }),
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
}));
vi.mock('../components/PushPrompt', () => ({ PushPrompt: () => null }));
vi.mock('../components/AddToHomeScreen', () => ({ AddToHomeScreen: () => null }));

afterEach(() => vi.clearAllMocks());

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

const HOME_BASE = {
  kinfolkId: 'fam1',
  displayName: 'Wren',
  businessLogoUrl: '',
  businessName: 'Tribe Tails Pet Care',
  portal: { home: [] },
  bannerDismissedByUser: false,
  payMethods: [],
};

describe('billingAccessOf', () => {
  it('hides billing only on an explicit false', () => {
    expect(billingAccessOf({ billingAccess: false })).toBe(false);
    expect(billingAccessOf({ billingAccess: true })).toBe(true);
    // An older server sends no field: a household with access must not lose its bills.
    expect(billingAccessOf({})).toBe(true);
    expect(billingAccessOf(undefined)).toBe(true);
  });

  it('knows the refusal code', () => {
    expect(isPermissionDenied(new FirebaseError('functions/permission-denied', 'no'))).toBe(true);
    expect(isPermissionDenied(new FirebaseError('functions/internal', 'no'))).toBe(false);
    expect(isPermissionDenied(new Error('no'))).toBe(false);
  });
});

describe('PortalNav', () => {
  it('draws no Invoices link for a member without billing access', async () => {
    mocks.getMyHome.mockResolvedValue({ ...HOME_BASE, billingAccess: false });
    const { PortalNav } = await import('../components/PortalNav');
    wrap(<PortalNav active="home" displayName="Sam" />);
    await waitFor(() => expect(mocks.getMyHome).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Invoices' })).toBeNull());
    expect(screen.getByRole('link', { name: 'Schedule' })).toBeTruthy();
  });

  it('draws it for a member with billing access', async () => {
    mocks.getMyHome.mockResolvedValue({ ...HOME_BASE, billingAccess: true });
    const { PortalNav } = await import('../components/PortalNav');
    wrap(<PortalNav active="home" displayName="Pat" />);
    await waitFor(() => expect(mocks.getMyHome).toHaveBeenCalled());
    expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/invoices');
  });
});

describe('Home', () => {
  function stubHomeReads(billingAccess: boolean | undefined) {
    mocks.getMyHome.mockResolvedValue({ ...HOME_BASE, ...(billingAccess === undefined ? {} : { billingAccess }) });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    mocks.getMyKin.mockResolvedValue({ kin: [] });
  }

  it('has no "View invoices" for a member without billing access', async () => {
    stubHomeReads(false);
    const { Home } = await import('./Home');
    wrap(<Home />);
    await screen.findByRole('link', { name: /Book a visit/ });
    // Quick start draws before Home has answered; the link goes once it has.
    await waitFor(() => expect(mocks.getMyBookings).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('link', { name: /View invoices/ })).toBeNull());
  });

  it('keeps "View invoices" for a member with billing access, and for an older server', async () => {
    stubHomeReads(true);
    const { Home } = await import('./Home');
    const first = wrap(<Home />);
    expect(await screen.findByRole('link', { name: /View invoices/ })).toBeTruthy();
    first.unmount();

    stubHomeReads(undefined);
    wrap(<Home />);
    expect(await screen.findByRole('link', { name: /View invoices/ })).toBeTruthy();
  });
});

describe('Invoices and InvoiceDetail, reached directly by a member without billing access', () => {
  it('Invoices goes back to Home with no error', async () => {
    mocks.getMyHome.mockResolvedValue({ ...HOME_BASE, billingAccess: false });
    mocks.getMyInvoices.mockRejectedValue(new FirebaseError('functions/permission-denied', 'Billing access is required'));
    mocks.getAccountCreditHistory.mockRejectedValue(new FirebaseError('functions/permission-denied', 'Billing access is required'));
    const { Invoices } = await import('./Invoices');
    wrap(<Invoices />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/home', replace: true }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/something went wrong|couldn.t load|try again/i)).toBeNull();
  });

  it('InvoiceDetail goes back to Home with no error', async () => {
    mocks.getMyHome.mockResolvedValue({ ...HOME_BASE, billingAccess: false });
    mocks.getMyInvoices.mockRejectedValue(new FirebaseError('functions/permission-denied', 'Billing access is required'));
    const { InvoiceDetail } = await import('./InvoiceDetail');
    wrap(<InvoiceDetail />);
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith({ to: '/home', replace: true }));
    expect(screen.queryByText(/something went wrong|couldn.t load|try again/i)).toBeNull();
  });

  it('any other failure still reports itself, and does not navigate', async () => {
    mocks.getMyHome.mockResolvedValue({ ...HOME_BASE, billingAccess: true });
    mocks.getMyInvoices.mockRejectedValue(new FirebaseError('functions/internal', 'boom'));
    mocks.getAccountCreditHistory.mockResolvedValue({ ok: true, kinfolkId: 'fam1', accountBalanceCents: 0, credits: [], uses: [] });
    const { Invoices } = await import('./Invoices');
    wrap(<Invoices />);
    await waitFor(() => expect(mocks.getMyInvoices).toHaveBeenCalled());
    await waitFor(() => expect(document.body.textContent ?? '').not.toBe(''));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
