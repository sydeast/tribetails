// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BookingDetail } from './BookingDetail';
import { BOOKINGS_POLL_MS } from '../lib/portalFormat';

/**
 * #1830: a visit notice opens `/schedule/<visitId>`, and that page shows the
 * visit at every status of its life. #1823: its chip, STATUS TIMELINE and
 * STATUS tile say where the visit stands, and follow it without a reload.
 *
 * The route's visit id is `v1` throughout, the id every notice of one visit
 * carries.
 */

const mocks = vi.hoisted(() => ({
  getMyBookings: vi.fn(),
  getMyVisits: vi.fn(),
  getMyHome: vi.fn(),
  getBookingNotes: vi.fn(),
}));

vi.mock('../api/portal', () => ({
  getMyHome: () => mocks.getMyHome(),
  getMyBookings: (...args: unknown[]) => mocks.getMyBookings(...args),
  getMyVisits: (...args: unknown[]) => mocks.getMyVisits(...args),
}));
vi.mock('../components/RouteMap', () => ({ RouteMap: () => null }));
vi.mock('../api/bookingApi', () => ({
  getBookingNotes: (...args: unknown[]) => mocks.getBookingNotes(...args),
  getBookingPolicy: vi.fn(),
  getBusinessClosures: vi.fn(),
  addBookingNote: vi.fn(),
  requestBookingCancellation: vi.fn(),
  requestBookingReschedule: vi.fn(),
}));
vi.mock('../lib/warmSave', () => ({ warmSave: vi.fn() }));
vi.mock('../lib/activeTribe', () => ({ getActiveKinfolkId: () => 'fam1' }));
vi.mock('../lib/auth', () => ({ useSignOut: () => ({ signOut: vi.fn(), signingOut: false }) }));
vi.mock('../components/PortalNav', () => ({ PortalNav: () => null }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ visitId: 'v1' }),
  Link: ({ children, to }: { children?: ReactNode; to?: string }) => <a data-to={to}>{children}</a>,
}));

beforeEach(() => {
  mocks.getMyHome.mockResolvedValue({ businessName: '' });
  mocks.getBookingNotes.mockResolvedValue({ bookingNote: null, notes: [], fromBusiness: [] });
  mocks.getMyVisits.mockResolvedValue({ visits: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function visit(status: string, visitProgress: string | null, overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    batchId: 'b1',
    kinfolkId: 'fam1',
    status,
    visitProgress,
    serviceType: 'visit_30',
    serviceLabel: '30 Minute Quick Check',
    serviceId: null,
    title: null,
    startTimeMs: Date.now() - 4 * 60_000,
    endTimeMs: null,
    startTimePending: false,
    requestedDate: null,
    timeBlockLabel: null,
    timeBlockStartTime: null,
    timeBlockEndTime: null,
    kinIds: ['k1'],
    kinNames: ['Biscuit'],
    auntieDisplayName: 'Maya',
    notes: null,
    sessionId: 'vis_v1',
    cancelRequested: false,
    cancelRequestStatus: null,
    cancelResponseNote: null,
    rescheduleRequestStatus: null,
    rescheduleRequestedStartTimeMs: null,
    rescheduleResponseNote: null,
    address: null,
    kinTaleId: null,
    invoiceId: null,
    ...overrides,
  };
}

/** The answer the server gives for one visit at this point of its life. */
function answerFor(v: ReturnType<typeof visit>) {
  const finished = v.status === 'completed' || v.status === 'cancelled';
  const live = v.status === 'enRoute' || (v.status === 'active' && v.visitProgress !== 'ended');
  return {
    liveVisit: live ? v : null,
    upcoming: finished ? [] : [v],
    recent: finished ? [v] : [],
    envelopes: [{ batchId: 'b1', kinCares: [v] }],
  };
}

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BookingDetail />
    </QueryClientProvider>,
  );
}

/** The labels of the timeline steps that are ticked, and the one the visit is on. */
function timeline(container: HTMLElement) {
  const steps = [...container.querySelectorAll('.tl-step')];
  return {
    done: steps.filter((s) => s.classList.contains('done')).map((s) => s.querySelector('.lbl')!.textContent),
    now: steps.filter((s) => s.classList.contains('now')).map((s) => s.querySelector('.lbl')!.textContent),
  };
}

function statusTile() {
  return within(screen.getByText('Status', { selector: '.lab' }).parentElement!).getByText(/./, { selector: '.val' });
}

const STAGES = [
  { name: 'requested', v: visit('requested', null), chip: 'REQUESTED', tile: 'Requested', done: [], now: ['Requested'] },
  { name: 'confirmed, past its start', v: visit('confirmed', null), chip: 'CONFIRMED', tile: 'Confirmed', done: ['Requested'], now: ['Confirmed'] },
  { name: 'On the way', v: visit('enRoute', 'enRoute'), chip: 'EN ROUTE', tile: 'En route', done: ['Requested', 'Confirmed'], now: ['En route'] },
  { name: 'Arrived', v: visit('active', 'active'), chip: 'IN PROGRESS', tile: 'In progress', done: ['Requested', 'Confirmed', 'En route'], now: ['In progress'] },
  // #2123: a visit is Completed at departure. The server sends it as
  // completed; an older answer's `active` + `ended` pair reads the same.
  {
    name: 'Departed, from an older answer',
    v: visit('active', 'ended'),
    chip: 'COMPLETED',
    tile: 'Completed',
    done: ['Requested', 'Confirmed', 'En route', 'In progress', 'Completed'],
    now: [],
  },
  {
    name: 'Completed',
    v: visit('completed', 'ended'),
    chip: 'COMPLETED',
    tile: 'Completed',
    done: ['Requested', 'Confirmed', 'En route', 'In progress', 'Completed'],
    now: [],
  },
];

describe('BookingDetail: a visit notice opens the visit at every status', () => {
  it.each(STAGES)('$name: the page loads with the $chip chip, the timeline and the STATUS tile in step', async ({ v, chip, tile, done, now }) => {
    mocks.getMyBookings.mockResolvedValue(answerFor(v));
    const { container } = renderScreen();

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('30 Minute Quick Check');
    expect(screen.queryByText(/couldn.t find that booking/i)).toBeNull();
    expect(container.querySelector('.chip.lg')).toHaveTextContent(chip);
    expect(statusTile()).toHaveTextContent(tile);
    expect(timeline(container)).toEqual({ done, now });
    expect(screen.getByText('Biscuit')).toBeInTheDocument();
  });

  it('cancelled: the page loads with the CANCELLED chip and no timeline', async () => {
    mocks.getMyBookings.mockResolvedValue(answerFor(visit('cancelled', null)));
    const { container } = renderScreen();
    await screen.findByRole('heading', { level: 1 });
    expect(container.querySelector('.chip.lg')).toHaveTextContent('CANCELLED');
    expect(container.querySelector('.tl-step')).toBeNull();
  });

  it.each(STAGES)('$name: still opens when the visit is on no list, through its envelope', async ({ v, chip }) => {
    mocks.getMyBookings.mockResolvedValue({ liveVisit: null, upcoming: [], recent: [], envelopes: [{ batchId: 'b1', kinCares: [v] }] });
    const { container } = renderScreen();
    await screen.findByRole('heading', { level: 1 });
    expect(container.querySelector('.chip.lg')).toHaveTextContent(chip);
    expect(screen.queryByText(/couldn.t find that booking/i)).toBeNull();
  });

  it('a visit under way cannot be cancelled or moved from here', async () => {
    mocks.getMyBookings.mockResolvedValue(answerFor(visit('active', 'active')));
    renderScreen();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Request cancellation/)).toBeNull();
    expect(screen.queryByText(/Reschedule visit/)).toBeNull();
  });

  it('#2123: a departed visit, even from an older answer, is finished: After the visit shows and nothing can be asked', async () => {
    mocks.getMyBookings.mockResolvedValue(answerFor(visit('active', 'ended')));
    renderScreen();
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByTestId('after-visit')).toBeInTheDocument();
    expect(screen.queryByText(/Request cancellation/)).toBeNull();
    expect(screen.queryByText(/Reschedule visit/)).toBeNull();
    expect(screen.queryByText('DEPARTED')).toBeNull();
  });

  it('#2123: a completed visit with no KinTale yet still reads Completed', async () => {
    mocks.getMyBookings.mockResolvedValue(answerFor(visit('completed', 'ended', { kinTaleId: null })));
    const { container } = renderScreen();
    await screen.findByRole('heading', { level: 1 });
    expect(container.querySelector('.chip.lg')).toHaveTextContent('COMPLETED');
    expect(statusTile()).toHaveTextContent('Completed');
  });

  it('another household\'s visit: the server never sends it, so the page says it could not be found', async () => {
    // What `getMyBookings` answers for household fam1 when the route names a
    // visit that belongs to someone else: fam1's own visits and nothing more.
    const mine = visit('active', 'active', { id: 'mine' });
    mocks.getMyBookings.mockResolvedValue(answerFor(mine));
    renderScreen();
    expect(await screen.findByText(/couldn.t find that booking/i)).toBeInTheDocument();
    expect(screen.queryByText('30 Minute Quick Check')).toBeNull();
    expect(mocks.getMyBookings).toHaveBeenCalledWith('fam1');
    expect(mocks.getBookingNotes).not.toHaveBeenCalled();
  });

  it('shows a loading line while the visit is being read, never "not found"', async () => {
    mocks.getMyBookings.mockReturnValue(new Promise(() => {}));
    renderScreen();
    expect(await screen.findByText(/Loading this booking/)).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t find that booking/i)).toBeNull();
  });

  it('a read that fails says so, with a way to try again', async () => {
    mocks.getMyBookings.mockRejectedValue(new Error('unavailable'));
    renderScreen();
    expect(await screen.findByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t find that booking/i)).toBeNull();
  });
});

describe('BookingDetail: the open page follows the visit (#1823)', () => {
  it('#2123: moves from CONFIRMED to EN ROUTE, IN PROGRESS and COMPLETED with no reload, and never reads DEPARTED', async () => {
    vi.useFakeTimers();
    for (const v of [
      visit('confirmed', null),
      visit('enRoute', 'enRoute'),
      visit('active', 'active'),
      // The Auntie departs: the server answers completed, KinTale or not.
      visit('completed', 'ended'),
    ]) {
      mocks.getMyBookings.mockResolvedValueOnce(answerFor(v));
    }
    const { container } = renderScreen();
    const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    await settle(0);
    const seen = [container.querySelector('.chip.lg')!.textContent];
    for (let i = 0; i < 3; i += 1) {
      await settle(BOOKINGS_POLL_MS);
      // The fetched answer reaches the page a tick after the cache takes it.
      await settle(1);
      seen.push(container.querySelector('.chip.lg')!.textContent);
    }
    expect(seen).toEqual(['CONFIRMED', 'EN ROUTE', 'IN PROGRESS', 'COMPLETED']);
    expect(statusTile()).toHaveTextContent('Completed');
    expect(timeline(container).done).toHaveLength(5);
    // The page was never replaced by a loading line or an error on the way.
    expect(screen.queryByText(/Loading this booking/)).toBeNull();
  });
});
