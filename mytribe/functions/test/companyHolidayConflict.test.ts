import { describe, it, expect } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import {
  utcDatesForVisit,
  findCompanyHolidayConflicts,
  formatCompanyHolidayConflictMessage,
  loadCompanyHolidayEntries,
  guardCompanyHolidayConflict,
  COMPANY_HOLIDAY_CONFLICT_CODE,
} from '../src/lib/companyHolidayConflict';
import { parseClosureEntry, type ClosureEntry } from '../src/lib/closureRecurrence';

function once(dateIso: string, name = 'Test holiday'): ClosureEntry {
  return parseClosureEntry(`${dateIso}|${name}`);
}

function yearlyFixed(mmdd: string, name: string): ClosureEntry {
  return parseClosureEntry(`yearly:${mmdd}|${name}`);
}

// ── utcDatesForVisit (pure) ───────────────────────────────────────────────

describe('utcDatesForVisit', () => {
  it('a same-UTC-day visit yields one date', () => {
    expect(
      utcDatesForVisit({
        startTimeMs: Date.parse('2026-07-04T14:00:00.000Z'),
        endTimeMs: Date.parse('2026-07-04T15:00:00.000Z'),
      }),
    ).toEqual(['2026-07-04']);
  });

  it('a window crossing UTC midnight yields both days', () => {
    expect(
      utcDatesForVisit({
        startTimeMs: Date.parse('2026-07-04T22:00:00.000Z'),
        endTimeMs: Date.parse('2026-07-05T02:00:00.000Z'),
      }),
    ).toEqual(['2026-07-04', '2026-07-05']);
  });

  it('a window ending exactly at UTC midnight does not touch the next day', () => {
    expect(
      utcDatesForVisit({
        startTimeMs: Date.parse('2026-07-04T20:00:00.000Z'),
        endTimeMs: Date.parse('2026-07-05T00:00:00.000Z'),
      }),
    ).toEqual(['2026-07-04']);
  });

  it('a point-in-time visit (no endTimeMs) yields its own day', () => {
    expect(utcDatesForVisit({ startTimeMs: Date.parse('2026-12-25T09:00:00.000Z') })).toEqual(['2026-12-25']);
  });

  it('an unresolvable start yields no dates, never throws', () => {
    expect(utcDatesForVisit({ startTimeMs: Number.NaN })).toEqual([]);
  });
});

// ── findCompanyHolidayConflicts (pure) ───────────────────────────────────────

describe('findCompanyHolidayConflicts', () => {
  it('flags a visit landing on a once-dated closure', () => {
    const entries = [once('2026-09-14', "Owner's surgery")];
    const r = findCompanyHolidayConflicts([{ startTimeMs: Date.parse('2026-09-14T15:00:00.000Z') }], entries);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ visitIndex: 0, dateIso: '2026-09-14', holidayName: "Owner's surgery" });
  });

  it('honors yearly recurrence ACROSS a year boundary: the same yearly-fixed entry matches both years', () => {
    const entries = [yearlyFixed('07-04', 'Independence Day')];
    const r = findCompanyHolidayConflicts(
      [
        { startTimeMs: Date.parse('2026-07-04T15:00:00.000Z') },
        { startTimeMs: Date.parse('2027-07-04T15:00:00.000Z') },
        { startTimeMs: Date.parse('2030-07-04T15:00:00.000Z') },
      ],
      entries,
    );
    expect(r.map((c) => c.dateIso)).toEqual(['2026-07-04', '2027-07-04', '2030-07-04']);
  });

  it('does not flag a visit on an open day', () => {
    const entries = [once('2026-09-14', 'Closed')];
    expect(findCompanyHolidayConflicts([{ startTimeMs: Date.parse('2026-09-15T15:00:00.000Z') }], entries)).toHaveLength(0);
  });

  it('no closure entries at all means no conflicts', () => {
    expect(findCompanyHolidayConflicts([{ startTimeMs: Date.parse('2026-09-14T15:00:00.000Z') }], [])).toHaveLength(0);
  });

  it('checks every visit and reports each conflict with its own visitIndex', () => {
    const entries = [once('2026-12-25', 'Christmas')];
    const r = findCompanyHolidayConflicts(
      [
        { startTimeMs: Date.parse('2026-12-24T15:00:00.000Z') }, // open
        { startTimeMs: Date.parse('2026-12-25T15:00:00.000Z') }, // closed
      ],
      entries,
    );
    expect(r).toHaveLength(1);
    expect(r[0].visitIndex).toBe(1);
  });

  it('skips a visit whose startTimeMs is not finite, rather than throwing', () => {
    const entries = [once('2026-12-25', 'Christmas')];
    expect(() => findCompanyHolidayConflicts([{ startTimeMs: Number.NaN }], entries)).not.toThrow();
    expect(findCompanyHolidayConflicts([{ startTimeMs: Number.NaN }], entries)).toHaveLength(0);
  });

  it('a blank closure name falls back to a readable label', () => {
    const entries = [once('2026-09-14', '')];
    const r = findCompanyHolidayConflicts([{ startTimeMs: Date.parse('2026-09-14T15:00:00.000Z') }], entries);
    expect(r[0].holidayName).toBe('a company holiday');
  });
});

describe('formatCompanyHolidayConflictMessage', () => {
  it('names every conflicting visit, its date, and the holiday, 1-indexed', () => {
    const msg = formatCompanyHolidayConflictMessage([
      { visitIndex: 0, dateIso: '2026-07-04', holidayName: 'Independence Day' },
      { visitIndex: 2, dateIso: '2026-12-25', holidayName: 'Christmas' },
    ]);
    expect(msg).toContain('visit 1');
    expect(msg).toContain('2026-07-04');
    expect(msg).toContain('Independence Day');
    expect(msg).toContain('visit 3');
    expect(msg).toContain('Christmas');
  });
});

// ── loadCompanyHolidayEntries (Firestore read shape) ─────────────────────────

describe('loadCompanyHolidayEntries', () => {
  it('reads and decodes companyHolidays off business_settings/business_settings', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas', 'yearly:07-04|Independence Day'] } },
    });
    const entries = await loadCompanyHolidayEntries(ctx.db as any);
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('Christmas');
    expect(entries[1].recurrence).toBe('yearly-fixed');
  });

  it('returns [] when the doc is missing or companyHolidays is absent/not an array', async () => {
    const ctx1 = buildDbMock({});
    expect(await loadCompanyHolidayEntries(ctx1.db as any)).toEqual([]);
    const ctx2 = buildDbMock({ docs: { 'business_settings/business_settings': { companyHolidays: 'not-an-array' } } });
    expect(await loadCompanyHolidayEntries(ctx2.db as any)).toEqual([]);
  });

  it('a corrupt entry decodes to the safe once/blank fallback rather than throwing, and never matches any date', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['garbage-not-a-real-entry'] } },
    });
    const entries = await loadCompanyHolidayEntries(ctx.db as any);
    expect(entries).toHaveLength(1);
    expect(entries[0].recurrence).toBe('once');
    expect(entries[0].date).toBe('');
    expect(findCompanyHolidayConflicts([{ startTimeMs: Date.parse('2026-09-14T15:00:00.000Z') }], entries)).toHaveLength(0);
  });
});

// ── guardCompanyHolidayConflict (the one call every write path makes) ───────

describe('guardCompanyHolidayConflict', () => {
  it('resolves silently when there are no closures at all', async () => {
    const ctx = buildDbMock({});
    await expect(
      guardCompanyHolidayConflict({ firestore: ctx.db as any, visits: [{ startTimeMs: Date.parse('2026-09-14T15:00:00.000Z') }] }),
    ).resolves.toBeUndefined();
  });

  it('resolves silently when closures exist but none cover the candidate date', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    await expect(
      guardCompanyHolidayConflict({ firestore: ctx.db as any, visits: [{ startTimeMs: Date.parse('2026-09-14T15:00:00.000Z') }] }),
    ).resolves.toBeUndefined();
  });

  it('throws failed-precondition naming the date and holiday when a conflict is found -- no override parameter exists at all', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas'] } },
    });
    let thrown: any;
    try {
      await guardCompanyHolidayConflict({
        firestore: ctx.db as any,
        visits: [{ startTimeMs: Date.parse('2026-12-25T15:00:00.000Z') }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe('failed-precondition');
    expect(thrown.message).toContain('2026-12-25');
    expect(thrown.message).toContain('Christmas');
    expect(thrown.details).toMatchObject({ code: COMPANY_HOLIDAY_CONFLICT_CODE });
  });

  it('a recurring yearly closure blocks every future year, not just the year it was entered', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['yearly:12-25|Christmas'] } },
    });
    await expect(
      guardCompanyHolidayConflict({ firestore: ctx.db as any, visits: [{ startTimeMs: Date.parse('2031-12-25T15:00:00.000Z') }] }),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('names EVERY conflicting visit in a multi-visit batch, not just the first', async () => {
    const ctx = buildDbMock({
      docs: { 'business_settings/business_settings': { companyHolidays: ['2026-12-25|Christmas', '2027-01-01|New Year'] } },
    });
    await expect(
      guardCompanyHolidayConflict({
        firestore: ctx.db as any,
        visits: [
          { startTimeMs: Date.parse('2026-12-25T15:00:00.000Z') },
          { startTimeMs: Date.parse('2027-01-01T15:00:00.000Z') },
        ],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('visit 1') });
  });
});
