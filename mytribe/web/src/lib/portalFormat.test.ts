import { describe, expect, it } from 'vitest';
import {
  BOOKING_TIMELINE_STEPS,
  auntieName,
  bookingChip,
  bookingStatusIcon,
  pendingChangeLabel,
  pendingChangeOf,
  bookingStatusChip,
  bookingTimelineIndex,
  calTile,
  elapsedMinutes,
  findBookingById,
  fullDateKick,
  greetingKick,
  isoTime,
  kinVariant,
  relativeDay,
  resolveHomeLayout,
  speciesEmoji,
  bookingSubtitle,
  visitSubtitle,
  visitTile,
  visitVariant,
  visitWhenLine,
  visitBlockText,
  weekdayTime,
} from './portalFormat';
import type { GetMyBookingsResult, GetMyBookingsResultLiveVisit } from '../contracts/bookingContracts.generated';

describe('calTile', () => {
  it('formats month + zero-padded day', () => {
    expect(calTile(new Date(2026, 5, 2).getTime())).toEqual({ month: 'Jun', day: '02' });
  });
});

describe('weekdayTime', () => {
  it('formats weekday + 12h time', () => {
    expect(weekdayTime(new Date(2026, 5, 1, 8, 0).getTime())).toBe('Mon, 8:00 AM');
  });

  it('handles noon and midnight edges', () => {
    expect(weekdayTime(new Date(2026, 5, 1, 0, 5).getTime())).toBe('Mon, 12:05 AM');
    expect(weekdayTime(new Date(2026, 5, 1, 12, 0).getTime())).toBe('Mon, 12:00 PM');
  });
});

describe('visitSubtitle', () => {
  it('combines weekday-time with the auntie name', () => {
    expect(visitSubtitle(new Date(2026, 5, 1, 8, 0).getTime(), 'Maya')).toBe('Mon, 8:00 AM with Auntie Maya');
  });

  it('falls back when the start time is unknown', () => {
    expect(visitSubtitle(null, 'Maya')).toBe('With Auntie Maya');
    expect(visitSubtitle(null, null)).toBe('Time to be confirmed');
  });
});

describe('auntieName (#1322)', () => {
  it('puts the role word in front of a plain name', () => {
    expect(auntieName('Maya')).toBe('Auntie Maya');
  });
  it('says the role word once when the name already carries it, in any case or position', () => {
    expect(auntieName('TEST SANDBOX Auntie')).toBe('TEST SANDBOX Auntie');
    expect(auntieName('Auntie Maya')).toBe('Auntie Maya');
    expect(auntieName('auntie maya')).toBe('auntie maya');
    expect(auntieName('Auntie')).toBe('Auntie');
  });
  it('matches the whole word only', () => {
    expect(auntieName('Aunties Club')).toBe('Auntie Aunties Club');
  });
  it('returns null for a missing or blank name so the caller keeps its fallback', () => {
    expect(auntieName(null)).toBeNull();
    expect(auntieName(undefined)).toBeNull();
    expect(auntieName('   ')).toBeNull();
  });
  it('feeds visitSubtitle without doubling', () => {
    expect(visitSubtitle(null, 'TEST SANDBOX Auntie')).toBe('With TEST SANDBOX Auntie');
    expect(visitSubtitle(new Date(2026, 5, 1, 8, 0).getTime(), 'TEST SANDBOX Auntie')).toBe(
      'Mon, 8:00 AM with TEST SANDBOX Auntie',
    );
  });
});
describe('relativeDay', () => {
  const now = new Date(2026, 5, 10, 9, 0).getTime();

  it('today / yesterday / N days ago', () => {
    expect(relativeDay(new Date(2026, 5, 10, 2, 0).getTime(), now)).toBe('Today');
    expect(relativeDay(new Date(2026, 5, 9).getTime(), now)).toBe('Yesterday');
    expect(relativeDay(new Date(2026, 5, 7).getTime(), now)).toBe('3 days ago');
  });

  it('falls back to a short date past a week out', () => {
    expect(relativeDay(new Date(2026, 5, 1).getTime(), now)).toBe('Jun 1');
  });
});

describe('speciesEmoji', () => {
  it('maps known species', () => {
    expect(speciesEmoji('dog')).toBe('\u{1F436}');
    expect(speciesEmoji('Cat')).toBe('\u{1F431}');
  });

  it('reads the picker spellings, so Small mammal and Rabbit keep their icons (#1313)', () => {
    expect(speciesEmoji('Small mammal')).toBe('\u{1F439}');
    expect(speciesEmoji('Small Animal')).toBe('\u{1F439}');
    expect(speciesEmoji(' Rabbit ')).toBe('\u{1F430}');
    expect(speciesEmoji('Reptile')).toBe('\u{1F98E}');
  });
  it('falls back to a paw print for unknown/null species', () => {
    expect(speciesEmoji('betta fish')).toBe('\u{1F43E}');
    expect(speciesEmoji(null)).toBe('\u{1F43E}');
  });
});

describe('bookingChip', () => {
  it.each([
    ['confirmed', 'CONFIRMED', 'warm'],
    ['requested', 'REQUESTED', 'go'],
    ['enRoute', 'EN ROUTE', 'warm'],
    ['active', 'IN PROGRESS', 'warm'],
    ['completed', 'COMPLETED', 'done'],
    ['cancelled', 'CANCELLED', 'done'],
  ] as const)('%s -> %s / %s', (status, label, tone) => {
    expect(bookingChip(status)).toEqual({ label, tone });
  });
  // #1298: the list pill and the detail badge were two spellings of one status.
  it.each(['requested', 'confirmed', 'enRoute', 'active', 'completed', 'cancelled'] as const)(
    'says %s with the same words the detail badge uses',
    (status) => {
      expect(bookingChip(status).label).toBe(bookingStatusChip(status).label);
    },
  );
});
describe('bookingStatusIcon (#1298)', () => {
  it('is not a green check while the visit is only requested', () => {
    expect(bookingStatusIcon('requested')).not.toBe('\u2705');
    expect(bookingStatusIcon('confirmed')).toBe('\u2705');
    expect(bookingStatusIcon('cancelled')).not.toBe('\u2705');
  });
});
describe('pendingChange (#1299)', () => {
  const none = { cancelRequestStatus: null, rescheduleRequestStatus: null } as const;
  it('is null when nothing is open, including after an answer', () => {
    expect(pendingChangeOf(none)).toBeNull();
    expect(pendingChangeLabel({ cancelRequestStatus: 'declined', rescheduleRequestStatus: 'accepted' })).toBeNull();
  });
  it('names a pending new time', () => {
    expect(pendingChangeLabel({ ...none, rescheduleRequestStatus: 'pending' })).toBe('New time requested');
  });
  it('names a pending cancellation', () => {
    expect(pendingChangeLabel({ ...none, cancelRequestStatus: 'pending' })).toBe('Cancellation requested');
  });
  it('names the cancellation when a visit written before the rule carries both', () => {
    expect(pendingChangeLabel({ cancelRequestStatus: 'pending', rescheduleRequestStatus: 'pending' })).toBe(
      'Cancellation requested',
    );
  });
});

describe('visitVariant', () => {
  it('cycles v1/v2/v3', () => {
    expect([0, 1, 2, 3, 4].map(visitVariant)).toEqual(['v1', 'v2', 'v3', 'v1', 'v2']);
  });
});

describe('kinVariant', () => {
  it('cycles k1..k4', () => {
    expect([0, 1, 2, 3, 4].map(kinVariant)).toEqual(['k1', 'k2', 'k3', 'k4', 'k1']);
  });
});

describe('greetingKick', () => {
  it.each([
    [new Date(2026, 5, 6, 8, 0).getTime(), 'Saturday morning'],
    [new Date(2026, 5, 6, 13, 0).getTime(), 'Saturday afternoon'],
    [new Date(2026, 5, 6, 19, 0).getTime(), 'Saturday evening'],
  ])('%d -> %s', (now, expected) => {
    expect(greetingKick(now)).toBe(expected);
  });
});

describe('elapsedMinutes', () => {
  it('computes whole minutes since start', () => {
    const start = new Date(2026, 5, 6, 8, 0).getTime();
    const now = new Date(2026, 5, 6, 8, 12, 30).getTime();
    expect(elapsedMinutes(start, now)).toBe(12);
  });

  it('clamps to 0 for future timestamps (clock skew)', () => {
    expect(elapsedMinutes(Date.now() + 60_000)).toBe(0);
  });
});

describe('fullDateKick', () => {
  it('formats weekday, abbreviated month, day', () => {
    expect(fullDateKick(new Date(2026, 5, 6).getTime())).toBe('Saturday, Jun 6');
  });
});

describe('isoTime', () => {
  it('extracts the time-of-day portion', () => {
    expect(isoTime(new Date(2026, 5, 6, 8, 2).toISOString())).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });

  it('returns null for missing/invalid input', () => {
    expect(isoTime(null)).toBeNull();
    expect(isoTime('not-a-date')).toBeNull();
  });
});

describe('resolveHomeLayout', () => {
  it('empty config -> canonical order, all sections, unlimited', () => {
    expect(resolveHomeLayout([])).toEqual([
      { id: 'liveVisit', limit: 0 },
      { id: 'upNext', limit: 0 },
      { id: 'tales', limit: 0 },
      { id: 'roster', limit: 0 },
      { id: 'quickStart', limit: 0 },
    ]);
  });

  it('configured order is honored verbatim (not forced back to canonical)', () => {
    expect(
      resolveHomeLayout([
        { id: 'quickStart', enabled: true, limit: 0 },
        { id: 'tales', enabled: true, limit: 5 },
      ]),
    ).toEqual([
      { id: 'quickStart', limit: 0 },
      { id: 'tales', limit: 5 },
    ]);
  });

  it('drops disabled sections', () => {
    expect(
      resolveHomeLayout([
        { id: 'upNext', enabled: false, limit: 0 },
        { id: 'roster', enabled: true, limit: 2 },
      ]),
    ).toEqual([{ id: 'roster', limit: 2 }]);
  });

  it('drops unknown section ids (forward-compat with a future operator config)', () => {
    expect(
      resolveHomeLayout([
        { id: 'someFutureWidget', enabled: true, limit: 0 },
        { id: 'roster', enabled: true, limit: 0 },
      ]),
    ).toEqual([{ id: 'roster', limit: 0 }]);
  });
});

function booking(overrides: Partial<GetMyBookingsResultLiveVisit> = {}): GetMyBookingsResultLiveVisit {
  return {
    id: 'v1',
    batchId: 'b1',
    kinfolkId: 'fam1',
    status: 'confirmed',
    serviceType: 'Drop-in Visit',
    serviceId: null,
    title: null,
    startTimeMs: null,
    endTimeMs: null,
    kinIds: [],
    kinNames: [],
    auntieDisplayName: null,
    auntieAvatarUrl: null,
    notes: null,
    requestedByUid: null,
    createdAtMs: null,
    updatedAtMs: null,
    visitProgress: null,
    sourceBookingId: null,
    sessionId: null,
    cancelRequested: false,
    cancelRequestStatus: null,
    cancelRequestReason: null,
    cancelResponseNote: null,
    rescheduleRequestStatus: null,
    rescheduleRequestedStartTimeMs: null,
    rescheduleRequestedEndTimeMs: null,
    rescheduleRequestReason: null,
    rescheduleResponseNote: null,
    address: null,
    kinTaleId: null,
    invoiceId: null,
    startTimePending: false,
    requestedDate: null,
    timeBlockLabel: null,
    timeBlockStartTime: null,
    timeBlockEndTime: null,
    ...overrides,
  };
}

function bookingsResult(overrides: Partial<GetMyBookingsResult> = {}): GetMyBookingsResult {
  return { liveVisit: null, upcoming: [], recent: [], envelopes: [], ...overrides };
}

describe('findBookingById', () => {
  it('finds a match in upcoming', () => {
    const result = bookingsResult({ upcoming: [booking({ id: 'a' }), booking({ id: 'b' })] });
    expect(findBookingById(result, 'b')?.id).toBe('b');
  });

  it('finds a match in recent', () => {
    const result = bookingsResult({ recent: [booking({ id: 'past-1' })] });
    expect(findBookingById(result, 'past-1')?.id).toBe('past-1');
  });

  it('finds the live visit', () => {
    const result = bookingsResult({ liveVisit: booking({ id: 'live-1' }) });
    expect(findBookingById(result, 'live-1')?.id).toBe('live-1');
  });

  it('returns null when nothing matches, or the result is not loaded yet', () => {
    expect(findBookingById(bookingsResult({ upcoming: [booking({ id: 'a' })] }), 'missing')).toBeNull();
    expect(findBookingById(undefined, 'a')).toBeNull();
  });
});

describe('bookingStatusChip', () => {
  it.each([
    ['requested', 'REQUESTED', 'requested'],
    ['confirmed', 'CONFIRMED', 'confirmed'],
    ['enRoute', 'EN ROUTE', 'inprogress'],
    ['active', 'IN PROGRESS', 'inprogress'],
    ['completed', 'COMPLETED', 'completed'],
    ['cancelled', 'CANCELLED', 'cancelled'],
  ] as const)('%s -> %s / %s', (status, label, tone) => {
    expect(bookingStatusChip(status)).toEqual({ label, tone });
  });
});

describe('bookingTimelineIndex', () => {
  it('maps requested/confirmed/completed to their own step', () => {
    expect(bookingTimelineIndex('requested')).toBe(0);
    expect(bookingTimelineIndex('confirmed')).toBe(1);
    expect(bookingTimelineIndex('completed')).toBe(4);
  });

  it('gives enRoute and active their own timeline steps', () => {
    expect(bookingTimelineIndex('enRoute')).toBe(2);
    expect(bookingTimelineIndex('active')).toBe(3);
    expect(BOOKING_TIMELINE_STEPS[2]).toEqual({ id: 'enRoute', label: 'En route' });
    expect(BOOKING_TIMELINE_STEPS[3]).toEqual({ id: 'active', label: 'In progress' });
  });

  it('walks the five real non-cancelled statuses in backend order', () => {
    expect(bookingTimelineIndex('requested')).toBe(0);
    expect(bookingTimelineIndex('confirmed')).toBe(1);
    expect(bookingTimelineIndex('completed')).toBe(4);
    expect(BOOKING_TIMELINE_STEPS).toHaveLength(5);
  });

  it('cancelled has no timeline position', () => {
    expect(bookingTimelineIndex('cancelled')).toBeNull();
  });

  it('every non-null index is a valid BOOKING_TIMELINE_STEPS index', () => {
    for (const status of ['requested', 'confirmed', 'enRoute', 'active', 'completed'] as const) {
      const index = bookingTimelineIndex(status);
      expect(index).not.toBeNull();
      expect(BOOKING_TIMELINE_STEPS[index as number]).toBeDefined();
    }
  });
});

/**
 * #1098: a night-only visit (the overnight) has no start time until the Auntie
 * sets one on approval. It is shown on the night the household asked for, read
 * as a LOCAL date, and never as midnight, "Invalid Date" or "Time to be
 * confirmed".
 */
describe('a visit whose start time the Auntie sets (#1098)', () => {
  const pending = booking({ startTimeMs: null, startTimePending: true, requestedDate: '2026-10-09' });
  it('tiles on the requested night, read as a local calendar date', () => {
    expect(visitTile(pending)).toEqual({ month: 'Oct', day: '09' });
  });
  it('says the Auntie sets the start time, on its own night', () => {
    expect(visitWhenLine(pending)).toBe('Fri night · Start time set by your Auntie');
    expect(bookingSubtitle(pending)).toBe('Fri night · Start time set by your Auntie');
    expect(bookingSubtitle({ ...pending, auntieDisplayName: 'Maya' })).toBe('Fri night · Start time set by your Auntie');
  });
  it('still says who sets it when the night cannot be read', () => {
    const noDate = booking({ startTimeMs: null, startTimePending: true, requestedDate: null });
    expect(bookingSubtitle(noDate)).toBe('Start time set by your Auntie');
    expect(visitTile(noDate)).toEqual({ month: '—', day: '—' });
    expect(bookingSubtitle({ ...noDate, requestedDate: 'not-a-date' })).toBe('Start time set by your Auntie');
  });
  it('leaves a timed visit, and a visit from an older server, as they were', () => {
    const timed = booking({ startTimeMs: new Date(2026, 5, 1, 8, 0).getTime(), auntieDisplayName: 'Maya' });
    expect(bookingSubtitle(timed)).toBe('Mon, 8:00 AM with Auntie Maya');
    expect(visitWhenLine(timed)).toBe('Mon, 8:00 AM');
    expect(visitTile(timed)).toEqual({ month: 'Jun', day: '01' });
    const older = { ...booking(), startTimePending: undefined, requestedDate: undefined } as unknown as GetMyBookingsResultLiveVisit;
    expect(bookingSubtitle(older)).toBe('Time to be confirmed');
    expect(visitWhenLine(older)).toBe('Time to be confirmed');
  });
});

describe('block-booked visits (#1301)', () => {
  const ms = new Date(2026, 5, 7, 11, 0).getTime(); // a Sunday, the window's anchor
  it('names the window, never the anchor clock', () => {
    const b = { timeBlockLabel: 'Midday', timeBlockStartTime: '11:00', timeBlockEndTime: '15:00' };
    expect(visitSubtitle(ms, null, b)).toBe('Sun, Midday (11 AM to 3 PM)');
    expect(visitSubtitle(ms, 'Maya', b)).toBe('Sun, Midday (11 AM to 3 PM) with Auntie Maya');
    expect(visitBlockText(b)).toBe('Midday (11 AM to 3 PM)');
  });
  it('falls back to the stored label when the window has been removed', () => {
    expect(visitBlockText({ timeBlockLabel: 'Midday', timeBlockStartTime: null, timeBlockEndTime: null })).toBe('Midday');
  });
  it('leaves a clock visit alone', () => {
    expect(visitSubtitle(ms, null, { timeBlockLabel: null })).toBe('Sun, 11:00 AM');
    expect(visitBlockText({})).toBeNull();
  });
});
