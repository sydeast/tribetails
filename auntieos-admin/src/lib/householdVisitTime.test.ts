import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bookingModeFields,
  householdBlockFor,
  servedHouseholdTimeMode,
  startTimeServiceIdsFrom,
  storedHouseholdTimeMode,
  usableBlocks,
  type HouseholdTimeSettings,
} from './householdVisitTime';
import type { TimeBlockDefinition } from '../api/settings';

/**
 * #1863 / #2034: the office's copy of the household-time rule runs the SAME
 * case table as the server (mytribe/functions/test/householdVisitTime.test.ts),
 * so a Bookings row and the portal cannot disagree about a visit.
 */
type Case = {
  name: string;
  settings: string | Record<string, unknown>;
  blocks?: TimeBlockDefinition[];
  serviceStartTimeBooking?: Record<string, boolean>;
  visit: { localTime: string; timeBlockId?: string; serviceId?: string };
  expect: { mode: 'TIME_BLOCK' | 'SPECIFIC_TIME'; blockId: string | null };
};
const table = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../mytribe/functions/test/fixtures/householdVisitTime.json', import.meta.url)),
    'utf8',
  ),
) as { timeZone: string; date: string; blocks: TimeBlockDefinition[]; cases: Case[] } & Record<string, unknown>;

/** 2026-11-17 is CST (UTC-6) in America/Chicago. */
function startMs(localTime: string): number {
  const [h, m] = localTime.split(':').map(Number) as [number, number];
  return Date.UTC(2026, 10, 17, h + 6, m);
}

function settingsFor(c: Case): HouseholdTimeSettings {
  const mode = typeof c.settings === 'string' ? (table[c.settings] as Record<string, unknown>) : c.settings;
  return {
    ...mode,
    timeBlocks: c.blocks ?? table.blocks,
    startTimeServiceIds: startTimeServiceIdsFrom(c.serviceStartTimeBooking),
  };
}

describe('#1863 household visit time, admin mirror: the shared case table', () => {
  it('reads the table (a missing file would pass every case vacuously)', () => {
    expect(table.cases.length).toBeGreaterThanOrEqual(20);
  });
  for (const c of table.cases) {
    it(c.name, () => {
      const settings = settingsFor(c);
      expect(servedHouseholdTimeMode(settings)).toBe(c.expect.mode);
      const block = householdBlockFor(
        { startMs: startMs(c.visit.localTime), timeBlockId: c.visit.timeBlockId ?? null, serviceId: c.visit.serviceId ?? null },
        settings,
        table.timeZone,
      );
      expect(block?.id ?? null).toBe(c.expect.blockId);
    });
  }
});

describe('#1863 household visit time, admin mirror: edges', () => {
  const settings: HouseholdTimeSettings = {
    ...bookingModeFields('TIME_BLOCK'),
    timeBlocks: table.blocks,
    startTimeServiceIds: [],
  };

  it('reads the BUSINESS clock, never the device: the same instant is Morning two zones west', () => {
    expect(householdBlockFor({ startMs: startMs('12:30') }, settings, 'America/Chicago')?.id).toBe('midday');
    expect(householdBlockFor({ startMs: startMs('12:30') }, settings, 'America/Los_Angeles')?.id).toBe('morning');
  });

  it('a visit with no start has no block', () => {
    expect(householdBlockFor({ startMs: null }, settings, 'America/Chicago')).toBeNull();
  });

  it('a row with no end runs for the default block length, as the server reads it', () => {
    expect(usableBlocks([{ id: 'am', startTime: '08:00', active: true }], 2)).toMatchObject([
      { id: 'am', label: 'Am', startTime: '08:00', endTime: '10:00' },
    ]);
  });

  it('the stored mode is what the operator saved; each mode writes all three fields', () => {
    expect(storedHouseholdTimeMode({})).toBe('SPECIFIC_TIME');
    expect(storedHouseholdTimeMode(bookingModeFields('TIME_BLOCK'))).toBe('TIME_BLOCK');
    expect(bookingModeFields('SPECIFIC_TIME')).toEqual({
      defaultBookingMode: 'SPECIFIC_TIME',
      allowTimeBlockBooking: false,
      allowSpecificTimeBooking: true,
    });
  });
});
