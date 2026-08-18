// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
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

import { Schedule } from './Schedule';

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

/**
 * Schedule.tsx calls `useCollection` twice (sessions + busy slots), so the
 * mock must dispatch on the CollectionSpec's `path` rather than call order,
 * the two-collection-screen convention this port introduces (no existing
 * screen reads two collections yet).
 */
function mockCollections(opts: {
  sessions?: Async<ScheduleSessionEntry[]>;
  busy?: Async<BusySlotEntry[]>;
}): void {
  useCollection.mockImplementation((spec: { path: string }) => {
    if (spec.path === 'kin_care_sessions') return opts.sessions ?? emptySessions;
    if (spec.path === 'booking_time_slots') return opts.busy ?? emptyBusy;
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
  getBusinessSettings.mockReset().mockResolvedValue({ serviceDurations: {} });
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

describe('Schedule screen', () => {
  it('renders a streamed session in the selected-day agenda with its time window, household, and status chip', () => {
    withFixedToday(() => {
      mockCollections({ sessions: { status: 'ready', data: [sessionEntry({})] } });
      render(<Schedule />);
      const row = screen.getByText('The Whitfields').closest('.schedule__row') as HTMLElement;
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
      expect(screen.getByText('Today', { selector: '.den-panel-title' })).toBeInTheDocument();
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
      expect(screen.getByText('The Whitfields')).toBeInTheDocument();
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
    expect(screen.queryByText('Target-Day Household')).toBeNull();

    await user.click(screen.getByRole('button', { name: targetDay }));
    expect(screen.getByText('Target-Day Household')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
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
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    expect(screen.getByTestId('booking-detail-modal')).toHaveAttribute('data-entry-id', 'sess-42');
  });

  it('closing the detail sheet returns to the agenda', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession()] } });
    render(<Schedule />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    await user.click(screen.getByRole('button', { name: 'stub close' }));
    expect(screen.queryByTestId('booking-detail-modal')).toBeNull();
  });

  it('the sheet routes to the kinfolk detail (operator issue 16, the hyperlink half)', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession({ kinfolkId: 'kf-7' })] } });
    render(<Schedule />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
    await user.click(screen.getByRole('button', { name: 'stub open kinfolk' }));
    expect(navigate).toHaveBeenCalledWith({
      to: '/directory/$kinfolkId',
      params: { kinfolkId: 'kf-7' },
    });
  });

  it('the sheet routes to the KinTale detail', async () => {
    mockCollections({ sessions: { status: 'ready', data: [todaySession()] } });
    render(<Schedule />);
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
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
    await user.click(screen.getByRole('button', { name: /The Whitfields/i }));
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
