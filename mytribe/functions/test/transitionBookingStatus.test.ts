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
  BOOKING_STATUS_UNKNOWN_CODE,
  BOOKING_TRANSITION_ILLEGAL_CODE,
} from '../src/lib/bookingTransitions';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? { uid, token: { admin: true } } : undefined,
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** A db seeded with one session at `status`. */
function seed(status: unknown, extra: Record<string, unknown> = {}) {
  const ctx = buildDbMock({
    docs: { 'kin_care_sessions/s1': { kinfolkId: 'kf1', status, ...extra } },
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

/** The single write this handler ever makes. */
function sessionWrite(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.find((w) => w.path === 'kin_care_sessions/s1');
}

function auditEvents(): string[] {
  return mocks.writeAuditEntryFn.mock.calls.map((c) => (c[0] as { event: string }).event);
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

// ── Happy paths: the four transitions the client used to write directly ──────

describe('transitionBookingStatus happy paths', () => {
  it('APPROVE moves PENDING to SCHEDULED, stamps updatedBy, and audits from->to', async () => {
    const ctx = seed('PENDING');
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));

    expect(res).toEqual({
      ok: true,
      sessionId: 's1',
      action: 'APPROVE',
      from: 'PENDING',
      status: 'SCHEDULED',
      changed: true,
    });
    const w = sessionWrite(ctx);
    expect(w?.merge).toBe(true);
    expect(w?.data).toMatchObject({ status: 'SCHEDULED', updatedAt: '__TS__', updatedBy: 'admin1' });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BOOKING_STATUS_TRANSITION',
        severity: 'info',
        actorRole: 'AUNTIE',
        actorUid: 'admin1',
        targetCollection: 'kin_care_sessions',
        payload: expect.objectContaining({
          action: 'APPROVE',
          from: 'PENDING',
          to: 'SCHEDULED',
          changed: true,
        }),
      }),
    );
  });

  it('REJECT terminates a DRAFT request and is audited AS a REJECT', async () => {
    const ctx = seed('DRAFT');
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'REJECT' }));

    expect(res.status).toBe('CANCELLED');
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'CANCELLED' });
    // The collection stores CANCELLED for both; the trail is where the operator's
    // actual decision survives.
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ action: 'REJECT', from: 'DRAFT', to: 'CANCELLED' }),
      }),
    );
  });

  it('CANCEL terminates a SCHEDULED visit and is audited AS a CANCEL, from a different source status', async () => {
    seed('SCHEDULED');
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));

    expect(res.status).toBe('CANCELLED');
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ action: 'CANCEL', from: 'SCHEDULED', to: 'CANCELLED' }),
      }),
    );
  });

  it('COMPLETE stamps the caller-supplied completedAt', async () => {
    const ctx = seed('DEPARTED');
    await transitionBookingStatusHandler(
      req({ sessionId: 's1', action: 'COMPLETE', completedAt: '2026-08-01T10:00:00.000Z' }),
    );
    expect(sessionWrite(ctx)?.data).toMatchObject({
      status: 'COMPLETED',
      completedAt: '2026-08-01T10:00:00.000Z',
    });
  });

  it('COMPLETE stamps its own ISO completedAt when the caller omits one', async () => {
    const ctx = seed('ARRIVED');
    await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' }));
    const completedAt = sessionWrite(ctx)?.data.completedAt;
    expect(typeof completedAt).toBe('string');
    expect(Number.isNaN(Date.parse(completedAt as string))).toBe(false);
  });

  it('CANCEL with a reason appends it to the session notes and flags the audit without storing the text', async () => {
    const ctx = seed('SCHEDULED', { notes: 'Gate code 1234' });
    await transitionBookingStatusHandler(
      req({ sessionId: 's1', action: 'CANCEL', reason: 'household away' }),
    );
    expect(sessionWrite(ctx)?.data.notes).toBe('Gate code 1234\n[Booking cancelled] household away');
    const entry = mocks.writeAuditEntryFn.mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(entry.payload.reasonSupplied).toBe(true);
    expect(JSON.stringify(entry.payload)).not.toContain('household away');
  });

  it('ignores a reason on COMPLETE rather than writing an unrelated note', async () => {
    const ctx = seed('SCHEDULED', { notes: 'keep me' });
    await transitionBookingStatusHandler(
      req({ sessionId: 's1', action: 'COMPLETE', reason: 'nope' }),
    );
    expect(sessionWrite(ctx)?.data.notes).toBeUndefined();
  });

  it('normalizes a legacy CANCELED row on read without writing that spelling back', async () => {
    const ctx = seed('CANCELED');
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));
    expect(res).toMatchObject({ from: 'CANCELLED', status: 'CANCELLED', changed: false });
    expect(sessionWrite(ctx)).toBeUndefined();
  });
});

// ── Idempotence ─────────────────────────────────────────────────────────────

describe('transitionBookingStatus idempotence', () => {
  it('reports success with changed:false and writes NOTHING when already in the target status', async () => {
    const ctx = seed('CANCELLED');
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));

    expect(res).toEqual({
      ok: true,
      sessionId: 's1',
      action: 'CANCEL',
      from: 'CANCELLED',
      status: 'CANCELLED',
      changed: false,
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('still audits the no-op, so a double-press is not a gap in the trail', async () => {
    seed('SCHEDULED');
    await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));
    expect(auditEvents()).toEqual(['BOOKING_STATUS_TRANSITION']);
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ changed: false }) }),
    );
  });
});

// ── Refusals: illegal transitions ───────────────────────────────────────────

describe('transitionBookingStatus illegal transitions', () => {
  it('refuses COMPLETE on a cancelled visit, names both ends, and writes nothing', async () => {
    const ctx = seed('CANCELLED');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'COMPLETE' })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: BOOKING_TRANSITION_ILLEGAL_CODE, from: 'CANCELLED' },
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses CANCEL on a completed visit', async () => {
    seed('COMPLETED');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('refuses REJECT on an already-approved visit (that is a CANCEL, and a different decision)', async () => {
    seed('SCHEDULED');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'REJECT' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('refuses APPROVE on a visit already in flight', async () => {
    seed('ARRIVED');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('AUDITS the refusal as a FAILURE naming the attempted transition', async () => {
    seed('COMPLETED');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' })),
    ).rejects.toThrow();
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BOOKING_TRANSITION_REFUSED',
        severity: 'warn',
        status: 'FAILURE',
        actorUid: 'admin1',
        payload: expect.objectContaining({
          action: 'CANCEL',
          refusalCode: BOOKING_TRANSITION_ILLEGAL_CODE,
          from: 'COMPLETED',
          attempted: 'CANCELLED',
        }),
      }),
    );
  });

  it('still refuses when the audit write itself fails (the refusal is never swallowed)', async () => {
    seed('COMPLETED');
    mocks.writeAuditEntryFn.mockRejectedValue(new Error('audit down'));
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

// ── Refusals: unreadable status ─────────────────────────────────────────────

describe('transitionBookingStatus unreadable status', () => {
  it('refuses a session whose status is a value this app does not know', async () => {
    const ctx = seed('HIJACKED');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: BOOKING_STATUS_UNKNOWN_CODE },
    });
    expect(ctx.writes).toHaveLength(0);
    expect(auditEvents()).toEqual(['BOOKING_TRANSITION_REFUSED']);
  });

  it('refuses a session with no status field at all rather than assuming SCHEDULED', async () => {
    seed(undefined);
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' })),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

// ── Not found, unauthorized, bad input ──────────────────────────────────────

describe('transitionBookingStatus error surface', () => {
  it('404s an unknown session and audits the attempt', async () => {
    mocks.dbFn.mockReturnValue(buildDbMock({ docs: {} }).db);
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 'nope', action: 'CANCEL' })),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BOOKING_TRANSITION_REFUSED',
        payload: expect.objectContaining({ refusalCode: 'not_found' }),
      }),
    );
  });

  it('rejects an unauthenticated caller before touching Firestore', async () => {
    const ctx = seed('PENDING');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }, null)),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.writeAuditEntryFn).not.toHaveBeenCalled();
  });

  it('rejects an unknown action (zod), naming the field', async () => {
    seed('PENDING');
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'DELETE_EVERYTHING' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a missing sessionId', async () => {
    seed('PENDING');
    await expect(
      transitionBookingStatusHandler(req({ action: 'APPROVE' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects an over-long reason rather than storing it', async () => {
    const ctx = seed('SCHEDULED');
    await expect(
      transitionBookingStatusHandler(
        req({ sessionId: 's1', action: 'CANCEL', reason: 'x'.repeat(501) }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });

  it('propagates a Firestore write failure instead of reporting a transition that never landed', async () => {
    const ctx = seed('SCHEDULED');
    const ref = ctx.db.doc('kin_care_sessions/s1');
    ctx.db.doc = (path: string) =>
      path === 'kin_care_sessions/s1'
        ? { ...ref, set: vi.fn(async () => { throw new Error('permission-denied'); }) }
        : ref;

    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' })),
    ).rejects.toThrow('permission-denied');
    // No success entry may exist for a write that never landed.
    expect(auditEvents()).not.toContain('BOOKING_STATUS_TRANSITION');
  });

  it('does not fail a landed transition when the audit write fails', async () => {
    const ctx = seed('SCHEDULED');
    mocks.writeAuditEntryFn.mockRejectedValue(new Error('audit down'));
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }));
    expect(res.changed).toBe(true);
    expect(sessionWrite(ctx)?.data).toMatchObject({ status: 'CANCELLED' });
  });
});
