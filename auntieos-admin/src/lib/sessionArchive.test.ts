import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  archiveDefaultRange,
  archiveFetchBounds,
  archiveInstantRange,
  archiveRows,
  groupArchiveByBusinessDay,
  isInArchiveRange,
} from './sessionArchive';
import { sessionPhase, shiftDayIso } from './sessionFormat';
import { businessWallClockToMs } from './businessZoneTime';
import { BOOKING_CATALOG_KEY } from './useBookingCatalog';
import { BUSINESS_SETTINGS_SHARED_KEY } from './useBusinessZone';

/**
 * #2036. Every case names the zone, and the file runs with the DEVICE on UTC,
 * the setting in which the old UTC-midnight cut and a correct business-day cut
 * differ most. A pass here cannot be the device zone happening to match.
 */
const CHICAGO = 'America/Chicago';
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
});
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

/** A business wall clock as the UTC instant string a server writer stamps. */
function instant(day: string, hhmm: string, zone = CHICAGO): string {
  const ms = businessWallClockToMs(day, hhmm, zone);
  if (ms === null) throw new Error(`unreadable ${day} ${hhmm}`);
  return new Date(ms).toISOString();
}

describe('the picked days as instants', () => {
  it('runs from the business midnight of FROM to the business midnight after TO', () => {
    // Nov 10 and 11, 2026 are both on standard time: UTC-6.
    expect(archiveInstantRange({ from: '2026-11-10', to: '2026-11-11' }, CHICAGO)).toEqual({
      startMs: Date.parse('2026-11-10T06:00:00.000Z'),
      endMs: Date.parse('2026-11-12T06:00:00.000Z'),
    });
  });

  it('keeps the 23 hour day of the spring clock change whole', () => {
    const r = archiveInstantRange({ from: '2026-03-08', to: '2026-03-08' }, CHICAGO);
    expect(r).toEqual({
      startMs: Date.parse('2026-03-08T06:00:00.000Z'),
      endMs: Date.parse('2026-03-09T05:00:00.000Z'),
    });
    expect((r!.endMs - r!.startMs) / 3_600_000).toBe(23);
  });

  it('keeps the 25 hour day of the autumn clock change whole', () => {
    const r = archiveInstantRange({ from: '2026-11-01', to: '2026-11-01' }, CHICAGO);
    expect(r).toEqual({
      startMs: Date.parse('2026-11-01T05:00:00.000Z'),
      endMs: Date.parse('2026-11-02T06:00:00.000Z'),
    });
    expect((r!.endMs - r!.startMs) / 3_600_000).toBe(25);
  });

  it('reads an unusable zone as the server default, never as the device', () => {
    expect(archiveInstantRange({ from: '2026-11-10', to: '2026-11-10' }, 'Not/AZone')).toEqual(
      archiveInstantRange({ from: '2026-11-10', to: '2026-11-10' }, CHICAGO),
    );
  });
});

describe('which visits a FROM and TO pair holds', () => {
  const range = { from: '2026-11-10', to: '2026-11-11' };

  it('includes a 23:30 visit on the TO day, stored as an instant', () => {
    // 23:30 in Chicago is 05:30 UTC the NEXT day, past the old `<= "2026-11-11"`.
    const start = instant('2026-11-11', '23:30');
    expect(start).toBe('2026-11-12T05:30:00.000Z');
    expect(isInArchiveRange(start, range, CHICAGO)).toBe(true);
  });

  it('leaves out a 00:15 visit on the day after TO', () => {
    expect(isInArchiveRange(instant('2026-11-12', '00:15'), range, CHICAGO)).toBe(false);
  });

  it('includes the first minute of the FROM day and leaves out the last minute before it', () => {
    expect(isInArchiveRange(instant('2026-11-10', '00:00'), range, CHICAGO)).toBe(true);
    // 22:32 on Nov 9 is 04:32 UTC on Nov 10: the old `>= "2026-11-10"` took it.
    expect(isInArchiveRange(instant('2026-11-09', '22:32'), range, CHICAGO)).toBe(false);
    expect(isInArchiveRange(instant('2026-11-09', '23:59'), range, CHICAGO)).toBe(false);
  });

  it('reads a zone-less start as the business wall clock it is', () => {
    expect(isInArchiveRange('2026-11-11T23:30', range, CHICAGO)).toBe(true);
    expect(isInArchiveRange('2026-11-11T23:30:00', range, CHICAGO)).toBe(true);
    expect(isInArchiveRange('2026-11-12T00:15', range, CHICAGO)).toBe(false);
    expect(isInArchiveRange('2026-11-09T23:59', range, CHICAGO)).toBe(false);
    expect(isInArchiveRange('2026-11-10T00:00', range, CHICAGO)).toBe(true);
  });

  it('reads a start with an offset as the instant it is', () => {
    // 23:30 Chicago, written with New York's offset.
    expect(isInArchiveRange('2026-11-12T00:30:00-05:00', range, CHICAGO)).toBe(true);
    expect(isInArchiveRange('2026-11-12T01:15:00-05:00', range, CHICAGO)).toBe(false);
  });

  it('holds one whole day when FROM and TO are the same day', () => {
    const day = { from: '2026-11-11', to: '2026-11-11' };
    expect(isInArchiveRange(instant('2026-11-11', '00:00'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-11-11', '13:10'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-11-11', '23:59'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-11-10', '23:59'), day, CHICAGO)).toBe(false);
    expect(isInArchiveRange(instant('2026-11-12', '00:00'), day, CHICAGO)).toBe(false);
  });

  it('counts the day on the business clock for a business east of UTC too', () => {
    const tokyo = 'Asia/Tokyo';
    const day = { from: '2026-11-11', to: '2026-11-11' };
    // 00:30 in Tokyo on Nov 11 is 15:30 UTC on Nov 10.
    expect(isInArchiveRange(instant('2026-11-11', '00:30', tokyo), day, tokyo)).toBe(true);
    expect(isInArchiveRange(instant('2026-11-12', '00:15', tokyo), day, tokyo)).toBe(false);
  });

  it('keeps a start that does not parse by its leading day, and drops one outside the range', () => {
    expect(isInArchiveRange('2026-11-10 around noon', range, CHICAGO)).toBe(true);
    expect(isInArchiveRange('2026-11-13 around noon', range, CHICAGO)).toBe(false);
    expect(isInArchiveRange(undefined, range, CHICAGO)).toBe(false);
  });
});

describe('clock change days', () => {
  it('spring forward: Mar 8 holds 23:30 that night and not 00:15 after it', () => {
    const day = { from: '2026-03-08', to: '2026-03-08' };
    expect(isInArchiveRange(instant('2026-03-08', '23:30'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-03-08', '00:15'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-03-09', '00:15'), day, CHICAGO)).toBe(false);
    expect(isInArchiveRange(instant('2026-03-07', '23:30'), day, CHICAGO)).toBe(false);
  });

  it('fall back: Nov 1 holds 23:30 that night and not 00:15 after it', () => {
    const day = { from: '2026-11-01', to: '2026-11-01' };
    // 23:30 CST on Nov 1 is 05:30 UTC on Nov 2; a fixed 24 hours from the
    // day's start (05:00 UTC) would have stopped at 05:00 and lost it.
    expect(instant('2026-11-01', '23:30')).toBe('2026-11-02T05:30:00.000Z');
    expect(isInArchiveRange(instant('2026-11-01', '23:30'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-11-01', '00:15'), day, CHICAGO)).toBe(true);
    expect(isInArchiveRange(instant('2026-11-02', '00:15'), day, CHICAGO)).toBe(false);
    expect(isInArchiveRange(instant('2026-10-31', '23:30'), day, CHICAGO)).toBe(false);
  });
});

describe('the fetch reaches every row the picked days can hold', () => {
  const range = { from: '2026-11-10', to: '2026-11-11' };
  const { fromDay, beforeDay } = archiveFetchBounds(range);
  /** The query's own comparison: Firestore orders these strings lexically. */
  const fetched = (startTime: string) => startTime >= fromDay && startTime < beforeDay;

  it('pads a day before FROM and two days past TO', () => {
    expect({ fromDay, beforeDay }).toEqual({ fromDay: '2026-11-09', beforeDay: '2026-11-13' });
  });

  it('fetches both stored shapes at both ends of the range', () => {
    for (const start of [
      instant('2026-11-10', '00:00'),
      instant('2026-11-11', '23:30'),
      '2026-11-10T00:00',
      '2026-11-11T23:30',
    ]) {
      expect(fetched(start)).toBe(true);
    }
  });

  it('fetches the ends for a business as far from UTC as zones go', () => {
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      expect(fetched(instant('2026-11-10', '00:00', zone))).toBe(true);
      expect(fetched(instant('2026-11-11', '23:59', zone))).toBe(true);
    }
  });

  it('then keeps only the picked days out of what the padding brought in', () => {
    const rows = [
      { _id: 'before', startTime: instant('2026-11-09', '22:32') },
      { _id: 'first', startTime: instant('2026-11-10', '09:00') },
      { _id: 'late', startTime: instant('2026-11-11', '23:30') },
      { _id: 'after', startTime: instant('2026-11-12', '00:15') },
      { _id: 'bare', startTime: '2026-11-11T21:00' },
    ];
    expect(rows.every((r) => fetched(r.startTime))).toBe(true);
    expect(archiveRows(rows, range, CHICAGO).map((r) => r._id)).toEqual(['first', 'late', 'bare']);
  });
});

describe('the day a card is filed under', () => {
  it('heads an evening visit with the business day it happened on, in time order', () => {
    const groups = groupArchiveByBusinessDay(
      [
        { _id: 'late', startTime: instant('2026-11-11', '23:30') },
        { _id: 'noon', startTime: instant('2026-11-11', '13:10') },
        { _id: 'bare', startTime: '2026-11-11T21:00' },
        { _id: 'prior', startTime: instant('2026-11-10', '22:32') },
        { _id: 'odd', startTime: 'whenever' },
      ],
      CHICAGO,
    );
    expect(groups.map((g) => [g.dayKeyValue, g.rows.map((r) => r._id)])).toEqual([
      ['2026-11-10', ['prior']],
      ['2026-11-11', ['noon', 'bare', 'late']],
      ['Undated', ['odd']],
    ]);
  });
});

describe('the range the Archive opens on', () => {
  const today = '2026-11-12';

  it('ends the day before Recent begins and covers 30 days', () => {
    expect(archiveDefaultRange(today)).toEqual({ from: '2026-10-12', to: '2026-11-10' });
  });

  it('holds a visit from 10 days ago', () => {
    const tenDaysAgo = instant(shiftDayIso(today, -10), '18:30');
    expect(isInArchiveRange(tenDaysAgo, archiveDefaultRange(today), CHICAGO)).toBe(true);
  });

  it('leaves no wrapped visit between Recent and the Archive, and none in both', () => {
    const opening = archiveDefaultRange(today);
    for (let age = 0; age <= 31; age += 1) {
      const day = shiftDayIso(today, -age);
      for (const hhmm of ['00:15', '12:00', '23:30']) {
        // The board files by the device's day (`sessionPhase`), which is the
        // business's day whenever the two agree, as they do for these rows.
        const row = { status: 'COMPLETED', startTime: `${day}T${hhmm}`, completedAt: `${day}T${hhmm}` };
        const onBoard = sessionPhase(row, today) === 'recent';
        const inArchive = isInArchiveRange(row.startTime, opening, CHICAGO);
        expect([age, hhmm, onBoard !== inArchive]).toEqual([age, hhmm, true]);
      }
    }
  });

  it('is reached past 31 days by moving FROM', () => {
    const old = instant(shiftDayIso(today, -40), '23:30');
    expect(isInArchiveRange(old, archiveDefaultRange(today), CHICAGO)).toBe(false);
    expect(isInArchiveRange(old, { from: shiftDayIso(today, -40), to: today }, CHICAGO)).toBe(true);
  });
});

describe('the zone read', () => {
  it('joins the request the KinCare catalog already makes', () => {
    expect(BUSINESS_SETTINGS_SHARED_KEY).toBe(BOOKING_CATALOG_KEY);
  });
});
