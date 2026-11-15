import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), dispatch: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/admin/dispatchVisitNotification', () => ({
  dispatchVisitNotificationCore: mocks.dispatch,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { setVisitLifecycleHandler } from '../src/admin/setVisitLifecycle';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import {
  START_LOCATION_MISSING_MESSAGE,
  START_LOCATION_ROUGH_MESSAGE,
  VISIT_START_LOCATION_CODE,
  VISIT_START_RANGE_CODE,
  auntieStartDecision,
  startOutsideRangeMessage,
} from '../src/lib/visitStartRange';

/**
 * #2279, operator ruling 2026-11-14: "cant start visit until within range of
 * the property. if they cant start, then they cant complete. only admin auntie
 * can complete visits outside of ranges".
 *
 * The issue's test list: an Auntie out of range is refused on each start tap;
 * in range works; the owner out of range is allowed and logged; verification
 * off is unchanged.
 */

/** 12 Oak St, a point ~50 m north of it, and one across town. */
const HOUSE = { lat: 34.05, lng: -118.24 };
const NEXT_DOOR = { lat: 34.05045, lng: -118.24 };
const ACROSS_TOWN = { lat: 34.09, lng: -118.3 };

const OWNER = { admin: true, name: 'Owner' };
const AUNTIE = { staffRole: 'auntie', name: 'Auntie Jo' };

function req(data: unknown, token: Record<string, unknown>): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: token.admin === true ? 'owner1' : 'auntie1', token },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function seed(opts: {
  settings?: Record<string, unknown>;
  household?: Record<string, unknown>;
  session?: Record<string, unknown>;
} = {}) {
  const ctx = buildDbMock({
    docs: {
      'business_settings/business_settings': opts.settings ?? {
        requireArrivalDepartureVerification: true,
        arrivalRadiusMeters: 150,
      },
      'kin_care_sessions/s1': {
        kinfolkId: 'kf1',
        kinCareBatchId: 'batch1',
        kinCareVisitId: 'visit1',
        status: 'SCHEDULED',
        startTime: '2026-11-14T14:00:00Z',
        ...(opts.session ?? {}),
      },
      'kinfolk/kf1': {
        serviceAddress: '12 Oak St',
        serviceLocation: { ...HOUSE, geocodedFrom: '12 Oak St', geocodedAt: 'T' },
        ...(opts.household ?? {}),
      },
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const sessionWrite = (ctx: ReturnType<typeof seed>) => ctx.writes.find((w) => w.path === 'kin_care_sessions/s1');
const audits = () => (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0]);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue({ ok: true, dispatchIds: ['d1'], suppressed: false });
  (writeAuditEntry as any).mockClear();
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

describe('an Auntie outside the range, with arrival verification on', () => {
  it.each(['ON_MY_WAY', 'ARRIVED'] as const)('is refused on %s, and nothing is written', async (action) => {
    const ctx = seed();
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action, ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE)),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: VISIT_START_RANGE_CODE, sessionId: 's1' },
    });
    expect(sessionWrite(ctx)).toBeUndefined();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('is refused on Arrived from On my way too', async () => {
    const ctx = seed({ session: { status: 'ON_MY_WAY', onMyWayAt: '2026-11-14T13:40:00Z' } });
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE)),
    ).rejects.toMatchObject({ details: { code: VISIT_START_RANGE_CODE } });
    expect(sessionWrite(ctx)).toBeUndefined();
  });

  it('reads a plain sentence: how far, be at the property, the owner can start it', async () => {
    seed();
    const err = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE),
    ).catch((e) => e);
    // The words are the error's own message, so a build that has never heard
    // of the code still shows them.
    expect(err.message).toMatch(/^You are \d+(\.\d)? km from this household\. /);
    expect(err.message).toContain('You need to be at the property to start this visit.');
    expect(err.message).toContain('The owner can start it');
    expect(err.message).not.toMatch(/Settings|radius|—|permission|precondition/i);
  });

  it('writes the refusal to the Activity Log, with the distance and never the position', async () => {
    const ctx = seed();
    await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE),
    ).catch(() => undefined);
    const refusal = audits().find((a: any) => a.event === 'VISIT_LIFECYCLE_REFUSED');
    expect(refusal).toMatchObject({ status: 'FAILURE', severity: 'warn', actorUid: 'auntie1' });
    expect(refusal.description).toMatch(/^Could not mark the arrival: the Auntie was \d+(\.\d)? km from the household$/);
    expect(refusal.payload).toMatchObject({ refusalCode: VISIT_START_RANGE_CODE, radiusMeters: 150 });
    const everything = JSON.stringify([ctx.writes, audits(), mocks.logEventFn.mock.calls]);
    expect(everything).not.toContain(String(ACROSS_TOWN.lat));
    expect(everything).not.toContain(String(ACROSS_TOWN.lng));
  });

  it('is refused when the tap sends no location at all', async () => {
    const ctx = seed();
    for (const action of ['ON_MY_WAY', 'ARRIVED'] as const) {
      const err = await setVisitLifecycleHandler(req({ sessionId: 's1', action }, AUNTIE)).catch((e) => e);
      expect(err).toMatchObject({ code: 'failed-precondition', details: { code: VISIT_START_LOCATION_CODE } });
      expect(err.message).toBe(START_LOCATION_MISSING_MESSAGE);
    }
    expect(sessionWrite(ctx)).toBeUndefined();
  });

  it('is refused when her location is too rough to place her', async () => {
    const ctx = seed();
    const err = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...NEXT_DOOR, accuracyMeters: 5000 }, AUNTIE),
    ).catch((e) => e);
    expect(err).toMatchObject({ details: { code: VISIT_START_LOCATION_CODE } });
    expect(err.message).toBe(START_LOCATION_ROUGH_MESSAGE);
    expect(sessionWrite(ctx)).toBeUndefined();
  });
});

describe('an Auntie inside the range', () => {
  it('goes On my way, and no arrival measurement is stamped for a step that is not an arrival', async () => {
    const ctx = seed();
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ON_MY_WAY', atIso: '2026-11-14T13:40:00Z', ...NEXT_DOOR, accuracyMeters: 8 }, AUNTIE),
    );
    expect(res).toMatchObject({ status: 'ON_MY_WAY', changed: true });
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'ON_MY_WAY', onMyWayAt: '2026-11-14T13:40:00Z' });
    expect(sessionWrite(ctx)?.data).not.toHaveProperty('arrivalDistanceMeters');
  });

  it('arrives, and the measurement goes on the visit as hers, not the owner\'s', async () => {
    const ctx = seed();
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', atIso: '2026-11-14T14:02:00Z', ...NEXT_DOOR, accuracyMeters: 8 }, AUNTIE),
    );
    expect(res).toMatchObject({ status: 'ARRIVED', changed: true, notified: true });
    const data = sessionWrite(ctx)?.data as Record<string, any>;
    expect(data).toMatchObject({
      status: 'ARRIVED',
      arrivedAt: '2026-11-14T14:02:00Z',
      arrivalAccuracyMeters: 8,
      arrivalCheckedByOwner: false,
    });
    expect(data.arrivalDistanceMeters).toBeGreaterThan(45);
    expect(data.arrivalDistanceMeters).toBeLessThan(55);
    expect(JSON.stringify(ctx.writes)).not.toContain(String(NEXT_DOOR.lat));
  });

  it('is not refused on a reading whose accuracy reaches back inside the range', async () => {
    seed({ settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 20 } });
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...NEXT_DOOR, accuracyMeters: 40 }, AUNTIE),
    );
    expect(res).toMatchObject({ status: 'ARRIVED' });
  });

  it("is held to the operator's range, not a fixed one", async () => {
    seed({ settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 20 } });
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED', ...NEXT_DOOR, accuracyMeters: 1 }, AUNTIE)),
    ).rejects.toMatchObject({ details: { code: VISIT_START_RANGE_CODE } });
  });
});

describe('a household with no map location', () => {
  it('lets an Auntie start, and says in the Activity Log that no range was checked', async () => {
    const ctx = seed({ household: { serviceAddress: '', serviceLocation: null } });
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE),
    );
    expect(res).toMatchObject({ status: 'ARRIVED', changed: true });
    expect(sessionWrite(ctx)?.data).toMatchObject({ arrivalDistanceMeters: null, arrivalCheckedByOwner: false });
    const line = audits().find((a: any) => a.event === 'VISIT_ARRIVAL_LOCATION_CHECK');
    expect(line).toMatchObject({
      severity: 'warn',
      description: "Marked the arrival with no range check: the household's location is not set",
    });
  });
});

describe('the owner, with arrival verification on', () => {
  it.each(['ON_MY_WAY', 'ARRIVED'] as const)('starts from outside the range on %s', async (action) => {
    const ctx = seed();
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action, ...ACROSS_TOWN, accuracyMeters: 10 }, OWNER),
    );
    expect(res).toMatchObject({ status: action, changed: true });
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: action });
  });

  it('has an outside arrival recorded on the visit as the owner\'s', async () => {
    const ctx = seed();
    await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, OWNER),
    );
    const data = sessionWrite(ctx)?.data as Record<string, any>;
    expect(data.arrivalCheckedByOwner).toBe(true);
    expect(data.arrivalDistanceMeters).toBeGreaterThan(1000);
  });

  it('starts with no location at all, as before', async () => {
    const ctx = seed();
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }, OWNER));
    expect(res).toMatchObject({ status: 'ARRIVED', changed: true });
    expect(sessionWrite(ctx)?.data).not.toHaveProperty('arrivalDistanceMeters');
  });
});

describe('arrival verification off', () => {
  const OFF = { requireArrivalDepartureVerification: false, arrivalRadiusMeters: 150 };

  it.each(['ON_MY_WAY', 'ARRIVED'] as const)('an Auntie across town does %s exactly as before', async (action) => {
    const ctx = seed({ settings: OFF });
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action, ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE),
    );
    expect(res).toMatchObject({ status: action, changed: true });
    // Nothing is measured, so nothing about a range is stamped or said.
    expect(sessionWrite(ctx)?.data).not.toHaveProperty('arrivalDistanceMeters');
    expect(sessionWrite(ctx)?.data).not.toHaveProperty('arrivalCheckedByOwner');
    expect(audits().some((a: any) => a.event === 'VISIT_LIFECYCLE_REFUSED')).toBe(false);
  });

  it('an Auntie with no location starts, when the switch was never saved (absent means off)', async () => {
    seed({ settings: {} });
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }, AUNTIE));
    expect(res).toMatchObject({ status: 'ARRIVED', changed: true });
  });
});

describe('steps the range does not gate', () => {
  it('an Auntie departs a started visit with no location', async () => {
    const ctx = seed({ session: { status: 'ARRIVED', arrivedAt: '2026-11-14T14:02:00Z' } });
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'DEPARTED' }, AUNTIE));
    expect(res).toMatchObject({ status: 'DEPARTED', changed: true });
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'DEPARTED' });
  });

  it('an Auntie undoes an arrival with no location', async () => {
    seed({ session: { status: 'ARRIVED', arrivedAt: '2026-11-14T14:02:00Z' } });
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }, AUNTIE));
    expect(res).toMatchObject({ status: 'SCHEDULED', changed: true });
  });

  // #2038: the undo clears what was measured for the arrival it takes back,
  // so the arrival after it stands on a measurement of its own.
  it('an undone arrival keeps none of its measurement', async () => {
    const ctx = seed({
      session: {
        status: 'ARRIVED',
        arrivedAt: '2026-11-14T14:02:00Z',
        arrivalDistanceMeters: 50,
        arrivalAccuracyMeters: 8,
        arrivalLocationCheckedAt: '2026-11-14T14:02:01Z',
        arrivalCheckedByOwner: false,
      },
    });
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }, AUNTIE));
    expect(sessionWrite(ctx)?.data).toMatchObject({
      status: 'SCHEDULED',
      arrivedAt: '',
      arrivalDistanceMeters: '',
      arrivalAccuracyMeters: '',
      arrivalLocationCheckedAt: '',
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('re-arriving after an undo is measured again: refused across town, taken next door', async () => {
    // The visit as an undo leaves it: back at On my way, the evidence blank.
    const undone = {
      status: 'ON_MY_WAY',
      onMyWayAt: '2026-11-14T13:40:00Z',
      arrivedAt: '',
      arrivalDistanceMeters: '',
      arrivalAccuracyMeters: '',
      arrivalLocationCheckedAt: '',
    };
    let ctx = seed({ session: undone });
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE)),
    ).rejects.toMatchObject({ details: { code: VISIT_START_RANGE_CODE } });
    expect(sessionWrite(ctx)).toBeUndefined();
    // And with no position at all she is refused too: the old arrival vouches for nothing.
    await expect(setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }, AUNTIE))).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    ctx = seed({ session: undone });
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', atIso: '2026-11-14T14:30:00Z', ...NEXT_DOOR, accuracyMeters: 8 }, AUNTIE),
    );
    expect(res).toMatchObject({ status: 'ARRIVED', changed: true });
    const data = sessionWrite(ctx)?.data as Record<string, any>;
    expect(data.arrivedAt).toBe('2026-11-14T14:30:00Z');
    expect(data.arrivalDistanceMeters).toBeGreaterThan(45);
    expect(data.arrivalDistanceMeters).toBeLessThan(55);
    expect(data.arrivalCheckedByOwner).toBe(false);
  });

  it('a second Arrived tap on a started visit is the usual no-op, not a range refusal', async () => {
    seed({ session: { status: 'ARRIVED', arrivedAt: '2026-11-14T14:02:00Z' } });
    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', ...ACROSS_TOWN, accuracyMeters: 10 }, AUNTIE),
    );
    expect(res).toMatchObject({ changed: false, status: 'ARRIVED' });
  });

  it('a start from the wrong state reports the wrong state, not the range', async () => {
    seed({ session: { status: 'DEPARTED' } });
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ON_MY_WAY', ...ACROSS_TOWN }, AUNTIE)),
    ).rejects.toMatchObject({ details: { code: 'visit_lifecycle_illegal' } });
  });
});

describe('auntieStartDecision: the whole policy, one row each', () => {
  const base = { distanceMeters: 40, reason: null, geocodedNow: false };

  it('within: yes', () => {
    expect(auntieStartDecision({ ...base, status: 'within' })).toEqual({ allow: true, unchecked: false });
  });

  it('outside: no, with the distance in the sentence', () => {
    const d = auntieStartDecision({ ...base, status: 'outside', distanceMeters: 2300 });
    expect(d).toMatchObject({ allow: false, code: VISIT_START_RANGE_CODE, message: startOutsideRangeMessage(2300) });
    expect(startOutsideRangeMessage(2300)).toBe(
      'You are 2.3 km from this household. You need to be at the property to start this visit. ' +
        'The owner can start it if you cannot get there.',
    );
    expect(startOutsideRangeMessage(480)).toContain('You are 480 m from this household.');
  });

  it('no location sent: no', () => {
    expect(auntieStartDecision({ status: 'no_fix' })).toMatchObject({ allow: false, code: VISIT_START_LOCATION_CODE });
  });

  it('a location too rough to use: no', () => {
    expect(auntieStartDecision({ ...base, status: 'unverified', reason: 'fix_too_imprecise' })).toMatchObject({
      allow: false,
      code: VISIT_START_LOCATION_CODE,
    });
  });

  it('a household with no map location: yes, recorded as unchecked', () => {
    expect(
      auntieStartDecision({ status: 'household_location_unknown', distanceMeters: null, reason: 'no_address', geocodedNow: false }),
    ).toEqual({ allow: true, unchecked: true });
  });

  it('no refusal names Settings, the size of the range, or uses a dash for a pause', () => {
    for (const m of [startOutsideRangeMessage(900), START_LOCATION_MISSING_MESSAGE, START_LOCATION_ROUGH_MESSAGE]) {
      expect(m).not.toMatch(/Settings|radius|within \d|—|–/);
      expect(m).toMatch(/owner/);
      expect(m).toMatch(/at the property/);
    }
  });
});
