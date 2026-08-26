import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});
import { transitionBookingStatusHandler } from '../src/admin/transitionBookingStatus';
import {
  ARRIVAL_RADIUS_CODE,
  ARRIVAL_RADIUS_DEFAULT_METERS,
  ARRIVAL_RADIUS_MAX_METERS,
  ARRIVAL_RADIUS_MIN_METERS,
  ARRIVAL_VERIFICATION_CODE,
  arrivalRadiusMessage,
  arrivalVerificationMessage,
  isArrivalVerificationRequired,
  missingVisitSteps,
  readArrivalEvidence,
  readArrivalRadiusMeters,
  readArrivalSettings,
} from '../src/lib/arrivalVerification';

/**
 * ISSUE #519: `requireArrivalDepartureVerification` decides whether a visit may
 * be closed as COMPLETE without having been arrived at and departed from.
 *
 * The field had a control on three surfaces and no reader; `transitionBookingStatus`
 * completed any legally-transitionable visit whatever it said.
 */

function fs(data: Record<string, unknown> | undefined) {
  return { doc: () => ({ get: async () => ({ data: () => data }) }) } as never;
}

describe('isArrivalVerificationRequired', () => {
  it('is on only when the operator explicitly switched it on', async () => {
    expect(await isArrivalVerificationRequired(fs({ requireArrivalDepartureVerification: true }))).toBe(true);
  });

  /**
   * The opposite of the other #519 gates, and deliberately. Those wrapped a live
   * behaviour whose flag was unread, so absent had to mean ON. This one is a NEW
   * restriction, and a restriction nobody switched on must not switch itself on
   * across every install the moment it ships.
   */
  it('is OFF when the key is absent, so no deploy starts refusing COMPLETE', async () => {
    expect(await isArrivalVerificationRequired(fs({}))).toBe(false);
    expect(await isArrivalVerificationRequired(fs(undefined))).toBe(false);
  });

  it('is off when explicitly false', async () => {
    expect(await isArrivalVerificationRequired(fs({ requireArrivalDepartureVerification: false }))).toBe(false);
  });

  it('is off when the settings read fails, because an error is not an operator asking for a rule', async () => {
    const broken = { doc: () => ({ get: async () => { throw new Error('offline'); } }) } as never;
    expect(await isArrivalVerificationRequired(broken)).toBe(false);
  });
});

describe('missingVisitSteps', () => {
  it('finds nothing missing on a fully recorded visit', () => {
    expect(missingVisitSteps({ arrivedAt: '2026-08-24T10:00:00Z', departedAt: '2026-08-24T11:00:00Z' })).toEqual([]);
  });

  it('names both steps on a visit that recorded neither', () => {
    expect(missingVisitSteps({})).toEqual(['arrival', 'departure']);
  });

  /** Both fields default to `""` on the model, so blank is the usual "not stamped". */
  it('treats a blank stamp as not recorded, not as recorded', () => {
    expect(missingVisitSteps({ arrivedAt: '', departedAt: '   ' })).toEqual(['arrival', 'departure']);
  });

  it('names just the departure when only the arrival landed', () => {
    expect(missingVisitSteps({ arrivedAt: '2026-08-24T10:00:00Z' })).toEqual(['departure']);
  });

  it('ignores a non-string stamp rather than trusting it', () => {
    expect(missingVisitSteps({ arrivedAt: 12345, departedAt: null })).toEqual(['arrival', 'departure']);
  });
});

describe('arrivalVerificationMessage', () => {
  it('names both steps, and says how to proceed either way', () => {
    const msg = arrivalVerificationMessage(['arrival', 'departure']);
    expect(msg).toContain('arrival and departure');
    expect(msg).toContain('Verify arrival and departure');
  });

  it('names one step when only one is missing', () => {
    expect(arrivalVerificationMessage(['departure'])).toContain('no departure recorded');
  });

  it('exports a machine-readable code so a client can branch on it', () => {
    expect(ARRIVAL_VERIFICATION_CODE).toBe('arrival_verification_required');
  });
});

// ── through the callable, which is where the requirement actually bites ─────
function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}
/** A db with one DEPARTED session and a settings doc. */
function seed(settings: Record<string, unknown>, session: Record<string, unknown>) {
  const ctx = buildDbMock({
    docs: {
      'kin_care_sessions/s1': { kinfolkId: 'kf1', status: 'DEPARTED', ...session },
      'business_settings/business_settings': settings,
    },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}
describe('transitionBookingStatus COMPLETE honours the switch', () => {
  beforeEach(() => {
    mocks.dbFn.mockReset();
    mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-1');
  });
  it('REFUSES a visit that was never arrived at, when the operator requires it', async () => {
    seed({ requireArrivalDepartureVerification: true }, { arrivedAt: '', departedAt: '' });
    await expect(transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' })))
      .rejects.toMatchObject({
        code: 'failed-precondition',
        details: { code: ARRIVAL_VERIFICATION_CODE, missing: ['arrival', 'departure'] },
      });
  });
  it('completes the same visit once both steps are recorded', async () => {
    seed(
      { requireArrivalDepartureVerification: true },
      { arrivedAt: '2026-08-24T10:00:00Z', departedAt: '2026-08-24T11:00:00Z' },
    );
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    expect(res).toMatchObject({ status: 'COMPLETED' });
  });
  it('completes an unstamped visit when the operator has NOT switched the rule on', async () => {
    seed({}, { arrivedAt: '', departedAt: '' });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    expect(res).toMatchObject({ status: 'COMPLETED' });
  });
  /** The rule is about closing a visit as done, not about abandoning one. */
  it('never blocks CANCEL, however unstamped the visit is', async () => {
    seed({ requireArrivalDepartureVerification: true }, { arrivedAt: '', departedAt: '' });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));
    expect(res).toMatchObject({ status: 'CANCELLED' });
  });
  it('audits the refusal rather than failing silently', async () => {
    seed({ requireArrivalDepartureVerification: true }, {});
    await expect(transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }))).rejects.toThrow();
    const refusal = mocks.writeAuditEntryFn.mock.calls.find(
      (c) => c[0]?.payload?.refusalCode === ARRIVAL_VERIFICATION_CODE,
    );
    expect(refusal).toBeDefined();
    expect(refusal?.[0]?.status).toBe('FAILURE');
  });
});

// ── ISSUE #582: the second gate, distance ────────────────────────────────────

describe('readArrivalRadiusMeters', () => {
  it('defaults to 150 m when the operator has not set one', () => {
    expect(readArrivalRadiusMeters(undefined)).toBe(ARRIVAL_RADIUS_DEFAULT_METERS);
    expect(readArrivalRadiusMeters(null)).toBe(ARRIVAL_RADIUS_DEFAULT_METERS);
    expect(readArrivalRadiusMeters('150')).toBe(ARRIVAL_RADIUS_DEFAULT_METERS);
    expect(readArrivalRadiusMeters(Number.NaN)).toBe(ARRIVAL_RADIUS_DEFAULT_METERS);
  });

  it('takes the operator value when there is one', () => {
    expect(readArrivalRadiusMeters(400)).toBe(400);
  });

  /**
   * Clamped, not refused. A settings document written before the rules guard
   * existed, or by a future client, must still yield a usable radius rather
   * than making a visit uncompletable.
   */
  it('clamps a value outside the bounds instead of refusing to read it', () => {
    expect(readArrivalRadiusMeters(1)).toBe(ARRIVAL_RADIUS_MIN_METERS);
    expect(readArrivalRadiusMeters(-9000)).toBe(ARRIVAL_RADIUS_MIN_METERS);
    expect(readArrivalRadiusMeters(9_999_999)).toBe(ARRIVAL_RADIUS_MAX_METERS);
  });

  it('rounds a fractional radius to whole metres', () => {
    expect(readArrivalRadiusMeters(120.6)).toBe(121);
  });
});

describe('readArrivalSettings', () => {
  it('reads both halves of the policy from one document', async () => {
    expect(
      await readArrivalSettings(
        fs({ requireArrivalDepartureVerification: true, arrivalRadiusMeters: 300 }),
      ),
    ).toEqual({ required: true, radiusMeters: 300 });
  });

  it('falls back to the default radius on a settings read that failed', async () => {
    const broken = { doc: () => ({ get: async () => { throw new Error('offline'); } }) } as never;
    expect(await readArrivalSettings(broken)).toEqual({
      required: false,
      radiusMeters: ARRIVAL_RADIUS_DEFAULT_METERS,
    });
  });
});

describe('readArrivalEvidence', () => {
  it('reads the measured distance and error bar off the session', () => {
    expect(
      readArrivalEvidence({ arrivalDistanceMeters: 42.5, arrivalAccuracyMeters: 8 }),
    ).toEqual({ distanceMeters: 42.5, accuracyMeters: 8 });
  });

  it('treats a missing, blank or non-numeric reading as no evidence', () => {
    expect(readArrivalEvidence({})).toEqual({ distanceMeters: null, accuracyMeters: null });
    expect(readArrivalEvidence({ arrivalDistanceMeters: null })).toMatchObject({
      distanceMeters: null,
    });
    expect(readArrivalEvidence({ arrivalDistanceMeters: '42' })).toMatchObject({
      distanceMeters: null,
    });
  });
});

describe('arrivalRadiusMessage', () => {
  it('names the distance AND the radius, so a tight setting is distinguishable from a real miss', () => {
    const msg = arrivalRadiusMessage(2400, 150);
    expect(msg).toContain('2.4 km');
    expect(msg).toContain('150 m');
  });

  it('offers both remedies: record it again, or widen the setting', () => {
    const msg = arrivalRadiusMessage(2400, 150);
    expect(msg).toContain('Arrival must be within');
    expect(msg).toContain('Verify arrival and departure');
  });

  it('is a different code from the missing-step refusal, so a client can tell them apart', () => {
    expect(ARRIVAL_RADIUS_CODE).toBe('arrival_outside_radius');
    expect(ARRIVAL_RADIUS_CODE).not.toBe(ARRIVAL_VERIFICATION_CODE);
  });
});

describe('transitionBookingStatus COMPLETE honours the arrival radius', () => {
  const stamped = { arrivedAt: '2026-08-25T10:00:00Z', departedAt: '2026-08-25T11:00:00Z' };

  beforeEach(() => {
    mocks.dbFn.mockReset();
    mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-1');
  });

  it('REFUSES a visit whose arrival was recorded well outside the radius', async () => {
    seed(
      { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
      { ...stamped, arrivalDistanceMeters: 2400, arrivalAccuracyMeters: 10 },
    );
    await expect(transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' })))
      .rejects.toMatchObject({
        code: 'failed-precondition',
        details: { code: ARRIVAL_RADIUS_CODE, distanceMeters: 2400, radiusMeters: 150 },
      });
  });

  it('completes a visit whose arrival was recorded at the household', async () => {
    seed(
      { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
      { ...stamped, arrivalDistanceMeters: 30, arrivalAccuracyMeters: 8 },
    );
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    expect(res).toMatchObject({ status: 'COMPLETED' });
  });

  /**
   * THE MOST IMPORTANT CASE IN THIS FILE. No fix, an offline arrival, a
   * household that will not geocode, an arrival recorded from the desktop
   * console which has no GPS at all — the server cannot tell any of them from
   * an honest Auntie in a basement, and refusing would strand her.
   */
  it('COMPLETES a visit with no location evidence at all, and records that it was unverified', async () => {
    seed({ requireArrivalDepartureVerification: true }, stamped);
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    expect(res).toMatchObject({ status: 'COMPLETED' });
    const success = mocks.writeAuditEntryFn.mock.calls.find(
      (c) => c[0]?.event === 'BOOKING_STATUS_TRANSITION',
    );
    expect(success?.[0]?.payload?.arrivalLocationVerdict).toBe('unverified');
  });

  it('records a verified completion as verified, so the two are distinguishable after the fact', async () => {
    seed(
      { requireArrivalDepartureVerification: true },
      { ...stamped, arrivalDistanceMeters: 30, arrivalAccuracyMeters: 8 },
    );
    await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    const success = mocks.writeAuditEntryFn.mock.calls.find(
      (c) => c[0]?.event === 'BOOKING_STATUS_TRANSITION',
    );
    expect(success?.[0]?.payload?.arrivalLocationVerdict).toBe('within');
  });

  /** The error bar is spent in the Auntie's favour: 200 m ± 90 m could be 110 m. */
  it('does not refuse a reading whose accuracy reaches back inside the radius', async () => {
    seed(
      { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
      { ...stamped, arrivalDistanceMeters: 200, arrivalAccuracyMeters: 90 },
    );
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    expect(res).toMatchObject({ status: 'COMPLETED' });
  });

  it('does not apply the radius at all when the operator has the rule switched off', async () => {
    seed({ arrivalRadiusMeters: 150 }, { ...stamped, arrivalDistanceMeters: 9000 });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    expect(res).toMatchObject({ status: 'COMPLETED' });
    const success = mocks.writeAuditEntryFn.mock.calls.find(
      (c) => c[0]?.event === 'BOOKING_STATUS_TRANSITION',
    );
    expect(success?.[0]?.payload?.arrivalLocationVerdict).toBe('not_checked');
  });

  /** Ordering: a visit with no arrival at all must report the missing step, not a distance it could not have. */
  it('reports the missing step before the distance when both would fail', async () => {
    seed(
      { requireArrivalDepartureVerification: true },
      { arrivedAt: '', departedAt: '', arrivalDistanceMeters: 9000 },
    );
    await expect(transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' })))
      .rejects.toMatchObject({ details: { code: ARRIVAL_VERIFICATION_CODE } });
  });

  it('never blocks CANCEL on distance, however far away the arrival was', async () => {
    seed(
      { requireArrivalDepartureVerification: true },
      { ...stamped, arrivalDistanceMeters: 9000, arrivalAccuracyMeters: 5 },
    );
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));
    expect(res).toMatchObject({ status: 'CANCELLED' });
  });

  it('audits the distance refusal, with the distance and the radius but no coordinate', async () => {
    seed(
      { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
      { ...stamped, arrivalDistanceMeters: 2400, arrivalAccuracyMeters: 10 },
    );
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' })),
    ).rejects.toThrow();
    const refusal = mocks.writeAuditEntryFn.mock.calls.find(
      (c) => c[0]?.payload?.refusalCode === ARRIVAL_RADIUS_CODE,
    );
    expect(refusal?.[0]).toMatchObject({ status: 'FAILURE', severity: 'warn' });
    expect(refusal?.[0]?.description).toContain('2400m from the household');
  });
});
