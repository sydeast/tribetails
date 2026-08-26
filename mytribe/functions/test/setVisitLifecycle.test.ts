import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), dispatch: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
// The household notification. Mocked at the CORE rather than at the callable,
// because that is the seam `setVisitLifecycle` actually reaches: the whole point
// of lifting it out of the wrapper was that the web path never makes a second
// client call. See dispatchVisitNotification.ts's header.
vi.mock('../src/admin/dispatchVisitNotification', () => ({
  dispatchVisitNotificationCore: mocks.dispatch,
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { setVisitLifecycleHandler } from '../src/admin/setVisitLifecycle';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';
import { ARRIVAL_EVIDENCE_FIELDS } from '../src/lib/arrivalVerification';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.dispatch.mockReset();
  mocks.dispatch.mockResolvedValue({ ok: true, dispatchIds: ['d1'], suppressed: false });
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true, name: 'Auntie Jo' } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const visit = (extra: Record<string, unknown> = {}) => ({
  kinfolkId: 'fam1',
  kinCareBatchId: 'batch1',
  kinCareVisitId: 'visit1',
  status: 'SCHEDULED',
  startTime: '2026-08-24T14:00:00Z',
  ...extra,
});

function seed(sessions: Record<string, Record<string, unknown> | null>) {
  const docs: Record<string, Record<string, unknown> | null> = {};
  for (const [id, data] of Object.entries(sessions)) docs[`kin_care_sessions/${id}`] = data;
  return buildDbMock({ docs });
}

function writeAt(ctx: ReturnType<typeof seed>, id: string) {
  return ctx.writes.find((w) => w.path === `kin_care_sessions/${id}`);
}

function auditOf(event: string) {
  return (writeAuditEntry as any).mock.calls.map((c: any[]) => c[0]).find((a: any) => a.event === event);
}

describe('clocking a visit in', () => {
  it('stamps arrivedAt, moves the status, and tells the household', async () => {
    const ctx = seed({ s1: visit({ status: 'ON_MY_WAY', onMyWayAt: '2026-08-24T13:40:00Z' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', atIso: '2026-08-24T14:02:00Z' }),
    );

    expect(res).toMatchObject({
      ok: true,
      from: 'ON_MY_WAY',
      status: 'ARRIVED',
      changed: true,
      notified: true,
      notifySkipped: null,
    });
    const write = writeAt(ctx, 's1');
    expect(write?.merge).toBe(true);
    expect(write?.data).toMatchObject({
      status: 'ARRIVED',
      arrivedAt: '2026-08-24T14:02:00Z',
      updatedBy: 'admin1',
    });
    // The clock is not the office's completion decision: nothing terminal is
    // written, and `firestore.rules` would refuse it from a client anyway.
    expect(write?.data).not.toHaveProperty('completedAt');
    expect(mocks.dispatch).toHaveBeenCalledWith(
      { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'arrived' },
      'admin1',
      'Auntie Jo',
    );
    expect(auditOf(AUDIT_EVENTS.VISIT_LIFECYCLE_SET)).toMatchObject({
      status: 'SUCCESS',
      payload: { from: 'ON_MY_WAY', to: 'ARRIVED', changed: true, notified: true },
    });
  });

  it('clocks in straight from SCHEDULED, because Android does', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));
    expect(res).toMatchObject({ from: 'SCHEDULED', status: 'ARRIVED', changed: true });
  });

  it('stamps its own instant when the caller states none', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));
    expect(String(writeAt(ctx, 's1')?.data.arrivedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('a double clock-in cannot move the arrival time', () => {
  it('writes NOTHING and reports changed:false', async () => {
    const ctx = seed({ s1: visit({ status: 'ARRIVED', arrivedAt: '2026-08-24T14:02:00Z' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ARRIVED', atIso: '2026-08-24T16:30:00Z' }),
    );

    expect(res).toMatchObject({ ok: true, from: 'ARRIVED', status: 'ARRIVED', changed: false });
    // THE ASSERTION THAT MATTERS: the first arrival time survives, because no
    // write was issued at all.
    expect(writeAt(ctx, 's1')).toBeUndefined();
    // And the household is not told twice.
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe('clocking out', () => {
  it('stamps departedAt from ARRIVED and notifies', async () => {
    const ctx = seed({ s1: visit({ status: 'ARRIVED', arrivedAt: '2026-08-24T14:02:00Z' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'DEPARTED', atIso: '2026-08-24T14:45:00Z' }),
    );

    expect(res).toMatchObject({ status: 'DEPARTED', changed: true, notified: true });
    expect(writeAt(ctx, 's1')?.data).toMatchObject({
      status: 'DEPARTED',
      departedAt: '2026-08-24T14:45:00Z',
    });
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({ event: 'departed' });
  });

  it('REFUSES a clock-out on a visit nobody clocked into, and audits the attempt', async () => {
    const ctx = seed({ s1: visit({ status: 'SCHEDULED' }) });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(setVisitLifecycleHandler(req({ sessionId: 's1', action: 'DEPARTED' }))).rejects.toThrow(
      /Cannot clock out of this visit while it is SCHEDULED/,
    );

    expect(writeAt(ctx, 's1')).toBeUndefined();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    const audit = auditOf(AUDIT_EVENTS.VISIT_LIFECYCLE_REFUSED);
    expect(audit).toMatchObject({
      status: 'FAILURE',
      severity: 'warn',
      payload: { action: 'DEPARTED', refusalCode: 'visit_lifecycle_illegal', from: 'SCHEDULED' },
    });
  });

  it('carries a machine-readable code the client can match on', async () => {
    const ctx = seed({ s1: visit({ status: 'ON_MY_WAY' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'DEPARTED' })).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe('failed-precondition');
    expect((err as HttpsError).details).toMatchObject({
      code: 'visit_lifecycle_illegal',
      from: 'ON_MY_WAY',
      allowedFrom: ['ARRIVED'],
    });
  });
});

describe('on my way', () => {
  it('stamps onMyWayAt and the ETA, and forwards the ETA to the household', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);

    await setVisitLifecycleHandler(
      req({ sessionId: 's1', action: 'ON_MY_WAY', atIso: '2026-08-24T13:40:00Z', etaMinutes: 20 }),
    );

    expect(writeAt(ctx, 's1')?.data).toMatchObject({
      status: 'ON_MY_WAY',
      onMyWayAt: '2026-08-24T13:40:00Z',
      etaMinutesAway: 20,
    });
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({ event: 'on_my_way', etaMinutes: 20 });
  });

  it('refuses from ARRIVED: a visit already in progress is not on its way', async () => {
    const ctx = seed({ s1: visit({ status: 'ARRIVED' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ON_MY_WAY' })),
    ).rejects.toThrow(/while it is ARRIVED/);
  });
});

describe('undoing an arrival', () => {
  it('goes back to ON_MY_WAY when one was declared, and clears the stamps', async () => {
    const ctx = seed({
      s1: visit({
        status: 'ARRIVED',
        onMyWayAt: '2026-08-24T13:40:00Z',
        arrivedAt: '2026-08-24T14:02:00Z',
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }));

    expect(res).toMatchObject({ from: 'ARRIVED', status: 'ON_MY_WAY', changed: true });
    expect(writeAt(ctx, 's1')?.data).toMatchObject({ status: 'ON_MY_WAY', arrivedAt: '' });
    // The on-my-way itself is NOT cleared: it is the evidence of where to go
    // back to, and clearing it would make a second undo land somewhere else.
    expect(writeAt(ctx, 's1')?.data).not.toHaveProperty('onMyWayAt');
    // Nobody is told an arrival was undone.
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('goes back to SCHEDULED when none was', async () => {
    const ctx = seed({ s1: visit({ status: 'ARRIVED', arrivedAt: '2026-08-24T14:02:00Z' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }));
    expect(res).toMatchObject({ status: 'SCHEDULED' });
  });

  // The one deliberate divergence from Android, pinned so it cannot be lost.
  // Android clears `arrivedAt` alone, leaving a departure on a visit that has
  // not started -- and `missingVisitSteps` reads both fields to decide whether a
  // COMPLETE is allowed, so the stale value is not cosmetic.
  it('clears departedAt too when undoing from DEPARTED', async () => {
    const ctx = seed({
      s1: visit({
        status: 'DEPARTED',
        arrivedAt: '2026-08-24T14:02:00Z',
        departedAt: '2026-08-24T14:45:00Z',
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }));
    expect(writeAt(ctx, 's1')?.data).toMatchObject({ arrivedAt: '', departedAt: '' });
  });
  /**
   * ISSUE #582, arriving after this callable did. `verifyVisitArrival` stamps
   * how far from the household an arrival was recorded, and
   * `transitionBookingStatus` refuses a COMPLETE on a measurement outside the
   * operator's radius. The measurement belongs to the arrival being undone, so
   * leaving it lets the NEXT arrival, quite possibly at a different door and
   * quite possibly offline with no measurement of its own, inherit it. Wrong
   * evidence can refuse a COMPLETE that should pass as easily as pass one that
   * should be refused.
   *
   * The Android and desktop Auntie Time cards clear the same three fields on
   * their own direct undo patch, which does not come through here.
   */
  it('clears the arrival-location evidence, so a later arrival cannot inherit it', async () => {
    const ctx = seed({
      s1: visit({
        status: 'ARRIVED',
        arrivedAt: '2026-08-24T14:02:00Z',
        arrivalDistanceMeters: 2400,
        arrivalAccuracyMeters: 10,
        arrivalLocationCheckedAt: '2026-08-24T14:02:03Z',
      }),
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }));
    expect(writeAt(ctx, 's1')?.data).toMatchObject({
      arrivalDistanceMeters: '',
      arrivalAccuracyMeters: '',
      arrivalLocationCheckedAt: '',
    });
  });
  /** Every field the shared list names is cleared; a field added there cannot be forgotten here. */
  it('clears every field the shared evidence list names', async () => {
    const ctx = seed({ s1: visit({ status: 'ARRIVED', arrivedAt: '2026-08-24T14:02:00Z' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_ARRIVAL' }));
    const written = writeAt(ctx, 's1')?.data ?? {};
    for (const field of ARRIVAL_EVIDENCE_FIELDS) {
      expect(written[field]).toBe('');
    }
  });
  /** A forward clock-in must not wipe anything; only the undo clears. */
  it('does NOT clear the evidence on a plain arrival', async () => {
    const ctx = seed({ s1: visit({ status: 'ON_MY_WAY', onMyWayAt: '2026-08-24T13:40:00Z' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));
    const written = writeAt(ctx, 's1')?.data ?? {};
    for (const field of ARRIVAL_EVIDENCE_FIELDS) {
      expect(written).not.toHaveProperty(field);
    }
  });
});

describe('what it refuses outright', () => {
  it('a session that is not there', async () => {
    const ctx = seed({ s1: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }))).rejects.toThrow(
      /not found/i,
    );
    expect(auditOf(AUDIT_EVENTS.VISIT_LIFECYCLE_REFUSED)).toMatchObject({
      payload: { refusalCode: 'not_found' },
    });
  });

  it('a status it cannot read, rather than guessing the visit into a state', async () => {
    const ctx = seed({ s1: visit({ status: 'IN_PROGRESS' }) });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' })).catch(
      (e: unknown) => e,
    );
    expect((err as HttpsError).details).toMatchObject({ code: 'booking_status_unknown' });
    expect(writeAt(ctx, 's1')).toBeUndefined();
  });

  it('every clock action on a COMPLETED visit', async () => {
    for (const action of ['ON_MY_WAY', 'ARRIVED', 'DEPARTED', 'UNDO_ARRIVAL']) {
      const ctx = seed({ s1: visit({ status: 'COMPLETED' }) });
      mocks.dbFn.mockReturnValue(ctx.db);
      await expect(setVisitLifecycleHandler(req({ sessionId: 's1', action }))).rejects.toThrow(
        /while it is COMPLETED/,
      );
      expect(writeAt(ctx, 's1')).toBeUndefined();
    }
  });

  it('an action it does not have', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'COMPLETE' })),
    ).rejects.toThrow(/validation failed/);
  });

  it('an unsigned caller', async () => {
    await expect(
      setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }, null)),
    ).rejects.toThrow(/Sign-in required/);
  });
});

describe('the notification is best-effort, exactly as it is on Android', () => {
  it('a failed dispatch does not undo the clock-in; it is reported instead', async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.dispatch.mockRejectedValue(new Error('push provider down'));

    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));

    expect(res).toMatchObject({ changed: true, notified: false, notifySkipped: 'dispatch_failed' });
    expect(writeAt(ctx, 's1')?.data).toMatchObject({ status: 'ARRIVED' });
  });

  it('a visit with no routing ids is a NAMED skip, not a silent one', async () => {
    const ctx = seed({
      s1: { kinfolkId: 'fam1', status: 'SCHEDULED', startTime: '2026-08-24T14:00:00Z' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));

    expect(res).toMatchObject({ notified: false, notifySkipped: 'session_has_no_routing_ids' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it('falls back to the legacy flat booking id when the envelope pair is absent', async () => {
    const ctx = seed({
      s1: {
        kinfolkId: 'fam1',
        sourceBookingId: 'legacy7',
        status: 'SCHEDULED',
        startTime: '2026-08-24T14:00:00Z',
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));
    expect(mocks.dispatch.mock.calls[0]?.[0]).toMatchObject({
      familyId: 'fam1',
      bookingId: 'legacy7',
    });
  });

  it("reports a household's own preferences suppressing it as suppression, not as delivery", async () => {
    const ctx = seed({ s1: visit() });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.dispatch.mockResolvedValue({ ok: true, dispatchIds: [], suppressed: true });
    const res = await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'ARRIVED' }));
    expect(res).toMatchObject({ notified: false, notifySkipped: 'household_prefs_suppressed' });
  });
});
