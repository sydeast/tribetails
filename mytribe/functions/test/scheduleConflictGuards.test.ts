import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #397 M11/M12/M13: the three admin Schedule write paths and the one question
 * none of them used to ask — is this window already taken?
 *
 * One file for the three because they share the guard
 * (`lib/visitOverlapConflict.ts`, unit-tested on its own next door) and because
 * the interesting assertion is the same each time: the refusal happens BEFORE
 * the write, so nothing lands.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { createBlockedTimeSlotHandler } from '../src/admin/createBlockedTimeSlot';
import { createKinCareSessionHandler } from '../src/admin/createKinCareSession';
import { rescheduleBookingHandler } from '../src/admin/rescheduleBooking';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** One visit already on the books, 15:00-16:00 UTC on 2026-08-24. */
const EXISTING = {
  id: 'existing-visit',
  data: {
    kinfolkId: 'kf9',
    status: 'SCHEDULED',
    startTime: '2026-08-24T15:00:00.000Z',
    endTime: '2026-08-24T16:00:00.000Z',
  },
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

// ── M11: block time ──────────────────────────────────────────────────────────

describe('createBlockedTimeSlot: blocking a window a visit already occupies', () => {
  const blockArgs = {
    date: '2026-08-24',
    startTime: '15:30',
    endTime: '17:00',
    notes: 'Vet appointment',
    startTimeMs: Date.parse('2026-08-24T15:30:00.000Z'),
    endTimeMs: Date.parse('2026-08-24T17:00:00.000Z'),
  };

  it('refuses, names the visit, and writes no slot', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [EXISTING] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(createBlockedTimeSlotHandler(req(blockArgs))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'visit_overlap_conflict', attempt: 'block_time' },
    });
    expect(ctx.writes.filter((w) => w.path.startsWith('booking_time_slots/'))).toHaveLength(0);
  });

  it('an explicit override blocks the time anyway and audits the collision', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [EXISTING] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createBlockedTimeSlotHandler(
      req({ ...blockArgs, overrideVisitConflict: true }),
    );
    expect(res.ok).toBe(true);
    const slot = ctx.writes.find((w) => w.path.startsWith('booking_time_slots/'));
    expect(slot?.data).toMatchObject({ slotType: 'BLOCKED', source: 'INTERNAL_MANUAL' });
    expect(
      mocks.writeAuditEntryFn.mock.calls.map((c) => (c[0] as { event: string }).event),
    ).toContain('VISIT_OVERLAP_CONFLICT_OVERRIDDEN');
  });

  it('a clear window still blocks, and the ms twin never reaches the document', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [EXISTING] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createBlockedTimeSlotHandler(
      req({
        date: '2026-08-24',
        startTime: '17:00',
        endTime: '18:00',
        startTimeMs: Date.parse('2026-08-24T17:00:00.000Z'),
        endTimeMs: Date.parse('2026-08-24T18:00:00.000Z'),
      }),
    );
    expect(res.ok).toBe(true);
    const slot = ctx.writes.find((w) => w.path.startsWith('booking_time_slots/'));
    expect(slot?.data).not.toHaveProperty('startTimeMs');
    expect(slot?.data).toMatchObject({ startTime: '17:00', endTime: '18:00' });
  });

  /**
   * The desktop admin's `BlockTimeDialog.kt` sends the three wall-clock fields
   * and nothing else. Without a zone there is no honest comparison to make, so
   * it keeps working exactly as it does today rather than being guarded wrongly.
   */
  it('a caller that sends no epoch-ms twin is not overlap-checked at all', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [EXISTING] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createBlockedTimeSlotHandler(
      req({ date: '2026-08-24', startTime: '15:30', endTime: '17:00', notes: '' }),
    );
    expect(res.ok).toBe(true);
  });
});

// ── M12: one-off visit ───────────────────────────────────────────────────────

describe('createKinCareSession: creating a visit into an occupied slot', () => {
  const visitArgs = {
    kinfolkId: 'kf1',
    serviceType: '30Minute',
    startTime: '2026-08-24T15:30:00.000Z',
    endTime: '2026-08-24T16:00:00.000Z',
    serviceDurationMinutes: 30,
  };

  it('refuses and adds no session', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [EXISTING] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(createKinCareSessionHandler(req(visitArgs))).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'visit_overlap_conflict', attempt: 'create_visit' },
    });
    expect(ctx.adds.filter((a) => a.collection === 'kin_care_sessions')).toHaveLength(0);
  });

  it('an explicit override creates it anyway', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [EXISTING] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await createKinCareSessionHandler(
      req({ ...visitArgs, overrideVisitConflict: true }),
    );
    expect(res.ok).toBe(true);
    expect(ctx.adds.filter((a) => a.collection === 'kin_care_sessions')).toHaveLength(1);
  });

  /**
   * Every visit list renders `kinfolkName` off the session row and never joins
   * back to `kinfolk`, so a row without it read as "Unnamed Kinfolk" on the very
   * screen that created it. This writer was the one that never stamped it.
   */
  it('stamps the household display name so the visit is not anonymous', async () => {
    const ctx = buildDbMock({
      docs: { 'kinfolk/kf1': { firstName: 'Ada', lastName: 'Lovelace' } },
      queryDocs: { kin_care_sessions: [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await createKinCareSessionHandler(req(visitArgs));
    const added = ctx.adds.find((a) => a.collection === 'kin_care_sessions');
    expect(added?.data).toMatchObject({ kinfolkName: 'Ada Lovelace', serviceType: '30Minute' });
  });

  it('falls back to the id when the household doc names nobody, never to a blank', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_sessions: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await createKinCareSessionHandler(req(visitArgs));
    expect(ctx.adds.find((a) => a.collection === 'kin_care_sessions')?.data).toMatchObject({
      kinfolkName: 'kf1',
    });
  });
});

// ── M13: drag to a new time ──────────────────────────────────────────────────

describe('rescheduleBooking: dropping a visit onto a busy one', () => {
  const moved = {
    'kin_care_sessions/moving': {
      startTime: '2026-08-24T09:00:00.000Z',
      endTime: '2026-08-24T10:00:00.000Z',
    },
  };

  it('refuses a drop that lands on another visit, and leaves the session where it was', async () => {
    const ctx = buildDbMock({
      docs: moved,
      queryDocs: {
        kin_care_sessions: [
          EXISTING,
          {
            id: 'moving',
            data: { startTime: '2026-08-24T09:00:00.000Z', endTime: '2026-08-24T10:00:00.000Z' },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      rescheduleBookingHandler(
        req({
          sessionId: 'moving',
          startTime: '2026-08-24T15:30:00.000Z',
          endTime: '2026-08-24T16:30:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'visit_overlap_conflict', attempt: 'reschedule' },
    });
    expect(ctx.writes.filter((w) => w.path === 'kin_care_sessions/moving')).toHaveLength(0);
  });

  /**
   * The regression this guard could so easily have introduced: a visit must not
   * be found conflicting with the window it is being moved OUT of, or every
   * nudge shorter than the visit's own length would refuse itself.
   */
  it('a small nudge that still overlaps the visit\'s OWN old window is allowed', async () => {
    const ctx = buildDbMock({
      docs: moved,
      queryDocs: {
        kin_care_sessions: [
          {
            id: 'moving',
            data: { startTime: '2026-08-24T09:00:00.000Z', endTime: '2026-08-24T10:00:00.000Z' },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await rescheduleBookingHandler(
      req({
        sessionId: 'moving',
        startTime: '2026-08-24T09:15:00.000Z',
        endTime: '2026-08-24T10:15:00.000Z',
      }),
    );
    expect(res).toEqual({ ok: true, sessionId: 'moving' });
    expect(ctx.writes.find((w) => w.path === 'kin_care_sessions/moving')?.data).toMatchObject({
      startTime: '2026-08-24T09:15:00.000Z',
      endTime: '2026-08-24T10:15:00.000Z',
    });
  });

  it('an explicit override moves it onto the occupied slot and audits that', async () => {
    const ctx = buildDbMock({
      docs: moved,
      queryDocs: { kin_care_sessions: [EXISTING] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await rescheduleBookingHandler(
      req({
        sessionId: 'moving',
        startTime: '2026-08-24T15:30:00.000Z',
        endTime: '2026-08-24T16:30:00.000Z',
        overrideVisitConflict: true,
      }),
    );
    expect(res.ok).toBe(true);
    expect(
      mocks.writeAuditEntryFn.mock.calls.map((c) => (c[0] as { event: string }).event),
    ).toContain('VISIT_OVERLAP_CONFLICT_OVERRIDDEN');
  });

  /**
   * The OTHER gap this file closes: `rescheduleBooking`'s own header used to
   * record the Google-busy check as deliberately skipped on this path, so a
   * visit could be dragged onto an imported busy block and land silently.
   */
  it('refuses a drop onto a Google Calendar busy block', async () => {
    const ctx = buildDbMock({
      docs: moved,
      queryDocs: {
        kin_care_sessions: [],
        booking_time_slots: [
          {
            id: 'busy-1',
            data: {
              source: 'GOOGLE_BUSY_IMPORT',
              date: '2026-08-24',
              startTime: '15:00',
              endTime: '17:00',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(
      rescheduleBookingHandler(
        req({
          sessionId: 'moving',
          startTime: '2026-08-24T15:30:00.000Z',
          endTime: '2026-08-24T16:30:00.000Z',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'failed-precondition',
      details: { code: 'booking_busy_conflict' },
    });
    expect(ctx.writes.filter((w) => w.path === 'kin_care_sessions/moving')).toHaveLength(0);
  });

  it('overrideBusyConflict lets that one through, the same escape hatch a create has', async () => {
    const ctx = buildDbMock({
      docs: moved,
      queryDocs: {
        kin_care_sessions: [],
        booking_time_slots: [
          {
            id: 'busy-1',
            data: {
              source: 'GOOGLE_BUSY_IMPORT',
              date: '2026-08-24',
              startTime: '15:00',
              endTime: '17:00',
            },
          },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await rescheduleBookingHandler(
      req({
        sessionId: 'moving',
        startTime: '2026-08-24T15:30:00.000Z',
        endTime: '2026-08-24T16:30:00.000Z',
        overrideBusyConflict: true,
      }),
    );
    expect(res.ok).toBe(true);
  });
});
