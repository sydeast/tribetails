// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Home } from './Home';

/**
 * #1832: Home shows a visit that is under way. The live card says which of
 * On the way and Arrived it is, names the Kin and opens the visit; Up next
 * lists the visit with its current status at every point until it is finished.
 */

const mocks = vi.hoisted(() => ({
  getMyHome: vi.fn(),
  getMyBookings: vi.fn(),
  getMyKinTales: vi.fn(),
  getMyAccount: vi.fn(),
}));

vi.mock('../api/accountApi', () => ({ getMyAccount: (...args: unknown[]) => mocks.getMyAccount(...args) }));
vi.mock('../api/portal', () => ({
  getMyHome: (...args: unknown[]) => mocks.getMyHome(...args),
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyKinTales: (...args: unknown[]) => mocks.getMyKinTales(...args),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1', email: 'e2e-admin@tribetails.com' } }),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/PushPrompt', () => ({ PushPrompt: () => null }));
vi.mock('../components/AddToHomeScreen', () => ({ AddToHomeScreen: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    params?: Record<string, string>;
    className?: string;
  }) => (
    <a className={className} data-to={to} data-params={params ? JSON.stringify(params) : undefined}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function visit(status: string, visitProgress: string | null) {
  return {
    id: 'v1',
    batchId: 'b1',
    kinfolkId: 'fam1',
    status,
    visitProgress,
    serviceType: 'visit_30',
    serviceLabel: '30 Minute Quick Check',
    title: null,
    startTimeMs: Date.now() - 4 * 60_000,
    endTimeMs: null,
    startTimePending: false,
    requestedDate: null,
    kinIds: ['k1'],
    kinNames: ['Biscuit'],
    auntieDisplayName: 'Maya',
    sessionId: 'vis_v1',
    cancelRequestStatus: null,
    rescheduleRequestStatus: null,
  };
}

function renderWith(v: ReturnType<typeof visit>, live: boolean) {
  mocks.getMyHome.mockResolvedValue({ displayName: 'TEST SANDBOX', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
  mocks.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'e2e-admin@tribetails.com', impersonated: false });
  mocks.getMyBookings.mockResolvedValue({ liveVisit: live ? v : null, upcoming: [v], recent: [], envelopes: [] });
  mocks.getMyKinTales.mockResolvedValue({ tales: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>,
  );
}

async function upNextRow(chip: string) {
  const label = await screen.findByText(chip);
  return label.closest('a')!;
}

describe('Home, a visit under way', () => {
  it('On the way: the card says on the way, not checked in, names the Kin and opens the visit', async () => {
    renderWith(visit('enRoute', 'enRoute'), true);

    const card = await screen.findByTestId('live-visit');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Auntie Maya is on the way to Biscuit');
    expect(within(card).getByText('ON THE WAY')).toBeInTheDocument();
    expect(within(card).queryByText(/Checked in|MIN IN|LIVE NOW/)).toBeNull();
    expect(card.querySelector('a.live-open')).toHaveAttribute('data-to', '/schedule/$visitId');
    expect(card.querySelector('a.live-open')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));

    const row = await upNextRow('EN ROUTE');
    expect(row).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(screen.queryByText('Nothing on the calendar yet.')).toBeNull();
  });

  it('Arrived: the card says the Auntie is with the Kin and opens the visit; Up next reads IN PROGRESS', async () => {
    renderWith(visit('active', 'active'), true);

    const card = await screen.findByTestId('live-visit');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Auntie Maya is with Biscuit');
    expect(within(card).getByText('LIVE NOW')).toBeInTheDocument();
    expect(card.querySelector('a.live-open')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(await upNextRow('IN PROGRESS')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
  });

  // #2123: a visit is Completed at departure. These are answers from before
  // the change, still pairing `active` with `ended`: they read Completed.
  it('#2123 Departed, from an older answer: no card, and the visit reads COMPLETED, never DEPARTED', async () => {
    renderWith(visit('active', 'ended'), false);

    expect(await upNextRow('COMPLETED')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(screen.queryByText('DEPARTED')).toBeNull();
    expect(screen.queryByTestId('live-visit')).toBeNull();
    expect(screen.queryByText('LIVE NOW')).toBeNull();
    expect(screen.queryByText('IN PROGRESS')).toBeNull();
  });

  it('#2123 Departed: an answer that still names the visit as live does not bring the card back', async () => {
    renderWith(visit('active', 'ended'), true);
    await upNextRow('COMPLETED');
    expect(screen.queryByTestId('live-visit')).toBeNull();
  });

  it('confirmed and running late: Up next lists it as CONFIRMED with no card', async () => {
    renderWith(visit('confirmed', null), false);
    expect(await upNextRow('CONFIRMED')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(screen.queryByTestId('live-visit')).toBeNull();
  });
});
