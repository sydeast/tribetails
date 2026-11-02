// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  search: { current: {} as { tab?: 'past' } },
  navigate: vi.fn(),
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
  Link: ({ children, className }: { children?: ReactNode; className?: string }) => <a className={className}>{children}</a>,
  useSearch: () => mocks.search.current,
  useNavigate: () => mocks.navigate,
}));

// `onlineManager` is a module singleton shared by every spec in the process.
// Leaving it offline would poison whatever ran next.
afterEach(() => {
  mocks.search.current = {};
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

    expect(screen.getAllByText(/We can.t reach your Auntie/).length).toBeGreaterThan(0);
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
    // #1304: the open tab is the URL's, so "clicking" it is the URL saying so.
    mocks.search.current = { tab: 'past' };
    renderOffline();

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
    expect(screen.queryByText(/We can.t reach your Auntie/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('tab', { name: /Upcoming/ })).getByText('0')).toBeInTheDocument();
  });
});

/** #1098: a night-only visit waiting on the Auntie's start time. */
function pendingOvernight() {
  return {
    id: 'v-night',
    batchId: 'b1',
    kinfolkId: 'fam1',
    status: 'requested',
    serviceType: 'Overnight',
    title: null,
    startTimeMs: null,
    endTimeMs: null,
    startTimePending: true,
    requestedDate: '2026-10-09',
    kinIds: [],
    kinNames: [],
    auntieDisplayName: null,
    sessionId: null,
  };
}

describe('Schedule, a visit whose start time the Auntie sets (#1098)', () => {
  it('lists it on its night with who sets the start, never a made-up time', async () => {
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [pendingOvernight()], recent: [] });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Fri night · Start time set by your Auntie')).toBeInTheDocument();
    expect(screen.getByText('Oct')).toBeInTheDocument();
    expect(screen.getByText('09')).toBeInTheDocument();
    expect(screen.queryByText(/Time to be confirmed|Invalid Date|12:00 AM/)).toBeNull();
  });
});
// #1297: rows print the server-resolved service name, never the stored code,
// and the "Service Type ·" prefix is gone.
describe('Schedule, service names (#1297)', () => {
  it('shows the service name above the title, with no code and no prefix', async () => {
    mocks.getMyBookings.mockResolvedValue({
      liveVisit: null,
      upcoming: [{ ...pendingOvernight(), id: 'v-named', serviceType: 'visit_60', serviceLabel: '60 Minute', title: 'Midday drop-in' }],
      recent: [],
    });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Midday drop-in')).toBeInTheDocument();
    expect(screen.getByText('60 Minute')).toBeInTheDocument();
    expect(screen.queryByText(/visit_60/i)).toBeNull();
    expect(screen.queryByText(/Service Type/i)).toBeNull();
  });
});

describe('Schedule, the open tab lives in the URL (#1304)', () => {
  const completed = {
    ...pendingOvernight(),
    id: 'v-done',
    status: 'completed',
    startTimePending: false,
    requestedDate: null,
    startTimeMs: new Date(2026, 6, 2, 8, 0).getTime(),
    cancelRequestStatus: null,
    rescheduleRequestStatus: null,
  };
  function renderOnline() {
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [completed] });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
  }
  it('opens on Past Visits when the URL says ?tab=past, as it does coming back from a past visit', async () => {
    mocks.search.current = { tab: 'past' };
    renderOnline();
    expect(await screen.findByRole('region', { name: 'Past visits' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Past Visits/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('region', { name: 'Upcoming bookings' })).toBeNull();
  });
  it('opens on Upcoming with no tab in the URL', async () => {
    renderOnline();
    expect(await screen.findByRole('region', { name: 'Upcoming bookings' })).toBeInTheDocument();
  });
  it('writes the choice to the URL, replacing the entry rather than stacking one', async () => {
    renderOnline();
    await screen.findByRole('region', { name: 'Upcoming bookings' });
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: /Past Visits/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/schedule', search: { tab: 'past' }, replace: true });
    await user.click(screen.getByRole('tab', { name: /Upcoming/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ to: '/schedule', search: {}, replace: true });
  });
});
describe('Schedule, nothing moves when the live-visit check finishes (#1305)', () => {
  it('draws the check inside the tab row, in a slot that stays when the check is done', async () => {
    let finishVisits: (v: { visits: unknown[] }) => void = () => {};
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyVisits.mockReturnValue(new Promise((resolve) => { finishVisits = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
    const line = await screen.findByText(/Checking whether a visit is under way/);
    const slot = container.querySelector('.sched-tabbar > .livecheck');
    expect(slot).not.toBeNull();
    expect(slot).toContainElement(line);
    // Nothing between the tabs and the lists: the check is not a row of its own.
    expect(container.querySelector('.sched-tabbar')!.nextElementSibling?.classList.contains('cols')).toBe(true);
    finishVisits({ visits: [] });
    await waitFor(() => expect(screen.queryByText(/Checking whether a visit is under way/)).toBeNull());
    expect(container.querySelector('.sched-tabbar > .livecheck')).toBe(slot);
  });
  it('shows no count while the list is still loading, never a 0', async () => {
    mocks.getMyBookings.mockReturnValue(new Promise(() => {}));
    mocks.getMyVisits.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
    expect(within(await screen.findByRole('tab', { name: /Past Visits/ })).queryByText('0')).toBeNull();
    expect(within(screen.getByRole('tab', { name: /Past Visits/ })).getByText('…')).toBeInTheDocument();
  });
});
describe('Schedule rows are links styled by the stylesheet (#1286)', () => {
  it('draws each row as an <a class="visit">, the element the link reset targets', async () => {
    mocks.getMyBookings.mockResolvedValue({
      liveVisit: null,
      upcoming: [{ ...pendingOvernight(), startTimePending: false, requestedDate: null, startTimeMs: new Date(2030, 5, 2, 8, 0).getTime() }],
      recent: [],
    });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
    await screen.findByText('Overnight', { selector: 'b' });
    expect(container.querySelectorAll('a.visit').length).toBe(1);
  });
  // jsdom loads no stylesheet, so the rendered colour cannot be read back here.
  // This pins the rule itself: every link state inherits the row's colours and
  // none underlines. The Cypress/visual walk is where the pixels are judged.
  it('has a reset that stops the browser link colour and underline in every link state', () => {
    const css = readFileSync(resolve(__dirname, '../styles/schedule.css'), 'utf8');
    const rule = css.match(/a\.visit,[^{]*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain('a.visit:visited');
    expect(rule![0]).toContain('a.visit:hover');
    expect(rule![1]).toMatch(/color:\s*inherit/);
    expect(rule![1]).toMatch(/text-decoration:\s*none/);
  });
});
describe('Schedule, one status vocabulary and the pending change (#1298, #1299)', () => {
  function renderWith(upcoming: unknown[]) {
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming, recent: [] });
    mocks.getMyVisits.mockResolvedValue({ visits: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Schedule />
      </QueryClientProvider>,
    );
  }
  const requested = {
    ...pendingOvernight(),
    startTimePending: false,
    requestedDate: null,
    startTimeMs: new Date(2030, 5, 2, 8, 0).getTime(),
    cancelRequestStatus: null,
    rescheduleRequestStatus: null,
  };
  it('labels a requested booking REQUESTED, the word its detail page uses, never PENDING', async () => {
    renderWith([requested]);
    expect(await screen.findByText('REQUESTED')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).toBeNull();
  });
  it('says a new time is waiting on the row', async () => {
    renderWith([{ ...requested, rescheduleRequestStatus: 'pending' }]);
    expect((await screen.findByTestId('pending-change')).textContent).toBe('New time requested');
  });
  it('says a cancellation is waiting on the row', async () => {
    renderWith([{ ...requested, cancelRequestStatus: 'pending' }]);
    expect((await screen.findByTestId('pending-change')).textContent).toBe('Cancellation requested');
  });
  it('adds no line when nothing is open', async () => {
    renderWith([requested]);
    await screen.findByText('REQUESTED');
    expect(screen.queryByTestId('pending-change')).toBeNull();
  });
});
