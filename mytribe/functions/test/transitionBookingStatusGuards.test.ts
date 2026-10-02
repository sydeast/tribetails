import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #1145: approving a session that has no household request behind it (created
 * on the admin side) is the one transition that PUTS a visit on the calendar,
 * so it gets the same three checks a reschedule does. Every other action is
 * untouched.
 */
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

function req(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const START = '2026-08-24T15:30:00.000Z';
const END = '2026-08-24T16:30:00.000Z';

/** One visit already on the books, 15:00-16:00 UTC. */
const EXISTING = {
  id: 'existing-visit',
  data: {
    kinfolkId: 'kf9',
    status: 'SCHEDULED',
    startTime: '2026-08-24T15:00:00.000Z',
    endTime: '2026-08-24T16:00:00.000Z',
  },
};

const BUSY_SLOT = {
  id: 'busy-1',
  data: { source: 'GOOGLE_BUSY_IMPORT', date: '2026-08-24', startTime: '15:00', endTime: '17:00' },
};

function seed(
  session: Record<string, unknown>,
  extra: {
    docs?: Record<string, Record<string, unknown>>;
    queryDocs?: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
  } = {},
) {
  const ctx = buildDbMock({
    docs: { 'kin_care_sessions/s1': { kinfolkId: 'kf1', status: 'PENDING', ...session }, ...extra.docs },
    queryDocs: extra.queryDocs ?? {},
  });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

const sessionWrites = (ctx: ReturnType<typeof buildDbMock>) =>
  ctx.writes.filter((w) => w.path === 'kin_care_sessions/s1');
const auditEvents = () => mocks.writeAuditEntryFn.mock.calls.map((c) => (c[0] as { event: string }).event);

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

describe('transitionBookingStatus APPROVE guards (#1145)', () => {
  it('refuses an approval onto a closed day, writes nothing, and offers no override', async () => {
    const ctx = seed(
      { startTime: START, endTime: END },
      { docs: { 'business_settings/business_settings': { companyHolidays: ['2026-08-24|Office closed'] } } },
    );
    await expect(
      transitionBookingStatusHandler(
        req({ sessionId: 's1', action: 'APPROVE', overrideBusyConflict: true, overrideVisitConflict: true }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('refuses an approval onto a Google busy block, and the override lets it through', async () => {
    const ctx = seed({ startTime: START, endTime: END }, { queryDocs: { booking_time_slots: [BUSY_SLOT] } });
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'booking_busy_conflict' } });
    expect(sessionWrites(ctx)).toHaveLength(0);
    const res = await transitionBookingStatusHandler(
      req({ sessionId: 's1', action: 'APPROVE', overrideBusyConflict: true }),
    );
    expect(res).toMatchObject({ status: 'SCHEDULED', changed: true });
    expect(sessionWrites(ctx)[0]?.data).toMatchObject({ status: 'SCHEDULED' });
    expect(auditEvents()).toContain('BOOKING_BUSY_CONFLICT_OVERRIDDEN');
  });

  it('refuses an approval onto another visit, and the override lets it through', async () => {
    const ctx = seed({ startTime: START, endTime: END }, { queryDocs: { kin_care_sessions: [EXISTING] } });
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' })),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'visit_overlap_conflict' },
    });
    expect(sessionWrites(ctx)).toHaveLength(0);
    const res = await transitionBookingStatusHandler(
      req({ sessionId: 's1', action: 'APPROVE', overrideVisitConflict: true }),
    );
    expect(res.status).toBe('SCHEDULED');
    expect(auditEvents()).toContain('VISIT_OVERLAP_CONFLICT_OVERRIDDEN');
  });

  it('never finds the session conflicting with itself', async () => {
    const ctx = seed(
      { startTime: START, endTime: END },
      {
        queryDocs: {
          kin_care_sessions: [{ id: 's1', data: { status: 'PENDING', startTime: START, endTime: END } }],
        },
      },
    );
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));
    expect(res.status).toBe('SCHEDULED');
    expect(sessionWrites(ctx)).toHaveLength(1);
  });

  it('checks the whole visit when the session has no end, using the KinCare length', async () => {
    // Starts at 14:30 with a 45 minute KinCare: ends 15:15, inside EXISTING (15:00-16:00).
    // Checked as a bare instant at 14:30 it would pass.
    const ctx = seed(
      { startTime: '2026-08-24T14:30:00.000Z', serviceId: 'walk' },
      {
        docs: { 'business_settings/business_settings': { serviceDurations: { walk: 45 } } },
        queryDocs: { kin_care_sessions: [EXISTING] },
      },
    );
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' })),
    ).rejects.toMatchObject({ details: { code: 'visit_overlap_conflict' } });
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('approves a session with no readable start time as before (nothing to check)', async () => {
    const ctx = seed({}, { queryDocs: { kin_care_sessions: [EXISTING], booking_time_slots: [BUSY_SLOT] } });
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));
    expect(res.status).toBe('SCHEDULED');
    expect(sessionWrites(ctx)).toHaveLength(1);
  });

  it('does not re-check a session that is already scheduled (no-op)', async () => {
    const ctx = seed(
      { status: 'SCHEDULED', startTime: START, endTime: END },
      { queryDocs: { kin_care_sessions: [EXISTING], booking_time_slots: [BUSY_SLOT] } },
    );
    const res = await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' }));
    expect(res.changed).toBe(false);
    expect(sessionWrites(ctx)).toHaveLength(0);
  });

  it('leaves the other transitions unguarded', async () => {
    const busyWorld = { queryDocs: { kin_care_sessions: [EXISTING], booking_time_slots: [BUSY_SLOT] } };
    const reject = seed({ status: 'PENDING', startTime: START, endTime: END }, busyWorld);
    expect((await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'REJECT' }))).status).toBe('CANCELLED');
    expect(sessionWrites(reject)).toHaveLength(1);
    const cancel = seed({ status: 'SCHEDULED', startTime: START, endTime: END }, busyWorld);
    expect((await transitionBookingStatusHandler(req({ sessionId: 's1', action: 'CANCEL' }))).status).toBe('CANCELLED');
    expect(sessionWrites(cancel)).toHaveLength(1);
  });

  it('audits a guard refusal as a refused transition', async () => {
    seed({ startTime: START, endTime: END }, { queryDocs: { booking_time_slots: [BUSY_SLOT] } });
    await expect(
      transitionBookingStatusHandler(req({ sessionId: 's1', action: 'APPROVE' })),
    ).rejects.toBeDefined();
    expect(mocks.writeAuditEntryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BOOKING_TRANSITION_REFUSED',
        payload: expect.objectContaining({ refusalCode: 'booking_busy_conflict', action: 'APPROVE' }),
      }),
    );
  });
});
