import { describe, it, expect } from 'vitest';
import type { BookingDto } from '../src/lib/portalBookingDto';
import {
  LATE_VISIT_WINDOW_MS,
  bucketOf,
  isLive,
  isUnderWay,
  isUpcoming,
  pickLiveVisit,
  sessionProgressOf,
  visitStageOf,
  withSessionProgress,
} from '../src/lib/portalVisitProgress';

/** #1830 / #1832 / #1823: the pure rules behind a visit's stage and its list. */

const NOW = Date.parse('2026-11-10T23:20:00Z');

function dto(patch: Partial<BookingDto>): BookingDto {
  return {
    id: 'v1',
    startTimeMs: NOW - 8 * 60_000,
    startTimePending: false,
    requestedDate: null,
    status: 'confirmed',
    visitProgress: null,
    ...patch,
  } as BookingDto;
}

describe('sessionProgressOf', () => {
  it.each([
    ['ON_MY_WAY', { status: 'enRoute', visitProgress: 'enRoute' }],
    ['ARRIVED', { status: 'active', visitProgress: 'active' }],
    ['DEPARTED', { status: 'active', visitProgress: 'ended' }],
    ['COMPLETED', { status: 'completed', visitProgress: 'ended' }],
    [' arrived ', { status: 'active', visitProgress: 'active' }],
  ])('%s', (raw, expected) => {
    expect(sessionProgressOf(raw)).toEqual(expected);
  });

  it.each(['SCHEDULED', 'PENDING', 'DRAFT', 'CANCELLED', '', 'something else', null, undefined, 7])(
    '%s says nothing the visit does not already know',
    (raw) => {
      expect(sessionProgressOf(raw)).toBeNull();
    },
  );
});

describe('withSessionProgress', () => {
  it('lays the session over a confirmed visit', () => {
    expect(withSessionProgress({ status: 'confirmed', visitProgress: null, title: 'x' }, 'DEPARTED')).toEqual({
      status: 'active',
      visitProgress: 'ended',
      title: 'x',
    });
  });

  it.each(['completed', 'cancelled'])('never moves a %s visit', (status) => {
    const data = { status, visitProgress: null };
    expect(withSessionProgress(data, 'ARRIVED')).toBe(data);
  });

  it('leaves the visit alone when the session has not started', () => {
    const data = { status: 'confirmed' };
    expect(withSessionProgress(data, 'SCHEDULED')).toBe(data);
  });
});

describe('visitStageOf', () => {
  it.each([
    ['requested', null, 'requested'],
    ['confirmed', null, 'confirmed'],
    ['enRoute', 'enRoute', 'enRoute'],
    ['active', 'active', 'active'],
    ['active', null, 'active'],
    ['active', 'ended', 'departed'],
    ['completed', 'ended', 'completed'],
    ['completed', null, 'completed'],
    ['cancelled', null, 'cancelled'],
  ] as const)('%s + %s is %s', (status, visitProgress, stage) => {
    expect(visitStageOf({ status, visitProgress })).toBe(stage);
  });

  it('under way is on the way, arrived or departed; live is the first two', () => {
    const stages = [
      dto({ status: 'requested' }),
      dto({ status: 'confirmed' }),
      dto({ status: 'enRoute', visitProgress: 'enRoute' }),
      dto({ status: 'active', visitProgress: 'active' }),
      dto({ status: 'active', visitProgress: 'ended' }),
      dto({ status: 'completed' }),
      dto({ status: 'cancelled' }),
    ];
    expect(stages.map(isUnderWay)).toEqual([false, false, true, true, true, false, false]);
    expect(stages.map(isLive)).toEqual([false, false, true, true, false, false, false]);
  });
});

describe('bucketOf, for a visit whose start has passed', () => {
  it.each([
    ['requested', null, null],
    ['confirmed', null, 'upcoming'],
    ['enRoute', 'enRoute', 'upcoming'],
    ['active', 'active', 'upcoming'],
    ['active', 'ended', 'upcoming'],
    ['completed', 'ended', 'recent'],
    ['cancelled', null, 'recent'],
  ] as const)('%s + %s: %s', (status, visitProgress, bucket) => {
    expect(bucketOf(dto({ status, visitProgress }), NOW)).toBe(bucket);
  });

  it('a request or a confirmed visit still ahead is upcoming', () => {
    expect(bucketOf(dto({ status: 'requested', startTimeMs: NOW + 3600_000 }), NOW)).toBe('upcoming');
    expect(bucketOf(dto({ status: 'confirmed', startTimeMs: NOW + 3600_000 }), NOW)).toBe('upcoming');
  });

  it('a late confirmed visit stays for the window and no longer', () => {
    expect(isUpcoming(dto({ startTimeMs: NOW - LATE_VISIT_WINDOW_MS + 1000 }), NOW)).toBe(true);
    expect(isUpcoming(dto({ startTimeMs: NOW - LATE_VISIT_WINDOW_MS - 1000 }), NOW)).toBe(false);
    expect(bucketOf(dto({ startTimeMs: NOW - LATE_VISIT_WINDOW_MS - 1000 }), NOW)).toBeNull();
  });

  it('a visit under way is upcoming however old its start', () => {
    expect(bucketOf(dto({ status: 'active', visitProgress: 'ended', startTimeMs: NOW - 3 * LATE_VISIT_WINDOW_MS }), NOW)).toBe('upcoming');
  });

  it('#1098: a night awaiting its start time is upcoming while its night has not passed', () => {
    const night = dto({ status: 'requested', startTimeMs: null, startTimePending: true, requestedDate: '2026-11-10' });
    expect(bucketOf(night, NOW)).toBe('upcoming');
    expect(bucketOf({ ...night, requestedDate: '2026-11-07' }, NOW)).toBeNull();
  });
});

describe('pickLiveVisit', () => {
  it('prefers the visit the Auntie is at, then the one she is on the way to', () => {
    const otw = dto({ id: 'otw', status: 'enRoute', visitProgress: 'enRoute' });
    const here = dto({ id: 'here', status: 'active', visitProgress: 'active' });
    expect(pickLiveVisit([otw, here])?.id).toBe('here');
    expect(pickLiveVisit([otw])?.id).toBe('otw');
  });

  it('is never a departed, confirmed or finished visit', () => {
    expect(
      pickLiveVisit([
        dto({ status: 'active', visitProgress: 'ended' }),
        dto({ status: 'confirmed' }),
        dto({ status: 'completed' }),
      ]),
    ).toBeNull();
  });
});
