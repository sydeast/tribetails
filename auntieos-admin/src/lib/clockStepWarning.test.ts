import { describe, it, expect } from 'vitest';
import { clockStepWarning, spanWords, EARLY_ARRIVAL_WARNING_MINUTES, SHORT_VISIT_WARNING_SHARE } from './clockStepWarning';

const CHICAGO = 'America/Chicago';
const MIN = 60_000;
// The walk's visit: 45 minutes booked for 22:45 Chicago on Nov 10, 2026,
// which is 04:45 UTC on Nov 11.
const START = Date.parse('2026-11-11T04:45:00.000Z');
const visit = {
  startTime: '2026-11-11T04:45:00.000Z',
  endTime: '2026-11-11T05:30:00.000Z',
  serviceDurationMinutes: 45,
};

describe('clockStepWarning (#2039)', () => {
  it('keeps the two thresholds the clients share', () => {
    expect(EARLY_ARRIVAL_WARNING_MINUTES).toBe(30);
    expect(SHORT_VISIT_WARNING_SHARE).toBe(0.5);
  });

  it('warns on a clock-out before the booked start, the walk’s case', () => {
    const now = START - 43 * MIN;
    expect(clockStepWarning('DEPARTED', { ...visit, arrivedAt: new Date(now - MIN).toISOString() }, now, CHICAGO)).toBe(
      'This visit is booked to start at 22:45, 43 minutes from now. Clocking out now ends it before it was due to begin.',
    );
  });

  it('warns on a clock-out under half the booked length after clock-in', () => {
    const arrived = START;
    const now = arrived + MIN;
    expect(clockStepWarning('DEPARTED', { ...visit, arrivedAt: new Date(arrived).toISOString() }, now, CHICAGO)).toBe(
      'Only 1 minute since clock-in. This visit is booked for 45 minutes.',
    );
  });

  it('says nothing for a clock-out at half the length or later', () => {
    const arrived = START;
    expect(
      clockStepWarning('DEPARTED', { ...visit, arrivedAt: new Date(arrived).toISOString() }, arrived + 23 * MIN, CHICAGO),
    ).toBeNull();
    expect(
      clockStepWarning('DEPARTED', { ...visit, arrivedAt: new Date(arrived).toISOString() }, arrived + 45 * MIN, CHICAGO),
    ).toBeNull();
  });

  it('reads a clock-in the desktop stamped on the business clock with no zone', () => {
    // 22:45 Chicago written as a wall clock; a clock-out two minutes later.
    expect(
      clockStepWarning('DEPARTED', { ...visit, arrivedAt: '2026-11-10T22:45:00' }, START + 2 * MIN, CHICAGO),
    ).toBe('Only 2 minutes since clock-in. This visit is booked for 45 minutes.');
  });

  it('reads a visit start stored as a wall clock', () => {
    expect(
      clockStepWarning('DEPARTED', { startTime: '2026-11-10T22:45:00', serviceDurationMinutes: 45 }, START - 10 * MIN, CHICAGO),
    ).toBe('This visit is booked to start at 22:45, 10 minutes from now. Clocking out now ends it before it was due to begin.');
  });

  it('warns on a clock-in more than half an hour early, and not at 30 minutes', () => {
    expect(clockStepWarning('ARRIVED', visit, START - 47 * MIN, CHICAGO)).toBe(
      'This visit is booked for 22:45, 47 minutes from now.',
    );
    expect(clockStepWarning('ARRIVED', visit, START - 30 * MIN, CHICAGO)).toBeNull();
    expect(clockStepWarning('ARRIVED', visit, START + 5 * MIN, CHICAGO)).toBeNull();
  });

  it('places an 11:30 PM visit on the night clocks go back (Nov 1, 2026)', () => {
    // 23:30 CST on Nov 1 is 05:30 UTC Nov 2.
    const late = { startTime: '2026-11-02T05:30:00.000Z', serviceDurationMinutes: 30 };
    expect(clockStepWarning('ARRIVED', late, Date.parse('2026-11-02T04:00:00.000Z'), CHICAGO)).toBe(
      'This visit is booked for 23:30, 1 hour 30 minutes from now.',
    );
  });

  it('places a 12:30 AM visit on the night clocks go forward (Mar 8, 2026)', () => {
    // 00:30 CST Mar 8 is 06:30 UTC; a clock-out at 00:20 is before it starts.
    const early = { startTime: '2026-03-08T06:30:00.000Z', serviceDurationMinutes: 30 };
    expect(clockStepWarning('DEPARTED', early, Date.parse('2026-03-08T06:20:00.000Z'), CHICAGO)).toBe(
      'This visit is booked to start at 00:30, 10 minutes from now. Clocking out now ends it before it was due to begin.',
    );
  });

  it('says nothing it cannot back: no start, no clock-in, no length, other steps', () => {
    expect(clockStepWarning('ARRIVED', {}, START, CHICAGO)).toBeNull();
    expect(clockStepWarning('DEPARTED', { startTime: visit.startTime }, START + MIN, CHICAGO)).toBeNull();
    expect(
      clockStepWarning('DEPARTED', { startTime: visit.startTime, arrivedAt: visit.startTime }, START + MIN, CHICAGO),
    ).toBeNull();
    expect(clockStepWarning('ON_MY_WAY', visit, START - 5 * 60 * MIN, CHICAGO)).toBeNull();
    expect(clockStepWarning('UNDO_ARRIVAL', visit, START - 5 * 60 * MIN, CHICAGO)).toBeNull();
  });
});

describe('spanWords', () => {
  it('reads like a person would say it', () => {
    expect(spanWords(0.4)).toBe('less than a minute');
    expect(spanWords(1)).toBe('1 minute');
    expect(spanWords(43)).toBe('43 minutes');
    expect(spanWords(60)).toBe('1 hour');
    expect(spanWords(125)).toBe('2 hours 5 minutes');
  });
});
