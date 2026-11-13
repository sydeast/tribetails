// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { Home } from './Home';

/**
 * Home's version of the false-empty defect, plus the gated-query half that is
 * unique to this screen.
 *
 * `bookings` and `kinTales` are gated on `home`. When the signal drops, `home`
 * pauses, so those never even reach 'paused': they sit at pending/idle, which
 * is just as invisible. The household was greeted "Hi , your tribe is in good
 * hands." above sections each claiming there was nothing there.
 *
 * The pause is the real one, driven through `onlineManager`; the query
 * functions are asserted never to run.
 *
 * #1412: the kin roster left Home for Tribe, so `getMyKin` is asserted never
 * to run at all, online or off, and Quick Start is asserted to come first.
 */

const mocks = vi.hoisted(() => ({
  getMyHome: vi.fn(),
  getMyBookings: vi.fn(),
  getMyKin: vi.fn(),
  getMyKinTales: vi.fn(),
  getMyAccount: vi.fn(),
}));

vi.mock('../api/accountApi', () => ({ getMyAccount: (...args: unknown[]) => mocks.getMyAccount(...args) }));
vi.mock('../api/portal', () => ({
  getMyHome: (...args: unknown[]) => mocks.getMyHome(...args),
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyKin: (...args: unknown[]) => mocks.getMyKin(...args),
  getMyKinTales: (...args: unknown[]) => mocks.getMyKinTales(...args),
}));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({
  useSignOut: () => ({ signOut: vi.fn(), signingOut: false }),
  useAuth: () => ({ status: 'signedIn', user: { uid: 'u1', email: 'casey.qa@example.com' } }),
}));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('../components/PushPrompt', () => ({ PushPrompt: () => null }));
vi.mock('../components/AddToHomeScreen', () => ({ AddToHomeScreen: () => null }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    search,
    params,
    className,
  }: {
    children?: ReactNode;
    to?: string;
    search?: Record<string, string>;
    params?: Record<string, string>;
    className?: string;
  }) => (
    <a
      className={className}
      data-to={to}
      data-search={search ? JSON.stringify(search) : undefined}
      data-params={params ? JSON.stringify(params) : undefined}
    >
      {children}
    </a>
  ),
}));

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
      <Home />
    </QueryClientProvider>,
  );
}

describe('Home, signal lost with the tab open', () => {
  it('the identity query really is paused, and the gated ones never start', () => {
    renderOffline();
    expect(mocks.getMyHome).not.toHaveBeenCalled();
    expect(mocks.getMyBookings).not.toHaveBeenCalled();
    expect(mocks.getMyKinTales).not.toHaveBeenCalled();
    expect(mocks.getMyKin).not.toHaveBeenCalled();
  });

  it('does not greet a household by a name it never loaded', () => {
    renderOffline();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/We can.t reach your tribe right now/);
    expect(screen.queryByText(/your tribe is in good hands/)).not.toBeInTheDocument();
  });

  it('every gated section says the read could not be reached, not that it is empty', () => {
    renderOffline();

    expect(screen.getByText(/your schedule has not loaded/)).toBeInTheDocument();
    expect(screen.getByText(/your KinTales has not loaded/)).toBeInTheDocument();

    expect(screen.queryByText('Nothing on the calendar yet.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your first KinTale will show up here after a visit/)).not.toBeInTheDocument();
  });

  it('gives the live-visit slot a cue rather than silently omitting it', () => {
    renderOffline();
    expect(screen.getByText(/we can.t check whether a visit is under way right now/i)).toBeInTheDocument();
  });
});

describe('Home, online and genuinely empty', () => {
  it('still shows the empty copy when the server answers with nothing', async () => {
    mocks.getMyHome.mockResolvedValue({ displayName: 'TEST SANDBOX', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'casey.qa@example.com', impersonated: false });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    mocks.getMyKin.mockResolvedValue({ kin: [] });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Nothing on the calendar yet.')).toBeInTheDocument();
    // #1290: the person's first name, not the household's upper-case name.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Hi Casey, your tribe is in good hands/);
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveTextContent(/TEST SANDBOX/i);
    expect(screen.queryByText(/We can.t reach your Auntie/)).not.toBeInTheDocument();
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

describe('Home, a visit whose start time the Auntie sets (#1098)', () => {
  it('lists it on its night with who sets the start, never a made-up time', async () => {
    mocks.getMyHome.mockResolvedValue({ displayName: 'TEST SANDBOX', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'casey.qa@example.com', impersonated: false });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [pendingOvernight()], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Fri night · Start time set by your Auntie')).toBeInTheDocument();
    expect(screen.getByText('Oct')).toBeInTheDocument();
    expect(screen.queryByText(/Time to be confirmed|Invalid Date|12:00 AM/)).toBeNull();
  });
});
describe('Home, first paint is one round trip deep (#1282)', () => {
  it('starts bookings and KinTales while getMyHome is still in flight', async () => {
    mocks.getMyHome.mockReturnValue(new Promise(() => {}));
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(mocks.getMyKinTales).toHaveBeenCalledWith('fam1', { limit: 3 }));
    expect(mocks.getMyHome).toHaveBeenCalledTimes(1);
    expect(mocks.getMyBookings).toHaveBeenCalledWith('fam1');
    // #1412: the roster is Tribe's read now, not Home's.
    expect(mocks.getMyKin).not.toHaveBeenCalled();
  });
});

describe('Home is the dashboard (#1412)', () => {
  async function renderEmptyHome() {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'casey.qa@example.com', impersonated: false });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    await screen.findByText('Nothing on the calendar yet.');
  }

  it('never loads or draws the kin roster; that is the Tribe screen', async () => {
    await renderEmptyHome();
    expect(mocks.getMyKin).not.toHaveBeenCalled();
    expect(screen.queryByText('Your tribe')).toBeNull();
    expect(screen.queryByText('Add Kin')).toBeNull();
    expect(screen.queryByText('The Kin')).toBeNull();
  });

  it('puts Quick start before Up next in the document, so the phone column leads with it', async () => {
    await renderEmptyHome();
    const quick = screen.getByText('Quick start');
    const upNext = screen.getByText(/^Up next/);
    // jsdom cannot lay out CSS grid `order`, so the DOM order is the state
    // carrier: the single phone column follows it.
    expect(quick.compareDocumentPosition(upNext) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/Book a visit/)).toBeInTheDocument();
  });

  it('Quick start keeps one button, Book a visit (#1460)', async () => {
    await renderEmptyHome();
    const card = screen.getByText('Quick start').closest('section')!;
    const links = card.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('Book a visit');
    expect(links[0]).toHaveAttribute('data-to', '/schedule/book');
    expect(screen.queryByText(/Message your Auntie/)).toBeNull();
    expect(screen.queryByText(/View invoices/)).toBeNull();
  });

  it('still skips a roster row an operator config carries from before the ruling', async () => {
    mocks.getMyHome.mockResolvedValue({
      displayName: 'Wren',
      businessName: 'Tribe Tails Pet Care',
      portal: {
        home: [
          { id: 'roster', enabled: true, limit: 4 },
          { id: 'quickStart', enabled: true, limit: 0 },
          { id: 'upNext', enabled: true, limit: 5 },
        ],
      },
    });
    mocks.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'casey.qa@example.com', impersonated: false });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Nothing on the calendar yet.')).toBeInTheDocument();
    expect(screen.getByText('Quick start')).toBeInTheDocument();
    expect(screen.queryByText('Your tribe')).toBeNull();
    expect(mocks.getMyKin).not.toHaveBeenCalled();
  });
});

describe('Home, Recent KinTales cards open the tale (#1329)', () => {
  it('each card is a link to /kintales carrying that tale id', async () => {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        { id: 't-a', title: 'Park day', body: 'Ran everywhere.', authorDisplayName: 'Maya', mediaIds: [], sentAtMs: null },
        { id: 't-b', title: 'Nap day', body: 'Slept.', authorDisplayName: 'Maya', mediaIds: [], sentAtMs: null },
      ],
    });
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    const card = (await screen.findByText('Park day')).closest('a');
    expect(card).toHaveAttribute('data-to', '/kintales');
    expect(card).toHaveAttribute('data-search', JSON.stringify({ tale: 't-a' }));
    expect(screen.getByText('Nap day').closest('a')).toHaveAttribute('data-search', JSON.stringify({ tale: 't-b' }));
  });
});
describe('Home, Recent KinTales date line for a migrated row (#1775)', () => {
  it('shows the stored text when the server read no date from it', async () => {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({
      tales: [
        { id: 't-a', title: 'Park day', body: 'Ran.', authorDisplayName: 'Maya', mediaIds: [], sentAtMs: null, sentAtText: 'sometime in the spring' },
      ],
    });
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/FROM AUNTIE MAYA · sometime in the spring/)).toBeInTheDocument();
  });
});
/**
 * #1987: a Limit caps rows and never reshapes the page.
 *
 * jsdom lays nothing out, so the columns are read off their carrier: the
 * `.cols` grid with the `.aside` (Quick start) first in the document. base.css
 * turns that one markup into two columns on a wide screen and into a single
 * column led by Quick start at phone width, so desktop and phone are the same
 * assertion here.
 */
describe('Home layout follows the order, never a Limit (#1987)', () => {
  const row = (id: string, enabled = true, limit = 0) => ({ id, enabled, limit });
  const DEFAULT_ROWS = ['liveVisit', 'upNext', 'tales', 'quickStart'].map((id) => row(id));
  const visit = (id: string, title: string) => ({
    ...pendingOvernight(),
    id,
    title,
    startTimePending: false,
    requestedDate: null,
    startTimeMs: new Date(2030, 5, 2, 8, 0).getTime(),
  });
  const VISITS = [visit('v-a', 'Morning walk'), visit('v-b', 'Midday walk'), visit('v-c', 'Evening walk')];
  async function renderWith(home: Array<{ id: string; enabled: boolean; limit: number }>) {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home } });
    mocks.getMyAccount.mockResolvedValue({ displayName: 'Casey QA', email: 'casey.qa@example.com', impersonated: false });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: VISITS, recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    await screen.findByText('Morning walk');
    return view.container;
  }
  /** The two-column page: Quick start in the aside, first in the document, Up next and KinTales in the main stack. */
  function expectColumns(container: HTMLElement) {
    const cols = container.querySelector('.cols');
    expect(cols).not.toBeNull();
    expect(cols).toHaveAttribute('data-home-layout', 'columns');
    expect(container.querySelector('[data-home-layout="stacked"]')).toBeNull();
    const [aside, main] = Array.from(cols!.children);
    expect(aside).toHaveClass('stack', 'aside');
    expect(aside).toHaveTextContent('Quick start');
    expect(main).toHaveClass('stack');
    expect(main).toHaveTextContent('Up next');
  }
  it('no saved layout: two columns, every upcoming visit listed', async () => {
    const container = await renderWith([]);
    expectColumns(container);
    expect(screen.getByText('Evening walk')).toBeInTheDocument();
  });
  it('only the Up next Limit set to 2: two rows, and the page keeps its two columns', async () => {
    const container = await renderWith(DEFAULT_ROWS.map((r) => (r.id === 'upNext' ? { ...r, limit: 2 } : r)));
    expectColumns(container);
    expect(screen.getByText('Midday walk')).toBeInTheDocument();
    expect(screen.queryByText('Evening walk')).toBeNull();
    expect(screen.getByText(/Recent KinTales/)).toBeInTheDocument();
  });
  it('a stored layout equal to the default draws exactly the default page', async () => {
    const container = await renderWith(DEFAULT_ROWS);
    expectColumns(container);
    expect(screen.getByText('Evening walk')).toBeInTheDocument();
  });
  it('a card switched off in the standard order leaves the columns and drops only that card', async () => {
    const container = await renderWith(DEFAULT_ROWS.map((r) => (r.id === 'tales' ? { ...r, enabled: false } : r)));
    expectColumns(container);
    expect(screen.queryByText(/Recent KinTales/)).toBeNull();
  });
  it('a real custom order is still honoured: one column, in that order, the cards sharing one stack', async () => {
    const container = await renderWith([row('tales'), row('upNext', true, 1), row('quickStart'), row('liveVisit')]);
    expect(container.querySelector('.cols')).toBeNull();
    const stacked = container.querySelector('[data-home-layout="stacked"]');
    expect(stacked).not.toBeNull();
    // One `.stack` holds all three cards, which is what puts the gap between
    // them. Each used to get a stack of its own and touch the card above.
    const stacks = stacked!.querySelectorAll('.stack');
    expect(stacks).toHaveLength(1);
    const headings = Array.from(stacks[0]!.children).map((el) => el.textContent ?? '');
    expect(headings).toHaveLength(3);
    expect(headings[0]).toMatch(/^Recent KinTales/);
    expect(headings[1]).toMatch(/^Up next/);
    expect(headings[2]).toMatch(/^Quick start/);
    // Its own limit still applies.
    expect(screen.queryByText('Midday walk')).toBeNull();
  });
  it('Quick start switched off has nothing to sit beside, so the rest is one column', async () => {
    const container = await renderWith(DEFAULT_ROWS.map((r) => (r.id === 'quickStart' ? { ...r, enabled: false } : r)));
    expect(container.querySelector('.cols')).toBeNull();
    expect(screen.queryByText('Quick start')).toBeNull();
    expect(screen.getByText(/^Up next/)).toBeInTheDocument();
  });
});
describe('Home, rows open the booking and headings open the lists (#1461)', () => {
  const visitA = {
    ...pendingOvernight(),
    id: 'v-a',
    title: 'Morning walk',
    startTimePending: false,
    requestedDate: null,
    startTimeMs: new Date(2030, 5, 2, 8, 0).getTime(),
  };
  const visitB = { ...visitA, id: 'v-b', title: 'Evening drop-in' };

  async function renderRows() {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [visitA, visitB], recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
    await screen.findByText('Morning walk');
  }

  it('each Up next row is a link to that booking on Schedule', async () => {
    await renderRows();
    const a = screen.getByText('Morning walk').closest('a');
    expect(a).toHaveAttribute('data-to', '/schedule/$visitId');
    expect(a).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v-a' }));
    expect(screen.getByText('Evening drop-in').closest('a')).toHaveAttribute('data-params', JSON.stringify({ visitId: 'v-b' }));
  });

  it('the Up next and Recent KinTales headings are headings that open their lists', async () => {
    await renderRows();
    const upNext = screen.getByRole('heading', { level: 2, name: 'Up next' });
    expect(upNext.querySelector('a')).toHaveAttribute('data-to', '/schedule');
    const tales = screen.getByRole('heading', { level: 2, name: 'Recent KinTales' });
    expect(tales.querySelector('a')).toHaveAttribute('data-to', '/kintales');
    expect(screen.queryByText('Full schedule')).toBeNull();
    expect(screen.queryByText('All tales')).toBeNull();
  });
});

describe('Home, status words and the pending change (#1298, #1299)', () => {
  async function renderWith(upcoming: unknown[]) {
    mocks.getMyHome.mockResolvedValue({ displayName: 'Wren', businessName: 'Tribe Tails Pet Care', portal: { home: [] } });
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming, recent: [] });
    mocks.getMyKinTales.mockResolvedValue({ tales: [] });
    mocks.getMyKin.mockResolvedValue({ kin: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Home />
      </QueryClientProvider>,
    );
  }
  const visit = {
    ...pendingOvernight(),
    startTimePending: false,
    requestedDate: null,
    startTimeMs: new Date(2030, 5, 2, 8, 0).getTime(),
    cancelRequestStatus: null,
    rescheduleRequestStatus: null,
  };
  it('uses REQUESTED, not PENDING, and no change line when nothing is open', async () => {
    await renderWith([visit]);
    expect(await screen.findByText('REQUESTED')).toBeInTheDocument();
    expect(screen.queryByText('PENDING')).toBeNull();
    expect(screen.queryByTestId('pending-change')).toBeNull();
  });
  it('shows the open cancellation under Up Next', async () => {
    await renderWith([{ ...visit, cancelRequestStatus: 'pending' }]);
    expect((await screen.findByTestId('pending-change')).textContent).toBe('Cancellation requested');
  });
  it('shows the open new-time request under Up Next', async () => {
    await renderWith([{ ...visit, rescheduleRequestStatus: 'pending' }]);
    expect((await screen.findByTestId('pending-change')).textContent).toBe('New time requested');
  });
});
