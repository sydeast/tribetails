// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Schedule } from './Schedule';

/**
 * #1832: a visit that is under way is on the household's Schedule, with its
 * current status, and the live card names the Kin, opens the visit, shows
 * while the Auntie is on the way, and is gone once she has left.
 *
 * Each case feeds the answer `getMyBookings` now gives at that point of the
 * visit (see functions/test/getMyBookingsVisitUnderWay.test.ts).
 */

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn(),
  getMyVisits: vi.fn(),
  breadcrumbsFor: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyVisits: (...args: unknown[]) => mocks.getMyVisits(...args),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../lib/breadcrumbs', () => ({
  useBreadcrumbs: (sessionId: string | null) => {
    mocks.breadcrumbsFor(sessionId);
    return { points: [], error: null };
  },
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/RouteMap', () => ({ RouteMap: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    className,
    to,
    params,
  }: {
    children?: ReactNode;
    className?: string;
    to?: string;
    params?: Record<string, string>;
  }) => (
    <a className={className} data-to={to} data-params={params ? JSON.stringify(params) : undefined}>
      {children}
    </a>
  ),
  useSearch: () => ({}),
  useNavigate: () => vi.fn(),
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
    kinIds: ['k1', 'k2'],
    kinNames: ['Biscuit', 'Miso'],
    auntieDisplayName: 'Maya',
    sessionId: 'vis_v1',
    cancelRequestStatus: null,
    rescheduleRequestStatus: null,
  };
}

function renderWith(v: ReturnType<typeof visit>, live: boolean) {
  mocks.getMyBookings.mockResolvedValue({ liveVisit: live ? v : null, upcoming: [v], recent: [], envelopes: [] });
  mocks.getMyVisits.mockResolvedValue({
    visits: [{ id: 'vis_v1', status: 'ARRIVED', arrivedAtIso: new Date(2026, 10, 10, 23, 16).toISOString() }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Schedule />
    </QueryClientProvider>,
  );
}

function upcomingRow() {
  const list = screen.getByRole('region', { name: 'Upcoming bookings' });
  return within(list).getByText('30 Minute Quick Check', { selector: 'b' }).closest('a')!;
}

describe('Schedule, a visit under way', () => {
  it('On the way: a card says so, names the Kin and opens the visit; the visit is on Upcoming as EN ROUTE', async () => {
    renderWith(visit('enRoute', 'enRoute'), true);

    const card = await screen.findByTestId('live-visit');
    expect(card).toHaveAccessibleName('Your Auntie is on the way');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Auntie Maya is on the way to Biscuit, Miso');
    expect(within(card).getAllByText('ON THE WAY').length).toBeGreaterThan(0);
    // Nothing on this card says she has arrived.
    expect(within(card).queryByText(/at your place|in progress|Arrived/i)).toBeNull();

    const open = card.querySelector('a.live-open')!;
    expect(open).toHaveAttribute('data-to', '/schedule/$visitId');
    expect(open).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));

    expect(within(screen.getByRole('tab', { name: /Upcoming/ })).getByText('1')).toBeInTheDocument();
    const row = upcomingRow();
    expect(within(row).getByText('EN ROUTE')).toBeInTheDocument();
    expect(row).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(screen.queryByText('No upcoming bookings')).toBeNull();
    // No live map until she is there: the walk has not started.
    expect(mocks.breadcrumbsFor).not.toHaveBeenCalledWith('vis_v1');
  });

  it('Arrived: the card names every Kin on the visit, opens it, and follows the visit\'s own session', async () => {
    renderWith(visit('active', 'active'), true);

    const card = await screen.findByTestId('live-visit');
    expect(card).toHaveAccessibleName('Visit in progress');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Auntie Maya is at your place with Biscuit, Miso');
    expect(within(card).getByText('VISIT IN PROGRESS')).toBeInTheDocument();
    expect(within(card).getByText('Biscuit, Miso', { selector: 'b' })).toBeInTheDocument();
    expect(within(card).queryByText('Your kin')).toBeNull();
    expect(await within(card).findByText(/Arrived 11:16 PM/)).toBeInTheDocument();
    expect(card.querySelector('a.live-open')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(mocks.breadcrumbsFor).toHaveBeenCalledWith('vis_v1');

    expect(within(upcomingRow()).getByText('IN PROGRESS')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Upcoming/ })).getByText('1')).toBeInTheDocument();
  });

  it('#2123 Departed: the server sends it completed, so the card is gone and it is a Past Visit', async () => {
    const done = visit('completed', 'ended');
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [done], envelopes: [] });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('No upcoming bookings')).toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Past Visits/ })).getByText('1')).toBeInTheDocument();
    expect(screen.queryByTestId('live-visit')).toBeNull();
    expect(screen.queryByText('DEPARTED')).toBeNull();
  });

  it('#2123 Departed, from an older answer: the card is gone, the row reads COMPLETED and still opens', async () => {
    renderWith(visit('active', 'ended'), false);

    const row = await screen.findByText('COMPLETED');
    expect(row.closest('a')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v1' }));
    expect(screen.queryByText('DEPARTED')).toBeNull();
    expect(screen.queryByTestId('live-visit')).toBeNull();
    expect(screen.queryByText('VISIT IN PROGRESS')).toBeNull();
    expect(screen.queryByText(/AT YOUR PLACE/)).toBeNull();
    expect(screen.queryByText('IN PROGRESS')).toBeNull();
  });

  it('#2123 Departed: an answer that still names the visit as live does not bring the card back', async () => {
    renderWith(visit('active', 'ended'), true);
    await screen.findByText('COMPLETED');
    expect(screen.queryByTestId('live-visit')).toBeNull();
  });

  it('confirmed and running late: listed as CONFIRMED, with no card', async () => {
    renderWith(visit('confirmed', null), false);
    expect(await screen.findByText('CONFIRMED')).toBeInTheDocument();
    expect(screen.queryByTestId('live-visit')).toBeNull();
  });

  it('a live visit with no Kin names on it falls back to a plain word, never a blank', async () => {
    renderWith({ ...visit('active', 'active'), kinNames: [] }, true);
    const card = await screen.findByTestId('live-visit');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('Auntie Maya is at your place');
    expect(within(card).getByText('Your kin')).toBeInTheDocument();
  });

  it('the replay read failing does not take the card or the list away', async () => {
    const v = visit('active', 'active');
    mocks.getMyBookings.mockResolvedValue({ liveVisit: v, upcoming: [v], recent: [], envelopes: [] });
    mocks.getMyVisits.mockRejectedValue(new Error('unavailable'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
    const card = await screen.findByTestId('live-visit');
    expect(within(card).getByRole('heading', { level: 2 })).toHaveTextContent('with Biscuit, Miso');
    expect(within(card).queryByText(/Arrived \d/)).toBeNull();
    expect(within(upcomingRow()).getByText('IN PROGRESS')).toBeInTheDocument();
  });
});
