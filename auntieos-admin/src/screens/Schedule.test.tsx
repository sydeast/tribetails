// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Async } from '../lib/async';
import { type ScheduleSessionEntry, type BusySlotEntry } from '../api/schedule';
import { localDateIso, weekDays, monthGridDays } from '../lib/scheduleFormat';

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

/**
 * One cell of the month grid, by its ISO day.
 *
 * Queried by `data-day` rather than by the day-number button, because since
 * #696 the cell is a DIV holding several controls: the day number, one button
 * per visit, and "+N more". `within(getByRole('button', { name: day }))` used to
 * reach the whole cell and now reaches only the number inside it.
 */
function monthCell(day: string): HTMLElement {
  return document.querySelector(`.schedule__day-cell[data-day="${day}"]`) as HTMLElement;
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
      expect(within(agenda()).getByText('8:00 AM to 9:00 AM')).toBeInTheDocument();
      // The kit's StatusPill: "Blocked" in the DOM, uppercased by the stylesheet.
      expect(within(agenda()).getByText('Blocked')).toBeInTheDocument();
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
      // Scoped to the agenda: the week grid's busy block names the same
      // source since #755, so an unscoped query would match twice.
      expect(within(agenda()).getByText('From Google Calendar')).toBeInTheDocument();
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
    expect(within(agenda()).getByText('Blocked')).toBeInTheDocument();
  });

  it('drops a busy slot with an unrecognized slotType (AO-12-style: never assumed BLOCKED)', () => {
    withFixedToday(() => {
      mockCollections({
        busy: { status: 'ready', data: [busySlot({ date: '2026-07-16', slotType: 'SOMETHING_NEW' })] },
      });
      render(<Schedule />);
      expect(screen.queryByText('Blocked')).toBeNull();
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
      expect(within(agenda()).getByText('Blocked')).toBeInTheDocument();
      // Scoped to the agenda: since #697 the "Busy blocks" StatCard is itself a
      // clickable button when there is a busy day to jump to, so an unscoped
      // query here would match that card instead of the row this test is about.
      expect(within(agenda()).queryByRole('button', { name: /Busy/i })).toBeNull();
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

  /**
   * #695: "Today" used to render after the week/month grid, off screen behind
   * a 540px time grid until the operator scrolled. It now sits above the grid,
   * after the hero band that holds the Day/Week/Month controls (#755 moved
   * them there) and the stat cards.
   */
  it('renders the Today agenda panel after the hero controls and above the week grid (#695)', () => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
      render(<Schedule />);
      const controls = document.querySelector('.schedule__controls') as HTMLElement;
      const agendaPanel = agenda();
      const grid = document.querySelector('.schedule-grid') as HTMLElement;
      expect(controls).toBeInTheDocument();
      expect(agendaPanel).toBeInTheDocument();
      expect(grid).toBeInTheDocument();
      // DOCUMENT_POSITION_FOLLOWING: the argument comes AFTER the node compared against.
      expect(controls.compareDocumentPosition(agendaPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(agendaPanel.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('renders the Today agenda panel above the month grid too', async () => {
    mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
    render(<Schedule />);
    await user.click(screen.getByRole('tab', { name: 'Month' }));
    const agendaPanel = agenda();
    const monthGrid = screen.getByRole('group', { name: 'Month' });
    expect(agendaPanel.compareDocumentPosition(monthGrid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the Today agenda panel is collapsible, so a long day’s list does not have to push the grid down (#695)', () => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
      render(<Schedule />);
      const toggle = within(agenda()).getByRole('button', { name: /Today/ });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(within(agenda()).getByText('The Whitfields')).toBeInTheDocument();

      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(within(agenda()).queryByText('The Whitfields')).toBeNull();
    });
  });

  /**
   * #697: the "Busy blocks" stat card used to render a bare count with no
   * `onClick`, and nothing on the month grid marked which days it counted.
   */
  it('the Busy blocks card is not clickable when there is nothing to jump to', () => {
    mockCollections({ busy: { status: 'ready', data: [] } });
    render(<Schedule />);
    const card = screen.getByText('Busy blocks').closest('.den-stat, button.den-stat--button') as HTMLElement;
    expect(card.tagName).toBe('DIV');
  });

  it('clicking the Busy blocks card selects the first busy day in the visible range and scrolls its block into view (#697)', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // Computed off the REAL "today" (not clock-pinned): pick any OTHER day in
    // the current real week, the "selecting a day" test's own technique above.
    const todayIsoReal = localDateIso(new Date());
    const days = weekDays(todayIsoReal);
    const busyDay = days.find((d) => d !== todayIsoReal) ?? (days[0] as string);

    mockCollections({
      sessions: { status: 'ready', data: [sessionEntry({})] },
      busy: { status: 'ready', data: [busySlot({ date: busyDay })] },
    });
    render(<Schedule />);

    const card = screen.getByRole('button', { name: /busy blocks/i });
    await user.click(card);

    // Selecting the busy day moves the agenda off "Today" (it is a DIFFERENT
    // day than the real today by construction above).
    expect(screen.queryByRole('heading', { name: 'Today', level: 2 })).toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  /**
   * #696 replaced #697's corner dot with the busy WINDOW drawn as its own
   * block, so this reads the block rather than the dot. The fact under test is
   * unchanged and still #697's: every busy day in the month is marked, a clean
   * day is not, so the "Busy blocks" count can be traced to dates.
   */
  it('draws a busy block on every month-grid day that carries a busy slot, and none on a clean day (#697)', async () => {
    const todayIsoReal = localDateIso(new Date());
    const monthDays = monthGridDays(todayIsoReal);
    const busyDayA = monthDays[3] as string;
    const busyDayB = monthDays[9] as string;
    const cleanDay = monthDays.find((d) => d !== busyDayA && d !== busyDayB) as string;

    mockCollections({
      sessions: { status: 'ready', data: [sessionEntry({})] },
      busy: {
        status: 'ready',
        data: [busySlot({ _id: 'b1', date: busyDayA }), busySlot({ _id: 'b2', date: busyDayB })],
      },
    });
    render(<Schedule />);
    await user.click(screen.getByRole('tab', { name: 'Month' }));

    expect(within(monthCell(busyDayA)).getByText('Busy')).toBeInTheDocument();
    expect(within(monthCell(busyDayB)).getByText('Busy')).toBeInTheDocument();
    expect(within(monthCell(cleanDay)).queryByText('Busy')).toBeNull();
  });
});

/**
 * The month calendar (#696).
 *
 * The operator's words were "we are still using the wrong calendar", looking at
 * a month of bare numbered pills. What these pin is that a cell now draws its
 * OWN day: the visits on it, tinted by service type, the busy windows on it,
 * and an honest count of whatever did not fit.
 *
 * Days are computed off the REAL today rather than a pinned clock, the
 * convention the click-driven tests in the suite above already follow
 * (`withFixedToday`'s doc explains why fake timers and userEvent do not mix),
 * and every session time is built from a LOCAL `Date` so the block label is the
 * hour written here in any zone and on either side of a DST boundary.
 */
describe('Schedule month grid', () => {
  const todayIsoReal = localDateIso(new Date());
  const monthDays = monthGridDays(todayIsoReal);
  /** Two days in the visible month grid, far enough apart to be separate weeks. */
  const dayA = monthDays[8] as string;
  const dayB = monthDays[16] as string;

  /** An ISO instant for a LOCAL wall-clock hour on a `YYYY-MM-DD` day. */
  function at(dayIso: string, hour: number, minute = 0): string {
    const [y, m, d] = dayIso.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d, hour, minute, 0, 0).toISOString();
  }

  async function renderMonth(
    sessions: ScheduleSessionEntry[],
    busy: BusySlotEntry[] = [],
  ): Promise<void> {
    mockCollections({
      sessions: { status: 'ready', data: sessions },
      busy: { status: 'ready', data: busy },
    });
    render(<Schedule />);
    await user.click(screen.getByRole('tab', { name: 'Month' }));
  }

  it('draws each day’s visits and busy windows as blocks in that day’s own cell', async () => {
    await renderMonth(
      [
        sessionEntry({
          _id: 'a-morning',
          kinfolkName: 'Morning Household',
          serviceType: 'Dog Walk',
          startTime: at(dayA, 9),
          endTime: at(dayA, 10),
        }),
        sessionEntry({
          _id: 'a-midday',
          kinfolkName: 'Midday Household',
          serviceType: 'House Sit',
          startTime: at(dayA, 11),
          endTime: at(dayA, 12),
        }),
        sessionEntry({
          _id: 'b-only',
          kinfolkName: 'Other-Day Household',
          serviceType: 'Drop-in',
          startTime: at(dayB, 15),
          endTime: at(dayB, 16),
        }),
      ],
      [busySlot({ _id: 'busy-a', date: dayA, startTime: '13:00', endTime: '14:00' })],
    );

    const cellA = monthCell(dayA);
    const cellB = monthCell(dayB);

    // Day A: both of its visits, with their LOCAL start times, plus its busy
    // window. Nothing from day B.
    expect(within(cellA).getByText('Morning Household')).toBeInTheDocument();
    expect(within(cellA).getByText('09:00')).toBeInTheDocument();
    expect(within(cellA).getByText('Midday Household')).toBeInTheDocument();
    expect(within(cellA).getByText('11:00')).toBeInTheDocument();
    expect(within(cellA).getByText('Busy')).toBeInTheDocument();
    expect(within(cellA).getByText('13:00')).toBeInTheDocument();
    expect(within(cellA).queryByText('Other-Day Household')).toBeNull();

    // Day B: only its own visit, and no busy block at all.
    expect(within(cellB).getByText('Other-Day Household')).toBeInTheDocument();
    expect(within(cellB).getByText('15:00')).toBeInTheDocument();
    expect(within(cellB).queryByText('Morning Household')).toBeNull();
    expect(within(cellB).queryByText('Busy')).toBeNull();

    // Exactly at the cap, so nothing is folded away.
    expect(within(cellA).queryByText(/more$/)).toBeNull();
  });

  it('tints each visit block by service type, from the same palette the legend’s pills use', async () => {
    await renderMonth([
      sessionEntry({
        _id: 'walk',
        kinfolkName: 'Walk Household',
        serviceType: 'Dog Walk',
        startTime: at(dayA, 9),
        endTime: at(dayA, 10),
      }),
      sessionEntry({
        _id: 'sit',
        kinfolkName: 'Sit Household',
        serviceType: 'House Sit',
        startTime: at(dayB, 9),
        endTime: at(dayB, 10),
      }),
    ]);

    // `serviceTone` is the app-wide mapping: walk -> teal, sit -> purple. The
    // block reads it through the same `data-tone` attribute `ServicePill` sets,
    // so a block and its legend row can never drift to two different colours.
    const walkBlock = within(monthCell(dayA)).getByRole('button', { name: /Walk Household/ });
    const sitBlock = within(monthCell(dayB)).getByRole('button', { name: /Sit Household/ });
    expect(walkBlock).toHaveAttribute('data-tone', 'teal');
    expect(sitBlock).toHaveAttribute('data-tone', 'purple');
  });

  it('folds everything past the cap into "+N more", which opens that day in the agenda', async () => {
    const names = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
    await renderMonth(
      names.map((name, i) =>
        sessionEntry({
          _id: `crowd-${String(i)}`,
          kinfolkName: `${name} Household`,
          startTime: at(dayA, 9 + i),
          endTime: at(dayA, 10 + i),
        }),
      ),
    );

    const cellA = monthCell(dayA);
    // Three drawn, in clock order, and the last two folded rather than dropped.
    expect(within(cellA).getByText('First Household')).toBeInTheDocument();
    expect(within(cellA).getByText('Third Household')).toBeInTheDocument();
    expect(within(cellA).queryByText('Fourth Household')).toBeNull();
    const more = within(cellA).getByRole('button', { name: /2 more visits on/ });
    expect(more).toHaveTextContent('+2 more');

    // The fold is never a dead end: the whole day is one click away in the
    // agenda panel, which is where the folded rows can be read.
    await user.click(more);
    expect(within(agenda()).getByText('Fifth Household')).toBeInTheDocument();
  });

  /**
   * The cap counts VISITS. A cap over the merged list would hide the busy block
   * on exactly the crowded day an operator is looking for a free window on,
   * which is the tracing #697 promised from the month grid alone.
   */
  it('draws the busy window even on a day whose visits already fill the cap', async () => {
    await renderMonth(
      ['First', 'Second', 'Third', 'Fourth'].map((name, i) =>
        sessionEntry({
          _id: `crowd-${String(i)}`,
          kinfolkName: `${name} Household`,
          startTime: at(dayA, 9 + i),
          endTime: at(dayA, 10 + i),
        }),
      ),
      // Later than every visit, so a merged cap would sort it past the cut.
      [busySlot({ _id: 'busy-late', date: dayA, startTime: '16:00', endTime: '17:00' })],
    );

    const cellA = monthCell(dayA);
    expect(within(cellA).getByText('Busy')).toBeInTheDocument();
    expect(within(cellA).getByText('16:00')).toBeInTheDocument();
    // Only the fourth VISIT is folded; the busy window never counts against it.
    expect(within(cellA).getByRole('button', { name: /1 more visit on/ })).toHaveTextContent(
      '+1 more',
    );
    expect(within(cellA).queryByText('Fourth Household')).toBeNull();
  });

  it('a visit block is a control: clicking it opens that session’s detail sheet', async () => {
    await renderMonth([
      sessionEntry({
        _id: 'sess-month',
        kinfolkName: 'Openable Household',
        startTime: at(dayA, 9),
        endTime: at(dayA, 10),
      }),
    ]);

    await user.click(within(monthCell(dayA)).getByRole('button', { name: /Openable Household/ }));
    expect(screen.getByTestId('booking-detail-modal')).toHaveAttribute('data-entry-id', 'sess-month');
  });

  it('renders the service-type legend in month view, scoped to the month on screen', async () => {
    await renderMonth([
      sessionEntry({
        _id: 'walk',
        kinfolkName: 'Walk Household',
        serviceType: 'Dog Walk',
        startTime: at(dayA, 9),
        endTime: at(dayA, 10),
      }),
    ]);

    expect(screen.getByRole('group', { name: 'Month' })).toBeInTheDocument();
    const legend = document.querySelector('.schedule__legend') as HTMLElement;
    expect(legend).toBeInTheDocument();
    const items = Array.from(legend.querySelectorAll('.schedule__legend-item')).map(
      (el) => el.textContent,
    );
    expect(items).toEqual(['Dog Walk', 'Busy']);
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

/**
 * #755, the Schedule line: the screen against `ui-ideas/auntieos-schedule-2026-05-27.html`
 * on the navy ground. What the mock draws that the 2026-09-10 pass did not:
 * the controls in the hero band, a swatch legend with the drag note on its
 * right, tone-tinted week blocks, busy blocks that say where they came from,
 * and no second panel around the calendar. The operator's own additions to
 * the mock (stat cards #697, the Today panel #695, Block time #397 M11) stay.
 */
describe('Schedule on the glass ground (#755)', () => {
  /** A visit at 9:00-10:30 LOCAL today, inside the drawn 8a-6p window in any zone. */
  function gridSession(over: Partial<ScheduleSessionEntry> = {}): ScheduleSessionEntry {
    const today = new Date();
    return sessionEntry({
      _id: 'sess-42',
      startTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 0, 0, 0).toISOString(),
      endTime: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 30, 0, 0).toISOString(),
      ...over,
    });
  }
  function hero(): HTMLElement {
    return document.querySelector('.den-heading') as HTMLElement;
  }
  function grid(): HTMLElement {
    return document.querySelector('.schedule-grid') as HTMLElement;
  }

  it('puts the range navigator, the view segment and both write buttons in the hero band', () => {
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    const band = hero();
    expect(within(band).getByRole('heading', { level: 1 })).toHaveTextContent(/^Schedule week\.$/);
    expect(within(band).getByRole('button', { name: 'Previous' })).toBeInTheDocument();
    expect(within(band).getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(within(band).getByRole('tablist', { name: 'Schedule view' })).toBeInTheDocument();
    expect(within(band).getByRole('button', { name: 'New visit' })).toBeInTheDocument();
    expect(within(band).getByRole('button', { name: 'Block time' })).toBeInTheDocument();
    // The range reads off the navigator, the mock's way, and is not repeated
    // as a detail line under the title.
    expect(band.querySelector('.den-heading-detail')).toBeNull();
    // The explanation is the info tooltip, never a line of copy (#758).
    expect(within(band).getByRole('tooltip', { hidden: true })).toHaveTextContent(/latest 300/);
  });

  it('draws no "Schedule" panel around the calendar: the agenda panel is the only titled panel', () => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
      render(<Schedule />);
      const panelTitles = Array.from(document.querySelectorAll('.den-panel-title')).map((el) => el.textContent);
      expect(panelTitles).toEqual(['Today']);
      // Order under the hero: stat cards, the Today panel, the legend, the grid.
      const summary = document.querySelector('.schedule__summary') as HTMLElement;
      const legend = document.querySelector('.schedule__legend') as HTMLElement;
      expect(summary.compareDocumentPosition(agenda()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(agenda().compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(legend.compareDocumentPosition(grid()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  it('keys the legend with a tone swatch per service type, and writes the drag note on its right', async () => {
    mockCollections({
      sessions: {
        status: 'ready',
        data: [gridSession({ _id: 'a', serviceType: 'Dog Walk' }), gridSession({ _id: 'b', serviceType: 'House Sit' })],
      },
    });
    render(<Schedule />);
    await waitFor(() => expect(getBusinessSettings).toHaveBeenCalled());
    const legend = document.querySelector('.schedule__legend') as HTMLElement;
    const walk = within(legend).getByText('Dog Walk').closest('.schedule__legend-item') as HTMLElement;
    const sit = within(legend).getByText('House Sit').closest('.schedule__legend-item') as HTMLElement;
    expect(walk).toHaveAttribute('data-tone', 'teal');
    expect(sit).toHaveAttribute('data-tone', 'purple');
    expect(walk.querySelector('.schedule__legend-swatch')).not.toBeNull();
    // Not a pill: the legend keys colours, it does not label a visit.
    expect(legend.querySelector('.den-pill')).toBeNull();
    // Snap is off in this suite's default settings, so the note says so.
    expect(within(legend).getByText('Drag a visit to reschedule · to the minute')).toBeInTheDocument();
    // The old note under the grid is gone: nothing is outside the window.
    expect(grid().querySelector('.schedule-grid__note')).toBeNull();
  });

  it('the drag note reads the operator’s snap setting', async () => {
    getBusinessSettings.mockResolvedValue({ serviceDurations: {}, serviceRates: {}, snapRescheduleTo15Min: true });
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    expect(await screen.findByText('Drag a visit to reschedule · snaps to 15 min')).toBeInTheDocument();
  });

  it('the drag note is a week-view thing: the month legend has none', async () => {
    mockCollections({ sessions: { status: 'ready', data: [gridSession()] } });
    render(<Schedule />);
    await user.click(screen.getByRole('tab', { name: 'Month' }));
    const legend = document.querySelector('.schedule__legend') as HTMLElement;
    expect(legend).not.toBeNull();
    expect(legend.querySelector('.schedule__legend-hint')).toBeNull();
  });

  it('tints each week block by its service type, the same tone its legend swatch wears', () => {
    mockCollections({ sessions: { status: 'ready', data: [gridSession({ serviceType: 'Drop-in' })] } });
    render(<Schedule />);
    const block = within(grid()).getByRole('button', { name: /The Whitfields/ });
    expect(block).toHaveAttribute('data-tone', 'orange');
  });

  it('the agenda row wears the kit status pill in the state’s tone, struck through when cancelled', () => {
    withFixedToday(() => {
      mockCollections({
        sessions: {
          status: 'ready',
          data: [sessionEntry({ _id: 's1', status: 'ARRIVED' }), sessionEntry({ _id: 's2', status: 'CANCELLED' })],
        },
      });
      render(<Schedule />);
      const arrived = within(agenda()).getByText('ARRIVED');
      expect(arrived).toHaveClass('den-statuspill');
      expect(arrived).toHaveAttribute('data-tone', 'teal');
      const cancelled = within(agenda()).getByText('CANCELLED');
      expect(cancelled).toHaveClass('den-statuspill--struck');
      expect(cancelled).toHaveAttribute('data-tone', 'muted');
      expect(agenda().querySelector('.schedule__chip')).toBeNull();
    });
  });

  it('a busy block on the grid names its start and, for a mirror, where it came from', () => {
    const today = localDateIso(new Date());
    mockCollections({
      busy: {
        status: 'ready',
        data: [
          busySlot({ _id: 'g', date: today, startTime: '09:00', endTime: '10:00', source: 'GOOGLE_BUSY_IMPORT' }),
          busySlot({ _id: 'm', date: today, startTime: '11:00', endTime: '12:00', source: 'INTERNAL_MANUAL' }),
        ],
      },
    });
    render(<Schedule />);
    const blocks = Array.from(grid().querySelectorAll('.schedule-grid__busy')) as HTMLElement[];
    expect(blocks).toHaveLength(2);
    const [mirror, manual] = blocks as [HTMLElement, HTMLElement];
    expect(mirror).toHaveTextContent('09:00');
    expect(mirror).toHaveTextContent('From Google Calendar');
    expect(manual).toHaveTextContent('11:00');
    expect(manual).not.toHaveTextContent('From Google Calendar');
  });
});
