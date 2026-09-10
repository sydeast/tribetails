import { describe, it, expect } from 'vitest';
import type { Timestamp } from 'firebase/firestore';
import {
  bookingMetaLine,
  bookingServiceName,
  bookingSortTimeMs,
  bookingState,
  bookingStateInfo,
  bookingWhen,
  formatLocalDateTime,
  initialsFor,
  parseFlexibleDate,
  EMPTY_BOOKING_CATALOG,
  type BookingCatalog,
  type BookingStateInput,
  type BookingWhenInput,
} from './bookingFormat';

function fakeTs(iso: string): Timestamp {
  const ms = new Date(iso).getTime();
  return { toDate: () => new Date(iso), toMillis: () => ms } as unknown as Timestamp;
}

function statusRow(status: string): BookingStateInput {
  return { status };
}

function whenRow(over: Partial<BookingWhenInput>): BookingWhenInput {
  return { startTime: '', completedAt: '', departedAt: '', createdAt: null, ...over };
}

describe('bookingState (enumerated, never derived by negation)', () => {
  it('reads the five recognized statuses directly, case-insensitively and trimmed', () => {
    expect(bookingState(statusRow('DRAFT'))).toBe('draft');
    expect(bookingState(statusRow(' pending '))).toBe('pending');
    expect(bookingState(statusRow('Scheduled'))).toBe('scheduled');
    expect(bookingState(statusRow('completed'))).toBe('completed');
    expect(bookingState(statusRow('cancelled'))).toBe('cancelled');
  });

  it('folds CANCELLED / CANCELED / REJECTED into one cancelled bucket, per BookingScreen.kt', () => {
    expect(bookingState(statusRow('CANCELLED'))).toBe('cancelled');
    expect(bookingState(statusRow('CANCELED'))).toBe('cancelled');
    expect(bookingState(statusRow('REJECTED'))).toBe('cancelled');
  });

  it('an unrecognized or blank status lands in its own named "unknown" bucket, never silently absorbed into another state', () => {
    expect(bookingState(statusRow(''))).toBe('unknown');
    expect(bookingState(statusRow('SOMETHING_ELSE'))).toBe('unknown');
  });
});

describe('bookingStateInfo', () => {
  it.each([
    ['draft', 'Draft', 'DRAFT', 'draft'],
    ['pending', 'Pending', 'PENDING', 'pending'],
    ['scheduled', 'Scheduled', 'SCHEDULED', 'scheduled'],
    ['completed', 'Completed', 'COMPLETED', 'completed'],
    ['cancelled', 'Cancelled', 'CANCELLED', 'cancelled'],
    ['unknown', 'Unknown', 'UNKNOWN', 'unknown'],
  ] as const)('%s -> label %s / chip %s / css %s', (state, label, chipLabel, cssClass) => {
    expect(bookingStateInfo(state)).toEqual({ label, chipLabel, cssClass });
  });
});

describe('initialsFor', () => {
  it('two-word name -> first letter of each', () => {
    expect(initialsFor('John Smith')).toBe('JS');
  });
  it('one-word name -> first two letters', () => {
    expect(initialsFor('Cher')).toBe('CH');
  });
  it('blank name -> "?"', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
  });
  it('three-word name uses first and LAST word, not the middle', () => {
    expect(initialsFor('Mary Jane Watson')).toBe('MW');
  });
});

describe('parseFlexibleDate', () => {
  it('parses a real UTC-instant string (Date#toISOString shape)', () => {
    expect(parseFlexibleDate('2026-07-16T14:00:00.000Z')).not.toBeNull();
  });
  it('parses a local-wall-clock string with no timezone designator', () => {
    expect(parseFlexibleDate('2026-07-16T09:00:00')).not.toBeNull();
  });
  it('returns null for blank or unparseable text, never fabricating a date', () => {
    expect(parseFlexibleDate('')).toBeNull();
    expect(parseFlexibleDate('   ')).toBeNull();
    expect(parseFlexibleDate('not a date')).toBeNull();
  });

  // THE LIVE FORMAT. 83 of 92 kin_care_reports and 14 kin_care_session date
  // strings are written this way, and `new Date()` rejects ALL of them, because
  // the meridiem is lowercase and unspaced ("2:02pm", not "2:02 PM"). Every one
  // of those rows rendered "Date TBD" while the data was sitting right there.
  describe('the human-written format the migration actually produced', () => {
    it.each([
      'September 3, 2025 2:02pm',
      'April 3, 2026 11:26pm',
      'March 31, 2026 10:16am',
      'August 6, 2025 6:38pm',
    ])('parses %s', (raw) => {
      expect(parseFlexibleDate(raw)).not.toBeNull();
    });

    it('reads the meridiem correctly rather than just accepting the string', () => {
      expect(parseFlexibleDate('September 3, 2025 2:02pm')?.getHours()).toBe(14);
      expect(parseFlexibleDate('March 31, 2026 10:16am')?.getHours()).toBe(10);
      // 12am is midnight and 12pm is noon; the classic off-by-twelve.
      expect(parseFlexibleDate('March 31, 2026 12:00am')?.getHours()).toBe(0);
      expect(parseFlexibleDate('March 31, 2026 12:00pm')?.getHours()).toBe(12);
    });

    it('tolerates spacing and punctuation variants', () => {
      expect(parseFlexibleDate('September 3, 2025 2:02 PM')?.getHours()).toBe(14);
      expect(parseFlexibleDate('September 3, 2025 2:02 p.m.')?.getHours()).toBe(14);
    });

    it('still refuses a bare time with no date, rather than inventing today', () => {
      // `departedAt: "6pm"` exists in kin_care_sessions. A date is NOT knowable
      // from it, and guessing one would fabricate history on a care record.
      expect(parseFlexibleDate('6pm')).toBeNull();
    });
  });
});

describe('formatLocalDateTime', () => {
  it('renders the LOCAL wall-clock date and time, not UTC (does not reproduce AO-18)', () => {
    // A local wall-clock Date built directly from local components: whatever
    // instant this maps to internally, the LOCAL getters must read back 9:05 AM
    // on Jul 16 regardless of the host's UTC offset.
    const d = new Date(2026, 6, 16, 9, 5, 0);
    expect(formatLocalDateTime(d)).toBe('Jul 16, 9:05 AM');
  });

  it('formats a midnight and a noon boundary correctly (12 AM / 12 PM, not 0)', () => {
    expect(formatLocalDateTime(new Date(2026, 0, 1, 0, 0, 0))).toBe('Jan 1, 12:00 AM');
    expect(formatLocalDateTime(new Date(2026, 0, 1, 12, 0, 0))).toBe('Jan 1, 12:00 PM');
  });
});

describe('bookingWhen', () => {
  it('prefers startTime when present', () => {
    expect(bookingWhen(whenRow({ startTime: '2026-07-16T09:00:00' }))).toBe('Jul 16, 9:00 AM');
  });

  it('falls back to completedAt when startTime is blank (legacy/imported session)', () => {
    expect(bookingWhen(whenRow({ startTime: '', completedAt: '2026-07-10T17:30:00' }))).toBe(
      'Jul 10, 5:30 PM',
    );
  });

  it('falls back to departedAt when startTime and completedAt are both blank', () => {
    expect(bookingWhen(whenRow({ departedAt: '2026-07-11T08:15:00' }))).toBe('Jul 11, 8:15 AM');
  });

  it('shows unparseable free text verbatim rather than hiding it (fail-loud)', () => {
    expect(bookingWhen(whenRow({ startTime: 'Net 14' }))).toBe('Net 14');
  });

  it('falls back to the real createdAt Timestamp only once every string field is blank', () => {
    expect(bookingWhen(whenRow({ createdAt: fakeTs('2026-07-01T12:00:00Z') }))).not.toBe('Date pending');
  });

  it('says "Date pending" honestly when nothing on the doc is usable, never fabricating a date', () => {
    expect(bookingWhen(whenRow({}))).toBe('Date pending');
  });
});

describe('bookingSortTimeMs (#699)', () => {
  it('sorts by the visit startTime, the same field bookingWhen displays', () => {
    const ms = bookingSortTimeMs(whenRow({ startTime: '2026-07-16T09:00:00' }));
    expect(ms).toBe(new Date('2026-07-16T09:00:00').getTime());
  });

  it('walks the same fallback chain as bookingWhen: completedAt, then departedAt', () => {
    expect(bookingSortTimeMs(whenRow({ completedAt: '2026-07-10T17:30:00' }))).toBe(
      new Date('2026-07-10T17:30:00').getTime(),
    );
    expect(bookingSortTimeMs(whenRow({ departedAt: '2026-07-11T08:15:00' }))).toBe(
      new Date('2026-07-11T08:15:00').getTime(),
    );
  });

  it('falls back to the real createdAt Timestamp once every string field is blank', () => {
    expect(bookingSortTimeMs(whenRow({ createdAt: fakeTs('2026-07-01T12:00:00Z') }))).toBe(
      new Date('2026-07-01T12:00:00Z').getTime(),
    );
  });

  it('returns null, never 1970 or "now", when nothing on the row is usable', () => {
    expect(bookingSortTimeMs(whenRow({}))).toBeNull();
  });

  it('returns null rather than a fabricated instant for unparseable free text', () => {
    expect(bookingSortTimeMs(whenRow({ startTime: 'Net 14' }))).toBeNull();
  });
});

/**
 * #704: the raw `serviceType` spellings the live collection actually holds,
 * and the one line the Bookings card builds out of them.
 *
 * The four shapes are the ones named on the walk: `visit_60`, `60Mins`,
 * `30 Minute` and `30Minute` sat side by side across thirteen rows for two
 * services. The catalog below is the operator's own `serviceRates` shape (keys
 * ARE the ids the booking wizard sends, prices as strings).
 */
const CATALOG: BookingCatalog = {
  serviceRates: { '30Minute': '25', '60Minute': '45' },
  serviceDurations: {},
  timeBlocks: [
    { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '11:00', active: true },
    { id: 'evening', label: 'Evening block', startTime: '17:00', endTime: '21:00', active: true },
    { id: 'seasonal', label: 'Seasonal', startTime: '11:00', endTime: '13:00', active: false },
  ],
};

describe('bookingServiceName', () => {
  it('resolves all four raw label shapes to the configured KinCare name', () => {
    // Exact key, and the same key spelled with a space: matched on letters and
    // digits alone.
    expect(bookingServiceName('30Minute', CATALOG)).toBe('30Minute');
    expect(bookingServiceName('30 Minute', CATALOG)).toBe('30Minute');
    // Neither of these IS a catalog key. Both state a length, and exactly one
    // configured KinCare runs that long.
    expect(bookingServiceName('60Mins', CATALOG)).toBe('60Minute');
    expect(bookingServiceName('visit_60', CATALOG)).toBe('60Minute');
  });

  it('reads an operator-stated duration in preference to the one in the name', () => {
    const renamed: BookingCatalog = {
      ...CATALOG,
      serviceRates: { 'Drop-in': '20' },
      serviceDurations: { 'Drop-in': '60' },
    };
    expect(bookingServiceName('visit_60', renamed)).toBe('Drop-in');
  });

  it('keeps the raw label rather than guessing when two KinCares run the same length', () => {
    const ambiguous: BookingCatalog = {
      ...CATALOG,
      serviceRates: { '60Minute': '45', '60MinuteOvernight': '90' },
      serviceDurations: { '60MinuteOvernight': '60' },
    };
    expect(bookingServiceName('visit_60', ambiguous)).toBe('visit_60');
  });

  it('keeps the raw label when the catalog has nothing to match it against', () => {
    expect(bookingServiceName('visit_60', EMPTY_BOOKING_CATALOG)).toBe('visit_60');
    expect(bookingServiceName('Dog Walking', CATALOG)).toBe('Dog Walking');
  });

  it('only a genuinely blank service becomes the neutral "Visit"', () => {
    expect(bookingServiceName('', CATALOG)).toBe('Visit');
    expect(bookingServiceName('   ', CATALOG)).toBe('Visit');
    expect(bookingServiceName(undefined, CATALOG)).toBe('Visit');
  });

  it('does not read a trailing number as minutes unless one KinCare runs that long', () => {
    expect(bookingServiceName('Walk 2', CATALOG)).toBe('Walk 2');
  });
});

describe('bookingMetaLine', () => {
  const row = (over: Partial<BookingWhenInput & { serviceType: string }> = {}) => ({
    serviceType: 'visit_60',
    startTime: '2026-05-28T09:30:00',
    completedAt: '',
    departedAt: '',
    createdAt: null,
    ...over,
  });

  it('names the service, the date, and the operator\'s own time block', () => {
    expect(bookingMetaLine(row(), CATALOG)).toBe('60Minute · May 28 · Morning block');
  });

  it('says the clock time when the start falls outside every active block', () => {
    // 12:00 is inside the SEASONAL window, which is switched off, so it resolves
    // to no block at all rather than to a window nothing can be booked into.
    expect(bookingMetaLine(row({ startTime: '2026-05-28T12:00:00' }), CATALOG)).toBe(
      '60Minute · May 28 · 12:00 PM',
    );
  });

  it('does not say "block" twice when the operator already typed it', () => {
    expect(bookingMetaLine(row({ startTime: '2026-05-28T18:00:00' }), CATALOG)).toBe(
      '60Minute · May 28 · Evening block',
    );
  });

  it('prints an unparseable stored stamp verbatim, with no empty third segment', () => {
    expect(bookingMetaLine(row({ startTime: 'Net 14' }), CATALOG)).toBe('60Minute · Net 14');
  });

  it('says "Date pending" rather than inventing one when the row carries no time at all', () => {
    expect(bookingMetaLine(row({ startTime: '' }), CATALOG)).toBe('60Minute · Date pending');
  });

  it('falls through startTime to completedAt to departedAt, the chain bookingWhen walks', () => {
    expect(
      bookingMetaLine(row({ startTime: '', completedAt: '2026-05-25T09:00:00' }), CATALOG),
    ).toBe('60Minute · May 25 · Morning block');
    expect(
      bookingMetaLine(row({ startTime: '', departedAt: '2026-05-24T09:00:00' }), CATALOG),
    ).toBe('60Minute · May 24 · Morning block');
  });

  it('degrades to the raw label and the clock time on an empty catalog, never to a blank', () => {
    expect(bookingMetaLine(row(), EMPTY_BOOKING_CATALOG)).toBe('visit_60 · May 28 · 9:30 AM');
  });
});
