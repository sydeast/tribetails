import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2038: "Undo arrived" left "Your Auntie has arrived" on the household's
 * notifications list, unread and counted on the bell, with the visit back at
 * Scheduled (walk 2026-11-10).
 *
 * Lead ruling, in line with the quiet "Undo departed" (#2250): the undo sends
 * the household nothing, the arrival's entry is withdrawn from their list and
 * their bell, what was already delivered is left, and a real arrival later is
 * announced once.
 *
 * These run the session trigger over the REAL dispatcher, as the #2037 cases
 * do, so a notice here is the `notifications/` row the household's list reads
 * and the bell counts.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  authFn: vi.fn(),
  resolveKinCareRefFn: vi.fn(),
  logEventFn: vi.fn(),
  lines: [] as Array<Record<string, any>>,
  ids: new Set<string>(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: mocks.authFn, getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: mocks.logEventFn }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/resolveKinCareRef', () => ({ resolveKinCareRef: mocks.resolveKinCareRefFn }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn(async (args: Record<string, any>) => {
    if (typeof args.docId === 'string') {
      if (mocks.ids.has(args.docId)) return args.docId;
      mocks.ids.add(args.docId);
    }
    mocks.lines.push(args);
    return args.docId ?? `auto-${mocks.lines.length}`;
  }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { ...(actual.FieldValue as object), serverTimestamp: () => '__TS__' } };
});

import {
  onKinCareSessionLifecycleHandler,
  type SessionLifecycleEvent,
} from '../src/triggers/onKinCareSessionLifecycle';
import { announceVisitStep, visitStepOf, visitStepNoticeId } from '../src/lib/visitStepNotice';
import { dispatchVisitNotificationHandler } from '../src/admin/dispatchVisitNotification';
import { setVisitLifecycleHandler } from '../src/admin/setVisitLifecycle';
import { unarchiveNotificationHandler, bulkUnarchiveNotificationsHandler } from '../src/portal/archiveNotification';
import { isUnreadNotification, isVisibleNotification } from '../src/lib/recipientNotifications';
import { arrivalStillStands } from '../src/lib/arrivalNoticeWithdrawal';
import { arrivalNoticeWithdrawnWords } from '../src/lib/activityWords';
import { evaluateVisitLifecycle } from '../src/lib/visitLifecycle';
import { stampMs } from '../src/lib/visitStepNotice';

const NOW = Date.UTC(2026, 10, 10, 22, 0, 0);
const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';
const ARRIVED_AT = '2026-11-10T22:00:00.000Z';
const ARRIVED_AGAIN_AT = '2026-11-10T22:30:00.000Z';
const ON_MY_WAY_AT = '2026-11-10T21:50:00.000Z';
const SESSION_PATH = 'kin_care_sessions/s1';

let ctx: ReturnType<typeof buildDbMock>;
/** The store itself: `buildDbMock` reads and writes this same object. */
let docs: Record<string, Record<string, unknown> | null>;

function seed(extra: Record<string, Record<string, unknown> | null> = {}) {
  docs = {
    [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: NOW, kinfolkId: 'fam1' },
    'staff/uid_auntie': { displayName: 'TiTi' },
    'clients/uid_kinfolk': { displayName: 'Dre' },
    'families/fam1': { displayName: 'Dre East' },
    'kinfolk/fam1': { uid: 'uid_kinfolk' },
    'families/fam1/members/uid_kinfolk': { role: 'PRIMARY', status: 'ACTIVE' },
    ...extra,
  };
  ctx = buildDbMock({ writeThrough: true, docs: docs as Record<string, Record<string, unknown>> });
  mocks.dbFn.mockReset().mockReturnValue(ctx.db);
  mocks.resolveKinCareRefFn.mockReset().mockResolvedValue({
    ref: ctx.db.doc(VISIT_PATH),
    batchId: 'batch1',
    visitId: 'visit1',
  });
}

const session = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kinfolkId: 'fam1',
  kinCareBatchId: 'batch1',
  kinCareVisitId: 'visit1',
  status: 'SCHEDULED',
  ...extra,
});

function event(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
  extra: Partial<SessionLifecycleEvent> = {},
): SessionLifecycleEvent {
  const snap = (data: Record<string, unknown> | undefined) =>
    data === undefined ? { exists: false, data: () => undefined } : { exists: true, data: () => data };
  return {
    id: 'evt-1',
    params: { sessionId: 's1' },
    data: { before: snap(before), after: snap(after) },
    authType: 'unknown',
    authId: 'uid_auntie',
    ...extra,
  } as unknown as SessionLifecycleEvent;
}

const ARRIVED = session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT });
const arrive = () => event(session(), ARRIVED);
const undo = () => event(ARRIVED, session({ status: 'SCHEDULED', arrivedAt: '' }));
const arriveAgain = () =>
  event(session({ arrivedAt: '' }), session({ status: 'ARRIVED', arrivedAt: ARRIVED_AGAIN_AT }));

/** Every `notifications/` row on file for the household, with its id. */
function rows(): Array<{ id: string; data: Record<string, unknown> }> {
  return Object.entries(docs)
    .filter(([path, data]) => path.startsWith('notifications/') && data?.['recipientUid'] === 'uid_kinfolk')
    .map(([path, data]) => ({ id: path.slice('notifications/'.length), data: data as Record<string, unknown> }));
}
/** What `listMyNotifications` shows for fam1, by the predicate it uses. */
const listed = () => rows().filter((r) => isVisibleNotification(r.data, 'fam1'));
/** What the bell counts for fam1: the server's count, which both clients mirror. */
const bell = () => listed().filter((r) => isUnreadNotification(r.data)).length;
/** New notices created (a `set` that carries the recipient), as opposed to a stamp on an old one. */
const sent = () => ctx.writes.filter((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk');
/** Work orders: what drives an email, a text or a push. */
const workOrders = () => ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'));
const linesOf = (kind: string) => mocks.lines.filter((l) => l.event === kind);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.lines.length = 0;
  mocks.ids.clear();
  mocks.logEventFn.mockReset();
  mocks.authFn.mockReset().mockReturnValue({ getUser: async () => ({ customClaims: { staffRole: 'auntie' } }) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2038 Undo arrived takes the arrival off the household list and bell', () => {
  it('an unread arrival row stops being listed and stops counting', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    expect(listed().map((r) => r.data.key)).toEqual(['kincare.auntie.arrived']);
    expect(bell()).toBe(1);

    await onKinCareSessionLifecycleHandler(undo());

    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);
    // Withdrawn, not deleted: the row is still on file, marked.
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.data).toMatchObject({
      key: 'kincare.auntie.arrived',
      archivedAt: '__TS__',
      withdrawnAt: '__TS__',
      withdrawnReason: 'arrival_undone',
    });
  });

  it('a row the household already read is withdrawn too, and the bell stays where it was', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    const id = rows()[0]!.id;
    docs[`notifications/${id}`] = { ...docs[`notifications/${id}`], readAt: '__READ__' };
    expect(bell()).toBe(0);
    expect(listed()).toHaveLength(1);

    await onKinCareSessionLifecycleHandler(undo());

    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);
    expect(rows()[0]?.data).toMatchObject({ readAt: '__READ__', withdrawnAt: '__TS__' });
  });

  it('only the arrival goes: other unread rows keep counting', async () => {
    seed({
      'notifications/other': { key: 'invoice.new', recipientUid: 'uid_kinfolk', data: { kinfolkId: 'fam1' } },
    });
    await onKinCareSessionLifecycleHandler(arrive());
    expect(bell()).toBe(2);
    await onKinCareSessionLifecycleHandler(undo());
    expect(bell()).toBe(1);
    expect(listed().map((r) => r.id)).toEqual(['other']);
  });

  it('sends the household nothing about the undo: no new notice, no email, text or push', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    const noticesBefore = sent().length;
    const ordersBefore = workOrders().length;

    await onKinCareSessionLifecycleHandler(undo());

    expect(sent()).toHaveLength(noticesBefore);
    expect(workOrders()).toHaveLength(ordersBefore);
    // The arrival's own work order is left as it was: what went out stays out.
    expect(docs[`notificationDispatch/${rows()[0]!.id}`]).toMatchObject({ key: 'kincare.auntie.arrived' });
    expect(docs[`notificationDispatch/${rows()[0]!.id}`]).not.toHaveProperty('withdrawnAt');
  });

  it('says so in the Activity Log, in plain words, once', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    await onKinCareSessionLifecycleHandler(undo());
    await onKinCareSessionLifecycleHandler(undo());

    expect(linesOf('VISIT_UNDO_ARRIVAL').map((l) => l.description)).toEqual([
      'Undid the arrival: arrived to scheduled',
      "Took the arrival notice off the household's notifications list. No message was sent about the undo",
    ]);
    const withdrawal = linesOf('VISIT_UNDO_ARRIVAL')[1]!;
    expect(withdrawal).toMatchObject({
      status: 'SUCCESS',
      actorRole: 'AUNTIE',
      actorUid: 'uid_auntie',
      targetUid: 's1',
      familyId: 'fam1',
    });
    expect(arrivalNoticeWithdrawnWords()).not.toMatch(/—|inbox|pet|client|sitter/i);
  });

  it('a household that was never told has nothing withdrawn and no second line', async () => {
    seed({ 'kinfolk/fam1': { uid: '' }, 'families/fam1/members/uid_kinfolk': null });
    await onKinCareSessionLifecycleHandler(arrive());
    expect(rows()).toEqual([]);
    await onKinCareSessionLifecycleHandler(undo());
    expect(linesOf('VISIT_UNDO_ARRIVAL').map((l) => l.description)).toEqual(['Undid the arrival: arrived to scheduled']);
  });

  it('withdraws through setVisitLifecycle as well, and the trigger its write fires adds nothing', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    docs[SESSION_PATH] = { ...ARRIVED };

    const res = await setVisitLifecycleHandler({
      data: { sessionId: 's1', action: 'UNDO_ARRIVAL' },
      auth: { uid: 'uid_auntie', token: { staffRole: 'auntie', name: 'TiTi' } },
      rawRequest: {},
    } as unknown as CallableRequest<unknown>);
    expect(res).toMatchObject({ status: 'SCHEDULED', changed: true, notified: false, notifySkipped: 'no_event_for_action' });
    expect(listed()).toEqual([]);

    await onKinCareSessionLifecycleHandler(
      event(ARRIVED, session({ status: 'SCHEDULED', arrivedAt: '', updatedBy: 'uid_auntie' }), {
        authType: 'service_account',
        authId: 'sa@x',
      }),
    );
    expect(linesOf('VISIT_UNDO_ARRIVAL')).toHaveLength(2);
    expect(bell()).toBe(0);
  });

  it('finds the row when an installed client sent the notice itself and the trigger was the duplicate', async () => {
    seed();
    // The old client's own dispatch lands first; the trigger then records
    // `already_notified` with no row id of its own.
    await dispatchVisitNotificationHandler({
      data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'arrived', eventAtMs: Date.parse(ARRIVED_AT) },
      auth: { uid: 'uid_auntie', token: { admin: true } },
    } as never);
    await onKinCareSessionLifecycleHandler(arrive());
    expect(docs[`visit_step_notices/${visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT))}`]).toMatchObject({
      dispatchIds: [],
    });
    expect(bell()).toBe(1);

    await onKinCareSessionLifecycleHandler(undo());
    expect(bell()).toBe(0);
    expect(listed()).toEqual([]);
  });
});

describe('#2038 a real arrival after the undo is announced once', () => {
  it('re-arriving sends one new notice, and the list holds one arrival, not two', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    await onKinCareSessionLifecycleHandler(undo());
    vi.setSystemTime(NOW + 30 * 60_000);
    await onKinCareSessionLifecycleHandler(arriveAgain());
    // Redelivered: still one.
    await onKinCareSessionLifecycleHandler(arriveAgain());

    expect(sent()).toHaveLength(2);
    expect(listed().map((r) => r.data.key)).toEqual(['kincare.auntie.arrived']);
    expect(bell()).toBe(1);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(2);
  });

  it('an undo that reaches the server after the re-arrival leaves the real arrival listed', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    vi.setSystemTime(NOW + 30 * 60_000);
    // A phone that was offline drains its queue: the re-arrival's event is
    // handled before the undo's.
    await onKinCareSessionLifecycleHandler(arriveAgain());
    await onKinCareSessionLifecycleHandler(undo());

    const still = listed();
    expect(still).toHaveLength(1);
    expect(bell()).toBe(1);
    // The one left is the second arrival's.
    const second = docs[`visit_step_notices/${visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AGAIN_AT))}`] as {
      dispatchIds: string[];
    };
    expect(second.dispatchIds).toEqual([still[0]!.id]);
  });

  it('a wrong tap undone before its notice was sent tells the household nothing at all', async () => {
    seed();
    // The undo's event is handled first and finds no row. The session already
    // reads Scheduled when the arrival's own event is handled.
    docs[SESSION_PATH] = session({ status: 'SCHEDULED', arrivedAt: '' });
    await onKinCareSessionLifecycleHandler(undo());
    await onKinCareSessionLifecycleHandler(arrive());

    expect(sent()).toEqual([]);
    expect(workOrders()).toEqual([]);
    expect(bell()).toBe(0);
    // Both steps are still in the Activity Log.
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(1);
    expect(linesOf('VISIT_UNDO_ARRIVAL')).toHaveLength(1);
  });

  it('a notice sent while the undo was landing is withdrawn as soon as it exists', async () => {
    seed();
    docs[SESSION_PATH] = session({ status: 'SCHEDULED', arrivedAt: '' });
    const step = visitStepOf(session(), ARRIVED)!;
    // `setVisitLifecycle` does not ask first: it has just written the arrival.
    await announceVisitStep({
      sessionId: 's1',
      session: ARRIVED,
      step,
      actorUid: 'uid_auntie',
      source: 'setVisitLifecycle',
      fallbackKey: ARRIVED_AT,
    });

    expect(sent()).toHaveLength(1);
    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);
    expect(rows()[0]?.data).toMatchObject({ withdrawnReason: 'arrival_undone' });
  });

  it('an arrival that still stands is never withdrawn by its own redelivery', async () => {
    seed();
    docs[SESSION_PATH] = { ...ARRIVED };
    await onKinCareSessionLifecycleHandler(arrive());
    await onKinCareSessionLifecycleHandler(arrive());
    docs[SESSION_PATH] = { ...ARRIVED, status: 'COMPLETED', departedAt: '2026-11-10T22:40:00.000Z' };
    await onKinCareSessionLifecycleHandler(arrive());
    expect(listed()).toHaveLength(1);
    expect(bell()).toBe(1);
  });

  it('arrivalStillStands: the same stamped arrival, on a visit that has arrived', () => {
    const at = Date.parse(ARRIVED_AT);
    expect(arrivalStillStands(ARRIVED, at, stampMs)).toBe(true);
    expect(arrivalStillStands({ ...ARRIVED, status: 'departed ' }, at, stampMs)).toBe(true);
    expect(arrivalStillStands({ ...ARRIVED, status: 'COMPLETED' }, at, stampMs)).toBe(true);
    expect(arrivalStillStands(session({ status: 'SCHEDULED', arrivedAt: '' }), at, stampMs)).toBe(false);
    expect(arrivalStillStands(session({ status: 'ON_MY_WAY', arrivedAt: ARRIVED_AT }), at, stampMs)).toBe(false);
    expect(arrivalStillStands(session({ status: 'ARRIVED', arrivedAt: ARRIVED_AGAIN_AT }), at, stampMs)).toBe(false);
    expect(arrivalStillStands(undefined, at, stampMs)).toBe(false);
  });
});

describe('#2038 "On my way" around an undone arrival', () => {
  const ON_MY_WAY = session({ status: 'ON_MY_WAY', onMyWayAt: ON_MY_WAY_AT });
  const ARRIVED_AFTER_OMW = session({ status: 'ARRIVED', onMyWayAt: ON_MY_WAY_AT, arrivedAt: ARRIVED_AT });

  it('the undo goes back to On my way, sends nothing, and leaves the "on the way" notice listed', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(event(session(), ON_MY_WAY));
    await onKinCareSessionLifecycleHandler(event(ON_MY_WAY, ARRIVED_AFTER_OMW));
    expect(bell()).toBe(2);
    const noticesBefore = sent().length;

    await onKinCareSessionLifecycleHandler(event(ARRIVED_AFTER_OMW, { ...ON_MY_WAY, arrivedAt: '' }));

    expect(sent()).toHaveLength(noticesBefore);
    expect(listed().map((r) => r.data.key)).toEqual(['kincare.auntie.on_my_way']);
    expect(bell()).toBe(1);
  });

  it('On my way pressed again after the undo is already true: nothing is written, so nothing is sent', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'ARRIVED', action: 'UNDO_ARRIVAL', onMyWayAt: ON_MY_WAY_AT })).toMatchObject({
      kind: 'apply',
      to: 'ON_MY_WAY',
    });
    expect(evaluateVisitLifecycle({ currentStatus: 'ON_MY_WAY', action: 'ON_MY_WAY', onMyWayAt: ON_MY_WAY_AT })).toEqual({
      kind: 'noop',
      at: 'ON_MY_WAY',
    });
    // And a write that leaves the status at On my way is not a clock step.
    expect(visitStepOf(ON_MY_WAY, { ...ON_MY_WAY, onMyWayAt: '2026-11-10T22:05:00.000Z' })).toBeNull();
  });
});

describe('#2038 a withdrawn notice does not come back', () => {
  const asKinfolk = (data: unknown) =>
    ({ data, auth: { uid: 'uid_kinfolk', token: {} }, rawRequest: {} }) as unknown as CallableRequest<unknown>;

  it('the restore callables leave it withdrawn, one at a time and in bulk', async () => {
    seed({
      'notifications/filed': { key: 'invoice.new', recipientUid: 'uid_kinfolk', archivedAt: '__TS__', data: {} },
    });
    await onKinCareSessionLifecycleHandler(arrive());
    await onKinCareSessionLifecycleHandler(undo());
    const id = rows().find((r) => r.data.key === 'kincare.auntie.arrived')!.id;

    await expect(unarchiveNotificationHandler(asKinfolk({ id }))).resolves.toEqual({ unarchived: 0 });
    await expect(bulkUnarchiveNotificationsHandler(asKinfolk({ ids: [id, 'filed'] }))).resolves.toEqual({ unarchived: 1 });

    expect(docs[`notifications/${id}`]).toMatchObject({ archivedAt: '__TS__', withdrawnAt: '__TS__' });
    expect(docs['notifications/filed']).toMatchObject({ archivedAt: null });
    expect(listed().map((r) => r.id)).toEqual(['filed']);
  });

  it('is left out even if its archive stamp were cleared', () => {
    const row = { recipientUid: 'uid_kinfolk', archivedAt: null, withdrawnAt: '__TS__', data: { kinfolkId: 'fam1' } };
    expect(isVisibleNotification(row, 'fam1')).toBe(false);
  });
});
