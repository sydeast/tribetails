// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { Schedule } from './Schedule';

/**
 * The false-empty defect, pinned.
 *
 * A household loses signal with the tab open. React Query's default
 * `networkMode: 'online'` PAUSES the query instead of failing it, so
 * `isLoading` is false, `isError` is false and `data` is undefined all at once,
 * and this screen used to answer that with "No upcoming bookings. Nothing on
 * the calendar yet. Request a booking and your Auntie will confirm a time."
 * Some households then booked the visit a second time.
 *
 * The pause here is the REAL one: `onlineManager` is driven offline before
 * render and the query function is asserted never to have been called. Nothing
 * about the component's own state is stubbed, so if the pause stopped producing
 * `fetchStatus: 'paused'` these specs would stop testing anything and say so.
 */

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn(),
  getMyVisits: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyVisits: (...args: unknown[]) => mocks.getMyVisits(...args),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../lib/breadcrumbs', () => ({ useBreadcrumbs: () => ({ points: [], error: null }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/RouteMap', () => ({ RouteMap: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

// `onlineManager` is a module singleton shared by every spec in the process.
// Leaving it offline would poison whatever ran next.
afterEach(() => {
  // Unmount FIRST. Vitest runs afterEach hooks in reverse registration order,
  // so this one fires before test-setup.ts's `cleanup()`: putting the network
  // back while the previous test's component is still mounted resumes its
  // paused queries against mocks the next test has not configured yet, and the
  // leaked render then answers the next test's queries. `onlineManager` is a
  // module singleton, so leaving it offline would poison the rest of the run.
  cleanup();
  onlineManager.setOnline(true);
  vi.clearAllMocks();
});

function renderOffline() {
  onlineManager.setOnline(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Schedule />
    </QueryClientProvider>,
  );
}

describe('Schedule, signal lost with the tab open', () => {
  it('the query really is paused, not called and not failed', () => {
    renderOffline();
    expect(mocks.getMyBookings).not.toHaveBeenCalled();
    expect(mocks.getMyVisits).not.toHaveBeenCalled();
  });

  it('says the schedule could not be reached instead of showing the empty state', () => {
    renderOffline();

    expect(screen.getAllByText(/We can.t reach Tribe Tails/).length).toBeGreaterThan(0);
    expect(screen.getByText(/your schedule has not loaded/)).toBeInTheDocument();

    expect(screen.queryByText('No upcoming bookings')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing on the calendar yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Request a booking and your Auntie will confirm a time/)).not.toBeInTheDocument();
  });

  it('does not claim a count it never read', () => {
    renderOffline();

    const upcomingTab = screen.getByRole('tab', { name: /Upcoming/ });
    const pastTab = screen.getByRole('tab', { name: /Past Visits/ });

    expect(upcomingTab.textContent).not.toContain('0');
    expect(pastTab.textContent).not.toContain('0');
    expect(within(upcomingTab).getByText('?')).toHaveAttribute('aria-label', 'Not known while you are offline');
    expect(within(pastTab).getByText('?')).toHaveAttribute('aria-label', 'Not known while you are offline');
  });

  it('gives the live-visit hero a cue rather than letting it pop in from nothing', () => {
    renderOffline();
    expect(screen.getByText(/we can.t check whether a visit is under way right now/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Visit in progress')).not.toBeInTheDocument();
  });

  it('the past-visits tab is covered too', async () => {
    const { getByRole } = renderOffline();
    getByRole('tab', { name: /Past Visits/ }).click();

    expect(await screen.findByText(/your visit history has not loaded/)).toBeInTheDocument();
    expect(screen.queryByText('No past visits')).not.toBeInTheDocument();
  });
});

describe('Schedule, online and genuinely empty', () => {
  it('still shows the empty state when the server answers with nothing', async () => {
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('No upcoming bookings')).toBeInTheDocument();
    expect(screen.queryByText(/We can.t reach Tribe Tails/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Upcoming/ })).getByText('0')).toBeInTheDocument();
  });
});
