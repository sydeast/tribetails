import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #648: an admin reschedule has to move BOTH copies of the visit.
 *
 * `admin/rescheduleRequests.ts` already states the rule in its own header, on
 * the path where an admin accepts a household's ask: "ACCEPTING IS WHAT MOVES
 * THE VISIT, and it moves BOTH records [...] and `admin/rescheduleBooking` only
 * ever wrote the second." That last clause was the live defect, and it covered
 * every admin-initiated reschedule there is: the Schedule week-grid drag, the
 * per-card Reschedule button, the booking detail modal.
 *
 * It was invisible from the office. `portal/getMyBookings` serves an
 * envelope-linked visit from the kinCares copy and deliberately SKIPS its
 * linked session, so the household's app could only ever show the copy that
 * was never written. The admin's schedule read the copy that was.
 *
 * These tests assert the two documents rather than the callable's return value,
 * because the return value was always `ok: true` and always will be. What was
 * wrong was on disk.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn(), logEventFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { rescheduleBookingHandler } from '../src/admin/rescheduleBooking';

const NEW_START = '2026-09-10T15:00:00.000Z';
const NEW_END = '2026-09-10T16:00:00.000Z';

/** The session path and the visit path the fixtures below always use. */
const SESSION = 'kin_care_sessions/vis_v1';
const VISIT = 'families/kf1/bookings/req_1/kinCares/v1';

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** A session that mirrors an envelope visit, exactly as approveBookingSeriesCore stamps it. */
function linkedSession() {
  return {
    startTime: '2026-09-01T10:00:00.000Z',
    endTime: '2026-09-01T11:00:00.000Z',
    kinfolkId: 'kf1',
    kinCareBatchId: 'req_1',
    kinCareVisitId: 'v1',
  };
}

/** The household's copy of that same visit. */
function envelopeVisit() {
  return {
    batchId: 'req_1',
    familyId: 'kf1',
    status: 'confirmed',
    serviceName: 'Dog Walk',
    startTime: Timestamp.fromMillis(Date.parse('2026-09-01T10:00:00.000Z')),
    endTime: Timestamp.fromMillis(Date.parse('2026-09-01T11:00:00.000Z')),
  };
}

function writeTo(ctx: ReturnType<typeof buildDbMock>, path: string) {
  return ctx.writes.filter((w) => w.path === path);
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.logEventFn.mockReset();
  mocks.writeAuditEntryFn.mockReset();
  mocks.writeAuditEntryFn.mockResolvedValue('audit-1');
});

describe('#648 rescheduleBooking moves both copies of the visit', () => {
  it('writes the household copy as well as the office session', async () => {
    const ctx = buildDbMock({ docs: { [SESSION]: linkedSession(), [VISIT]: envelopeVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    // The bug, asserted as the document that used to be left behind.
    expect(writeTo(ctx, VISIT)).toHaveLength(1);
    expect(writeTo(ctx, SESSION)).toHaveLength(1);
  });

  it('writes the SAME instant into both, in each collection\'s own shape', async () => {
    const ctx = buildDbMock({ docs: { [SESSION]: linkedSession(), [VISIT]: envelopeVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    // Sessions store ISO strings; the kinCares subcollection stores Timestamps.
    // getMyBookings parses the two paths with different readers, so writing
    // either shape into the other breaks the one that expects it.
    const session = writeTo(ctx, SESSION)[0]!.data;
    const visit = writeTo(ctx, VISIT)[0]!.data;

    expect(session['startTime']).toBe(NEW_START);
    expect(session['endTime']).toBe(NEW_END);
    expect((visit['startTime'] as Timestamp).toMillis()).toBe(Date.parse(NEW_START));
    expect((visit['endTime'] as Timestamp).toMillis()).toBe(Date.parse(NEW_END));
    // The whole point: the household and the office now name one instant.
    expect((visit['startTime'] as Timestamp).toMillis()).toBe(Date.parse(session['startTime'] as string));
  });

  it('moves the household copy BEFORE the session, so a failure cannot strand the office ahead', async () => {
    const ctx = buildDbMock({ docs: { [SESSION]: linkedSession(), [VISIT]: envelopeVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    // Copied from resolveBookingRescheduleRequest's ordering. If the visit
    // write throws, nothing moved anywhere and the caller is told.
    const order = ctx.writes.map((w) => w.path).filter((p) => p === VISIT || p === SESSION);
    expect(order[0]).toBe(VISIT);
    expect(order[1]).toBe(SESSION);
  });

  it('touches only the times, leaving the rest of the household copy alone', async () => {
    const ctx = buildDbMock({ docs: { [SESSION]: linkedSession(), [VISIT]: envelopeVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    const visit = writeTo(ctx, VISIT)[0]!;
    expect(visit.merge).toBe(true);
    expect(Object.keys(visit.data).sort()).toEqual(['endTime', 'startTime', 'updatedAt']);
    // No parent rollup. resolveBookingRescheduleRequest does not write
    // firstStartTime/lastStartTime either, and matching it is deliberate.
    expect(ctx.writes.some((w) => w.path === 'families/kf1/bookings/req_1')).toBe(false);
  });

  it('records in the audit trail whether the household copy moved', async () => {
    const ctx = buildDbMock({ docs: { [SESSION]: linkedSession(), [VISIT]: envelopeVisit() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    const payload = mocks.writeAuditEntryFn.mock.calls[0]![0].payload;
    expect(payload.envelopeMirrored).toBe(true);
    expect(payload.envelopeSkipReason).toBeNull();
  });
});

describe('#648 sessions with no household copy', () => {
  it('writes only the session when the visit was never a household request', async () => {
    // An AuntieOS-native visit booked by the office through createKinCareSession.
    // It carries no envelope coordinates because no envelope exists, and
    // getMyBookings reads these sessions directly, so one write is the whole
    // truth. This is an ordinary case, not a fault.
    const ctx = buildDbMock({
      docs: { [SESSION]: { startTime: '2026-09-01T10:00:00.000Z', endTime: '2026-09-01T11:00:00.000Z' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    expect(res.ok).toBe(true);
    expect(writeTo(ctx, SESSION)).toHaveLength(1);
    expect(ctx.writes.some((w) => w.path.includes('/kinCares/'))).toBe(false);
  });

  it('names the reason rather than passing over it in silence', async () => {
    const ctx = buildDbMock({
      docs: { [SESSION]: { startTime: '2026-09-01T10:00:00.000Z', endTime: '2026-09-01T11:00:00.000Z' } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    const skip = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .find((e) => e.event === 'admin.reschedule.noEnvelopeVisit');
    expect(skip?.extra?.reason).toBe('session_has_no_envelope_coords');
    expect(mocks.writeAuditEntryFn.mock.calls[0]![0].payload.envelopeMirrored).toBe(false);
  });

  it('does not conjure a half-formed visit when the named copy is gone', async () => {
    // The session points at an envelope visit that has since been deleted. A
    // merge write on a missing doc would CREATE one holding nothing but two
    // timestamps, and the household would see a visit with no service, no Kin
    // and no status.
    const ctx = buildDbMock({ docs: { [SESSION]: linkedSession() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: NEW_START, endTime: NEW_END }),
    );

    expect(res.ok).toBe(true);
    expect(ctx.writes.some((w) => w.path === VISIT)).toBe(false);
    const skip = mocks.logEventFn.mock.calls
      .map((c) => c[0])
      .find((e) => e.event === 'admin.reschedule.noEnvelopeVisit');
    expect(skip?.extra?.reason).toBe('envelope_visit_missing');
    expect(skip?.severity).toBe('warn');
  });
});
