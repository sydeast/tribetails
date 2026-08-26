import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));

import { verifyVisitArrivalHandler } from '../src/admin/verifyVisitArrival';

/**
 * ISSUE #582: the callable that measures a recorded arrival against the
 * household's coordinate.
 *
 * The happy path is one assertion. What the rest of this file is about is the
 * cases where the check CANNOT be made — and that none of them turns into a
 * refusal, because refusing an Auntie who is genuinely on site is the failure
 * this whole feature has to avoid.
 */

/** 12 Oak St, and a point ~50 m north of it. */
const HOUSE = { lat: 34.05, lng: -118.24 };
const NEXT_DOOR = { lat: 34.05045, lng: -118.24 };
const ACROSS_TOWN = { lat: 34.09, lng: -118.3 };

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'auntie1', token: { admin: true } },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(opts: {
  settings?: Record<string, unknown>;
  household?: Record<string, unknown> | null;
  session?: Record<string, unknown> | null;
}) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'business_settings/business_settings': opts.settings ?? {
      requireArrivalDepartureVerification: true,
    },
  };
  docs['kin_care_sessions/s1'] =
    opts.session === null ? null : { kinfolkId: 'kf1', status: 'ARRIVED', ...(opts.session ?? {}) };
  if (opts.household !== null) {
    docs['kinfolk/kf1'] = {
      serviceAddress: '12 Oak St',
      serviceLocation: { ...HOUSE, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
      ...(opts.household ?? {}),
    };
  }
  const ctx = buildDbMock({ docs });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

describe('verifyVisitArrival', () => {
  beforeEach(() => {
    mocks.dbFn.mockReset();
    mocks.logEventFn.mockReset();
    mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-1');
    process.env.MAPBOX_ACCESS_TOKEN = 'tok';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ features: [{ geometry: { coordinates: [HOUSE.lng, HOUSE.lat] } }] }),
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('verifies an arrival taken at the household', async () => {
    seed({});
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 8 }),
    );
    expect(res).toMatchObject({ ok: true, status: 'within', radiusMeters: 150 });
    expect(res.distanceMeters).toBeGreaterThan(45);
    expect(res.distanceMeters).toBeLessThan(55);
  });

  it('calls out an arrival taken across town', async () => {
    seed({});
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...ACROSS_TOWN, accuracyMeters: 10 }),
    );
    expect(res.status).toBe('outside');
    expect(res.distanceMeters).toBeGreaterThan(1000);
  });

  it('honours the operator radius rather than a hardcoded one', async () => {
    seed({ settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 20 } });
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 1 }),
    );
    expect(res).toMatchObject({ status: 'outside', radiusMeters: 20 });
  });

  it('stamps the distance and the accuracy on the session, and NOTHING else about the fix', async () => {
    const ctx = seed({});
    await verifyVisitArrivalHandler(req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 8 }));
    const write = ctx.writes.find((w) => w.path === 'kin_care_sessions/s1');
    expect(write?.merge).toBe(true);
    expect(Object.keys(write?.data ?? {}).sort()).toEqual([
      'arrivalAccuracyMeters',
      'arrivalDistanceMeters',
      'arrivalLocationCheckedAt',
    ]);
    expect(write?.data.arrivalAccuracyMeters).toBe(8);
  });

  /**
   * THE PRIVACY INVARIANT. The Auntie's coordinate is measured and dropped: it
   * must not reach the session document, the audit trail, or the logs. A
   * coordinate kept off the document is no better off in `activity_log`.
   */
  it('never writes, audits or logs the coordinate it was sent', async () => {
    const ctx = seed({});
    await verifyVisitArrivalHandler(req({ sessionId: 's1', ...ACROSS_TOWN, accuracyMeters: 10 }));
    const everything = JSON.stringify([
      ctx.writes,
      mocks.writeAuditEntryFn.mock.calls,
      mocks.logEventFn.mock.calls,
    ]);
    expect(everything).not.toContain(String(ACROSS_TOWN.lat));
    expect(everything).not.toContain(String(ACROSS_TOWN.lng));
  });

  it('audits every check, and raises the severity on the one worth finding later', async () => {
    seed({});
    await verifyVisitArrivalHandler(req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 5 }));
    expect(mocks.writeAuditEntryFn.mock.calls[0][0]).toMatchObject({
      event: 'VISIT_ARRIVAL_LOCATION_CHECK',
      severity: 'info',
      payload: { checkStatus: 'within' },
    });

    mocks.writeAuditEntryFn.mockClear();
    seed({});
    await verifyVisitArrivalHandler(req({ sessionId: 's1', ...ACROSS_TOWN, accuracyMeters: 5 }));
    expect(mocks.writeAuditEntryFn.mock.calls[0][0]).toMatchObject({
      severity: 'warn',
      payload: { checkStatus: 'outside' },
    });
  });

  // ── the cases where nothing can be verified, and none of them refuses ──────

  it('reports household_location_unknown for a household with no address', async () => {
    seed({ household: { serviceAddress: '', serviceLocation: null } });
    const res = await verifyVisitArrivalHandler(req({ sessionId: 's1', ...HOUSE }));
    expect(res).toMatchObject({
      ok: true,
      status: 'household_location_unknown',
      distanceMeters: null,
      reason: 'no_address',
    });
  });

  it('reports household_location_unknown, not an error, when Mapbox is down', async () => {
    seed({ household: { serviceLocation: null } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    const res = await verifyVisitArrivalHandler(req({ sessionId: 's1', ...HOUSE }));
    expect(res).toMatchObject({
      status: 'household_location_unknown',
      reason: 'geocoder_unavailable',
    });
  });

  it('geocodes a household that has an address and no coordinate yet', async () => {
    const ctx = seed({ household: { serviceLocation: null } });
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 5 }),
    );
    expect(res.status).toBe('within');
    expect(ctx.writes.some((w) => w.path === 'kinfolk/kf1' && w.data.serviceLocation)).toBe(true);
  });

  /** A cell-tower fix is not evidence; treating it as a pass would be worse than not checking. */
  it('records a hopelessly imprecise fix as unverified rather than as a pass', async () => {
    seed({});
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...ACROSS_TOWN, accuracyMeters: 4000 }),
    );
    expect(res).toMatchObject({ status: 'unverified', reason: 'fix_too_imprecise' });
  });

  /**
   * The arrival patch rides Firestore's offline queue and this call does not,
   * so on a flaky connection the check can land before the status change.
   * Refusing on that would drop the verification on the arrivals most worth
   * verifying.
   */
  it('does not require the session to already say ARRIVED', async () => {
    seed({ session: { status: 'ON_MY_WAY' } });
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 5 }),
    );
    expect(res.status).toBe('within');
  });

  it('clears a stale reading when the household coordinate can no longer be resolved', async () => {
    const ctx = seed({
      household: { serviceAddress: '', serviceLocation: null },
      session: { arrivalDistanceMeters: 12, arrivalAccuracyMeters: 4 },
    });
    await verifyVisitArrivalHandler(req({ sessionId: 's1', ...HOUSE }));
    const write = ctx.writes.find((w) => w.path === 'kin_care_sessions/s1');
    expect(write?.data.arrivalDistanceMeters).toBeNull();
    expect(write?.data.arrivalAccuracyMeters).toBeNull();
  });

  it('still reports the radius when the operator has the rule switched off', async () => {
    seed({ settings: {} });
    const res = await verifyVisitArrivalHandler(
      req({ sessionId: 's1', ...NEXT_DOOR, accuracyMeters: 5 }),
    );
    expect(res).toMatchObject({ status: 'within', verificationRequired: false, radiusMeters: 150 });
  });

  // ── boundary ──────────────────────────────────────────────────────────────

  it('refuses a coordinate that is not one', async () => {
    seed({});
    await expect(
      verifyVisitArrivalHandler(req({ sessionId: 's1', lat: 91, lng: 0 })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      verifyVisitArrivalHandler(req({ sessionId: 's1', lat: 0, lng: 181 })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      verifyVisitArrivalHandler(req({ sessionId: 's1', lat: 0, lng: 0, accuracyMeters: -1 })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses a call with no session id', async () => {
    seed({});
    await expect(verifyVisitArrivalHandler(req({ ...HOUSE }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('reports a session that is not there', async () => {
    seed({ session: null });
    await expect(verifyVisitArrivalHandler(req({ sessionId: 's1', ...HOUSE }))).rejects.toMatchObject(
      { code: 'not-found' },
    );
  });

  it('needs a signed-in caller', async () => {
    seed({});
    await expect(
      verifyVisitArrivalHandler({ data: { sessionId: 's1', ...HOUSE } } as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
