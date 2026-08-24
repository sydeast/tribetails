import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ISSUE #519: `allowClientLocationSharing` withholds coordinates AT THE SERVER.
 *
 * The switch had zero readers: three admin models declared it, the panels wrote
 * it, and every kinfolk-facing surface served route data regardless. These cases
 * fail against that code, because on it a `false` still returns a full route.
 *
 * The rules half of the same switch (the live-tracking `breadcrumbs` read) is
 * covered in `test/rules/flatCollections.test.ts` against the emulator, because
 * a rule can only be tested by evaluating it.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  logEvent: vi.fn(),
  resolveKinfolkAccess: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEvent }));
vi.mock('../src/lib/resolveKinfolkAccess', () => ({ resolveKinfolkAccess: mocks.resolveKinfolkAccess }));

import { isClientLocationSharingEnabled, withoutCoordinates } from '../src/lib/locationSharing';
import { getMyVisitsHandler } from '../src/portal/getMyVisits';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEvent.mockReset();
  mocks.resolveKinfolkAccess.mockReset().mockResolvedValue({ kinfolkId: 'kf1' });
});

describe('isClientLocationSharingEnabled', () => {
  function fs(data: Record<string, unknown> | undefined) {
    return { doc: () => ({ get: async () => ({ data: () => data }) }) } as never;
  }

  it('withholds only on an explicit false', async () => {
    expect(await isClientLocationSharingEnabled(fs({ allowClientLocationSharing: false }))).toBe(false);
  });

  it('reads an absent key as ON, so no deploy blanks a kinfolk map nobody switched off', async () => {
    expect(await isClientLocationSharingEnabled(fs({}))).toBe(true);
    expect(await isClientLocationSharingEnabled(fs(undefined))).toBe(true);
  });

  it('reads an explicit true as ON', async () => {
    expect(await isClientLocationSharingEnabled(fs({ allowClientLocationSharing: true }))).toBe(true);
  });

  it('leaves sharing on when the settings read fails', async () => {
    const broken = { doc: () => ({ get: async () => { throw new Error('offline'); } }) } as never;
    expect(await isClientLocationSharingEnabled(broken)).toBe(true);
  });
});

describe('withoutCoordinates', () => {
  it('strips every coordinate and keeps the non-locating facts', () => {
    const out = withoutCoordinates({
      distanceMeters: 1900,
      durationSeconds: 1500,
      computedAt: '2026-08-24T00:00:00.000Z',
      startLat: 30.1, startLng: -97.7, endLat: 30.2, endLng: -97.8,
      route: [{ lat: 30.1, lng: -97.7 }],
    });
    expect(out).toEqual({ distanceMeters: 1900, durationSeconds: 1500, computedAt: '2026-08-24T00:00:00.000Z' });
  });

  it('returns undefined when a summary was coordinates and nothing else', () => {
    expect(withoutCoordinates({ startLat: 1, startLng: 2, route: [] })).toBeUndefined();
    expect(withoutCoordinates(undefined)).toBeUndefined();
  });
});

// ── getMyVisits, the callable a kinfolk's schedule reads ────────────────────

const SUMMARY = {
  distanceMeters: 1900,
  durationSeconds: 1500,
  startLat: 30.1, startLng: -97.7, endLat: 30.2, endLng: -97.8,
  computedAt: '2026-08-24T00:00:00.000Z',
  route: [{ lat: 30.1, lng: -97.7, t: 1 }, { lat: 30.2, lng: -97.8, t: 2 }],
};

function visitsDb(settings: Record<string, unknown>) {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => query),
    get: vi.fn(async () => ({
      docs: [{ id: 'v1', data: () => ({ status: 'COMPLETED', startTime: '2026-08-20T10:00:00Z', gpsSummary: SUMMARY }) }],
    })),
  });
  return {
    collection: vi.fn(() => query),
    doc: vi.fn(() => ({ get: vi.fn(async () => ({ data: () => settings })) })),
  };
}

const REQ = { auth: { uid: 'u1', token: {} }, data: {} } as never;

describe('getMyVisits honours the switch', () => {
  it('serves the full route when sharing is on', async () => {
    mocks.dbFn.mockReturnValue(visitsDb({ allowClientLocationSharing: true }));
    const res = await getMyVisitsHandler(REQ);
    const summary = res.visits[0]?.gpsSummary;
    expect(summary?.route).toHaveLength(2);
    expect(summary?.startLat).toBe(30.1);
  });

  it('serves the full route when the key is absent', async () => {
    mocks.dbFn.mockReturnValue(visitsDb({}));
    const res = await getMyVisitsHandler(REQ);
    expect(res.visits[0]?.gpsSummary?.route).toHaveLength(2);
  });

  it('WITHHOLDS every coordinate when sharing is off, and still reports the visit', async () => {
    mocks.dbFn.mockReturnValue(visitsDb({ allowClientLocationSharing: false }));
    const res = await getMyVisitsHandler(REQ);
    const summary = res.visits[0]?.gpsSummary;

    expect(summary?.route).toBeUndefined();
    expect(summary?.startLat).toBeUndefined();
    expect(summary?.startLng).toBeUndefined();
    expect(summary?.endLat).toBeUndefined();
    expect(summary?.endLng).toBeUndefined();
    // The visit itself, and the fact of the walk, survive.
    expect(res.visits[0]?.id).toBe('v1');
    expect(summary?.distanceMeters).toBe(1900);
    expect(summary?.durationSeconds).toBe(1500);
  });

  it('serialises no coordinate anywhere in the response when sharing is off', async () => {
    mocks.dbFn.mockReturnValue(visitsDb({ allowClientLocationSharing: false }));
    const res = await getMyVisitsHandler(REQ);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('30.1');
    expect(wire).not.toContain('-97.7');
    expect(wire).not.toContain('lat');
  });
});
