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
  ARRIVAL_VERIFICATION_CODE,
  arrivalVerificationMessage,
  isArrivalVerificationRequired,
  missingVisitSteps,
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
