import { describe, it, expect } from 'vitest';
import {
  findTimeBlock,
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
});

describe('businessTimeZone', () => {
  it('reads and trims the field, and never throws on a document without one', () => {
    expect(businessTimeZone({ timeZone: ' America/Chicago ' })).toBe('America/Chicago');
    expect(businessTimeZone({})).toBe('');
    expect(businessTimeZone(null)).toBe('');
    expect(businessTimeZone({ timeZone: 42 })).toBe('');
  });
});
