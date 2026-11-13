import { describe, it, expect } from 'vitest';
import {
  blockWindowText,
  formatBlockClock,
  householdBlockFor,
  householdTimeContextFrom,
  nearestBlockForMinutes,
  resolveBookingPolicy,
  storedBookingMode,
} from '../src/lib/bookingTimeBlocks';
import { zonedNow } from '../src/lib/businessHours';
import table from './fixtures/householdVisitTime.json';

/**
 * #1863 / #2034: what a household is shown for a visit, run over the SHARED
 * case table (test/fixtures/householdVisitTime.json). The admin web, Android
 * admin and desktop console mirrors run the same file, so the office's
 * Bookings row and the household's portal cannot disagree about a visit.
 */
type Case = {
  name: string;
  settings: string | Record<string, unknown>;
  blocks?: unknown[];
  serviceStartTimeBooking?: Record<string, boolean>;
  visit: { localTime: string; timeBlockId?: string; serviceId?: string };
  expect: { mode: 'TIME_BLOCK' | 'SPECIFIC_TIME'; blockId: string | null };
};

/** 2026-11-17 is CST (UTC-6) in America/Chicago. */
function startMs(localTime: string): number {
  const [h, m] = localTime.split(':').map(Number) as [number, number];
  return Date.UTC(2026, 10, 17, h + 6, m);
}

function settingsFor(c: Case): Record<string, unknown> {
  const mode =
    typeof c.settings === 'string' ? (table as unknown as Record<string, Record<string, unknown>>)[c.settings]! : c.settings;
  return {
    ...mode,
    timeZone: table.timeZone,
    timeBlocks: c.blocks ?? table.blocks,
    ...(c.serviceStartTimeBooking ? { serviceStartTimeBooking: c.serviceStartTimeBooking } : {}),
  };
}

describe('#1863 household visit time: the shared case table', () => {
  it('the table converts its wall clock correctly', () => {
    expect(zonedNow(startMs('15:30'), table.timeZone)?.timeHHmm).toBe('15:30');
    expect(zonedNow(startMs('15:30'), table.timeZone)?.dateIso).toBe(table.date);
  });

  for (const c of table.cases as Case[]) {
    it(c.name, () => {
      const settings = settingsFor(c);
      const { policy, timeZone } = householdTimeContextFrom(settings);
      expect(policy.allowTimeBlockBooking ? 'TIME_BLOCK' : 'SPECIFIC_TIME').toBe(c.expect.mode);
      const block = householdBlockFor(
        { startTimeMs: startMs(c.visit.localTime), timeBlockId: c.visit.timeBlockId, serviceId: c.visit.serviceId },
        policy,
        timeZone,
      );
      expect(block?.id ?? null).toBe(c.expect.blockId);
    });
  }
});

describe('#1863 householdBlockFor edges', () => {
  const ctx = householdTimeContextFrom({ ...table.timeBlocksMode, timeZone: table.timeZone, timeBlocks: table.blocks });

  it('a visit with no start yet (a night waiting on its time) has no block', () => {
    expect(householdBlockFor({ startTimeMs: null }, ctx.policy, ctx.timeZone)).toBeNull();
    expect(householdBlockFor({ startTimeMs: Number.NaN }, ctx.policy, ctx.timeZone)).toBeNull();
  });

  it('reads the BUSINESS clock: the same instant is Midday in Chicago and Morning two zones west', () => {
    const ms = startMs('12:30');
    expect(householdBlockFor({ startTimeMs: ms }, ctx.policy, 'America/Chicago')?.id).toBe('midday');
    expect(householdBlockFor({ startTimeMs: ms }, ctx.policy, 'America/Los_Angeles')?.id).toBe('morning');
  });

  it('an unreadable zone falls back to the ruled default rather than dropping the block', () => {
    expect(householdBlockFor({ startTimeMs: startMs('12:30') }, ctx.policy, 'Not/AZone')?.id).toBe('midday');
  });

  it('nearestBlockForMinutes: no blocks, no answer', () => {
    expect(nearestBlockForMinutes(600, '', [])).toBeNull();
  });
});

describe('#1863 storedBookingMode: the starting mode is read from what the operator stored', () => {
  it('an untouched document starts on Exact times', () => {
    expect(storedBookingMode({}).mode).toBe('SPECIFIC_TIME');
    expect(storedBookingMode(undefined).mode).toBe('SPECIFIC_TIME');
  });
  it('a business that had turned specific times off is Time Blocks', () => {
    expect(storedBookingMode({ allowTimeBlockBooking: true, allowSpecificTimeBooking: false }).mode).toBe('TIME_BLOCK');
  });
  it('a business that had turned blocks off is Exact times', () => {
    expect(storedBookingMode({ allowTimeBlockBooking: false, allowSpecificTimeBooking: true, defaultBookingMode: 'TIME_BLOCK' }).mode).toBe('SPECIFIC_TIME');
  });
  it('both on: the mode new bookings opened on', () => {
    expect(storedBookingMode({ defaultBookingMode: 'TIME_BLOCK' }).mode).toBe('TIME_BLOCK');
    expect(storedBookingMode({ defaultBookingMode: 'SPECIFIC_TIME' }).mode).toBe('SPECIFIC_TIME');
  });
});

describe('#1863 the household wording of a block', () => {
  it('is a window, never one clock time', () => {
    const { policy } = resolveBookingPolicy({ ...table.timeBlocksMode, timeBlocks: table.blocks });
    expect(policy.timeBlocks.map(blockWindowText)).toEqual([
      'Morning (8 AM to 11 AM)',
      'Midday (11 AM to 3 PM)',
      'Evening (4 PM to 7 PM)',
    ]);
  });
  it('spells half hours, noon, midnight and the end of the day', () => {
    expect(formatBlockClock('08:30')).toBe('8:30 AM');
    expect(formatBlockClock('12:00')).toBe('12 PM');
    expect(formatBlockClock('00:00')).toBe('12 AM');
    expect(formatBlockClock('24:00')).toBe('12 AM');
    expect(blockWindowText({ label: 'Late', startTime: '20:00', endTime: '24:00' })).toBe('Late (8 PM to 12 AM)');
  });
});
