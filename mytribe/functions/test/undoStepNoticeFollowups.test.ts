import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2357 (which also covers #2348): three follow-ups to the quiet "Undo
 * arrived" (#2038) and the quiet "Undo departed" (#2250).
 *
 *   1. The quiet rule covers a quick mistake only. A real arrival or departure
 *      that reaches the server on a later business day than the undone one is
 *      announced as a normal notice.
 *   2. "Your Auntie has left" follows the arrival it belongs to: Undo arrival
 *      takes it off the household's list with the arrival's entry, and the
 *      next real Departed puts it back with no second message (same day).
 *   3. What the undo took off the list is recorded, so the admin clients only
 *      say an entry came off when one did.
 *
 * These run the session trigger over the REAL dispatcher, as the #2038 cases
 * do, so a notice here is the `notifications/` row the household's list reads
 * and the bell counts, and a work order is what drives email, text and push.
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
import { announceVisitStep, visitStepOf, visitStepNoticeId, stampMs } from '../src/lib/visitStepNotice';
import { dispatchVisitNotificationHandler } from '../src/admin/dispatchVisitNotification';
import { setVisitLifecycleHandler } from '../src/admin/setVisitLifecycle';
import { isUnreadNotification, isVisibleNotification } from '../src/lib/recipientNotifications';
import { departuresOfArrival, departureStillStands, isLaterBusinessDay } from '../src/lib/arrivalNoticeWithdrawal';
import { businessCalendarDate } from '../src/lib/bookingTimeBlocks';
import {
  arrivalNoticeReplacedWords,
  departureNoticeReplacedWords,
  departureNoticeRestoredWords,
  departureNoticeWithdrawnWords,
} from '../src/lib/activityWords';

/** 4:00 PM in Chicago on Tuesday the 10th. */
const DAY1 = Date.UTC(2026, 10, 10, 22, 0, 0);
/** 9:00 AM in Chicago on Wednesday the 11th. */
const DAY2 = Date.UTC(2026, 10, 11, 15, 0, 0);
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';
const SESSION_PATH = 'kin_care_sessions/s1';
const SETTINGS_PATH = 'business_settings/business_settings';
const ARRIVED_KEY = 'kincare.auntie.arrived';
const DEPARTED_KEY = 'kincare.auntie.departed';

let ctx: ReturnType<typeof buildDbMock>;
/** The store itself: `buildDbMock` reads and writes this same object. */
let docs: Record<string, Record<string, unknown> | null>;

function seed(extra: Record<string, Record<string, unknown> | null> = {}) {
  docs = {
    [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: DAY1, kinfolkId: 'fam1' },
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

type Row = Record<string, unknown>;
const session = (extra: Row = {}): Row => ({
  kinfolkId: 'fam1',
  kinCareBatchId: 'batch1',
  kinCareVisitId: 'visit1',
  status: 'SCHEDULED',
  ...extra,
});

function event(before: Row, after: Row, extra: Partial<SessionLifecycleEvent> = {}): SessionLifecycleEvent {
  const snap = (data: Row) => ({ exists: true, data: () => data });
  return {
    id: 'evt-1',
    params: { sessionId: 's1' },
    data: { before: snap(before), after: snap(after) },
    authType: 'unknown',
    authId: 'uid_auntie',
    ...extra,
  } as unknown as SessionLifecycleEvent;
}

/**
 * One saved clock step, as a client's own write reaches the server: the visit
 * on file reads the new state, the clock stands at `atMs`, and the session
 * trigger handles the move. The step is stamped with the same moment unless
 * `stamp` says what the device wrote.
 */
let current: Row;
async function move(patch: Row, atMs?: number): Promise<SessionLifecycleEvent> {
  if (atMs !== undefined) vi.setSystemTime(atMs);
  const before = current;
  current = { ...current, ...patch };
  docs[SESSION_PATH] = current;
  const evt = event(before, current);
  await onKinCareSessionLifecycleHandler(evt);
  return evt;
}
const arrive = (atMs: number, stamp: string = iso(atMs)) => move({ status: 'ARRIVED', arrivedAt: stamp }, atMs);
const depart = (atMs: number, stamp: string = iso(atMs)) => move({ status: 'DEPARTED', departedAt: stamp }, atMs);
const undoArrival = (atMs?: number) => move({ status: 'SCHEDULED', arrivedAt: '', departedAt: '' }, atMs);
const undoDeparted = (atMs?: number) => move({ status: 'ARRIVED', departedAt: '' }, atMs);

/** Every `notifications/` row on file for the household, with its id. */
function rows(key?: string): Array<{ id: string; data: Row }> {
  return Object.entries(docs)
    .filter(([path, data]) => path.startsWith('notifications/') && data?.['recipientUid'] === 'uid_kinfolk')
    .map(([path, data]) => ({ id: path.slice('notifications/'.length), data: data as Row }))
    .filter((r) => key === undefined || r.data['key'] === key);
}
/** What `listMyNotifications` shows for fam1, by the predicate it uses. */
const listed = () => rows().filter((r) => isVisibleNotification(r.data, 'fam1'));
const listedKeys = () => listed().map((r) => r.data['key']).sort();
/** What the bell counts for fam1: the server's count, which both MyTribe clients mirror. */
const bell = () => listed().filter((r) => isUnreadNotification(r.data)).length;
/** New notices created (a `set` that carries the recipient), as opposed to a stamp on an old one. */
const sent = (key?: string) =>
  ctx.writes.filter(
    (w) =>
      w.path.startsWith('notifications/') &&
      w.data.recipientUid === 'uid_kinfolk' &&
      (key === undefined || w.data.key === key),
  );
/** Work orders: what drives an email, a text or a push. */
const workOrders = () => ctx.writes.filter((w) => w.path.startsWith('notificationDispatch/'));
const linesOf = (kind: string) => mocks.lines.filter((l) => l.event === kind);
const record = (eventName: string, at: number | string) =>
  docs[`visit_step_notices/${visitStepNoticeId('s1', eventName, typeof at === 'number' ? at : Date.parse(at))}`] as
    | Row
    | undefined;
const asAdmin = (data: unknown) => ({ data, auth: { uid: 'uid_auntie', token: { admin: true } } }) as never;
const clientDispatch = (eventName: 'arrived' | 'departed', eventAtMs: number) =>
  dispatchVisitNotificationHandler(
    asAdmin({ familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: eventName, eventAtMs }),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DAY1);
  current = session();
  mocks.lines.length = 0;
  mocks.ids.clear();
  mocks.logEventFn.mockReset();
  mocks.authFn.mockReset().mockReturnValue({ getUser: async () => ({ customClaims: { staffRole: 'auntie' } }) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('#2357 a real arrival on a later business day is announced as normal', () => {
  it('the same day stays quiet: the one entry goes back, nothing is sent', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const orders = workOrders().length;
    await arrive(DAY1 + 30 * MIN);

    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(workOrders()).toHaveLength(orders);
    expect(bell()).toBe(1);
    expect(record('arrived', DAY1 + 30 * MIN)).toMatchObject({ notified: false, reason: 'already_notified' });
  });

  it('the next day: a new entry, and a new work order for email, text or push by their channels', async () => {
    seed();
    await arrive(DAY1);
    const first = rows(ARRIVED_KEY)[0]!.id;
    await undoArrival(DAY1 + MIN);
    const orders = workOrders().length;

    await arrive(DAY2);

    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders + 1);
    expect(record('arrived', DAY2)).toMatchObject({ notified: true, reason: null });
    // The wrong tap's entry stays off the list; the real arrival has its own.
    expect(listed().map((r) => r.id)).not.toContain(first);
    expect(listedKeys()).toEqual([ARRIVED_KEY]);
    expect(bell()).toBe(1);
    expect(docs[`notifications/${first}`]).toMatchObject({ withdrawnReason: 'arrival_undone' });
    // Nothing was put back, so the Activity Log does not say an entry was.
    expect(linesOf('VISIT_ARRIVED').map((l) => l.description)).toEqual([
      'Marked the arrival: scheduled to arrived',
      'Marked the arrival: scheduled to arrived',
    ]);
  });

  it('a redelivered event of the later-day arrival sends nothing more', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const evt = await arrive(DAY2);
    await onKinCareSessionLifecycleHandler(evt);
    vi.setSystemTime(DAY2 + 2 * 60 * MIN);
    await onKinCareSessionLifecycleHandler(evt);

    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(bell()).toBe(1);
  });

  it('a later UTC date that is still the same business day stays quiet', async () => {
    seed();
    await arrive(DAY1); // 4 PM Chicago on the 10th
    await undoArrival(DAY1 + MIN);
    await arrive(Date.UTC(2026, 10, 11, 3, 0, 0)); // 9 PM Chicago on the 10th, the 11th in UTC

    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(bell()).toBe(1);
  });

  it("the day is read on the business's own clock, not the server's and not Chicago's", async () => {
    // 11 PM in Tokyo on the 10th, then 00:30 AM on the 11th: one Chicago morning, two Tokyo days.
    seed({ [SETTINGS_PATH]: { timeZone: 'Asia/Tokyo', householdNotificationsLive: true } });
    const late = Date.UTC(2026, 10, 10, 14, 0, 0);
    await arrive(late);
    await undoArrival(late + MIN);
    await arrive(late + 90 * MIN);

    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(record('arrived', late + 90 * MIN)).toMatchObject({ notified: true });
  });

  it('a zone the server cannot read falls back to Chicago, never to the UTC date', async () => {
    seed({ [SETTINGS_PATH]: { timeZone: 'Not/AZone', householdNotificationsLive: true } });
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    await arrive(Date.UTC(2026, 10, 11, 3, 0, 0));
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
  });

  it("the desktop console's zone-less stamp does not decide the day: the server's clock does", async () => {
    seed();
    // The console writes the business's wall clock with no zone on it.
    await arrive(DAY1, '2026-11-10T16:00:00');
    await undoArrival(DAY1 + MIN);
    // 9 PM Chicago the same day. Read as UTC, this stamp and the first would
    // both be the 10th; read as instants they would straddle UTC midnight.
    await arrive(Date.UTC(2026, 10, 11, 3, 0, 0), '2026-11-10T21:00:00');
    expect(sent(ARRIVED_KEY)).toHaveLength(1);

    await undoArrival();
    // The next morning, stamped 8 AM with no zone.
    await arrive(Date.UTC(2026, 10, 11, 14, 0, 0), '2026-11-11T08:00:00');
    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(bell()).toBe(1);
  });

  it('keeps the household send gate: a later-day arrival with the switch off says the switch is off', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    docs[SETTINGS_PATH] = { householdNotificationsLive: false };
    const evt = await arrive(DAY2);

    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(record('arrived', DAY2)).toMatchObject({ notified: false, reason: 'household_notices_off' });
    expect(listed()).toEqual([]);
    // And the callable answers the same.
    const step = visitStepOf(evt.data!.before.data() as Row, current)!;
    await expect(
      announceVisitStep({ sessionId: 's1', session: current, step, actorUid: 'uid_auntie', source: 'setVisitLifecycle', fallbackKey: 'x' }),
    ).resolves.toEqual({ notified: false, notifySkipped: 'household_notices_off' });
  });

  it('keeps the channel choices: a household that turned the notice off is not sent a later-day one', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    docs['clients/uid_kinfolk'] = {
      displayName: 'Dre',
      notificationPreferences: { [ARRIVED_KEY]: { inApp: false, email: false, sms: false, push: false } },
    };
    await arrive(DAY2);
    const rec = record('arrived', DAY2)!;
    // Whatever the dispatcher answers for their own choice, it is never "already told".
    expect(rec['reason']).not.toBe('already_notified');
  });

  it('day 1 told, undone; day 2 announced, undone; day 2 again: the day-2 entry is the one put back', async () => {
    seed();
    await arrive(DAY1);
    const dayOne = rows(ARRIVED_KEY)[0]!.id;
    await undoArrival(DAY1 + MIN);
    await arrive(DAY2);
    const dayTwo = rows(ARRIVED_KEY).find((r) => r.id !== dayOne)!.id;
    await undoArrival(DAY2 + MIN);
    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);

    await arrive(DAY2 + 20 * MIN);

    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(listed().map((r) => r.id)).toEqual([dayTwo]);
    expect(bell()).toBe(1);
    expect(docs[`notifications/${dayOne}`]).toMatchObject({ withdrawnReason: 'arrival_undone' });
    expect(record('arrived', DAY2 + 20 * MIN)).toMatchObject({ reason: 'already_notified', dispatchIds: [dayTwo] });
  });

  it('a first arrival that never reached the household is announced whenever the real one lands', async () => {
    seed({ 'kinfolk/fam1': { uid: '' }, 'families/fam1/members/uid_kinfolk': null });
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    docs['kinfolk/fam1'] = { uid: 'uid_kinfolk' };
    docs['families/fam1/members/uid_kinfolk'] = { role: 'PRIMARY', status: 'ACTIVE' };
    await arrive(DAY1 + 10 * MIN);
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(record('arrived', DAY1 + 10 * MIN)).toMatchObject({ notified: true });
  });

  it('isLaterBusinessDay: later only, never the same day and never a clock that ran back', () => {
    const later = (a: number, b: number, zone = 'America/Chicago') => isLaterBusinessDay(a, b, zone, businessCalendarDate);
    expect(later(DAY1, DAY1 + MIN)).toBe(false);
    expect(later(DAY1, Date.UTC(2026, 10, 11, 5, 59, 0))).toBe(false); // 11:59 PM Chicago
    expect(later(DAY1, Date.UTC(2026, 10, 11, 6, 0, 0))).toBe(true); // midnight Chicago
    expect(later(DAY2, DAY1)).toBe(false);
    expect(later(DAY1, DAY2 + 30 * 24 * 60 * MIN)).toBe(true);
  });
});

describe('#2357 an installed client that still dispatches the step itself', () => {
  it('the same day: answers already_notified before and after the trigger, and nothing is sent', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const again = DAY1 + 30 * MIN;
    vi.setSystemTime(again);
    current = { ...current, status: 'ARRIVED', arrivedAt: iso(again) };
    docs[SESSION_PATH] = current;

    await expect(clientDispatch('arrived', again)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified', dispatchIds: [] });
    await onKinCareSessionLifecycleHandler(event(session({ arrivedAt: '' }), current));
    await expect(clientDispatch('arrived', again)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
  });

  it('a later day, the client first: it sends the one notice and the trigger is the duplicate', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const orders = workOrders().length;
    vi.setSystemTime(DAY2);
    current = { ...current, status: 'ARRIVED', arrivedAt: iso(DAY2) };
    docs[SESSION_PATH] = current;

    await expect(clientDispatch('arrived', DAY2)).resolves.toMatchObject({ suppressed: false, reason: null });
    await onKinCareSessionLifecycleHandler(event(session({ arrivedAt: '' }), current));
    await expect(clientDispatch('arrived', DAY2)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });

    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders + 1);
    expect(bell()).toBe(1);
  });

  it('a later day, the trigger first: the client is the duplicate', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const orders = workOrders().length;
    await arrive(DAY2);
    await expect(clientDispatch('arrived', DAY2)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders + 1);
  });

  it('the first arrival of a visit is dispatched by an installed client as before', async () => {
    seed({ [SESSION_PATH]: session({ status: 'ARRIVED', arrivedAt: iso(DAY1) }) });
    await expect(clientDispatch('arrived', DAY1)).resolves.toMatchObject({ suppressed: false });
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
  });

  it('a departure: quiet the same day, sent once on a later day', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoDeparted(DAY1 + 31 * MIN);
    const sameDay = DAY1 + 40 * MIN;
    vi.setSystemTime(sameDay);
    docs[SESSION_PATH] = { ...current, status: 'DEPARTED', departedAt: iso(sameDay) };
    await expect(clientDispatch('departed', sameDay)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(sent(DEPARTED_KEY)).toHaveLength(1);

    vi.setSystemTime(DAY2);
    docs[SESSION_PATH] = { ...current, status: 'DEPARTED', departedAt: iso(DAY2) };
    await expect(clientDispatch('departed', DAY2)).resolves.toMatchObject({ suppressed: false });
    await expect(clientDispatch('departed', DAY2)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
  });
});

describe('#2348 "Your Auntie has left" follows the arrival it belongs to', () => {
  it('Undo arrival from Departed takes both entries off the list and the bell, and sends nothing', async () => {
    seed({
      'notifications/other': { key: 'invoice.new', recipientUid: 'uid_kinfolk', data: { kinfolkId: 'fam1' } },
    });
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    expect(listedKeys()).toEqual(['invoice.new', ARRIVED_KEY, DEPARTED_KEY].sort());
    expect(bell()).toBe(3);
    const notices = sent().length;
    const orders = workOrders().length;

    await undoArrival(DAY1 + 31 * MIN);

    expect(listedKeys()).toEqual(['invoice.new']);
    expect(bell()).toBe(1);
    expect(sent()).toHaveLength(notices);
    expect(workOrders()).toHaveLength(orders);
    // Withdrawn, not deleted, each under its own reason.
    expect(rows(ARRIVED_KEY)[0]?.data).toMatchObject({ withdrawnAt: '__TS__', withdrawnReason: 'arrival_undone' });
    expect(rows(DEPARTED_KEY)[0]?.data).toMatchObject({
      archivedAt: '__TS__',
      withdrawnAt: '__TS__',
      withdrawnReason: 'departure_undone',
    });
    // One Activity Log line for each notice, in plain words.
    expect(linesOf('VISIT_UNDO_ARRIVAL').map((l) => l.description)).toEqual([
      'Undid the arrival: departed to scheduled',
      "Took the arrival notice off the household's notifications list. No message was sent about the undo",
      "Took the departure notice off the household's notifications list. No message was sent about the undo",
    ]);
    for (const words of [departureNoticeWithdrawnWords(), departureNoticeRestoredWords()]) {
      expect(words).not.toMatch(/—|inbox|pet|client|sitter/i);
    }
  });

  it('the household hears each step once: arriving and departing again the same day sends nothing more', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    const left = rows(DEPARTED_KEY)[0]!.id;
    docs[`notifications/${left}`] = { ...docs[`notifications/${left}`], readAt: '__READ__' };
    await undoArrival(DAY1 + 31 * MIN);
    const orders = workOrders().length;

    await arrive(DAY1 + 40 * MIN);
    expect(listedKeys()).toEqual([ARRIVED_KEY]);
    const evt = await depart(DAY1 + 70 * MIN);
    await onKinCareSessionLifecycleHandler(evt);

    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(workOrders()).toHaveLength(orders);
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
    expect(bell()).toBe(2);
    // The one "has left" entry is back, unread, standing for the real departure.
    expect(docs[`notifications/${left}`]).toMatchObject({
      archivedAt: null,
      withdrawnAt: null,
      withdrawnReason: null,
      readAt: null,
      createdAt: '__TS__',
      standsForDepartureAtMs: DAY1 + 70 * MIN,
    });
    expect(record('departed', DAY1 + 70 * MIN)).toMatchObject({
      notified: false,
      reason: 'already_notified',
      dispatchIds: [left],
      arrivalAtMs: DAY1 + 40 * MIN,
    });
    expect(linesOf('VISIT_DEPARTED').map((l) => l.description)).toEqual([
      'Marked the departure: arrived to departed',
      'Marked the departure: arrived to departed',
      departureNoticeRestoredWords(),
    ]);
  });

  it('Undo departed, then Undo arrival: the same, one "has left" and not two', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoDeparted(DAY1 + 31 * MIN);
    // "Undo departed" alone leaves the entry listed (#2250).
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);

    await undoArrival(DAY1 + 32 * MIN);
    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);

    await arrive(DAY1 + 40 * MIN);
    await depart(DAY1 + 70 * MIN);
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
    expect(bell()).toBe(2);
  });

  it('every order again, ending undone: nothing is left listed and nothing more was sent', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 10 * MIN);
    await undoDeparted(DAY1 + 11 * MIN);
    await depart(DAY1 + 12 * MIN);
    await undoArrival(DAY1 + 13 * MIN);
    await arrive(DAY1 + 20 * MIN);
    await depart(DAY1 + 30 * MIN);
    await undoDeparted(DAY1 + 31 * MIN);
    await undoArrival(DAY1 + 32 * MIN);

    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);
    expect(rows()).toHaveLength(2);
  });

  it('on a later business day the arrival and the departure are both announced', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoArrival(DAY1 + 31 * MIN);
    const orders = workOrders().length;

    await arrive(DAY2);
    await depart(DAY2 + 30 * MIN);

    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders + 2);
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
    expect(bell()).toBe(2);
    expect(record('departed', DAY2 + 30 * MIN)).toMatchObject({ notified: true, reason: null });
  });

  it('a departure never told has nothing to take off, and the real one is announced', async () => {
    seed();
    await arrive(DAY1);
    docs[SETTINGS_PATH] = { householdNotificationsLive: false };
    await depart(DAY1 + 30 * MIN);
    expect(rows(DEPARTED_KEY)).toEqual([]);
    await undoArrival(DAY1 + 31 * MIN);
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived'] });
    expect(linesOf('VISIT_UNDO_ARRIVAL')).toHaveLength(2);

    docs[SETTINGS_PATH] = { householdNotificationsLive: true };
    await arrive(DAY1 + 40 * MIN);
    await depart(DAY1 + 70 * MIN);
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(record('departed', DAY1 + 70 * MIN)).toMatchObject({ notified: true });
  });

  it("an undo handled after the visit's next arrival and departure leaves their entries listed", async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 10 * MIN);
    // A phone drains its queue out of order: the undo's event comes last.
    const undone = event(current, { ...current, status: 'SCHEDULED', arrivedAt: '', departedAt: '' });
    current = { ...current, status: 'SCHEDULED', arrivedAt: '', departedAt: '' };
    await arrive(DAY1 + 20 * MIN);
    await depart(DAY1 + 30 * MIN);
    await onKinCareSessionLifecycleHandler(undone);

    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
    expect(rows(DEPARTED_KEY)[0]?.data).toMatchObject({ standsForDepartureAtMs: DAY1 + 30 * MIN });
    expect(rows(DEPARTED_KEY)[0]?.data).not.toHaveProperty('withdrawnAt');
    // The household was told and still has both entries, so nothing on file
    // says the undo found them never told.
    expect(record('undo_arrival', DAY1)).toBeUndefined();
  });

  it('a departure the visit was already completed for is still announced: completion is not an undo', async () => {
    seed();
    await arrive(DAY1);
    const before = current;
    const departed = { ...current, status: 'DEPARTED', departedAt: iso(DAY1 + 30 * MIN) };
    // The departure trigger completed the visit before this one ran.
    docs[SESSION_PATH] = { ...departed, status: 'COMPLETED', completedAt: iso(DAY1 + 30 * MIN) };
    vi.setSystemTime(DAY1 + 30 * MIN);
    await onKinCareSessionLifecycleHandler(event(before, departed));

    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(record('departed', DAY1 + 30 * MIN)).toMatchObject({ notified: true, arrivalAtMs: DAY1 });
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
  });

  it('a "has left" sent while the Undo arrival was landing is taken off as soon as it exists', async () => {
    seed();
    await arrive(DAY1);
    const departed = { ...current, status: 'DEPARTED', departedAt: iso(DAY1 + 10 * MIN) };
    const step = visitStepOf(current, departed)!;
    // The undo has already been saved and handled; it found no "has left" row.
    await undoArrival(DAY1 + 11 * MIN);
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived'] });
    // `setVisitLifecycle` does not ask first: it has just written the departure.
    await announceVisitStep({
      sessionId: 's1',
      session: departed,
      step,
      actorUid: 'uid_auntie',
      source: 'setVisitLifecycle',
      fallbackKey: 'x',
    });

    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(listed()).toEqual([]);
    expect(rows(DEPARTED_KEY)[0]?.data).toMatchObject({ withdrawnReason: 'departure_undone' });
    // And the undo's record is brought up to date.
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived', 'departed'] });
  });

  it('a Departed tap taken back before its notice was sent tells the household nothing', async () => {
    seed();
    await arrive(DAY1);
    const before = current;
    const departed = { ...current, status: 'DEPARTED', departedAt: iso(DAY1 + 10 * MIN) };
    // "Undo departed" is saved before the departure's own event is handled.
    await onKinCareSessionLifecycleHandler(event(before, departed));
    expect(sent(DEPARTED_KEY)).toEqual([]);
    expect(linesOf('VISIT_DEPARTED')).toHaveLength(1);
    // The real departure later is the first the household hears of it.
    await depart(DAY1 + 20 * MIN);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
  });

  it('another visit of the same household keeps its own entries', async () => {
    seed({
      'families/fam1/bookings/batch1/kinCares/visit2': { serviceType: 'Dog Walk', scheduledAtMs: DAY1, kinfolkId: 'fam1' },
    });
    const other = (extra: Row) => session({ kinCareVisitId: 'visit2', ...extra });
    // An hour earlier: the test's visit resolver answers `visit1` for both, so the stamps must differ.
    const otherArrived = other({ status: 'ARRIVED', arrivedAt: iso(DAY1 - 60 * MIN) });
    const otherDeparted = { ...otherArrived, status: 'DEPARTED', departedAt: iso(DAY1 - 30 * MIN) };
    docs['kin_care_sessions/s2'] = otherDeparted;
    await onKinCareSessionLifecycleHandler(event(other({}), otherArrived, { params: { sessionId: 's2' } }));
    await onKinCareSessionLifecycleHandler(event(otherArrived, otherDeparted, { params: { sessionId: 's2' } }));

    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoArrival(DAY1 + 31 * MIN);

    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
    expect(bell()).toBe(2);
    expect(sent()).toHaveLength(4);
  });

  it('departuresOfArrival: by the arrival each names, and by the clock for a record from before', () => {
    const rec = (eventName: string, atMs: number, arrivalAtMs: number | null = null) => ({ event: eventName, atMs, arrivalAtMs });
    const records = [rec('arrived', 100), rec('departed', 150, 100), rec('arrived', 200), rec('departed', 250, 200)];
    expect(departuresOfArrival(records, 100).map((r) => r.atMs)).toEqual([150]);
    expect(departuresOfArrival(records, 200).map((r) => r.atMs)).toEqual([250]);
    const old = [rec('arrived', 100), rec('departed', 150), rec('arrived', 200), rec('departed', 250)];
    expect(departuresOfArrival(old, 100).map((r) => r.atMs)).toEqual([150]);
    expect(departuresOfArrival(old, 200).map((r) => r.atMs)).toEqual([250]);
    // An undo with no stamped arrival cannot tell whose departure is whose: none.
    expect(departuresOfArrival(old, null)).toEqual([]);
    expect(departuresOfArrival(records, null)).toEqual([]);
  });

  it('departureStillStands: the same stamped departure, on a visit that has left', () => {
    const at = DAY1 + 30 * MIN;
    const left = session({ status: 'DEPARTED', arrivedAt: iso(DAY1), departedAt: iso(at) });
    expect(departureStillStands(left, at, stampMs)).toBe(true);
    expect(departureStillStands({ ...left, status: 'completed ' }, at, stampMs)).toBe(true);
    expect(departureStillStands({ ...left, status: 'ARRIVED', departedAt: '' }, at, stampMs)).toBe(false);
    expect(departureStillStands({ ...left, departedAt: iso(at + MIN) }, at, stampMs)).toBe(false);
    expect(departureStillStands(undefined, at, stampMs)).toBe(false);
  });
});

describe('#2250 "Undo departed" alone, with the day rule (#2357)', () => {
  it('leaves "has left" listed; the real Departed the same day changes nothing the household sees', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    const left = rows(DEPARTED_KEY)[0]!.id;
    docs[`notifications/${left}`] = { ...docs[`notifications/${left}`], readAt: '__READ__', createdAt: '__FIRST__' };
    await undoDeparted(DAY1 + 31 * MIN);
    expect(listedKeys()).toEqual([ARRIVED_KEY, DEPARTED_KEY]);
    const orders = workOrders().length;

    await depart(DAY1 + 35 * MIN);

    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(workOrders()).toHaveLength(orders);
    // Not re-dated and not unread again: they were never without this entry.
    expect(docs[`notifications/${left}`]).toMatchObject({
      readAt: '__READ__',
      createdAt: '__FIRST__',
      standsForDepartureAtMs: DAY1 + 35 * MIN,
    });
    expect(bell()).toBe(1);
    expect(record('departed', DAY1 + 35 * MIN)).toMatchObject({ notified: false, reason: 'already_notified' });
    // Nothing went back on the list, so the Activity Log does not say it did.
    expect(linesOf('VISIT_DEPARTED').map((l) => l.description)).not.toContain(departureNoticeRestoredWords());
  });

  it('a real Departed on a later business day is announced as normal', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoDeparted(DAY1 + 31 * MIN);
    const orders = workOrders().length;

    await depart(DAY2);

    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders + 1);
    expect(record('departed', DAY2)).toMatchObject({ notified: true, reason: null });
  });

  it('through setVisitLifecycle: quiet the same day, announced the next', async () => {
    const tap = (atIso: string) =>
      setVisitLifecycleHandler({
        data: { sessionId: 's1', action: 'DEPARTED', atIso },
        auth: { uid: 'uid_auntie', token: { admin: true, name: 'TiTi' } },
        rawRequest: {},
      } as unknown as CallableRequest<unknown>);
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoDeparted(DAY1 + 31 * MIN);
    vi.setSystemTime(DAY1 + 35 * MIN);
    await expect(tap(iso(DAY1 + 35 * MIN))).resolves.toMatchObject({ notified: false, notifySkipped: 'already_notified' });

    docs[SESSION_PATH] = { ...current };
    vi.setSystemTime(DAY2);
    await expect(tap(iso(DAY2))).resolves.toMatchObject({ notified: true, notifySkipped: null });
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
  });
});

describe('#2357 what an Undo arrival took off the list is recorded for the admin clients', () => {
  it('an arrival the household was told about: the record says the arrival notice came off', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    expect(record('undo_arrival', DAY1)).toMatchObject({
      sessionId: 's1',
      action: 'UNDO_ARRIVAL',
      event: 'undo_arrival',
      atMs: DAY1,
      notified: false,
      reason: 'no_event_for_action',
      withdrawn: ['arrived'],
    });
  });

  it('from Departed, both told: both are named', async () => {
    seed();
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoArrival(DAY1 + 31 * MIN);
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived', 'departed'] });
  });

  it.each([
    ['no member login', { 'kinfolk/fam1': { uid: '' }, 'families/fam1/members/uid_kinfolk': null }],
    ['the household switch off', { [SETTINGS_PATH]: { householdNotificationsLive: false } }],
  ])('a household never told (%s): the record says nothing came off', async (_why, extra) => {
    seed(extra as Record<string, Record<string, unknown> | null>);
    await arrive(DAY1);
    expect(rows()).toEqual([]);
    await undoArrival(DAY1 + MIN);
    expect(record('undo_arrival', DAY1)).toMatchObject({ event: 'undo_arrival', notified: false, withdrawn: [] });
    expect(linesOf('VISIT_UNDO_ARRIVAL')).toHaveLength(1);
  });

  it('the callable and the trigger its write fires: the second never takes the answer back', async () => {
    seed();
    await arrive(DAY1);
    const before = current;
    const res = await setVisitLifecycleHandler({
      data: { sessionId: 's1', action: 'UNDO_ARRIVAL' },
      auth: { uid: 'uid_auntie', token: { staffRole: 'auntie', name: 'TiTi' } },
      rawRequest: {},
    } as unknown as CallableRequest<unknown>);
    expect(res).toMatchObject({ status: 'SCHEDULED', notified: false, notifySkipped: 'no_event_for_action' });
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived'] });

    await onKinCareSessionLifecycleHandler(
      event(before, session({ status: 'SCHEDULED', arrivedAt: '', updatedBy: 'uid_auntie' }), {
        authType: 'service_account',
        authId: 'sa@x',
      }),
    );
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived'] });
    expect(listed()).toEqual([]);
  });

  it('an undo handled before the arrival\'s own notice is settled writes no record yet, so no client reads "not told" early', async () => {
    seed();
    const arrived = session({ status: 'ARRIVED', arrivedAt: iso(DAY1) });
    const undone = session({ status: 'SCHEDULED', arrivedAt: '' });
    docs[SESSION_PATH] = undone;
    await onKinCareSessionLifecycleHandler(event(arrived, undone));
    expect(record('undo_arrival', DAY1)).toBeUndefined();

    // The arrival's own event is handled next. It was never announced, and says so.
    await onKinCareSessionLifecycleHandler(event(session(), arrived));
    expect(sent()).toEqual([]);
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: [] });
  });

  it('a notice that was sent while the undo was landing: the record says it came off', async () => {
    seed();
    const arrived = session({ status: 'ARRIVED', arrivedAt: iso(DAY1) });
    const undone = session({ status: 'SCHEDULED', arrivedAt: '' });
    docs[SESSION_PATH] = undone;
    await onKinCareSessionLifecycleHandler(event(arrived, undone));
    await announceVisitStep({
      sessionId: 's1',
      session: arrived,
      step: visitStepOf(session(), arrived)!,
      actorUid: 'uid_auntie',
      source: 'setVisitLifecycle',
      fallbackKey: 'x',
    });
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(listed()).toEqual([]);
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived'] });
  });

  it('the record is never read as an arrival or a departure of the visit', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    await arrive(DAY1 + 10 * MIN);
    await depart(DAY1 + 20 * MIN);
    // One of each: the undo's record did not stand in for a told step.
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(record('departed', DAY1 + 20 * MIN)).toMatchObject({ notified: true });
  });
});
describe('#2357 a notice announced on a later business day replaces the earlier day\'s entry', () => {
  /** Arrived and Departed on day 1, then "Undo departed" alone: "has left" stays listed (#2250). */
  async function undoneDepartureOnDayOne(): Promise<string> {
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    const first = rows(DEPARTED_KEY)[0]!.id;
    await undoDeparted(DAY1 + 31 * MIN);
    expect(listed().map((r) => r.id)).toContain(first);
    return first;
  }
  const departedListed = () => listed().filter((r) => r.data['key'] === DEPARTED_KEY).map((r) => r.id);
  it('Undo departed alone, then Departed the next day: the household sees only the real "has left"', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    expect(bell()).toBe(2);
    const orders = workOrders().length;
    await depart(DAY2);
    const second = rows(DEPARTED_KEY).find((r) => r.id !== first)!.id;
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders + 1);
    expect(departedListed()).toEqual([second]);
    expect(docs[`notifications/${first}`]).toMatchObject({ withdrawnReason: 'departure_undone', withdrawnFiledAway: true });
    // The arrival's entry and the one real departure: the count did not grow by two.
    expect(bell()).toBe(2);
    expect(linesOf('VISIT_DEPARTED').map((l) => l.description).filter((d) => d === departureNoticeReplacedWords())).toHaveLength(1);
    // Nothing was sent about the entry that came off.
    expect(workOrders()).toHaveLength(orders + 1);
  });
  it('the bell stays right when the first entry had been read', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    docs[`notifications/${first}`] = { ...docs[`notifications/${first}`], readAt: '__READ__' };
    expect(bell()).toBe(1);
    await depart(DAY2);
    expect(departedListed()).not.toContain(first);
    expect(bell()).toBe(2);
  });
  it('a first entry the reader had filed away stays filed, with the time they filed it', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    docs[`notifications/${first}`] = { ...docs[`notifications/${first}`], readAt: '__READ__', archivedAt: '__FILED__' };
    await depart(DAY2);
    expect(docs[`notifications/${first}`]).toMatchObject({
      archivedAt: '__FILED__',
      withdrawnReason: 'departure_undone',
      withdrawnFiledAway: false,
    });
    expect(departedListed()).toHaveLength(1);
    expect(bell()).toBe(2);
  });
  it('the same day changes nothing: the first entry is the household\'s one and is never withdrawn', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    await depart(DAY1 + 40 * MIN);
    expect(departedListed()).toEqual([first]);
    expect(docs[`notifications/${first}`]).not.toHaveProperty('withdrawnAt');
    expect(mocks.lines.map((l) => l.description)).not.toContain(departureNoticeReplacedWords());
  });
  it('a later-day Departed the household is not told about leaves the first entry listed', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    docs[SETTINGS_PATH] = { householdNotificationsLive: false };
    await depart(DAY2);
    expect(record('departed', DAY2)).toMatchObject({ notified: false, reason: 'household_notices_off' });
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(departedListed()).toEqual([first]);
    expect(docs[`notifications/${first}`]).not.toHaveProperty('withdrawnAt');
  });
  it('a household with every channel of the notice off still gets its listed entry, so the first one comes off', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    docs['clients/uid_kinfolk'] = {
      displayName: 'Dre',
      notificationPreferences: { [DEPARTED_KEY]: { inApp: false, email: false, sms: false, push: false } },
    };
    await depart(DAY2);
    // The dispatcher still writes the entry their notifications list reads.
    expect(rows(DEPARTED_KEY)).toHaveLength(2);
    expect(departedListed()).toHaveLength(1);
    expect(departedListed()).not.toContain(first);
  });
  it('an installed client that dispatches first: the first entry comes off when the trigger comes through', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    vi.setSystemTime(DAY2);
    const before = current;
    current = { ...current, status: 'DEPARTED', departedAt: iso(DAY2) };
    docs[SESSION_PATH] = current;
    await expect(clientDispatch('departed', DAY2)).resolves.toMatchObject({ suppressed: false });
    await onKinCareSessionLifecycleHandler(event(before, current));
    await expect(clientDispatch('departed', DAY2)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(departedListed()).toHaveLength(1);
    expect(departedListed()).not.toContain(first);
    expect(docs[`notifications/${first}`]).toMatchObject({ withdrawnReason: 'departure_undone' });
  });
  it('a redelivered event takes nothing more off and writes no second line', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    const evt = await depart(DAY2);
    vi.setSystemTime(DAY2 + 2 * 60 * MIN);
    await onKinCareSessionLifecycleHandler(evt);
    await onKinCareSessionLifecycleHandler(evt);
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(departedListed()).toHaveLength(1);
    expect(departedListed()).not.toContain(first);
    expect(mocks.lines.filter((l) => l.description === departureNoticeReplacedWords())).toHaveLength(1);
    expect(bell()).toBe(2);
  });
  it('Undo departed again on day 2, then Departed: the day-2 entry is reused and day 1\'s never comes back', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    await depart(DAY2);
    const second = rows(DEPARTED_KEY).find((r) => r.id !== first)!.id;
    await undoDeparted(DAY2 + MIN);
    const orders = workOrders().length;
    await depart(DAY2 + 20 * MIN);
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(workOrders()).toHaveLength(orders);
    expect(departedListed()).toEqual([second]);
    expect(docs[`notifications/${first}`]).toMatchObject({ withdrawnReason: 'departure_undone' });
    expect(record('departed', DAY2 + 20 * MIN)).toMatchObject({ reason: 'already_notified', dispatchIds: [second] });
  });
  it('then Undo arrival takes the real "has left" off as well, and the record names both', async () => {
    seed();
    await undoneDepartureOnDayOne();
    await depart(DAY2);
    await undoArrival(DAY2 + MIN);
    expect(listed()).toEqual([]);
    expect(bell()).toBe(0);
    expect(record('undo_arrival', DAY1)).toMatchObject({ withdrawn: ['arrived', 'departed'] });
  });
  it('through setVisitLifecycle on the later day: the first entry comes off with the answer', async () => {
    seed();
    const first = await undoneDepartureOnDayOne();
    vi.setSystemTime(DAY2);
    await expect(
      setVisitLifecycleHandler({
        data: { sessionId: 's1', action: 'DEPARTED', atIso: iso(DAY2) },
        auth: { uid: 'uid_auntie', token: { admin: true, name: 'TiTi' } },
        rawRequest: {},
      } as unknown as CallableRequest<unknown>),
    ).resolves.toMatchObject({ notified: true, notifySkipped: null });
    expect(departedListed()).toHaveLength(1);
    expect(departedListed()).not.toContain(first);
  });
  it('an arrival: a first-day entry whose withdrawal never landed comes off when the next day\'s is announced', async () => {
    seed();
    await arrive(DAY1);
    const first = rows(ARRIVED_KEY)[0]!.id;
    await undoArrival(DAY1 + MIN);
    // The undo's withdrawal did not land: the entry is still on their list.
    const { archivedAt: _a, withdrawnAt: _w, withdrawnReason: _r, withdrawnFiledAway: _f, ...asSent } = docs[
      `notifications/${first}`
    ] as Row;
    docs[`notifications/${first}`] = asSent;
    expect(listed().map((r) => r.id)).toEqual([first]);
    await arrive(DAY2);
    expect(sent(ARRIVED_KEY)).toHaveLength(2);
    expect(listed()).toHaveLength(1);
    expect(listed().map((r) => r.id)).not.toContain(first);
    expect(docs[`notifications/${first}`]).toMatchObject({ withdrawnReason: 'arrival_undone' });
    expect(mocks.lines.filter((l) => l.description === arrivalNoticeReplacedWords())).toHaveLength(1);
    expect(bell()).toBe(1);
  });
  it('an arrival whose first-day entry the undo already took off writes no "replaced" line', async () => {
    seed();
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    await arrive(DAY2);
    expect(mocks.lines.map((l) => l.description)).not.toContain(arrivalNoticeReplacedWords());
  });
  it("\"latest\" is read on the server's clock: a zone-less stamp that sorts early does not bring day 1 back", async () => {
    seed();
    // 11:30 PM Chicago on the 10th, stamped as the instant it was.
    const lateNight = Date.UTC(2026, 10, 11, 5, 30, 0);
    await arrive(DAY1);
    await depart(lateNight);
    const first = rows(DEPARTED_KEY)[0]!.id;
    await undoDeparted(lateNight + MIN);
    // 1:00 AM Chicago on the 11th from the desktop console: wall clock, no
    // zone. Read as UTC it names a moment BEFORE the first departure.
    const oneAm = Date.UTC(2026, 10, 11, 7, 0, 0);
    await depart(oneAm, '2026-11-11T01:00:00');
    expect(stampMs('2026-11-11T01:00:00')!).toBeLessThan(lateNight);
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    const second = rows(DEPARTED_KEY).find((r) => r.id !== first)!.id;
    await undoDeparted(oneAm + MIN);
    // Ten minutes later, the same business day as the second one.
    await depart(oneAm + 10 * MIN);
    expect(sent(DEPARTED_KEY)).toHaveLength(2);
    expect(departedListed()).toEqual([second]);
  });
});
describe('#2357 the business day at midnight and across a clock change', () => {
  const later = (a: number, b: number) => isLaterBusinessDay(a, b, 'America/Chicago', businessCalendarDate);
  it('the last millisecond of a day and the first of the next, on an ordinary night', () => {
    const midnight = Date.UTC(2026, 10, 11, 6, 0, 0); // 00:00 CST on the 11th
    expect(later(midnight - 2, midnight - 1)).toBe(false);
    expect(later(midnight - 1, midnight)).toBe(true);
    expect(later(midnight, midnight + 1)).toBe(false);
  });
  it('the night the clocks go back (1 November 2026): a 25-hour day is still one day', () => {
    const starts = Date.UTC(2026, 10, 1, 5, 0, 0); // 00:00 CDT
    const ends = Date.UTC(2026, 10, 2, 6, 0, 0); // 00:00 CST the next day
    expect(ends - starts).toBe(25 * 60 * MIN);
    expect(later(starts - 1, starts)).toBe(true);
    expect(later(starts, ends - 1)).toBe(false);
    // 1:30 AM happens twice that night. Both are the 1st.
    expect(later(Date.UTC(2026, 10, 1, 6, 30, 0), Date.UTC(2026, 10, 1, 7, 30, 0))).toBe(false);
    expect(later(ends - 1, ends)).toBe(true);
  });
  it('the night the clocks go forward (8 March 2026): a 23-hour day is still one day', () => {
    const starts = Date.UTC(2026, 2, 8, 6, 0, 0); // 00:00 CST
    const ends = Date.UTC(2026, 2, 9, 5, 0, 0); // 00:00 CDT the next day
    expect(ends - starts).toBe(23 * 60 * MIN);
    expect(later(starts - 1, starts)).toBe(true);
    expect(later(starts, ends - 1)).toBe(false);
    expect(later(ends - 1, ends)).toBe(true);
  });
  it('the trigger just before midnight and an installed client just after: one quiet entry, nothing sent', async () => {
    seed();
    const midnight = Date.UTC(2026, 10, 11, 6, 0, 0);
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const tap = midnight - 500;
    await arrive(tap);
    vi.setSystemTime(midnight + 500);
    await expect(clientDispatch('arrived', tap)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(sent(ARRIVED_KEY)).toHaveLength(1);
    expect(bell()).toBe(1);
  });
  it('setVisitLifecycle just before midnight and its trigger just after agree: the entry handed over stays quiet', async () => {
    seed();
    const midnight = Date.UTC(2026, 10, 11, 6, 0, 0);
    await arrive(DAY1);
    await depart(DAY1 + 30 * MIN);
    await undoDeparted(DAY1 + 31 * MIN);
    const tap = midnight - 500;
    vi.setSystemTime(tap);
    const before = current;
    current = { ...current, status: 'DEPARTED', departedAt: iso(tap) };
    docs[SESSION_PATH] = current;
    const step = visitStepOf(before, current)!;
    await expect(
      announceVisitStep({ sessionId: 's1', session: current, step, actorUid: 'uid_auntie', source: 'setVisitLifecycle', fallbackKey: 'x' }),
    ).resolves.toMatchObject({ notified: false, notifySkipped: 'already_notified' });
    vi.setSystemTime(midnight + 500);
    await onKinCareSessionLifecycleHandler(event(before, current));
    expect(sent(DEPARTED_KEY)).toHaveLength(1);
    expect(listed().filter((r) => r.data['key'] === DEPARTED_KEY)).toHaveLength(1);
    expect(rows(DEPARTED_KEY)[0]!.data).not.toHaveProperty('withdrawnAt');
  });
  it('an installed client just before midnight and the trigger just after: told once more, never twice', async () => {
    seed();
    const midnight = Date.UTC(2026, 10, 11, 6, 0, 0);
    await arrive(DAY1);
    await undoArrival(DAY1 + MIN);
    const tap = midnight - 500;
    vi.setSystemTime(tap);
    const before = current;
    current = { ...current, status: 'ARRIVED', arrivedAt: iso(tap) };
    docs[SESSION_PATH] = current;
    await expect(clientDispatch('arrived', tap)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    vi.setSystemTime(midnight + 500);
    await onKinCareSessionLifecycleHandler(event(before, current));
    await expect(clientDispatch('arrived', tap)).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    // The household has exactly one entry for the arrival, whichever side of midnight decided.
    expect(listed().filter((r) => r.data['key'] === ARRIVED_KEY)).toHaveLength(1);
    expect(sent(ARRIVED_KEY).length).toBeLessThanOrEqual(2);
  });
});
