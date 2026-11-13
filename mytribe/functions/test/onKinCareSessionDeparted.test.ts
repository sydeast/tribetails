import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2123 (operator ruling 2026-11-12): a visit is Completed as soon as the
 * Auntie has departed. Sending a KinTale never decides it. With "KinTale
 * required" on, the completion leaves `kinTaleDue: true` for the Auntie's task.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import {
  completeDepartedSession,
  departedNow,
  onKinCareSessionDepartedHandler,
} from '../src/triggers/onKinCareSessionDeparted';

const SESSION = 'kin_care_sessions/s1';
const SETTINGS = 'business_settings/business_settings';
const VISIT = 'families/kf1/bookings/b1/kinCares/v1';
const DEPARTED_AT = '2026-11-12T15:30:00Z';

function departedSession(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'DEPARTED',
    kinfolkId: 'kf1',
    kinCareBatchId: 'b1',
    kinCareVisitId: 'v1',
    arrivedAt: '2026-11-12T15:00:00Z',
    departedAt: DEPARTED_AT,
    ...extra,
  };
}

function seed(opts: {
  session?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
  visit?: Record<string, unknown> | null;
}) {
  const docs: Record<string, Record<string, unknown>> = {};
  if (opts.session !== null) docs[SESSION] = opts.session ?? departedSession();
  if (opts.settings) docs[SETTINGS] = opts.settings;
  if (opts.visit !== null) docs[VISIT] = opts.visit ?? { status: 'confirmed' };
  const ctx = buildDbMock({ docs });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

function event(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined) {
  const snap = (data: Record<string, unknown> | undefined) =>
    data === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => data };
  return { params: { sessionId: 's1' }, data: { before: snap(before), after: snap(after) } } as never;
}

const sessionWrite = (ctx: ReturnType<typeof buildDbMock>) => ctx.writes.find((w) => w.path === SESSION);
const visitWrite = (ctx: ReturnType<typeof buildDbMock>) => ctx.writes.find((w) => w.path === VISIT);
const audits = () => mocks.writeAuditEntryFn.mock.calls.map((c) => c[0] as Record<string, any>);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
  mocks.logEventFn.mockReset();
});

describe('departedNow', () => {
  it('fires on the write that moves a visit to DEPARTED, from any earlier step', () => {
    expect(departedNow({ status: 'ARRIVED' }, { status: 'DEPARTED' })).toBe(true);
    expect(departedNow(undefined, { status: 'DEPARTED' })).toBe(true);
    expect(departedNow({ status: 'arrived' }, { status: ' departed ' })).toBe(true);
  });

  it('does not fire again on a later write to a visit that was already DEPARTED', () => {
    expect(departedNow({ status: 'DEPARTED' }, { status: 'DEPARTED', notes: 'x' })).toBe(false);
  });

  it('ignores every other step, a deletion and its own completion write', () => {
    expect(departedNow({ status: 'ON_MY_WAY' }, { status: 'ARRIVED' })).toBe(false);
    expect(departedNow({ status: 'DEPARTED' }, { status: 'COMPLETED' })).toBe(false);
    expect(departedNow({ status: 'DEPARTED' }, undefined)).toBe(false);
    expect(departedNow({ status: 'ARRIVED' }, { status: 42 })).toBe(false);
  });
});

describe('a visit is Completed at departure', () => {
  it('completes the session at its departure time and moves the household copy', async () => {
    const ctx = seed({});
    await onKinCareSessionDepartedHandler(event({ status: 'ARRIVED' }, departedSession()));

    expect(sessionWrite(ctx)?.data).toMatchObject({
      status: 'COMPLETED',
      completedAt: DEPARTED_AT,
      updatedAt: '__TS__',
    });
    expect(visitWrite(ctx)?.data).toMatchObject({ status: 'completed', updatedAt: '__TS__' });
    expect(audits()).toEqual([
      expect.objectContaining({
        event: 'BOOKING_STATUS_TRANSITION',
        status: 'SUCCESS',
        actorRole: 'SYSTEM',
        targetUid: 's1',
        targetCollection: 'kin_care_sessions',
        description: 'Completed the visit: departed to completed',
        payload: expect.objectContaining({
          action: 'COMPLETE',
          from: 'DEPARTED',
          to: 'COMPLETED',
          trigger: 'departure',
          kinTaleDue: true,
          visitMirrored: 'completed',
        }),
      }),
    ]);
  });

  it('never needs a KinTale: an unsent visit with the switch off completes the same', async () => {
    const ctx = seed({ settings: { kinTaleRequired: false } });
    const outcome = await completeDepartedSession('s1');
    expect(outcome).toEqual({ kind: 'completed', kinTaleDue: false });
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'COMPLETED' });
    expect(sessionWrite(ctx)?.data).not.toHaveProperty('kinTaleDue');
  });

  it('with KinTale required (absent reads on) an unsent visit is left owing one', async () => {
    const ctx = seed({});
    expect(await completeDepartedSession('s1')).toEqual({ kind: 'completed', kinTaleDue: true });
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'COMPLETED', kinTaleDue: true });
  });

  it('a KinTale already sent before departure owes nothing', async () => {
    const ctx = seed({ session: departedSession({ sentReportCount: 1, reportIds: ['r1'] }) });
    expect(await completeDepartedSession('s1')).toEqual({ kind: 'completed', kinTaleDue: false });
    expect(sessionWrite(ctx)?.data).not.toHaveProperty('kinTaleDue');
  });

  it('a draft started before departure still leaves the KinTale owed', async () => {
    // Android lists a draft's id on `reportIds` when it is created; only a send bumps the count.
    const ctx = seed({ session: departedSession({ reportIds: ['draft1'] }) });
    expect(await completeDepartedSession('s1')).toEqual({ kind: 'completed', kinTaleDue: true });
    expect(sessionWrite(ctx)?.data).toMatchObject({ kinTaleDue: true });
  });

  it('a session with no departure stamp completes now', async () => {
    const ctx = seed({ session: departedSession({ departedAt: '' }) });
    await completeDepartedSession('s1', '2026-11-12T16:00:00.000Z');
    expect(sessionWrite(ctx)?.data).toMatchObject({ completedAt: '2026-11-12T16:00:00.000Z' });
  });

  it('a session with no household copy completes without writing one', async () => {
    const ctx = seed({ visit: null });
    expect((await completeDepartedSession('s1')).kind).toBe('completed');
    expect(visitWrite(ctx)).toBeUndefined();
    expect(ctx.writes.map((w) => w.path)).toEqual([SESSION]);
  });

  it('a household copy that is already cancelled is left alone', async () => {
    const ctx = seed({ visit: { status: 'cancelled' } });
    await completeDepartedSession('s1');
    expect(visitWrite(ctx)).toBeUndefined();
  });
});

describe('what it leaves alone', () => {
  it('does nothing for a write that is not a departure', async () => {
    const ctx = seed({});
    await onKinCareSessionDepartedHandler(event({ status: 'ON_MY_WAY' }, { status: 'ARRIVED' }));
    await onKinCareSessionDepartedHandler(event({ status: 'DEPARTED' }, { status: 'COMPLETED' }));
    await onKinCareSessionDepartedHandler(event({ status: 'DEPARTED' }, undefined));
    expect(ctx.writes).toEqual([]);
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('a visit that moved on before the trigger ran (undone, or completed by hand) is not touched', async () => {
    for (const status of ['ARRIVED', 'COMPLETED', 'CANCELLED']) {
      const ctx = seed({ session: departedSession({ status }) });
      expect(await completeDepartedSession('s1')).toEqual({ kind: 'skipped', status });
      expect(ctx.writes).toEqual([]);
    }
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('a session that is gone is skipped', async () => {
    const ctx = seed({ session: null });
    expect(await completeDepartedSession('s1')).toEqual({ kind: 'skipped', status: '' });
    expect(ctx.writes).toEqual([]);
  });
});

describe("the operator's arrival rule still applies", () => {
  it('with no arrival recorded the visit stays Departed and the refusal is in the Activity Log', async () => {
    const ctx = seed({
      settings: { requireArrivalDepartureVerification: true },
      session: departedSession({ arrivedAt: '' }),
    });
    const outcome = await completeDepartedSession('s1');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'arrival_verification_required' });
    expect(ctx.writes).toEqual([]);
    expect(audits()).toEqual([
      expect.objectContaining({
        event: 'BOOKING_TRANSITION_REFUSED',
        status: 'FAILURE',
        actorRole: 'SYSTEM',
        description: 'Could not complete the visit: no arrival recorded',
        payload: expect.objectContaining({ refusalCode: 'arrival_verification_required', trigger: 'departure' }),
      }),
    ]);
  });

  it('an arrival recorded outside the radius stays Departed', async () => {
    const ctx = seed({
      settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
      session: departedSession({ arrivalDistanceMeters: 2000, arrivalAccuracyMeters: 10 }),
    });
    const outcome = await completeDepartedSession('s1');
    expect(outcome).toMatchObject({ kind: 'refused', code: 'arrival_outside_radius' });
    expect(ctx.writes).toEqual([]);
    expect(audits()[0]).toMatchObject({
      description: 'Could not complete the visit: arrival was recorded 2000m from the household (radius 150m)',
    });
  });

  it('an arrival inside the radius completes, and the verdict is kept', async () => {
    const ctx = seed({
      settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
      session: departedSession({ arrivalDistanceMeters: 20, arrivalAccuracyMeters: 10 }),
    });
    expect((await completeDepartedSession('s1')).kind).toBe('completed');
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'COMPLETED' });
    expect(audits()[0]?.payload).toMatchObject({ arrivalLocationVerdict: 'within' });
  });
});

describe('errors', () => {
  it('a failed write is thrown for the trigger wrapper to report, and nothing is audited as done', async () => {
    const ctx = seed({});
    (ctx.db as { runTransaction: unknown }).runTransaction = vi.fn(async () => {
      throw new Error('aborted');
    });
    await expect(onKinCareSessionDepartedHandler(event({ status: 'ARRIVED' }, departedSession()))).rejects.toThrow(
      'aborted',
    );
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('a failed audit write does not undo or fail the completion', async () => {
    const ctx = seed({});
    mocks.writeAuditEntryFn.mockRejectedValue(new Error('audit down'));
    expect((await completeDepartedSession('s1')).kind).toBe('completed');
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'COMPLETED' });
  });
});
