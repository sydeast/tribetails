import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2094: Route for a day and the not-yet-invoiced list cut the day at UTC
 * midnight, which is 6 or 7 PM in Chicago. A day is the business's local day:
 * an 11:30 PM visit belongs to the day it happens on, in either stored shape (a
 * UTC instant, or the business wall clock with no zone).
 *
 * Every assertion here is zone-independent: `npm test` runs it in the machine's
 * zone, and CI runs it in UTC.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  businessClockOfStoredStart,
  businessDayOfStoredStart,
  storedStartBoundsForBusinessDays,
} from '../src/lib/bookingTimeBlocks';
import { optimizeRouteHandler, startMinutesFromIso } from '../src/admin/optimizeRoute';
import { listUninvoicedSessionsHandler } from '../src/admin/listUninvoicedSessions';

const CHICAGO = 'America/Chicago';

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

describe('businessClockOfStoredStart', () => {
  it('reads an 11:30 PM Chicago visit stored as a UTC instant on its own day', () => {
    // Nov 11 23:30 CST is Nov 12 05:30 UTC.
    expect(businessClockOfStoredStart('2026-11-12T05:30:00.000Z', CHICAGO)).toEqual({
      dateIso: '2026-11-11',
      minutes: 23 * 60 + 30,
    });
  });
  it('keeps a zone-less wall clock as business time', () => {
    expect(businessClockOfStoredStart('2026-11-11T23:30:00', CHICAGO)).toEqual({
      dateIso: '2026-11-11',
      minutes: 23 * 60 + 30,
    });
    expect(businessDayOfStoredStart('2026-11-11T23:30', CHICAGO)).toBe('2026-11-11');
  });
  it('reads a 6:30 PM visit, the hour the UTC cut used to roll over', () => {
    expect(businessDayOfStoredStart('2026-11-13T00:30:00.000Z', CHICAGO)).toBe('2026-11-12');
  });
  it('places visits on the night clocks go back (Nov 1, 2026)', () => {
    // 11:30 PM CDT on Oct 31 is 04:30 UTC Nov 1; 12:30 AM CDT Nov 1 is 05:30 UTC.
    expect(businessDayOfStoredStart('2026-11-01T04:30:00.000Z', CHICAGO)).toBe('2026-10-31');
    expect(businessClockOfStoredStart('2026-11-01T05:30:00.000Z', CHICAGO)).toEqual({ dateIso: '2026-11-01', minutes: 30 });
    // 11:30 PM CST on Nov 1 is 05:30 UTC Nov 2.
    expect(businessDayOfStoredStart('2026-11-02T05:30:00.000Z', CHICAGO)).toBe('2026-11-01');
  });
  it('places visits on the night clocks go forward (Mar 8, 2026)', () => {
    // 11:30 PM CST on Mar 7 is 05:30 UTC Mar 8; 12:30 AM CST Mar 8 is 06:30 UTC.
    expect(businessDayOfStoredStart('2026-03-08T05:30:00.000Z', CHICAGO)).toBe('2026-03-07');
    expect(businessClockOfStoredStart('2026-03-08T06:30:00.000Z', CHICAGO)).toEqual({ dateIso: '2026-03-08', minutes: 30 });
    // 11:30 PM CDT on Mar 8 is 04:30 UTC Mar 9.
    expect(businessDayOfStoredStart('2026-03-09T04:30:00.000Z', CHICAGO)).toBe('2026-03-08');
  });
  it('honours another stored business zone', () => {
    expect(businessDayOfStoredStart('2026-11-12T05:30:00.000Z', 'America/New_York')).toBe('2026-11-12');
    expect(businessDayOfStoredStart('2026-11-12T05:30:00.000Z', 'America/Los_Angeles')).toBe('2026-11-11');
  });
  it('gives null for nothing readable', () => {
    expect(businessClockOfStoredStart('', CHICAGO)).toBeNull();
    expect(businessClockOfStoredStart('soon', CHICAGO)).toBeNull();
    expect(businessClockOfStoredStart(undefined, CHICAGO)).toBeNull();
  });
});

describe('storedStartBoundsForBusinessDays', () => {
  it('reads a day wider on each side', () => {
    expect(storedStartBoundsForBusinessDays('2026-11-11', '2026-11-11')).toEqual({
      from: '2026-11-10',
      toExclusive: '2026-11-13',
    });
    expect(storedStartBoundsForBusinessDays('2026-02-28', '2026-03-31')).toEqual({
      from: '2026-02-27',
      toExclusive: '2026-04-02',
    });
  });
});

describe('startMinutesFromIso reads the business clock (#2094)', () => {
  it('an instant gives Chicago minutes, not the server’s', () => {
    expect(startMinutesFromIso('2026-11-11T15:00:00.000Z', CHICAGO)).toBe(9 * 60);
    expect(startMinutesFromIso('2026-07-18T14:00:00.000Z', CHICAGO)).toBe(9 * 60);
  });
  it('a wall clock gives its own minutes', () => {
    expect(startMinutesFromIso('2026-07-18T09:30:00', CHICAGO)).toBe(9 * 60 + 30);
  });
});

// ---------------------------------------------------------------------------

function routeFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes('geocode/v6/forward')) {
      return { ok: true, status: 200, json: async () => ({ features: [{ geometry: { coordinates: [-87.6, 41.8] } }] }) };
    }
    if (url.includes('optimized-trips/v1')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          waypoints: [0, 1, 2, 3].map((i) => ({ waypoint_index: i })),
          trips: [{ distance: 0, duration: 0, legs: [0, 0, 0].map((d) => ({ duration: d })) }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('optimizeRoute routes the business day (#2094)', () => {
  beforeEach(() => {
    mocks.dbFn.mockReset();
    process.env.MAPBOX_ACCESS_TOKEN = 'tok';
  });
  afterEach(() => vi.unstubAllGlobals());

  function seed(timeZone: string | null) {
    return buildDbMock({
      docs: {
        ...(timeZone ? { 'business_settings/business_settings': { timeZone } } : {}),
        'kinfolk/kfA': { firstName: 'Ann', lastName: 'Wren', serviceAddress: '1 A St' },
      },
      queryDocs: {
        kin_care_sessions: [
          // The evening before, 9 PM Nov 10 Chicago (03:00 UTC Nov 11).
          { id: 'prevEvening', data: { kinfolkId: 'kfA', startTime: '2026-11-11T03:00:00.000Z', status: 'SCHEDULED' } },
          // 9 AM Nov 11 Chicago, as an instant.
          { id: 'morning', data: { kinfolkId: 'kfA', startTime: '2026-11-11T15:00:00.000Z', status: 'SCHEDULED' } },
          // 6:30 PM Nov 11 Chicago, as a wall clock.
          { id: 'evening', data: { kinfolkId: 'kfA', startTime: '2026-11-11T18:30:00', status: 'SCHEDULED' } },
          // 11:30 PM Nov 11 Chicago (05:30 UTC Nov 12).
          { id: 'late', data: { kinfolkId: 'kfA', startTime: '2026-11-12T05:30:00.000Z', status: 'SCHEDULED' } },
          // 9 AM Nov 12 Chicago: tomorrow.
          { id: 'tomorrow', data: { kinfolkId: 'kfA', startTime: '2026-11-12T15:00:00.000Z', status: 'SCHEDULED' } },
        ],
      },
    });
  }

  it('keeps the evening and the 11:30 PM visit, and leaves the evening before off', async () => {
    mocks.dbFn.mockReturnValue(seed(CHICAGO).db);
    vi.stubGlobal('fetch', routeFetch());
    const res = await optimizeRouteHandler(req({ date: '2026-11-11' }));
    expect(res.stops.map((s) => s.sessionId)).toEqual(['morning', 'evening', 'late']);
    expect(res.stops[0]!.arrivalEta).toBe('09:00');
  });

  it('uses Chicago when no zone is stored', async () => {
    mocks.dbFn.mockReturnValue(seed(null).db);
    vi.stubGlobal('fetch', routeFetch());
    const res = await optimizeRouteHandler(req({ date: '2026-11-11' }));
    expect(res.stops.map((s) => s.sessionId)).toEqual(['morning', 'evening', 'late']);
  });
});

describe('listUninvoicedSessions takes business days (#2094)', () => {
  beforeEach(() => mocks.dbFn.mockReset());

  function seed() {
    const completed = (id: string, startTime: string) => ({
      id,
      data: { kinfolkId: 'fam1', status: 'COMPLETED', serviceType: 'dogWalking30', startTime },
    });
    return buildDbMock({
      docs: { 'business_settings/business_settings': { timeZone: CHICAGO, serviceRates: { dogWalking30: '25.00' } } },
      queryDocs: {
        kin_care_sessions: [
          // 8 PM Oct 31 Chicago (01:00 UTC Nov 1): the day before the range.
          completed('beforeFirst', '2026-11-01T01:00:00.000Z'),
          // 12:30 AM Nov 1 Chicago, the night clocks go back.
          completed('firstDay', '2026-11-01T05:30:00.000Z'),
          // 11:30 PM Nov 15 Chicago (05:30 UTC Nov 16): the last day.
          completed('lastEvening', '2026-11-16T05:30:00.000Z'),
          // A wall clock on the last day.
          completed('lastWall', '2026-11-15T21:00:00'),
          // 12:30 AM Nov 16 Chicago: after the range.
          completed('afterLast', '2026-11-16T06:30:00.000Z'),
        ],
      },
    });
  }

  it('keeps every visit of the first and last business day and nothing outside them', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listUninvoicedSessionsHandler(req({ from: '2026-11-01', to: '2026-11-15' }));
    expect(res.sessions.map((s) => s.sessionId).sort()).toEqual(['firstDay', 'lastEvening', 'lastWall']);
  });

  it('without a range, lists them all as before', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    const res = await listUninvoicedSessionsHandler(req({ kinfolkId: 'fam1' }));
    expect(res.sessions).toHaveLength(5);
  });
});
