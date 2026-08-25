import { describe, it, expect } from 'vitest';
import {
  businessCalendarDate,
  containmentIsInert,
  findTimeBlock,
  formatDayBoundaryHHmm,
  formatHHmm,
  parseDayBoundaryHHmm,
  parseHHmm,
  parseTimeBlockRow,
  resolveBookingPolicy,
  visitMatchesBlock,
  businessTimeZone,
} from '../src/lib/bookingTimeBlocks';

/**
 * Time-block booking, decoder half. Operator requirement 2026-08-24: kinfolk
 * book inside named windows, so these are the rules that decide which windows
 * exist and what a client is allowed to be offered.
 *
 * The row parser is tested against the shapes that actually reach it, not the
 * shape the type claims: `auntieos-admin/src/api/settings.ts` types every
 * string on `TimeBlockDefinition` as optional BECAUSE nothing validates the
 * stored rows, and its own comment says a legacy `{ id }` row "throws on the
 * first `.trim()`". That row has a test here.
 */
describe('parseTimeBlockRow', () => {
  const FOUR_HOURS = 240;

  it('reads a complete row', () => {
    expect(
      parseTimeBlockRow({ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }, FOUR_HOURS),
    ).toEqual({ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', durationMinutes: 240 });
  });

  it('does NOT throw on the legacy id-only row, it drops it', () => {
    expect(() => parseTimeBlockRow({ id: 'midday' }, FOUR_HOURS)).not.toThrow();
    // No readable start: there is nothing to guess a window from, so the row is
    // dropped rather than invented.
    expect(parseTimeBlockRow({ id: 'midday' }, FOUR_HOURS)).toBeNull();
  });

  it('never throws on junk of any shape', () => {
    for (const junk of [null, undefined, 'midday', 42, [], {}, { id: '' }, { id: 3, startTime: '11:00' }]) {
      expect(() => parseTimeBlockRow(junk, FOUR_HOURS)).not.toThrow();
      expect(parseTimeBlockRow(junk, FOUR_HOURS)).toBeNull();
    }
  });

  it('takes the end from defaultTimeBlockDurationHours when the row has no readable end', () => {
    expect(parseTimeBlockRow({ id: 'evening', startTime: '17:00' }, FOUR_HOURS)).toEqual({
      id: 'evening',
      label: 'Evening',
      startTime: '17:00',
      endTime: '21:00',
      durationMinutes: 240,
    });
    // Same recovery when the stored end is unusable rather than absent.
    expect(parseTimeBlockRow({ id: 'evening', startTime: '17:00', endTime: 'nonsense' }, 120)?.endTime).toBe('19:00');
    // ...and when it is BEFORE the start, which is not a window at all.
    expect(parseTimeBlockRow({ id: 'evening', startTime: '17:00', endTime: '09:00' }, 120)?.endTime).toBe('19:00');
  });

  it('names an unlabelled row from its id rather than offering a blank button', () => {
    expect(parseTimeBlockRow({ id: 'late-afternoon', startTime: '15:00', endTime: '18:00' }, FOUR_HOURS)?.label).toBe(
      'Late Afternoon',
    );
  });

  it('drops a row only when active is explicitly false', () => {
    expect(parseTimeBlockRow({ id: 'a', startTime: '08:00', endTime: '10:00', active: false }, FOUR_HOURS)).toBeNull();
    // Key absent = active. Every row the admin defaults write carries it, so an
    // absent key is a legacy row, not a deactivation.
    expect(parseTimeBlockRow({ id: 'a', startTime: '08:00', endTime: '10:00' }, FOUR_HOURS)).not.toBeNull();
  });

  it('normalises HH:MM padding', () => {
    expect(parseTimeBlockRow({ id: 'a', startTime: '8:05', endTime: '9:00' }, FOUR_HOURS)?.startTime).toBe('08:05');
  });

  /**
   * #596: the block that broke containment. The default duration is 4 hours, so
   * ANY start at or after 20:00 with no stored end lands on the end of the day —
   * and an operator typing 24:00 as an end time gets there directly. The row
   * must survive, keep its full window, and the times it comes out with must be
   * readable (see the round-trip property below).
   */
  it('keeps a window that runs to the end of the day, and its times still parse', () => {
    const fromDefault = parseTimeBlockRow({ id: 'evening', startTime: '20:00' }, FOUR_HOURS);
    expect(fromDefault).toEqual({
      id: 'evening',
      label: 'Evening',
      startTime: '20:00',
      endTime: '24:00',
      durationMinutes: 240,
    });
    expect(parseHHmm(fromDefault!.startTime)).toBe(1200);
    expect(parseDayBoundaryHHmm(fromDefault!.endTime)).toBe(1440);

    // Same window, stated outright by the operator rather than defaulted.
    expect(parseTimeBlockRow({ id: 'evening', startTime: '20:00', endTime: '24:00' }, 60)?.endTime).toBe('24:00');
  });

  it('never runs a window PAST the end of the day, however large the default duration', () => {
    const late = parseTimeBlockRow({ id: 'late', startTime: '23:00' }, 600);
    expect(late?.endTime).toBe('24:00');
    expect(late?.durationMinutes).toBe(60);
  });

  it('refuses a start of 24:00, which is a boundary rather than a time a block can open at', () => {
    expect(parseTimeBlockRow({ id: 'nope', startTime: '24:00', endTime: '24:00' }, FOUR_HOURS)).toBeNull();
  });
});

describe('parseHHmm', () => {
  it('accepts a real time and rejects everything else', () => {
    expect(parseHHmm('11:00')).toBe(660);
    expect(parseHHmm('8:05')).toBe(485);
    expect(parseHHmm('00:00')).toBe(0);
    expect(parseHHmm('23:59')).toBe(1439);
    for (const bad of ['24:00', '11:60', '11', '', '  ', 'abc', null, undefined, 1100, {}]) {
      expect(parseHHmm(bad)).toBeNull();
    }
  });
});

describe('parseDayBoundaryHHmm', () => {
  it('accepts everything parseHHmm does, plus the exclusive end-of-day boundary', () => {
    expect(parseDayBoundaryHHmm('11:00')).toBe(660);
    expect(parseDayBoundaryHHmm('00:00')).toBe(0);
    expect(parseDayBoundaryHHmm('23:59')).toBe(1439);
    // The value #596 turned on: a window running to midnight ENDS at 24:00, and
    // 23:59 would be a different, shorter window.
    expect(parseDayBoundaryHHmm('24:00')).toBe(1440);
    expect(parseDayBoundaryHHmm(' 24:00 ')).toBe(1440);
  });

  it('stops at the boundary — nothing past the end of the day is a boundary either', () => {
    for (const bad of ['24:01', '25:00', '24:60', '11:60', '11', '', 'abc', null, undefined, 1440, {}]) {
      expect(parseDayBoundaryHHmm(bad)).toBeNull();
    }
  });
});

/**
 * #596, THE PROPERTY THAT WOULD HAVE CAUGHT IT.
 *
 * The shipped defect was a formatter emitting a string its own parser rejected:
 * `formatHHmm(1440)` -> "24:00" -> `parseHHmm` -> null. Nothing asserted that
 * the two agreed, so a block ending at midnight failed the server's own parser
 * and containment silently stopped running for it.
 *
 * Every value each formatter can emit must be readable by its parser, and read
 * back as the same number. Exhaustive rather than sampled: the whole domain is
 * 1441 integers, and the one value that broke was an endpoint.
 */
describe('HH:MM round-trip', () => {
  it('formatHHmm -> parseHHmm is lossless for every minute of the day', () => {
    const broken: string[] = [];
    for (let m = 0; m <= 1439; m++) {
      const s = formatHHmm(m);
      if (parseHHmm(s) !== m) broken.push(`${m} -> "${s}" -> ${parseHHmm(s)}`);
    }
    expect(broken).toEqual([]);
  });

  it('formatDayBoundaryHHmm -> parseDayBoundaryHHmm is lossless for every boundary, 24:00 included', () => {
    const broken: string[] = [];
    for (let m = 0; m <= 1440; m++) {
      const s = formatDayBoundaryHHmm(m);
      if (parseDayBoundaryHHmm(s) !== m) broken.push(`${m} -> "${s}" -> ${parseDayBoundaryHHmm(s)}`);
    }
    expect(broken).toEqual([]);
    expect(formatDayBoundaryHHmm(1440)).toBe('24:00');
  });

  it('clamps rather than emitting a string its own parser cannot read', () => {
    // Out-of-range input is clamped INTO the readable range, both ways, so the
    // property above holds for every argument either formatter can be handed.
    expect(parseHHmm(formatHHmm(99_999))).toBe(1439);
    expect(parseHHmm(formatHHmm(-5))).toBe(0);
    expect(parseDayBoundaryHHmm(formatDayBoundaryHHmm(99_999))).toBe(1440);
    expect(parseDayBoundaryHHmm(formatDayBoundaryHHmm(-5))).toBe(0);
  });
});

/**
 * The normalization matrix. These four switch combinations x "are there usable
 * blocks" are the whole reason this resolver exists: both `getBookingPolicy`
 * and `requestBooking` read it, so a portal cannot be offered a control the
 * write path refuses.
 */
describe('resolveBookingPolicy', () => {
  const BLOCKS = [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }];

  it('defaults, on a document that says nothing: specific time only, no blocks', () => {
    const { policy, degrades } = resolveBookingPolicy({});
    expect(policy.allowSpecificTimeBooking).toBe(true);
    // Both switches default true, but with no configured window block booking
    // cannot be offered — that is the empty-picker rule.
    expect(policy.allowTimeBlockBooking).toBe(false);
    expect(policy.timeBlocks).toEqual([]);
    expect(policy.defaultBookingMode).toBe('SPECIFIC_TIME');
    expect(degrades).toContain('no-usable-blocks');
  });

  it('both allowed, blocks present: both modes, default honoured', () => {
    const { policy, degrades } = resolveBookingPolicy({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: true,
      defaultBookingMode: 'TIME_BLOCK',
      timeBlocks: BLOCKS,
    });
    expect(policy).toMatchObject({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: true,
      defaultBookingMode: 'TIME_BLOCK',
    });
    expect(policy.timeBlocks).toHaveLength(1);
    expect(degrades).toEqual([]);
  });

  it('block only: specific time is off and the default is forced onto the allowed mode', () => {
    const { policy, degrades } = resolveBookingPolicy({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: false,
      defaultBookingMode: 'SPECIFIC_TIME',
      timeBlocks: BLOCKS,
    });
    expect(policy.allowSpecificTimeBooking).toBe(false);
    expect(policy.allowTimeBlockBooking).toBe(true);
    expect(policy.defaultBookingMode).toBe('TIME_BLOCK');
    expect(degrades).toEqual(['default-mode-unavailable']);
  });

  it('specific only: blocks are not served even when rows exist', () => {
    const { policy } = resolveBookingPolicy({
      allowTimeBlockBooking: false,
      allowSpecificTimeBooking: true,
      timeBlocks: BLOCKS,
    });
    expect(policy.allowTimeBlockBooking).toBe(false);
    // Empty iff block booking is off, so an allowed mode always has something
    // to offer and no client has to reconcile the two.
    expect(policy.timeBlocks).toEqual([]);
  });

  it('NEITHER switch on: falls back to specific time rather than a dead wizard', () => {
    const { policy, degrades } = resolveBookingPolicy({
      allowTimeBlockBooking: false,
      allowSpecificTimeBooking: false,
      defaultBookingMode: 'TIME_BLOCK',
      timeBlocks: BLOCKS,
    });
    expect(policy.allowSpecificTimeBooking).toBe(true);
    expect(policy.allowTimeBlockBooking).toBe(false);
    expect(policy.defaultBookingMode).toBe('SPECIFIC_TIME');
    expect(degrades).toEqual(['no-mode-allowed', 'default-mode-unavailable']);
  });

  it('block booking on with only unreadable rows degrades to specific time, never an empty picker', () => {
    const { policy, degrades } = resolveBookingPolicy({
      allowTimeBlockBooking: true,
      allowSpecificTimeBooking: false,
      defaultBookingMode: 'TIME_BLOCK',
      // The exact legacy row the admin comment warns about, plus junk.
      timeBlocks: [{ id: 'midday' }, null, 'nope', { startTime: '11:00' }],
    });
    expect(policy.allowTimeBlockBooking).toBe(false);
    expect(policy.allowSpecificTimeBooking).toBe(true);
    expect(policy.defaultBookingMode).toBe('SPECIFIC_TIME');
    expect(degrades).toEqual(['no-usable-blocks', 'no-mode-allowed', 'default-mode-unavailable']);
  });

  it('keeps the readable rows out of a mixed list, in start order', () => {
    const { policy } = resolveBookingPolicy({
      allowTimeBlockBooking: true,
      timeBlocks: [
        { id: 'evening', label: 'Evening', startTime: '17:00', endTime: '21:00', active: true },
        { id: 'broken' },
        { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '11:00', active: true },
        { id: 'off', label: 'Off', startTime: '05:00', endTime: '06:00', active: false },
      ],
    });
    expect(policy.timeBlocks.map((b) => b.id)).toEqual(['morning', 'evening']);
  });

  it('an unknown defaultBookingMode string reads as SPECIFIC_TIME, not as a third mode', () => {
    const { policy } = resolveBookingPolicy({ defaultBookingMode: 'garbage', allowSpecificTimeBooking: true });
    expect(policy.defaultBookingMode).toBe('SPECIFIC_TIME');
  });

  it('never throws on a document of the wrong shape entirely', () => {
    for (const junk of [null, undefined, 'settings', 7, []]) {
      expect(() => resolveBookingPolicy(junk)).not.toThrow();
    }
  });
});

describe('findTimeBlock', () => {
  const { policy } = resolveBookingPolicy({
    allowTimeBlockBooking: true,
    timeBlocks: [{ id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true }],
  });

  it('finds by id and refuses anything else', () => {
    expect(findTimeBlock(policy, 'midday')?.label).toBe('Midday');
    expect(findTimeBlock(policy, ' midday ')?.label).toBe('Midday');
    expect(findTimeBlock(policy, 'Midday')).toBeNull();
    expect(findTimeBlock(policy, 'evening')).toBeNull();
  });
});

/**
 * Containment on the BUSINESS's wall clock, start-inclusive / end-exclusive —
 * the same semantics `auntieos-admin`'s `resolveTimeBlock` uses to label a
 * session, so the validator accepts exactly the set the admin app will label.
 */
describe('visitMatchesBlock', () => {
  const MIDDAY = { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', durationMinutes: 240 };
  const TZ = 'America/Chicago';
  /** 2026-09-04 is CDT (UTC-5), so 16:00Z is 11:00 local — the window's first minute. */
  const at = (utcHour: number, minute = 0) => Date.parse(`2026-09-04T${String(utcHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);

  it('accepts the first minute and the middle of the window', () => {
    expect(visitMatchesBlock(at(16), MIDDAY, TZ)).toBe('inside');
    expect(visitMatchesBlock(at(18, 30), MIDDAY, TZ)).toBe('inside');
  });

  it('refuses the closing minute (end is exclusive) and anything after it', () => {
    expect(visitMatchesBlock(at(20), MIDDAY, TZ)).toBe('outside'); // 15:00 local
    expect(visitMatchesBlock(at(21), MIDDAY, TZ)).toBe('outside'); // 16:00 local
  });

  it('refuses a time before the window opens', () => {
    expect(visitMatchesBlock(at(15, 59), MIDDAY, TZ)).toBe('outside'); // 10:59 local
  });

  it('reads the BUSINESS zone, not UTC', () => {
    // 11:00 UTC is 06:00 in Chicago: inside the window only if the zone is ignored.
    expect(visitMatchesBlock(at(11), MIDDAY, TZ)).toBe('outside');
    expect(visitMatchesBlock(at(11), MIDDAY, 'UTC')).toBe('inside');
  });

  it('says "cannot tell" rather than "no" when the stored zone is unusable', () => {
    expect(visitMatchesBlock(at(16), MIDDAY, '')).toBe('zone-unusable');
    expect(visitMatchesBlock(at(16), MIDDAY, 'Mars/Olympus_Mons')).toBe('zone-unusable');
  });

  /**
   * #596: a block ending at midnight used to fail the server's own parser and
   * come back `zone-unusable`, which `assertVisitBookingMode` lets through — so
   * for that block, "a client cannot send an arbitrary time under a block's
   * name" simply did not run. It runs now, and both ends of the window answer.
   */
  describe('a block that runs to the end of the day', () => {
    const EVENING = { id: 'evening', label: 'Evening', startTime: '20:00', endTime: '24:00', durationMinutes: 240 };

    it('answers, instead of reporting the zone as unusable', () => {
      expect(visitMatchesBlock(at(1, 0), EVENING, TZ)).toBe('inside'); // 20:00 local, the first minute
      expect(visitMatchesBlock(at(4, 59), EVENING, TZ)).toBe('inside'); // 23:59 local, the last
      expect(visitMatchesBlock(at(17), EVENING, TZ)).toBe('outside'); // 12:00 local: the #596 case
      expect(visitMatchesBlock(at(0, 59), EVENING, TZ)).toBe('outside'); // 19:59 local
    });

    it('still fails open on an unusable ZONE, which is a different thing entirely', () => {
      expect(visitMatchesBlock(at(17), EVENING, '')).toBe('zone-unusable');
    });
  });

  /**
   * The split #596 asked for. An unreadable ZONE is missing configuration and
   * fails open; an unreadable BLOCK is a bug in code that generated those two
   * strings itself, and must never wear the same "cannot tell" answer.
   */
  it('names an unreadable BLOCK separately, and does so even when the zone is unusable too', () => {
    const broken = { id: 'x', label: 'X', startTime: 'nonsense', endTime: '15:00', durationMinutes: 0 };
    const brokenEnd = { id: 'x', label: 'X', startTime: '11:00', endTime: '25:00', durationMinutes: 0 };
    const inverted = { id: 'x', label: 'X', startTime: '15:00', endTime: '11:00', durationMinutes: 0 };
    expect(visitMatchesBlock(at(16), broken, TZ)).toBe('block-unreadable');
    expect(visitMatchesBlock(at(16), brokenEnd, TZ)).toBe('block-unreadable');
    expect(visitMatchesBlock(at(16), inverted, TZ)).toBe('block-unreadable');
    // Zone ALSO unusable: the server-side defect still wins, because it is the
    // one we can answer for.
    expect(visitMatchesBlock(at(16), broken, '')).toBe('block-unreadable');
  });
});

/**
 * #597: the identity of a block-mode visit is (date, KinCare, block), and the
 * date is the BUSINESS's — every visit in a window carries that window's first
 * minute, so the instant is approximate by design and only the business's day
 * boundary can say whether two of them are the same day.
 */
describe('businessCalendarDate', () => {
  it('reads the business day, not UTC and not the device', () => {
    // 2026-09-05T02:00Z is still 2026-09-04 in Chicago.
    const lateEvening = Date.parse('2026-09-05T02:00:00.000Z');
    expect(businessCalendarDate(lateEvening, 'America/Chicago')).toBe('2026-09-04');
    expect(businessCalendarDate(lateEvening, 'UTC')).toBe('2026-09-05');
  });

  it('falls back to the UTC date when the zone is unusable, rather than giving up on keying', () => {
    const t = Date.parse('2026-09-04T16:00:00.000Z');
    expect(businessCalendarDate(t, '')).toBe('2026-09-04');
    expect(businessCalendarDate(t, 'Mars/Olympus_Mons')).toBe('2026-09-04');
    // The refusal that must survive any fallback: the same instant always keys
    // the same, whatever the zone is.
    expect(businessCalendarDate(t, '')).toBe(businessCalendarDate(t, ''));
  });

  it('never throws on an instant that is not a number', () => {
    expect(businessCalendarDate(Number.NaN, 'UTC')).toBe('unknown-date');
    expect(businessCalendarDate(Number.POSITIVE_INFINITY, '')).toBe('unknown-date');
  });
});

/**
 * #596, the wider half. Fail-open on an unreadable zone stays; being SILENT
 * about it does not. A business taking block bookings with no usable timezone
 * has containment switched off for every block, and that is an enforcement
 * control not running.
 */
describe('containmentIsInert', () => {
  const withBlocks = resolveBookingPolicy({
    allowTimeBlockBooking: true,
    timeBlocks: [{ id: 'midday', startTime: '11:00', endTime: '15:00', active: true }],
  }).policy;

  it('is true when a block-booking business has no usable zone', () => {
    expect(containmentIsInert(withBlocks, '')).toBe(true);
    expect(containmentIsInert(withBlocks, '   ')).toBe(true);
    expect(containmentIsInert(withBlocks, 'Mars/Olympus_Mons')).toBe(true);
  });

  it('is false once the zone is readable', () => {
    expect(containmentIsInert(withBlocks, 'America/Chicago')).toBe(false);
    expect(containmentIsInert(withBlocks, 'UTC')).toBe(false);
  });

  it('is false for a business that takes no block bookings — it has no containment to lose', () => {
    const clockOnly = resolveBookingPolicy({ allowTimeBlockBooking: false }).policy;
    expect(containmentIsInert(clockOnly, '')).toBe(false);
  });
});

describe('businessTimeZone', () => {
  it('reads and trims the field, and never throws on a document without one', () => {
    expect(businessTimeZone({ timeZone: ' America/Chicago ' })).toBe('America/Chicago');
    expect(businessTimeZone({})).toBe('');
    expect(businessTimeZone(null)).toBe('');
    expect(businessTimeZone({ timeZone: 42 })).toBe('');
  });
});
