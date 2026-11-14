import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

/**
 * #1838, #2027, #1841, #1816: each admin action that can tell a household
 * returns what the household was actually told, from the send itself, and the
 * booking trigger does not send it a second time.
 *
 * Every case runs the real dispatcher against an in-memory Firestore, so "told"
 * means a `notifications/{id}` record for the household's login was written.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), writeAuditEntryFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/businessAdmins', () => ({ resolveBusinessAdminUids: async () => ['ownerUid'] }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', arrayUnion: (...a: unknown[]) => a, increment: (n: number) => n } };
});

import { transitionBookingStatusHandler } from '../src/admin/transitionBookingStatus';
import { rescheduleBookingHandler } from '../src/admin/rescheduleBooking';
import { createKinCareSessionHandler } from '../src/admin/createKinCareSession';
import { addBookingNoteHandler } from '../src/portal/addBookingNote';
import { previewVisitNotificationHandler } from '../src/admin/dispatchVisitNotification';
import { officeNoticeStampChanged } from '../src/triggers/onBookingsWrite';
import { batchUpdateBookingsHandler } from '../src/admin/batchUpdateBookings';

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const SESSION = 'kin_care_sessions/vis_v1';
const VISIT = 'families/kf1/bookings/req_1/kinCares/v1';

/** A claimed household: an ACTIVE member login with a name. */
function household(extra: Record<string, Record<string, unknown> | null> = {}) {
  return {
    'kinfolk/kf1': { uid: 'kinUid', kinfolkName: 'The Easts' },
    'families/kf1/members/kinUid': { status: 'ACTIVE', role: 'PRIMARY' },
    'clients/kinUid': { displayName: 'Dre East', email: 'catch@hanasamku.com', kinfolkIds: ['kf1'] },
    ...extra,
  };
}

function linked(status = 'SCHEDULED') {
  return {
    [SESSION]: {
      status,
      startTime: '2026-09-01T10:00:00.000Z',
      endTime: '2026-09-01T11:00:00.000Z',
      kinfolkId: 'kf1',
      kinCareBatchId: 'req_1',
      kinCareVisitId: 'v1',
    },
    [VISIT]: {
      status: 'confirmed',
      serviceName: 'Dog Walk',
      startTime: Timestamp.fromMillis(Date.parse('2026-09-01T10:00:00.000Z')),
      endTime: Timestamp.fromMillis(Date.parse('2026-09-01T11:00:00.000Z')),
    },
  };
}

function seed(docs: Record<string, Record<string, unknown> | null>) {
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

function householdRecords(ctx: ReturnType<typeof buildDbMock>, key: string) {
  return ctx.writes.filter(
    (w) =>
      w.path.startsWith('notifications/') &&
      (w.data as { recipientUid?: string; key?: string }).recipientUid === 'kinUid' &&
      (w.data as { key?: string }).key === key,
  );
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-1');
});

describe('#1838 cancelling a visit', () => {
  it('HAPPY: tells the household itself, says who and how, and stamps the visit so the trigger stays quiet', async () => {
    const ctx = seed({ ...household(), ...linked() });
    const res = await transitionBookingStatusHandler(req({ sessionId: 'vis_v1', action: 'CANCEL' }));
    expect(res.notice).toEqual({ told: true, reason: null, name: 'Dre East', channels: ['email'] });
    expect(householdRecords(ctx, 'kincare.booking.cancel')).toHaveLength(1);
    const visit = ctx.writes.find((w) => w.path === VISIT)!;
    expect(visit.data).toMatchObject({ status: 'cancelled', officeNoticeStamp: expect.any(String) });
  });

  it('SAD: household notices off: nobody was told, and the answer says why', async () => {
    const ctx = seed({ ...household({ [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } }), ...linked() });
    const res = await transitionBookingStatusHandler(req({ sessionId: 'vis_v1', action: 'CANCEL' }));
    expect(res.notice).toMatchObject({ told: false, reason: 'household_notices_off', name: 'Dre East' });
    expect(householdRecords(ctx, 'kincare.booking.cancel')).toHaveLength(0);
  });

  it('NEGATIVE: a visit with no booking record reaches nobody, and no stamp is written', async () => {
    const ctx = seed({ ...household(), [SESSION]: { status: 'SCHEDULED', kinfolkId: 'kf1' } });
    const res = await transitionBookingStatusHandler(req({ sessionId: 'vis_v1', action: 'CANCEL' }));
    expect(res.notice).toMatchObject({ told: false, reason: 'session_has_no_routing_ids', name: 'The Easts' });
    expect(ctx.writes.some((w) => w.path === VISIT)).toBe(false);
  });

  it('a COMPLETE carries no notice: it tells the household nothing new', async () => {
    seed({ ...household(), ...linked('DEPARTED') });
    const res = await transitionBookingStatusHandler(req({ sessionId: 'vis_v1', action: 'COMPLETE' }));
    expect(res.notice).toBeUndefined();
  });
});

describe('#1838 cancelling from the Bookings list (batchUpdateBookings, the desktop and Android path)', () => {
  it('HAPPY: each cancelled visit reports what its household was told, and the visit carries the stamp', async () => {
    const docs = { ...household(), ...linked() };
    const ctx = buildDbMock({
      docs,
      writeThrough: true,
      collectionGroupDocs: { kinCares: [{ id: 'v1', path: VISIT, data: docs[VISIT] as Record<string, unknown> }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'CANCEL' }));
    expect(res.notices).toEqual([{ id: 'v1', notice: { told: true, reason: null, name: 'Dre East', channels: ['email'] } }]);
    expect(householdRecords(ctx, 'kincare.booking.cancel')).toHaveLength(1);
    expect(ctx.writes.find((w) => w.path === VISIT)!.data).toMatchObject({ status: 'cancelled', officeNoticeStamp: expect.any(String) });
  });

  it('an APPROVE carries no notices list', async () => {
    const docs = { ...household(), ...linked() };
    const ctx = buildDbMock({
      docs,
      writeThrough: true,
      collectionGroupDocs: { kinCares: [{ id: 'v1', path: VISIT, data: docs[VISIT] as Record<string, unknown> }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await batchUpdateBookingsHandler(req({ ids: ['v1'], action: 'APPROVE' }));
    expect(res.notices).toBeUndefined();
  });
});

describe('#2027 moving a visit', () => {
  const move = { sessionId: 'vis_v1', startTime: '2026-09-10T15:00:00.000Z', endTime: '2026-09-10T16:00:00.000Z' };

  it('HAPPY: a confirmed visit: the household is told it moved, by this call, once', async () => {
    const ctx = seed({ ...household(), ...linked() });
    const res = await rescheduleBookingHandler(req(move));
    expect(res.notice).toEqual({ told: true, reason: null, name: 'Dre East', channels: ['email'] });
    const records = householdRecords(ctx, 'kincare.changed');
    expect(records).toHaveLength(1);
    expect(ctx.writes.find((w) => w.path === VISIT)!.data).toMatchObject({ officeNoticeStamp: expect.any(String) });
  });

  it('SAD: a visit not yet confirmed is not announced, and the write carries no stamp', async () => {
    const docs = { ...household(), ...linked() };
    (docs[VISIT] as Record<string, unknown>)['status'] = 'requested';
    const ctx = seed(docs);
    const res = await rescheduleBookingHandler(req(move));
    expect(res.notice).toMatchObject({ told: false, reason: 'not_a_household_notice' });
    expect(householdRecords(ctx, 'kincare.changed')).toHaveLength(0);
    expect(ctx.writes.find((w) => w.path === VISIT)!.data['officeNoticeStamp']).toBeUndefined();
  });

  it('NEGATIVE: no member login: nobody is told, and the office is still told', async () => {
    const ctx = seed({ ...household({ 'families/kf1/members/kinUid': { status: 'REMOVED' } }), ...linked() });
    const res = await rescheduleBookingHandler(req(move));
    expect(res.notice).toMatchObject({ told: false, reason: 'household_has_no_portal_account' });
    expect(ctx.writes.some((w) => w.path.startsWith('notifications/') && (w.data as { recipientUid?: string }).recipientUid === 'ownerUid')).toBe(true);
  });
});

describe('the booking trigger leaves a stamped write to its caller', () => {
  it('a new stamp means the caller sent it', () => {
    expect(officeNoticeStampChanged({ officeNoticeStamp: 'a' }, { officeNoticeStamp: 'b' })).toBe(true);
    expect(officeNoticeStampChanged(undefined, { officeNoticeStamp: 'b' })).toBe(true);
  });
  it('an unchanged or absent stamp (the portal, a batch edit, an older client) still sends from the trigger', () => {
    expect(officeNoticeStampChanged({ officeNoticeStamp: 'b' }, { officeNoticeStamp: 'b' })).toBe(false);
    expect(officeNoticeStampChanged({}, {})).toBe(false);
    expect(officeNoticeStampChanged({}, { officeNoticeStamp: '' })).toBe(false);
  });
});

describe('#1841 Schedule > New visit', () => {
  const visit = {
    kinfolkId: 'kf1',
    serviceType: 'Dog Walk',
    startTime: '2026-09-10T15:00:00.000Z',
    endTime: '2026-09-10T15:30:00.000Z',
  };

  it('HAPPY: with the confirmation on, the household is sent "KinCare booking confirmed" and the answer says how', async () => {
    const ctx = seed(household());
    const res = await createKinCareSessionHandler(req({ ...visit, notifyHousehold: true }));
    expect(res.notice).toEqual({ told: true, reason: null, name: 'Dre East', channels: ['email'] });
    expect(householdRecords(ctx, 'kincare.booking.confirm')).toHaveLength(1);
  });

  it('SAD: with it off, nothing is sent and the answer says the admin chose that', async () => {
    const ctx = seed(household());
    const res = await createKinCareSessionHandler(req({ ...visit, notifyHousehold: false }));
    expect(res.notice).toMatchObject({ told: false, reason: 'not_requested' });
    expect(householdRecords(ctx, 'kincare.booking.confirm')).toHaveLength(0);
  });

  it('NEGATIVE: an older client that sends no choice sends nothing, as before', async () => {
    const ctx = seed(household());
    const res = await createKinCareSessionHandler(req(visit));
    expect(res.notice).toMatchObject({ told: false, reason: 'not_requested' });
    expect(householdRecords(ctx, 'kincare.booking.confirm')).toHaveLength(0);
  });

  it('NEGATIVE: a past visit recorded as completed is never announced, even if asked', async () => {
    const ctx = seed(household());
    const res = await createKinCareSessionHandler(
      req({ kinfolkId: 'kf1', serviceType: 'Dog Walk', startTime: '2026-05-01T15:00:00.000Z', endTime: '2026-05-01T15:30:00.000Z', recordAsCompleted: true, notifyHousehold: true }),
    );
    expect(res.notice).toMatchObject({ told: false, reason: 'not_requested' });
    expect(householdRecords(ctx, 'kincare.booking.confirm')).toHaveLength(0);
  });

  it('SAD: household notices off: the confirmation is held back and the answer says so', async () => {
    seed(household({ [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } }));
    const res = await createKinCareSessionHandler(req({ ...visit, notifyHousehold: true }));
    expect(res.notice).toMatchObject({ told: false, reason: 'household_notices_off' });
  });
});

describe('#2027 a kinfolk-facing note from the office', () => {
  it('says the household gets no notice for it (the note notice goes to the office only)', async () => {
    seed({ ...household(), ...linked(), 'staff/admin1': { role: 'admin' } });
    const res = await addBookingNoteHandler(req({ kinfolkId: 'kf1', batchId: 'req_1', visitId: 'v1', body: 'Fed the cat.' }));
    expect(res.notice).toMatchObject({ told: false, reason: 'not_a_household_notice', name: 'The Easts' });
  });
});

describe('previewVisitNotification with a key', () => {
  it('names the person and the channels; without a key the answer is the old two fields', async () => {
    seed(household());
    expect(await previewVisitNotificationHandler(req({ familyId: 'kf1', key: 'kincare.booking.cancel' }))).toEqual({
      ok: true,
      willNotify: true,
      reason: null,
      name: 'Dre East',
      channels: ['email'],
    });
    expect(await previewVisitNotificationHandler(req({ familyId: 'kf1' }))).toEqual({ ok: true, willNotify: true, reason: null });
  });

  it('with a sessionId, the confirm and the cancel agree on a visit with no booking record', async () => {
    const docs = { ...household(), [SESSION]: { status: 'SCHEDULED', kinfolkId: 'kf1' } };
    seed(docs);
    const preview = await previewVisitNotificationHandler(
      req({ sessionId: 'vis_v1', key: 'kincare.booking.cancel' }),
    );
    seed(docs);
    const res = await transitionBookingStatusHandler(req({ sessionId: 'vis_v1', action: 'CANCEL' }));
    expect(preview).toMatchObject({ willNotify: false, reason: 'session_has_no_routing_ids' });
    expect(res.notice).toMatchObject({ told: false, reason: 'session_has_no_routing_ids' });
  });

  it('with a sessionId, the confirm and the move agree on a visit not yet confirmed', async () => {
    const docs = { ...household(), ...linked() };
    (docs[VISIT] as Record<string, unknown>)['status'] = 'requested';
    seed(docs);
    const preview = await previewVisitNotificationHandler(req({ sessionId: 'vis_v1', key: 'kincare.changed' }));
    seed(docs);
    const res = await rescheduleBookingHandler(
      req({ sessionId: 'vis_v1', startTime: '2026-09-10T15:00:00.000Z', endTime: '2026-09-10T16:00:00.000Z' }),
    );
    expect(preview).toMatchObject({ willNotify: false, reason: 'not_a_household_notice' });
    expect(res.notice).toMatchObject({ told: false, reason: 'not_a_household_notice' });
  });

  it('with a sessionId on a linked, confirmed visit, the confirm names the household as the send does', async () => {
    seed({ ...household(), ...linked() });
    expect(
      await previewVisitNotificationHandler(req({ sessionId: 'vis_v1', key: 'kincare.booking.cancel' })),
    ).toEqual({ ok: true, willNotify: true, reason: null, name: 'Dre East', channels: ['email'] });
  });

  it('refuses a key that no admin confirm sends', async () => {
    seed(household());
    await expect(previewVisitNotificationHandler(req({ familyId: 'kf1', key: 'invoice.new' }))).rejects.toThrow();
  });
});
