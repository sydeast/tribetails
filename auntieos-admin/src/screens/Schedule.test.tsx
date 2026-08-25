// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type ScheduleSessionEntry, type BusySlotEntry } from '../api/schedule';
import { localDateIso, weekDays } from '../lib/scheduleFormat';

const { useCollection } = vi.hoisted(() => ({ useCollection: vi.fn() }));
vi.mock('../lib/firestore', () => ({ useCollection }));

// The legend's duration order (#392) reads `business_settings` once via
// `getBusinessSettings`, the same one-shot doc read `NewBookingDialog.test.tsx`
// mocks the same way. Defaults to no configured durations at all, so a test
// that doesn't care about ordering doesn't need its own mock.
const { getBusinessSettings } = vi.hoisted(() => ({ getBusinessSettings: vi.fn() }));
vi.mock('../api/settings', () => ({ getBusinessSettings }));

// Schedule navigates on the detail sheet's kinfolk / KinTale links. No suite in
// this tree mounts a RouterProvider (Home.tsx has the same dependency and no
// suite of its own), so the hook is stubbed rather than the whole router stood up.
const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));

/**
 * The detail sheet is stubbed here on purpose: its own behaviour (fact rows,
 * the 3h note lock, reschedule, optimistic assign) is covered directly in
 * `components/BookingDetailModal.test.tsx`. What this suite owns is the
 * WIRING: that a row opens the sheet for the right session, and that the
 * sheet's navigation callbacks reach the router.
 */
vi.mock('../components/BookingDetailModal', () => ({
  BookingDetailModal: (props: {
    entry: { _id: string; kinfolkId?: string | undefined };
    onClose: () => void;
    onOpenKinfolk?: (id: string) => void;
    onOpenKinTale?: (id: string) => void;
  }) => (
    <div data-testid="booking-detail-modal" data-entry-id={props.entry._id}>
      <button type="button" onClick={() => props.onOpenKinfolk?.(props.entry.kinfolkId ?? '')}>
        stub open kinfolk
      </button>
      <button type="button" onClick={() => props.onOpenKinTale?.('rep1')}>
        stub open kintale
      </button>
      <button type="button" onClick={props.onClose}>
        stub close
      </button>
    </div>
  ),
}));

/**
 * The three write surfaces (#397 M11/M12/M13). Only the CALLABLES are stubbed:
 * the dialogs, the grid, and the refusal-reading helpers are the real thing, so
 * these assertions are about what actually reaches the wire.
 */
const { rescheduleBooking } = vi.hoisted(() => ({ rescheduleBooking: vi.fn() }));
vi.mock('../api/bookingsWrite', () => ({ rescheduleBooking }));
const { createBlockedTimeSlot, createKinCareSession, deleteBlockedTimeSlot } = vi.hoisted(() => ({
  createBlockedTimeSlot: vi.fn(),
  createKinCareSession: vi.fn(),
  deleteBlockedTimeSlot: vi.fn(),
}));
vi.mock('../api/scheduleWrite', async () => {
  const actual = await vi.importActual<typeof import('../api/scheduleWrite')>('../api/scheduleWrite');
  return { ...actual, createBlockedTimeSlot, createKinCareSession, deleteBlockedTimeSlot };
});
import { Schedule } from './Schedule';
import { HOUR_HEIGHT_PX } from '../lib/scheduleGrid';

function sessionEntry(over: Partial<ScheduleSessionEntry>): ScheduleSessionEntry {
  return {
    _id: 'sess1',
    kinfolkId: 'kf1',
    kinfolkName: 'The Whitfields',
    kinIds: [],
    serviceType: 'Dog Walk',
    startTime: '2026-07-16T14:00:00.000Z',
    arrivedAt: '',
    endTime: '2026-07-16T15:00:00.000Z',
    status: 'SCHEDULED',
    completedAt: '',
    notes: '',
    ...over,
  };
}

function busySlot(over: Partial<BusySlotEntry>): BusySlotEntry {
  return {
    _id: 'slot1',
    date: '2026-07-16',
    startTime: '08:00',
    endTime: '09:00',
    slotType: 'BLOCKED',
    ...over,
  };
}

const emptyBusy: Async<BusySlotEntry[]> = { status: 'ready', data: [] };
const emptySessions: Async<ScheduleSessionEntry[]> = { status: 'ready', data: [] };
const emptyKinfolk: Async<unknown[]> = { status: 'ready', data: [] };

/**
 * Schedule.tsx calls `useCollection` twice (sessions + busy slots), so the
 * mock must dispatch on the CollectionSpec's `path` rather than call order,
 * the two-collection-screen convention this port introduces (no existing
 * screen reads two collections yet).
 */
function mockCollections(opts: {
  sessions?: Async<ScheduleSessionEntry[]>;
  busy?: Async<BusySlotEntry[]>;
  kinfolk?: Async<unknown[]>;
}): void {
  useCollection.mockImplementation((spec: { path: string }) => {
    if (spec.path === 'kin_care_sessions') return opts.sessions ?? emptySessions;
    if (spec.path === 'booking_time_slots') return opts.busy ?? emptyBusy;
    // The third listener arrived with the New visit dialog (#397 M12): its
    // household picker needs the roster, and Schedule opens its own bounded
    // listener rather than reaching into Directory's.
    if (spec.path === 'kinfolk') return opts.kinfolk ?? emptyKinfolk;
    throw new Error(`unexpected collection path in test: ${spec.path}`);
  });
}

// TZ pinned to a west-of-UTC zone so the AO-18 day-grouping assertions below
// are meaningful on any CI runner (the Sessions.test.tsx/sessionFormat.test.ts
// convention).
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env.TZ;
  process.env.TZ = 'America/Chicago';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const user = userEvent.setup();

beforeEach(() => {
  useCollection.mockReset();
  navigate.mockReset();
  mockCollections({});
  getBusinessSettings
    .mockReset()
    .mockResolvedValue({ serviceDurations: {}, serviceRates: {}, snapRescheduleTo15Min: false });
  rescheduleBooking.mockReset().mockResolvedValue({ ok: true, sessionId: 'sess-42' });
  createBlockedTimeSlot.mockReset().mockResolvedValue({ ok: true, docId: 'slot-1' });
  createKinCareSession.mockReset().mockResolvedValue({ ok: true, sessionId: 'sess-9' });
  deleteBlockedTimeSlot.mockReset().mockResolvedValue({ ok: true, slotId: 'slot1' });
});

/**
 * Only the tests that assert against "today" fake the system clock; fake
 * timers and userEvent's internal setTimeout-based delays don't mix
 * reliably, so click-driven tests run on the real clock (the
 * Sessions.test.tsx/Invoices.test.tsx convention).
 */
function withFixedToday(run: () => void): void {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date(2026, 6, 16, 12, 0, 0)); // 2026-07-16 (Thursday), local noon
    run();
  } finally {
    vi.useRealTimers();
  }
}


/**
 * The agenda list under the calendar. Since #397 M13 the week view is a real
 * time grid whose blocks ALSO carry the household name, so an unscoped
 * `getByText('The Whitfields')` now legitimately matches two elements. These
 * assertions are about the agenda row, so they say so; the grid block has its
 * own coverage in `components/ScheduleWeekGrid.test.tsx`.
 */
function agenda(): HTMLElement {
  return document.querySelector('.schedule__agenda-panel') as HTMLElement;
}
describe('Schedule screen', () => {
  it('renders a streamed session in the selected-day agenda with its time window, household, and status chip', () => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
      render(<Schedule />);
      const row = within(agenda()).getByText('The Whitfields').closest('.schedule__row') as HTMLElement;
      expect(within(row).getByText('The Whitfields')).toBeInTheDocument();
      expect(within(row).getByText('Dog Walk')).toBeInTheDocument();
      expect(within(row).getByText('SCHEDULED')).toBeInTheDocument();
    });
  });

  it('groups a late-evening local session under its LOCAL day agenda, not the UTC-next day (AO-18)', () => {
    withFixedToday(() => {
      // 2026-07-16 20:00 America/Chicago (CDT, UTC-5) round-trips as this UTC instant.
      mockCollections({
        sessions: {
          status: 'ready',
          data: [sessionEntry({ startTime: '2026-07-17T01:00:00.000Z', endTime: '2026-07-17T02:30:00.000Z' })],
        },
      });
      render(<Schedule />);
      // Default view starts on "today" (the fixed system clock's local day);
      // the panel title for the selected day should read "Today", and the
      // session should appear in that day's agenda, not be silently absent
      // because it landed under tomorrow's UTC-sliced key instead.
      expect(screen.getByRole('heading', { name: 'Today', level: 2 })).toBeInTheDocument();
      expect(screen.getByText('The Whitfields')).toBeInTheDocument();
    });
  });

  it('shows the local clock time in the row, not the UTC hour', () => {
    withFixedToday(() => {
      mockCollections({
        sessions: {
          status: 'ready',
          data: [sessionEntry({ startTime: '2026-07-17T01:00:00.000Z', endTime: '2026-07-17T02:30:00.000Z' })],
        },
      });
      render(<Schedule />);
      expect(screen.getByText('20:00 to 21:30')).toBeInTheDocument();
    });
  });

  it.each([
    ['SCHEDULED', 'SCHEDULED'],
    ['ON_MY_WAY', 'ON THE WAY'],
    ['ARRIVED', 'ARRIVED'],
    ['DEPARTED', 'DEPARTED'],
    ['COMPLETED', 'COMPLETED'],
    ['CANCELLED', 'CANCELLED'],
  ])('renders the %s status positively as its own chip', (status, chip) => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({ status })] } });
      render(<Schedule />);
      expect(screen.getByText(chip)).toBeInTheDocument();
    });
  });

  it('AO-12-style regression guard: an unrecognized status renders UNKNOWN, never a fabricated SCHEDULED', () => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({ status: 'some_new_code' })] } });
      render(<Schedule />);
      expect(screen.getByText('UNKNOWN')).toBeInTheDocument();
      expect(screen.queryByText('SCHEDULED')).toBeNull();
    });
  });

  it('surfaces a sessions-listener error, never a false empty', () => {
    mockCollections({ sessions: { status: 'error', message: 'permission-denied' } });
    render(<Schedule />);
    expect(screen.getByText('permission-denied', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.queryByText(/nothing on the schedule yet/i)).toBeNull();
  });

  it('surfaces a sessions load failure with retry, not a silent spinner', () => {
    mockCollections({ sessions: { status: 'error', message: 'deadline-exceeded', retry: vi.fn() } });
    render(<Schedule />);
    expect(screen.getByText('deadline-exceeded', { selector: '.async-error-detail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders the proven-empty state only when the sessions stream is ready and genuinely empty', () => {
    mockCollections({ sessions: { status: 'ready', data: [] } });
    render(<Schedule />);
    expect(screen.getByText(/nothing on the schedule yet/i)).toBeInTheDocument();
  });

  it('a busy-slot listener error surfaces inline WITHOUT gating the rest of the (ready) schedule', () => {
    withFixedToday(() => {
      mockCollections({
        sessions: { status: 'ready', data: [sessionEntry({})] },
        busy: { status: 'error', message: 'permission-denied' },
      });
      render(<Schedule />);
      // Scoped by class: the "Busy blocks" StatCard also renders its own
      // role="alert" trend for this same error, this assertion is about the
      // dedicated inline note in the schedule body, not that one.
      expect(
        screen.getByText(/busy blocks unavailable/i, { selector: '.schedule__busy-error' }),
      ).toHaveTextContent('permission-denied');
      // The primary (sessions) content still renders; a secondary stream's
      // error must not blank the whole screen.
      expect(within(agenda()).getByText('The Whitfields')).toBeInTheDocument();
    });
  });

  it('renders a BLOCKED busy slot in the selected day agenda with its window label', () => {
    withFixedToday(() => {
      mockCollections({ busy: { status: 'ready', data: [busySlot({ date: '2026-07-16' })] } });
      render(<Schedule />);
      expect(screen.getByText('8:00 AM to 9:00 AM')).toBeInTheDocument();
      expect(screen.getByText('BLOCKED')).toBeInTheDocument();
    });
  });

  /**
   * #574: the other half of "block time". `createBlockedTimeSlot` shipped in
   * B6; there was no way to take a block back off until `deleteBlockedTimeSlot`
   * was built, and the only unblock affordance that existed (Android's) deleted
   * the document straight from the client, which `firestore.rules` denies.
   */
  it('Unblock removes an operator’s own block through the callable', async () => {
    mockCollections({
      sessions: { status: 'ready', data: [sessionEntry({})] },
      busy: {
        status: 'ready',
        data: [busySlot({ date: localDateIso(new Date()), source: 'INTERNAL_MANUAL' })],
      },
    });
    render(<Schedule />);

    await user.click(within(agenda()).getByRole('button', { name: 'Unblock' }));

    await waitFor(() => expect(deleteBlockedTimeSlot).toHaveBeenCalledTimes(1));
    expect(deleteBlockedTimeSlot).toHaveBeenCalledWith('slot1');
  });

  /**
   * A Google mirror comes straight back on the next sync, so the server refuses
   * to delete it — and the button must not be there in the first place, or the
   * refusal is the operator's first news of it.
   */
  it('a Google Calendar mirror gets no Unblock button at all', () => {
    withFixedToday(() => {
      mockCollections({
        sessions: { status: 'ready', data: [sessionEntry({})] },
        busy: {
          status: 'ready',
          data: [busySlot({ date: '2026-07-16', source: 'GOOGLE_BUSY_IMPORT' })],
        },
      });
      render(<Schedule />);
      expect(screen.queryByRole('button', { name: 'Unblock' })).toBeNull();
      expect(screen.getByText('From Google Calendar')).toBeInTheDocument();
    });
  });

  /** A row written before `source` existed is an operator block, and removable. */
  it('a row with no source is treated as an operator block', () => {
    withFixedToday(() => {
      mockCollections({
        sessions: { status: 'ready', data: [sessionEntry({})] },
        busy: { status: 'ready', data: [busySlot({ date: '2026-07-16' })] },
      });
      render(<Schedule />);
      expect(screen.getByRole('button', { name: 'Unblock' })).toBeInTheDocument();
    });
  });

  it('a refused unblock surfaces the server’s own sentence and leaves the row alone', async () => {
    deleteBlockedTimeSlot.mockRejectedValueOnce(
      Object.assign(
        new Error('That busy block is a mirror of an event on the connected Google Calendar.'),
        { code: 'functions/failed-precondition', details: { code: 'imported_busy_slot' } },
      ),
    );
    mockCollections({
      sessions: { status: 'ready', data: [sessionEntry({})] },
      busy: {
        status: 'ready',
        data: [busySlot({ date: localDateIso(new Date()), source: 'INTERNAL_MANUAL' })],
      },
    });
    render(<Schedule />);

    await user.click(within(agenda()).getByRole('button', { name: 'Unblock' }));

    await screen.findByText('Couldn’t remove that block');
    expect(screen.getByText(/mirror of an event on the connected Google Calendar/)).toBeInTheDocument();
    // No optimistic removal: the row is still drawn, because nothing was deleted.
    expect(within(agenda()).getByText('BLOCKED')).toBeInTheDocument();
  });

  it('drops a busy slot with an unrecognized slotType (AO-12-style: never assumed BLOCKED)', () => {
    withFixedToday(() => {
      mockCollections({
        busy: { status: 'ready', data: [busySlot({ date: '2026-07-16', slotType: 'SOMETHING_NEW' })] },
      });
      render(<Schedule />);
      expect(screen.queryByText('BLOCKED')).toBeNull();
    });
  });

  it('switching the view tab swaps the week grid for the month grid', async () => {
    // A non-empty sessions stream: the calendar/nav controls render inside
    // AsyncRegion's "data" branch (the Sessions.tsx/Invoices.tsx convention),
    // so a proven-EMPTY collection would render only the top-level EmptyHint
    // instead, same as those screens hiding their filter tabs on empty.
    mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
    render(<Schedule />);
    expect(screen.getByRole('group', { name: 'Week' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Month' })).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Month' }));
    expect(screen.getByRole('group', { name: 'Month' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Week' })).toBeNull();
  });

  // Deliberately NOT wrapped in withFixedToday: userEvent's internal
  // setTimeout-based delays don't mix reliably with fake timers (the
  // Sessions.test.tsx convention), so these click-driven tests run on the
  // real clock and assert a ROUND TRIP (changed, then back to the original)
  // rather than a hardcoded date string, so they hold on any day the suite
  // happens to run.
  it('the Next control steps the visible range forward, and Previous steps it back', async () => {
    mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
    render(<Schedule />);
    const label = () => (screen.getByText((_, el) => el?.className === 'schedule__nav-label') as HTMLElement).textContent;
    const initial = label();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(label()).not.toBe(initial);

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(label()).toBe(initial);
  });

  it('selecting a day in the week strip updates the agenda panel to that day', async () => {
    // Computed relative to the REAL "today" (this test is not clock-pinned),
    // so it holds regardless of which day the suite runs on: pick any OTHER
    // day in the current real week, and stamp a session on it at a UTC hour
    // that cannot cross a local calendar-day boundary (14:00Z is always
    // mid-afternoon-or-later local in any US zone, and never rolls to the
    // next/previous LOCAL day given the pinned America/Chicago TZ).
    const todayIsoReal = localDateIso(new Date());
    const days = weekDays(todayIsoReal);
    const targetDay = days.find((d) => d !== todayIsoReal) ?? (days[0] as string);

    mockCollections({
      sessions: {
        status: 'ready',
        data: [
          sessionEntry({
            _id: 'target',
            kinfolkName: 'Target-Day Household',
            startTime: `${targetDay}T14:00:00.000Z`,
            endTime: `${targetDay}T15:00:00.000Z`,
          }),
        ],
      },
    });
    render(<Schedule />);
    // Scoped to the AGENDA: since #397 M13 the week view is a real time grid
    // that draws every visit in the week, so this household is legitimately on
    // screen in its own column before any day is selected. What selecting a day
    // changes is which day the agenda below lists.
    expect(within(agenda()).queryByText('Target-Day Household')).toBeNull();

    await user.click(screen.getByRole('button', { name: targetDay }));
    expect(within(agenda()).getByText('Target-Day Household')).toBeInTheDocument();
  });

  // Real-clock (not withFixedToday): userEvent's click is async and does not
  // mix reliably with fake timers (the Sessions.test.tsx convention), so the
  // session is stamped on the REAL today (computed, not hardcoded) at a UTC
  // hour that cannot cross a local calendar-day boundary, same technique as
  // the "selecting a day" test above.
  it('clicking a row calls onSelect with the session id', async () => {
    const todayIsoReal = localDateIso(new Date());
    mockCollections({
      sessions: {
        status: 'ready',
        data: [sessionEntry({ _id: 'sess-42', startTime: `${todayIsoReal}T14:00:00.000Z`, endTime: `${todayIsoReal}T15:00:00.000Z` })],
      },
    });
    const onSelect = vi.fn();
    render(<Schedule onSelect={onSelect} />);
    await user.click(within(agenda()).getByRole('button', { name: /The Whitfields/i }));
    expect(onSelect).toHaveBeenCalledWith('sess-42');
  });

  /** One session stamped on the REAL today, for the click-driven tests below. */
  function todaySession(over: Partial<ScheduleSessionEntry> = {}) {
    const todayIsoReal = localDateIso(new Date());
    return sessionEntry({
      _id: 'sess-42',
      startTime: `${todayIsoReal}T14:00:00.000Z`,
      endTime: `${todayIsoReal}T15:00:00.000Z`,
      ...over,
    });
  }

  it('propless (the router default), clicking a row OPENS the booking detail sheet', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession()] } });
    render(<Schedule />);
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
    await user.click(within(agenda()).getByRole('button', { name: /The Whitfields/i }));
    expect(screen.getByTestId('booking-detail-modal')).toHaveAttribute('data-entry-id', 'sess-42');
  });

  it('closing the detail sheet returns to the agenda', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession()] } });
    render(<Schedule />);
    await user.click(within(agenda()).getByRole('button', { name: /The Whitfields/i }));
    await user.click(screen.getByRole('button', { name: 'stub close' }));
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });

  it('the sheet routes to the kinfolk detail (operator issue 16, the hyperlink half)', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession({ kinfolkId: 'kf-7' })] } });
    render(<Schedule />);
    await user.click(within(agenda()).getByRole('button', { name: /The Whitfields/i }));
    await user.click(screen.getByRole('button', { name: 'stub open kinfolk' }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf-7' },
    });
  });

  it('the sheet routes to the KinTale detail', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession()] } });
    render(<Schedule />);
    await user.click(within(agenda()).getByRole('button', { name: /The Whitfields/i }));
    await user.click(screen.getByRole('button', { name: 'stub open kintale' }));
    // Search param, not a path: lib/notificationActions.ts set that convention
    // for kintale and invoice deep links, and this sheet follows it.
    expect(navigate).toHaveBeenCalledWith({
      to: '/kintales',
      search: { kinTaleId: 'rep1' },
    });
  });

  it('an onSelect override takes over and the sheet never opens', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession()] } });
    render(<Schedule onSelect={vi.fn()} />);
    await user.click(within(agenda()).getByRole('button', { name: /The Whitfields/i }));
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });

  it('a busy-slot row is always static (never a dead-control button), regardless of onSelect', () => {
    withFixedToday(() => {
      mockCollections({ busy: { status: 'ready', data: [busySlot({ date: '2026-07-16' })] } });
      render(<Schedule onSelect={vi.fn()} />);
      expect(screen.getByText('BLOCKED')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Busy/i })).toBeNull();
    });
  });

  /**
   * #392, part 1 + 2: the legend is SCOPED to the current view (`daysInView`,
   * not the whole bounded 300-session stream and not the operator's whole
   * configured `business_settings.serviceRates`) and ORDERED by duration
   * (`sortServiceTypesByDuration`, the same two-source rule #373 gave the
   * Android legend). All of the tests below render on the real clock: the
   * legend's duration order is loaded from an AWAITED `getBusinessSettings()`
   * call, and fake timers don't mix reliably with userEvent/await in this
   * suite (see `withFixedToday`'s own doc comment above), so these use the
   * suite's `todaySession()` convention instead of a fixed system clock.
   */
  it('the legend lists each distinct service type actually present, plus a Busy swatch', async () => {
    mockCollections({
      sessions: {
        status: 'ready',
        data: [
          todaySession({ _id: 'a', serviceType: 'Dog Walk' }),
          todaySession({ _id: 'b', serviceType: 'Drop-in' }),
        ],
      },
    });
    render(<Schedule />);
    await waitFor(() => expect(getBusinessSettings).toHaveBeenCalled());
    expect(await screen.findAllByText('Dog Walk')).not.toHaveLength(0);
    expect(screen.getAllByText('Drop-in').length).toBeGreaterThan(0);
    expect(screen.getByText('Busy')).toBeInTheDocument();
  });

  it('scopes the legend to the current view: a type present only weeks away from the visible week is excluded', async () => {
    const todayIsoReal = localDateIso(new Date());
    // Three weeks out is outside the Monday-first week strip no matter which
    // weekday the suite happens to run on.
    const farAway = new Date();
    farAway.setDate(farAway.getDate() + 21);
    const farAwayIso = localDateIso(farAway);
    mockCollections({
      sessions: {
        status: 'ready',
        data: [
          todaySession({ _id: 'in-view', serviceType: 'Dog Walk' }),
          sessionEntry({
            _id: 'out-of-view',
            serviceType: 'Overnight Stay',
            startTime: `${farAwayIso}T14:00:00.000Z`,
            endTime: `${farAwayIso}T15:00:00.000Z`,
          }),
        ],
      },
    });
    render(<Schedule />);
    await screen.findAllByText('Dog Walk');
    expect(screen.queryByText('Overnight Stay')).toBeNull();
    // Sanity: the session really is in the stream, just outside the default
    // week view, so this proves scoping and not a fixture typo.
    expect(todayIsoReal).not.toBe(farAwayIso);
  });

  it('an empty view shows no legend rows at all, not a stale full list', () => {
    mockCollections({ sessions: { status: 'ready', data: [] } });
    render(<Schedule />);
    expect(screen.queryByLabelText('Service type legend')).toBeNull();
    expect(screen.queryByText('Busy')).toBeNull();
  });

  it('an empty view honestly shows no legend even when the stream itself is non-empty (every session is out of view)', async () => {
    const farAway = new Date();
    farAway.setDate(farAway.getDate() + 21);
    const farAwayIso = localDateIso(farAway);
    mockCollections({
      sessions: {
        status: 'ready',
        data: [
          sessionEntry({
            _id: 'out-of-view',
            serviceType: 'Overnight Stay',
            startTime: `${farAwayIso}T14:00:00.000Z`,
            endTime: `${farAwayIso}T15:00:00.000Z`,
          }),
        ],
      },
    });
    render(<Schedule />);
    // AsyncRegion itself doesn't treat this as empty (the stream has a row),
    // so the agenda panel renders; it's the LEGEND specifically that must be
    // scoped away, never a stale row for a type entirely outside the view.
    expect(await screen.findByText('No Kin Care sessions on this day.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Service type legend')).toBeNull();
    expect(screen.queryByText('Overnight Stay')).toBeNull();
  });

  it('orders the legend by configured duration: two of five configured types render, in duration order', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceDurations: { 'Half-Day 6Hrs': '360', '30Minute': '30', Consultation: '20', '90Minute': '90', '2Hrs': '120' },
    });
    mockCollections({
      sessions: {
        status: 'ready',
        data: [
          // Only 2 of the 5 configured types are on screen. "Half-Day 6Hrs"
          // is the LONGER of the two but appears FIRST in the stream/DOM
          // order below, so passing requires the duration sort, not luck.
          todaySession({ _id: 'a', serviceType: 'Half-Day 6Hrs' }),
          todaySession({ _id: 'b', serviceType: '30Minute' }),
        ],
      },
    });
    const { container } = render(<Schedule />);
    await waitFor(() => expect(getBusinessSettings).toHaveBeenCalled());
    await screen.findAllByText('30Minute');
    const items = Array.from(container.querySelectorAll('.schedule__legend-item')).map((el) => el.textContent);
    expect(items).toEqual(['30Minute', 'Half-Day 6Hrs', 'Busy']);
    // The three configured-but-absent types never render.
    expect(screen.queryByText('Consultation')).toBeNull();
    expect(screen.queryByText('90Minute')).toBeNull();
    expect(screen.queryByText('2Hrs')).toBeNull();
  });

  it('a type on screen but missing from business_settings still gets a legend row', async () => {
    getBusinessSettings.mockResolvedValue({ serviceDurations: { '30Minute': '30' } });
    mockCollections({
      sessions: {
        status: 'ready',
        data: [
          todaySession({ _id: 'a', serviceType: '30Minute' }),
          todaySession({ _id: 'b', serviceType: 'Off-Book Visit' }),
        ],
      },
    });
    const { container } = render(<Schedule />);
    await waitFor(() => expect(getBusinessSettings).toHaveBeenCalled());
    await screen.findAllByText('Off-Book Visit');
    // Unconfigured and un-parseable, so it has no resolvable duration and
    // sorts last -- but it is never dropped.
    const items = Array.from(container.querySelectorAll('.schedule__legend-item')).map((el) => el.textContent);
    expect(items).toEqual(['30Minute', 'Off-Book Visit', 'Busy']);
  });

  it('the "in view" stat counts only sessions within the visible week, honestly reflecting a listener error as unknown (not zero)', () => {
    mockCollections({ sessions: { status: 'error', message: 'permission-denied' } });
    render(<Schedule />);
    const card = screen.getByText('Week sessions').closest('.den-stat, button.den-stat--button');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByText('-')).toBeInTheDocument();
  });
});

/**
 * #397 M11/M12/M13: the Schedule screen's own write wiring — the drag that
 * reaches `rescheduleBooking`, and the two dialogs the header opens.
 *
 * The DROP ARITHMETIC is pinned in `lib/scheduleGrid.test.ts` and the GESTURE in
 * `components/ScheduleWeekGrid.test.tsx`. What this suite owns is the join: that
 * a real drag on this screen sends the exact start and end a reader can check,
 * and that a refusal is shown rather than swallowed.
 */
describe('Schedule write surfaces', () => {
  /** A visit at 9:00-10:30 LOCAL today, so it lands inside the 8a-6p grid in any zone. */
  function gridSession(): ScheduleSessionEntry {
    const today = new Date();
    return sessionEntry({
      _id: 'sess-42',
      startTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0, 0, 0).toISOString(),
      endTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 30, 0, 0).toISOString(),
    });
  }
  function gridBlock(): HTMLElement {
    return within(document.querySelector('.schedule-grid') as HTMLElement).getByRole('button', {
      name: /The Whitfields/i,
    });
  }
  /** One press-move-release on a grid block, in client coordinates. */
  function dragBy(el: HTMLElement, dy: number) {
    fireEvent(el, new MouseEvent('pointerdown', { bubbles: true, clientX: 40, clientY: 40 }));
    fireEvent(el, new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 + dy }));
    fireEvent(el, new MouseEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40 + dy }));
  }
  function refusal(code: string, message: string) {
    return Object.assign(new Error(message), {
      code: 'functions/failed-precondition',
      details: { code },
    });
  }
  it('a drag sends the snapped new start and an end derived from the visit’s own duration', async () => {
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    dragBy(gridBlock(), HOUR_HEIGHT_PX); // one hour down: 9:00 -> 10:00
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalledTimes(1));
    const today = new Date();
    const at = (hh: number, mm: number) =>
      new Date(today.getFullYear(), today.getMonth(), today.getDate(), hh, mm, 0, 0).toISOString();
    expect(rescheduleBooking).toHaveBeenCalledWith('sess-42', at(10, 0), at(11, 30), {});
  });
  /**
   * A drop that resolves back to the visit's own start writes nothing: no
   * callable, no audit entry, no "rescheduled" event for a move nobody made.
   *
   * Run with the operator's 15-minute snap ON, and that is the point rather
   * than an incidental setting. At minute precision any travel that clears the
   * 5px click threshold is already six minutes or more, so it always lands on a
   * different minute; the quarter-hour snap is what makes a real drag resolve
   * back to where it started, and therefore the only case this guard bites.
   */
  it('a drag that snaps back onto the visit’s own start writes nothing at all', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceDurations: {},
      serviceRates: {},
      snapRescheduleTo15Min: true,
    });
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    await act(async () => {}); // let the one-shot settings read land before dragging

    // 6px is 6.7 minutes down from 9:00, so the drop resolves to 9:07 and then
    // floors back to the same 9:00 quarter-hour the visit already sits on.
    dragBy(gridBlock(), 6);
    await waitFor(() => expect(rescheduleBooking).not.toHaveBeenCalled());

    // The same gesture DOES write once the travel clears that quarter-hour, so
    // the assertion above is about the no-op guard and not about a dead drag.
    dragBy(gridBlock(), 15);
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalledTimes(1));
  });
  it('a refusal is surfaced with the server’s own sentence, and offers the override', async () => {
    rescheduleBooking.mockRejectedValueOnce(
      refusal('visit_overlap_conflict', 'That time is already taken: visit 1 overlaps a visit already booked.'),
    );
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    dragBy(gridBlock(), HOUR_HEIGHT_PX);
    await screen.findByText('Couldn’t move that visit');
    expect(screen.getByText(/overlaps a visit already booked/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move anyway' }));
    await waitFor(() => expect(rescheduleBooking).toHaveBeenCalledTimes(2));
    expect(rescheduleBooking.mock.calls[1]![3]).toEqual({ visit: true });
  });
  it('a company closure refusal is final: the override is not offered', async () => {
    rescheduleBooking.mockRejectedValueOnce(
      refusal('company_holiday_conflict', 'This date is not available. The business is closed.'),
    );
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    dragBy(gridBlock(), HOUR_HEIGHT_PX);
    await screen.findByText('Couldn’t move that visit');
    expect(screen.queryByRole('button', { name: 'Move anyway' })).toBeNull();
  });
  it('"Block time" opens the dialog and reaches the callable with the selected day', async () => {
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    // Two controls legitimately read "Block time": the header action that opens
    // the dialog, and the dialog's own submit. Scoped rather than disambiguated
    // by order, so a layout change cannot silently retarget this.
    await user.click(
      within(document.querySelector('.schedule__actions') as HTMLElement).getByRole('button', {
        name: 'Block time',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Block time' });
    await user.click(within(dialog).getByRole('button', { name: 'Block time' }));
    await waitFor(() => expect(createBlockedTimeSlot).toHaveBeenCalledTimes(1));
    expect(createBlockedTimeSlot.mock.calls[0]![0].date).toBe(localDateIso(new Date()));
  });
  it('"New visit" opens the dialog over the operator’s real catalog', async () => {
    getBusinessSettings.mockResolvedValue({
      serviceDurations: {},
      serviceRates: { '30Minute': '25' },
      snapRescheduleTo15Min: false,
    });
    mockCollections({
      sessions: { status: 'ready', data: [gridSession()] },
      kinfolk: { status: 'ready', data: [{ _id: 'kf1', firstName: 'Ada', lastName: 'Lovelace' }] },
    });
    render(<Schedule />);
    await act(async () => {});
    await user.click(screen.getByRole('button', { name: 'New visit' }));
    await user.selectOptions(screen.getByLabelText('Household'), 'kf1');
    await user.selectOptions(
      screen.getByLabelText('Service'),
      screen.getByRole('option', { name: '30Minute · $25' }),
    );
    await user.click(screen.getByRole('button', { name: 'Schedule visit' }));
    await waitFor(() => expect(createKinCareSession).toHaveBeenCalledTimes(1));
    expect(createKinCareSession.mock.calls[0]![0]).toMatchObject({
      kinfolkId: 'kf1',
      serviceType: '30Minute',
      serviceDurationMinutes: 30,
    });
  });
});
