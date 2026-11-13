import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1863: what a household's notice says about WHEN. In Time Blocks mode a
 * window ("Midday (11 AM to 3 PM)"), never one clock time; in Exact times mode
 * the clock. The office's and an Auntie's copies keep the clock either way.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));

import { enrichTemplateData } from '../src/notifications/enrichTemplateData';
import { buildVisitDateData, visitTimesForStream } from '../src/notifications/visitDates';
import { householdTimeContextFrom } from '../src/lib/bookingTimeBlocks';

const BLOCKS = [
  { id: 'midday', label: 'Midday', startTime: '11:00', endTime: '15:00', active: true },
  { id: 'evening', label: 'Evening', startTime: '16:00', endTime: '19:00', active: true },
];
const TIME_BLOCKS = {
  allowTimeBlockBooking: true,
  allowSpecificTimeBooking: false,
  defaultBookingMode: 'TIME_BLOCK',
  timeZone: 'America/Chicago',
  timeBlocks: BLOCKS,
};
const EXACT_TIMES = {
  allowTimeBlockBooking: false,
  allowSpecificTimeBooking: true,
  defaultBookingMode: 'SPECIFIC_TIME',
  timeZone: 'America/Chicago',
  timeBlocks: BLOCKS,
};
/** 2026-11-17 CST (UTC-6). */
const at = (hh: number, mm = 0) => Date.UTC(2026, 10, 17, hh + 6, mm);
const TZ = 'America/Chicago';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
});

describe('#1863 the household confirmation lists each visit the way the portal shows it', () => {
  const visits = [
    { visitId: 'v1', startTimeMs: at(11), timeBlockId: 'midday' },
    // #2034: moved by the office to 12:30.
    { visitId: 'v2', startTimeMs: at(12, 30), timeBlockId: 'midday' },
    // Booked by the office at a clock time in no block, the tie.
    { visitId: 'v3', startTimeMs: at(15, 30) },
  ];

  it('Time Blocks: windows on the household copy, the clock on every other copy', () => {
    const data = buildVisitDateData(visits, TZ, undefined, householdTimeContextFrom(TIME_BLOCKS));
    const household = visitTimesForStream(data as unknown as Record<string, unknown>, 'kinfolk');
    expect((household['visits'] as Array<{ time: string }>).map((v) => v.time)).toEqual([
      'Midday (11 AM to 3 PM)',
      'Midday (11 AM to 3 PM)',
      'Midday (11 AM to 3 PM)',
    ]);
    expect((household['nextVisit'] as { time: string }).time).toBe('Midday (11 AM to 3 PM)');
    const office = visitTimesForStream(data as unknown as Record<string, unknown>, 'business');
    expect((office['visits'] as Array<{ time: string }>).map((v) => v.time)).toEqual(['11:00 AM', '12:30 PM', '3:30 PM']);
    expect((office['nextVisit'] as { time: string }).time).toBe('11:00 AM');
    // No copy keeps the stand-ins.
    for (const copy of [household, office]) {
      expect(JSON.stringify(copy)).not.toContain('householdTime');
    }
  });

  it('Exact times: the household copy reads the clock too', () => {
    const data = buildVisitDateData(visits, TZ, undefined, householdTimeContextFrom(EXACT_TIMES));
    const household = visitTimesForStream(data as unknown as Record<string, unknown>, 'kinfolk');
    expect((household['visits'] as Array<{ time: string }>).map((v) => v.time)).toEqual(['11:00 AM', '12:30 PM', '3:30 PM']);
  });

  it('the single-visit stand-in for {{bookingTime}} reaches only the household copy', () => {
    const data = { bookingTime: '12:30 PM', householdBookingTime: 'Midday (11 AM to 3 PM)', kinfolkId: 'fam1' };
    expect(visitTimesForStream(data, 'kinfolk')).toEqual({ bookingTime: 'Midday (11 AM to 3 PM)', kinfolkId: 'fam1' });
    expect(visitTimesForStream(data, 'business')).toEqual({ bookingTime: '12:30 PM', kinfolkId: 'fam1' });
    expect(visitTimesForStream(data, 'staff')).toEqual({ bookingTime: '12:30 PM', kinfolkId: 'fam1' });
  });

  it('leaves data with no stand-ins exactly as it was', () => {
    const data = { email: 'catch@hanasamku.com', lockStartedAtMs: 1 };
    expect(visitTimesForStream(data, 'kinfolk')).toEqual(data);
  });
});

describe('#1863 the 24-hour reminder and other enriched {{bookingTime}}', () => {
  function seed(settings: Record<string, unknown>) {
    const ctx = buildDbMock({
      docs: {
        'business_settings/business_settings': settings,
        'families/fam1': { displayName: 'The Rivera Home' },
        'families/fam1/bookings/b1': { startTime: { toMillis: () => at(12, 30) }, timeBlockId: 'midday' },
      },
      queryDocs: { kin: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
  }

  it('Time Blocks: the reminder names the window, and reads the rendered sentence sensibly', async () => {
    seed(TIME_BLOCKS);
    const out = await enrichTemplateData('kincare.upcoming.reminder', 'cli1', {
      kinfolkId: 'fam1',
      bookingId: 'b1',
      startTimeMs: at(12, 30),
      timeBlockId: 'midday',
    });
    expect(out['bookingTime']).toBe('Midday (11 AM to 3 PM)');
    // The seeded SMS wording, with the window in it.
    expect(`your Visit is ${out['bookingDate']} at ${out['bookingTime']}.`).toBe(
      'your Visit is Tue, Nov 17 at Midday (11 AM to 3 PM).',
    );
  });

  it('Time Blocks: an office clock time in no block names the nearest window', async () => {
    seed(TIME_BLOCKS);
    const out = await enrichTemplateData('kincare.upcoming.reminder', 'cli1', {
      kinfolkId: 'fam1',
      startTimeMs: at(15, 45),
    });
    expect(out['bookingTime']).toBe('Evening (4 PM to 7 PM)');
  });

  it('Exact times: the reminder names the clock', async () => {
    seed(EXACT_TIMES);
    const out = await enrichTemplateData('kincare.upcoming.reminder', 'cli1', {
      kinfolkId: 'fam1',
      startTimeMs: at(12, 30),
      timeBlockId: 'midday',
    });
    expect(out['bookingTime']).toBe('12:30 PM');
  });

  it("the office's own notice keeps the clock in Time Blocks mode", async () => {
    seed(TIME_BLOCKS);
    const out = await enrichTemplateData('kincare.reschedule.requested', 'owner1', {
      kinfolkId: 'fam1',
      startTimeMs: at(12, 30),
    });
    expect(out['bookingTime']).toBe('12:30 PM');
  });

  it("a key that reaches both sides: the household's card copy names the window, the office's the clock", async () => {
    seed(TIME_BLOCKS);
    const data = { kinfolkId: 'fam1', startTimeMs: at(12, 30) };
    const household = await enrichTemplateData('kincare.changed', 'cli1', data, ['bookingTime'], true);
    expect(household['bookingTime']).toBe('Midday (11 AM to 3 PM)');
    const office = await enrichTemplateData('kincare.changed', 'owner1', data, ['bookingTime'], false);
    expect(office['bookingTime']).toBe('12:30 PM');
  });
});
