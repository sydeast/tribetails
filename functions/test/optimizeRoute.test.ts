import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import {
  OptimizeRouteArgs,
  minutesToHhmm,
  startMinutesFromIso,
  computeArrivalEtas,
  optimizeRouteHandler,
} from '../src/admin/optimizeRoute';

function req(data: unknown, uid: string | null = 'auntie-1'): CallableRequest<unknown> {
  return { data, auth: uid ? ({ uid, token: { admin: true } } as any) : undefined } as unknown as CallableRequest<unknown>;
}

/** Route geocode + optimize responses by URL. `geoByAddr` maps an address
 *  fragment -> coords (or null for a no-match). */
function fakeFetch(opts: {
  geoByAddr: Record<string, { lon: number; lat: number } | null>;
  optimize?: { code?: string; distance?: number; duration?: number; legs?: number[]; order?: number[] };
}) {
  return vi.fn(async (url: string) => {
    if (url.includes('geocode/v6/forward')) {
      const frag = Object.keys(opts.geoByAddr).find((f) => url.includes(encodeURIComponent(f)) || url.includes(f.replace(/ /g, '+')));
      const coords = frag ? opts.geoByAddr[frag] : undefined;
      if (!coords) return { ok: true, status: 200, json: async () => ({ features: [] }) };
      return { ok: true, status: 200, json: async () => ({ features: [{ geometry: { coordinates: [coords.lon, coords.lat] } }] }) };
    }
    if (url.includes('optimized-trips/v1')) {
      const o = opts.optimize ?? {};
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: o.code ?? 'Ok',
          waypoints: (o.order ?? [0, 1]).map((i) => ({ waypoint_index: i })),
          trips: [{ distance: o.distance ?? 0, duration: o.duration ?? 0, legs: (o.legs ?? []).map((d) => ({ duration: d })) }],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  process.env.MAPBOX_ACCESS_TOKEN = 'tok';
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
describe('pure helpers', () => {
  it('minutesToHhmm formats and pads', () => {
    expect(minutesToHhmm(8 * 60)).toBe('08:00');
    expect(minutesToHhmm(9 * 60 + 5)).toBe('09:05');
    expect(minutesToHhmm(-10)).toBe('00:00');
  });
  it('startMinutesFromIso parses local hours/min, null on garbage', () => {
    expect(startMinutesFromIso('nope')).toBeNull();
    expect(typeof startMinutesFromIso('2026-07-18T09:30:00')).toBe('number');
  });
  it('computeArrivalEtas accumulates leg durations from a base', () => {
    expect(computeArrivalEtas(3, [600, 900], 8 * 60)).toEqual(['08:00', '08:10', '08:25']);
  });
});

describe('OptimizeRouteArgs', () => {
  it('requires a YYYY-MM-DD date', () => {
    expect(OptimizeRouteArgs.safeParse({ date: '2026-07-18' }).success).toBe(true);
    expect(OptimizeRouteArgs.safeParse({ date: '07/18/2026' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('optimizeRouteHandler', () => {
  it('rejects unauthenticated', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(optimizeRouteHandler(req({ date: '2026-07-18' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('fails loud (no fake route) when the Mapbox token is missing', async () => {
    delete process.env.MAPBOX_ACCESS_TOKEN;
    mocks.dbFn.mockReturnValue(buildDbMock().db);
    await expect(optimizeRouteHandler(req({ date: '2026-07-18' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('optimizes a two-stop day, ordering by waypoint_index and computing totals + ETAs', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_sessions: [
          { id: 'sessA', data: { kinfolkId: 'kfA', startTime: '2026-07-18T09:00:00', status: 'SCHEDULED' } },
          { id: 'sessB', data: { kinfolkId: 'kfB', startTime: '2026-07-18T08:00:00', status: 'SCHEDULED' } },
        ],
      },
      docs: {
        'kinfolk/kfA': { firstName: 'Ann', lastName: 'Alpha', serviceAddress: '123 A St' },
        'kinfolk/kfB': { firstName: 'Bob', lastName: 'Beta', homeAddress: '456 B St' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // B sorts first (08:00) -> input order [B, A]; optimize keeps that order.
    vi.stubGlobal('fetch', fakeFetch({
      geoByAddr: { '456 B St': { lon: -74, lat: 40 }, '123 A St': { lon: -73.9, lat: 40.1 } },
      optimize: { distance: 3218.688, duration: 1200, legs: [600], order: [0, 1] },
    }));

    const res = await optimizeRouteHandler(req({ date: '2026-07-18' }));

    expect(res.unroutable).toEqual([]);
    expect(res.stops.map((s) => s.sessionId)).toEqual(['sessB', 'sessA']);
    expect(res.stops.map((s) => s.order)).toEqual([1, 2]);
    expect(res.stops[0]).toMatchObject({ household: 'Bob Beta', address: '456 B St', arrivalEta: '08:00' });
    expect(res.stops[1].arrivalEta).toBe('08:10'); // base 08:00 + 600s leg
    expect(res.totalMiles).toBe(2); // 3218.688 m / 1609.344
    expect(res.totalMinutes).toBe(20); // 1200s
  });

  it('surfaces a session with no service address as unroutable (fail loud, not dropped)', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_sessions: [
          { id: 'sessA', data: { kinfolkId: 'kfA', startTime: '2026-07-18T09:00:00', status: 'SCHEDULED' } },
        ],
      },
      docs: { 'kinfolk/kfA': { firstName: 'Ann', lastName: 'Alpha' } }, // no address field
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', fakeFetch({ geoByAddr: {} }));

    const res = await optimizeRouteHandler(req({ date: '2026-07-18' }));
    expect(res.stops).toEqual([]);
    expect(res.unroutable).toEqual([{ sessionId: 'sessA', household: 'Ann Alpha', reason: 'No service address on file' }]);
  });

  it('surfaces an ungeocodable address as unroutable', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_sessions: [
          { id: 'sessA', data: { kinfolkId: 'kfA', startTime: '2026-07-18T09:00:00', status: 'SCHEDULED' } },
        ],
      },
      docs: { 'kinfolk/kfA': { firstName: 'Ann', lastName: 'Alpha', address: 'Nowhere' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', fakeFetch({ geoByAddr: { Nowhere: null } }));

    const res = await optimizeRouteHandler(req({ date: '2026-07-18' }));
    expect(res.stops).toEqual([]);
    expect(res.unroutable[0].reason).toBe('Address could not be geocoded');
  });

  it('excludes cancelled sessions', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_sessions: [
          { id: 'sessX', data: { kinfolkId: 'kfA', startTime: '2026-07-18T09:00:00', status: 'cancelled' } },
        ],
      },
      docs: { 'kinfolk/kfA': { firstName: 'Ann', lastName: 'Alpha', serviceAddress: '123 A St' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    vi.stubGlobal('fetch', fakeFetch({ geoByAddr: { '123 A St': { lon: -74, lat: 40 } } }));

    const res = await optimizeRouteHandler(req({ date: '2026-07-18' }));
    expect(res.stops).toEqual([]);
    expect(res.unroutable).toEqual([]);
  });

  it('returns a single stop (no optimize call) for a one-session day', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_sessions: [
          { id: 'sessA', data: { kinfolkId: 'kfA', startTime: '2026-07-18T09:15:00', status: 'SCHEDULED' } },
        ],
      },
      docs: { 'kinfolk/kfA': { firstName: 'Ann', lastName: 'Alpha', serviceAddress: '123 A St' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const fetchMock = fakeFetch({ geoByAddr: { '123 A St': { lon: -74, lat: 40 } } });
    vi.stubGlobal('fetch', fetchMock);

    const res = await optimizeRouteHandler(req({ date: '2026-07-18' }));
    expect(res.stops.length).toBe(1);
    expect(res.stops[0].order).toBe(1);
    expect(res.totalMiles).toBe(0);
    expect(res.totalMinutes).toBe(0);
    // only the geocode was called, never the optimize endpoint
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes('optimized-trips'))).toBe(true);
  });
});
