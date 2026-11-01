import { describe, expect, it } from 'vitest';
import type { BusinessWeekdayHoursDto, TimeBlockDto } from '../api/bookingApi';
import { blockChoices, closedDaysFor, hoursOn, rescheduleModes, resolveProposal, zonedWallClockToMs } from './rescheduleTime';
const CHI = 'America/Chicago';
const HOURS: BusinessWeekdayHoursDto[] = [0, 1, 2, 3, 4, 5, 6].map((weekday) =>
  weekday === 0
    ? { weekday, open: false, startTime: null, endTime: null }
    : { weekday, open: true, startTime: '09:00', endTime: '17:00' },
);
const MORNING: TimeBlockDto = { id: 'morning', label: 'Morning', startTime: '08:00', endTime: '12:00', durationMinutes: 240 };
const LATE: TimeBlockDto = { id: 'late', label: 'Late', startTime: '20:00', endTime: '24:00', durationMinutes: 240 };
describe('zonedWallClockToMs', () => {
  it('reads the Chicago wall clock in standard time (UTC-6)', () => {
    expect(zonedWallClockToMs('2026-11-15', '09:00', CHI)).toBe(Date.UTC(2026, 10, 15, 15, 0));
  });
  it('reads it in daylight time (UTC-5)', () => {
    expect(zonedWallClockToMs('2026-07-15', '09:00', CHI)).toBe(Date.UTC(2026, 6, 15, 14, 0));
  });
  it('lands on the right side of the spring-forward change', () => {
    // 2026-03-08: 02:00 CST jumps to 03:00 CDT. 03:30 CDT is 08:30Z.
    expect(zonedWallClockToMs('2026-03-08', '03:30', CHI)).toBe(Date.UTC(2026, 2, 8, 8, 30));
    // 01:30 is still CST (UTC-6) = 07:30Z.
    expect(zonedWallClockToMs('2026-03-08', '01:30', CHI)).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });
  it('treats 24:00 as the next midnight and refuses garbage', () => {
    expect(zonedWallClockToMs('2026-11-15', '24:00', CHI)).toBe(zonedWallClockToMs('2026-11-16', '00:00', CHI));
    expect(zonedWallClockToMs('nope', '09:00', CHI)).toBeNull();
    expect(zonedWallClockToMs('2026-11-15', '25:00', CHI)).toBeNull();
    expect(zonedWallClockToMs('2026-11-15', '09:00', 'Not/AZone')).toBeNull();
  });
});
describe('closedDaysFor', () => {
  it('adds every closed weekday in the horizon beside the company closures', () => {
    const today = new Date(2026, 10, 1); // a Sunday
    const out = closedDaysFor(new Map([['2026-11-04', 'Owner away']]), HOURS, today, 14);
    expect(out.get('2026-11-04')).toBe('Owner away');
    expect(out.get('2026-11-01')).toBe('Sundays');
    expect(out.get('2026-11-08')).toBe('Sundays');
    expect(out.get('2026-11-15')).toBe('Sundays');
    expect(out.has('2026-11-02')).toBe(false);
  });
  it('adds nothing when no weekly hours are known', () => {
    expect(closedDaysFor(new Map(), [], new Date(2026, 10, 1), 14).size).toBe(0);
    expect(closedDaysFor(new Map(), undefined, new Date(2026, 10, 1), 14).size).toBe(0);
  });
});
describe('hoursOn', () => {
  it('returns null unless all seven days are on file', () => {
    expect(hoursOn(new Date(2026, 10, 2), HOURS)?.startTime).toBe('09:00');
    expect(hoursOn(new Date(2026, 10, 2), HOURS.slice(0, 3))).toBeNull();
    expect(hoursOn(new Date(2026, 10, 2), undefined)).toBeNull();
  });
});
describe('rescheduleModes', () => {
  const base = { allowTimeBlockBooking: true, allowSpecificTimeBooking: true, defaultBookingMode: 'TIME_BLOCK' as const };
  it('offers both when the business allows both, opening on its default', () => {
    expect(rescheduleModes(base, 's1')).toEqual({ modes: ['TIME_BLOCK', 'SPECIFIC_TIME'], initial: 'TIME_BLOCK' });
  });
  it('offers only blocks when clock booking is off', () => {
    expect(rescheduleModes({ ...base, allowSpecificTimeBooking: false }, 's1').modes).toEqual(['TIME_BLOCK']);
  });
  it('keeps a start-time KinCare on the clock whatever the switches say', () => {
    expect(rescheduleModes({ ...base, allowSpecificTimeBooking: false, startTimeServiceIds: ['night'] }, 'night')).toEqual({
      modes: ['SPECIFIC_TIME'],
      initial: 'SPECIFIC_TIME',
    });
  });
});
describe('blockChoices', () => {
  const day = '2026-11-16';
  const dayStart = zonedWallClockToMs(day, '00:00', CHI)!;
  it('offers a block that has not started at its first minute', () => {
    const out = blockChoices(day, [MORNING], dayStart, CHI);
    expect(out).toEqual([{ block: MORNING, startMs: zonedWallClockToMs(day, '08:00', CHI) }]);
  });
  it('starts a block that is already open a little after now, on a 5-minute step', () => {
    const now = zonedWallClockToMs(day, '09:02', CHI)!;
    const [c] = blockChoices(day, [MORNING], now, CHI);
    expect(c!.startMs).toBe(zonedWallClockToMs(day, '09:20', CHI));
  });
  it('drops a block that closes too soon to fit the lead, and a block already over', () => {
    expect(blockChoices(day, [MORNING], zonedWallClockToMs(day, '11:50', CHI)!, CHI)).toEqual([]);
    expect(blockChoices(day, [MORNING], zonedWallClockToMs(day, '13:00', CHI)!, CHI)).toEqual([]);
  });
  it('reads a 24:00 close as the next midnight', () => {
    expect(blockChoices(day, [LATE], zonedWallClockToMs(day, '21:00', CHI)!, CHI)).toHaveLength(1);
  });
});
describe('resolveProposal', () => {
  const day = '2026-11-16'; // a Monday
  const nowMs = zonedWallClockToMs('2026-11-10', '12:00', CHI)!;
  const base = { dayKey: day, mode: 'SPECIFIC_TIME' as const, time: '10:00', blockId: null, blocks: [MORNING], weekly: HOURS, timeZone: CHI, nowMs, startTimeService: false };
  it('turns a day and clock time into a Chicago instant with no block', () => {
    expect(resolveProposal(base)).toEqual({ proposal: { startMs: zonedWallClockToMs(day, '10:00', CHI), timeBlockId: null }, problem: null });
  });
  it('says nothing while no day is chosen', () => {
    expect(resolveProposal({ ...base, dayKey: null })).toEqual({ proposal: null, problem: null });
  });
  it('refuses 2:00 AM with the day\'s hours in the sentence', () => {
    const r = resolveProposal({ ...base, time: '02:00' });
    expect(r.proposal).toBeNull();
    expect(r.problem).toBe('We are open 09:00 to 17:00 on Mondays. Pick a time inside those hours.');
  });
  it('treats the closing minute as outside, like the server', () => {
    expect(resolveProposal({ ...base, time: '17:00' }).proposal).toBeNull();
    expect(resolveProposal({ ...base, time: '16:59' }).proposal).not.toBeNull();
  });
  it('does not bound a start-time KinCare by the weekly hours', () => {
    expect(resolveProposal({ ...base, time: '20:00', startTimeService: true }).proposal).not.toBeNull();
  });
  it('does not restrict when no hours are on file', () => {
    expect(resolveProposal({ ...base, time: '02:00', weekly: [] }).proposal).not.toBeNull();
  });
  it('carries the block id for a block, at the block\'s first minute', () => {
    expect(resolveProposal({ ...base, mode: 'TIME_BLOCK', blockId: 'morning' })).toEqual({
      proposal: { startMs: zonedWallClockToMs(day, '08:00', CHI), timeBlockId: 'morning' },
      problem: null,
    });
  });
  it('waits for a block to be chosen', () => {
    expect(resolveProposal({ ...base, mode: 'TIME_BLOCK', blockId: null })).toEqual({ proposal: null, problem: null });
  });
});
