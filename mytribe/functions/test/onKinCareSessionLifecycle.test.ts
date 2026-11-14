import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock, HOUSEHOLD_GATE_SETTINGS_PATH } from './_helpers/mockDb';

/**
 * #2037: a clock step's household notice and its Activity Log line come from
 * the committed session write, exactly once.
 *
 * Found on the Nov 10 walk: "Yes, clock in" and a reload a second later left
 * the visit ARRIVED with no notice to the household and no "Visit arrived"
 * line, because both were sent by the browser after its write. These cases
 * run the trigger over the REAL dispatcher (as the dispatch tests do), so a
 * notice here is a `notifications/` record the household's list would show.
 *
 * `writeAuditEntry` is mocked with the one property the real one guarantees
 * and these cases lean on: a fixed `docId` is written at most once.
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
  writerUidOf,
  type SessionLifecycleEvent,
} from '../src/triggers/onKinCareSessionLifecycle';
import { visitStepOf, visitStepNoticeId, announceVisitStep, stampMs } from '../src/lib/visitStepNotice';
import { dispatchVisitNotificationHandler, visitDedupeKey } from '../src/admin/dispatchVisitNotification';

const NOW = Date.UTC(2026, 10, 10, 22, 0, 0);
const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';
const ARRIVED_AT = '2026-11-10T22:00:00.000Z';

let ctx: ReturnType<typeof buildDbMock>;

function seed(docs: Record<string, Record<string, unknown> | null> = {}) {
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: NOW, kinfolkId: 'fam1' },
      'staff/uid_auntie': { displayName: 'TiTi' },
      'clients/uid_kinfolk': { displayName: 'Dre' },
      'families/fam1': { displayName: 'Dre East' },
      'kinfolk/fam1': { uid: 'uid_kinfolk' },
      'families/fam1/members/uid_kinfolk': { role: 'PRIMARY', status: 'ACTIVE' },
      ...docs,
    },
  });
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

const arrive = () => event(session(), session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }));

/** Notification records written to the household (what their notifications list shows). */
const householdNotices = () =>
  ctx.writes.filter((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk');
const linesOf = (kind: string) => mocks.lines.filter((l) => l.event === kind);
const outcomeDoc = (id: string) => ctx.writes.filter((w) => w.path === `visit_step_notices/${id}`).at(-1)?.data;

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

describe('#2037 a confirmed clock-in tells the household once and logs once', () => {
  it('the write alone (the page reloaded before the client did anything else) sends the notice and writes the line', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());

    expect(householdNotices()).toHaveLength(1);
    expect(householdNotices()[0]?.data.key).toBe('kincare.auntie.arrived');
    expect(linesOf('VISIT_ARRIVED')).toEqual([
      expect.objectContaining({
        status: 'SUCCESS',
        actorRole: 'AUNTIE',
        actorUid: 'uid_auntie',
        targetUid: 's1',
        targetCollection: 'kin_care_sessions',
        familyId: 'fam1',
        description: 'Marked the arrival: scheduled to arrived',
      }),
    ]);
    expect(linesOf('NOTIFICATION_DISPATCHED')).toHaveLength(1);
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT)))).toMatchObject({
      sessionId: 's1',
      action: 'ARRIVED',
      notified: true,
      reason: null,
    });
  });

  it('a redelivered event sends no second notice and writes no second line', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    await onKinCareSessionLifecycleHandler(arrive());

    expect(householdNotices()).toHaveLength(1);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(1);
    expect(linesOf('NOTIFICATION_DISPATCHED')).toHaveLength(1);
    // The second run found the notice sent; the card still reads the first outcome.
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT)))).toMatchObject({ notified: true });
  });

  it('an installed client from before #2037 that still dispatches after its write is the duplicate, either order', async () => {
    const oldClient = () =>
      dispatchVisitNotificationHandler({
        data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'arrived', eventAtMs: Date.parse(ARRIVED_AT) },
        auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
      } as never);

    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    await expect(oldClient()).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(householdNotices()).toHaveLength(1);
    expect(linesOf('NOTIFICATION_DISPATCHED')).toHaveLength(1);

    mocks.lines.length = 0;
    mocks.ids.clear();
    seed();
    await oldClient();
    await onKinCareSessionLifecycleHandler(arrive());
    expect(householdNotices()).toHaveLength(1);
    expect(linesOf('NOTIFICATION_DISPATCHED')).toHaveLength(1);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(1);
  });

  it('a second writer whose dispatch fails never overwrites a record that says the household was told', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    mocks.resolveKinCareRefFn.mockRejectedValueOnce(new Error('deadline exceeded'));
    await onKinCareSessionLifecycleHandler(arrive());
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT)))).toMatchObject({ notified: true });
    expect(householdNotices()).toHaveLength(1);
  });

  it('an installed client that sends no stamp (the desktop console, a pre-#832 Android build) is still the duplicate, either order', async () => {
    // The console stamps the wall clock with no offset, which its own parse
    // refused, so it dispatched with no `eventAtMs` at all.
    const wallClock = '2026-11-10T16:00:00';
    const row = session({ status: 'ARRIVED', arrivedAt: wallClock });
    const arriveAtWallClock = () => event(session(), row);
    const oldConsole = () =>
      dispatchVisitNotificationHandler({
        data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'arrived' },
        auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
      } as never);

    seed({ 'kin_care_sessions/s1': row });
    await onKinCareSessionLifecycleHandler(arriveAtWallClock());
    await expect(oldConsole()).resolves.toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(householdNotices()).toHaveLength(1);

    mocks.lines.length = 0;
    mocks.ids.clear();
    seed({ 'kin_care_sessions/s1': row });
    await oldConsole();
    await onKinCareSessionLifecycleHandler(arriveAtWallClock());
    expect(householdNotices()).toHaveLength(1);
    expect(linesOf('NOTIFICATION_DISPATCHED')).toHaveLength(1);
  });

  it('a stamp-less dispatch the session cannot vouch for is sent as before, under no time', async () => {
    // Two sessions name the visit: nothing is guessed, and a dispatch still goes.
    seed({
      'kin_care_sessions/s1': session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }),
      'kin_care_sessions/s2': session({ status: 'ARRIVED', arrivedAt: '2026-11-10T22:05:00.000Z' }),
    });
    await expect(
      dispatchVisitNotificationHandler({
        data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', event: 'arrived' },
        auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
      } as never),
    ).resolves.toMatchObject({ suppressed: false });
    expect(householdNotices()).toHaveLength(1);
  });

  it('setVisitLifecycle announcing inline, then the trigger its own write fires, is one notice and one line', async () => {
    seed();
    const before = session();
    const after = { ...session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }), updatedBy: 'uid_auntie' };
    const step = visitStepOf(before, after)!;
    await expect(
      announceVisitStep({
        sessionId: 's1',
        session: after,
        step,
        actorUid: 'uid_auntie',
        source: 'setVisitLifecycle',
        fallbackKey: ARRIVED_AT,
      }),
    ).resolves.toEqual({ notified: true, notifySkipped: null });
    await onKinCareSessionLifecycleHandler(event(before, after, { authType: 'service_account', authId: 'sa@x' }));

    expect(householdNotices()).toHaveLength(1);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(1);
  });

  it('an arrival after an undone arrival is a new step: a second notice and a second line', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    await onKinCareSessionLifecycleHandler(
      event(session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }), session({ status: 'SCHEDULED', arrivedAt: '' })),
    );
    vi.setSystemTime(NOW + 60_000);
    await onKinCareSessionLifecycleHandler(
      event(session({ arrivedAt: '' }), session({ status: 'ARRIVED', arrivedAt: '2026-11-10T22:01:00.000Z' })),
    );

    expect(householdNotices()).toHaveLength(2);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(2);
    expect(linesOf('VISIT_UNDO_ARRIVAL')).toEqual([
      expect.objectContaining({ description: 'Undid the arrival: arrived to scheduled' }),
    ]);
  });
});

describe('#2037 the household send gate and their preferences still decide', () => {
  it('gate off: no notice reaches the household, the line is written, and the card is told why', async () => {
    seed({ [HOUSEHOLD_GATE_SETTINGS_PATH]: { householdNotificationsLive: false } });
    await onKinCareSessionLifecycleHandler(arrive());

    expect(householdNotices()).toHaveLength(0);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(1);
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT)))).toMatchObject({
      notified: false,
      reason: 'household_notices_off',
    });
  });

  it('a household with no portal account is named for that, with no notice', async () => {
    seed({ 'kinfolk/fam1': { uid: '' }, 'families/fam1/members/uid_kinfolk': null });
    await onKinCareSessionLifecycleHandler(arrive());
    expect(householdNotices()).toHaveLength(0);
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT)))).toMatchObject({
      reason: 'household_has_no_portal_account',
    });
  });

  it('a visit linked to no booking writes the line and records why nobody was told', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(
      event({ kinfolkId: 'fam1', status: 'SCHEDULED' }, { kinfolkId: 'fam1', status: 'ARRIVED', arrivedAt: ARRIVED_AT }),
    );
    expect(householdNotices()).toHaveLength(0);
    expect(linesOf('VISIT_ARRIVED')).toHaveLength(1);
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.parse(ARRIVED_AT)))).toMatchObject({
      reason: 'session_has_no_routing_ids',
    });
  });
});

describe('#2037 writes that are not a clock step send nothing', () => {
  it.each([
    ['a created session', undefined, session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT })],
    ['a deleted session', session({ status: 'ARRIVED' }), undefined],
    ['an edit that leaves the status alone', session({ status: 'ARRIVED', notes: 'a' }), session({ status: 'ARRIVED', notes: 'b' })],
    ['the departure trigger completing the visit', session({ status: 'DEPARTED' }), session({ status: 'COMPLETED' })],
    ['a cancellation', session(), session({ status: 'CANCELLED' })],
    ['an unreadable status', session(), session({ status: 'WANDERING' })],
    // #2037 review: the other server writers on this collection.
    ['the KinTale-due stamp (#2158)', session({ status: 'COMPLETED' }), session({ status: 'COMPLETED', kinTaleDue: true })],
    ['an invoice back-link (#2160)', session({ status: 'DEPARTED' }), session({ status: 'DEPARTED', invoiceId: 'inv1' })],
    ['a reschedule', session({ scheduledAt: '2026-11-10T22:00:00Z' }), session({ scheduledAt: '2026-11-11T22:00:00Z' })],
    ['an arrival time corrected in place', session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }), session({ status: 'ARRIVED', arrivedAt: '2026-11-10T22:10:00.000Z' })],
    ['a visit in flight cancelled', session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }), session({ status: 'CANCELLED', arrivedAt: ARRIVED_AT })],
  ])('%s', async (_name, before, after) => {
    seed();
    await onKinCareSessionLifecycleHandler(event(before, after));
    expect(householdNotices()).toHaveLength(0);
    expect(mocks.lines).toHaveLength(0);
  });
});

describe('visitStepOf', () => {
  it('names the four steps along the edges the clock draws', () => {
    expect(visitStepOf(session(), session({ status: 'ON_MY_WAY', onMyWayAt: ARRIVED_AT }))).toMatchObject({
      action: 'ON_MY_WAY',
      atMs: Date.parse(ARRIVED_AT),
    });
    expect(visitStepOf(session({ status: 'ON_MY_WAY' }), session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }))).toMatchObject({
      action: 'ARRIVED',
      from: 'ON_MY_WAY',
    });
    expect(visitStepOf(session({ status: 'ARRIVED' }), session({ status: 'DEPARTED', departedAt: ARRIVED_AT }))?.action).toBe(
      'DEPARTED',
    );
    expect(
      visitStepOf(session({ status: 'DEPARTED', arrivedAt: ARRIVED_AT }), session({ status: 'ON_MY_WAY', arrivedAt: '' })),
    ).toMatchObject({ action: 'UNDO_ARRIVAL', atMs: Date.parse(ARRIVED_AT) });
  });

  it('is not a step for a jump the clock never draws', () => {
    expect(visitStepOf(session(), session({ status: 'DEPARTED' }))).toBeNull();
    expect(visitStepOf(session({ status: 'ON_MY_WAY' }), session({ status: 'SCHEDULED' }))).toBeNull();
  });

  it('takes an ETA only when this write declared one, as the Android Home card sends it', () => {
    const step = visitStepOf(session(), session({ status: 'ON_MY_WAY', onMyWayAt: ARRIVED_AT, etaMinutesAway: 15 }));
    expect(step?.etaMinutes).toBe(15);
    // Android writes 0 with the step and sends no ETA for it.
    expect(visitStepOf(session(), session({ status: 'ON_MY_WAY', onMyWayAt: ARRIVED_AT, etaMinutesAway: 0 }))?.etaMinutes).toBeUndefined();
  });

  it('builds the same dedupe key the clients send, so an old client is the duplicate', () => {
    // Android: Instant.parse("...").toEpochMilli() of the string it wrote, and
    // `etaMinutes` only above zero. Web and desktop: Date.parse of the same string.
    const iso = '2026-11-10T22:00:00.123456789Z';
    const step = visitStepOf(session(), session({ status: 'ON_MY_WAY', onMyWayAt: iso, etaMinutesAway: 12 }))!;
    expect(stampMs(iso)).toBe(Date.parse('2026-11-10T22:00:00.123Z'));
    expect(visitDedupeKey('visit1', { event: 'on_my_way', etaMinutes: step.etaMinutes, eventAtMs: step.atMs ?? undefined })).toBe(
      visitDedupeKey('visit1', { event: 'on_my_way', etaMinutes: 12, eventAtMs: Date.parse('2026-11-10T22:00:00.123Z') }),
    );
  });
});

describe('stampMs: the desktop console stamps the wall clock with no offset', () => {
  it('reads a zone-less stamp as UTC, whatever zone the server runs in', () => {
    // The console's `visitNoticeAtMs` names its record the same way.
    expect(stampMs('2026-11-10T16:00:00')).toBe(Date.UTC(2026, 10, 10, 16, 0, 0));
    expect(stampMs('2026-11-10T16:00')).toBe(Date.UTC(2026, 10, 10, 16, 0, 0));
    expect(stampMs('2026-11-10T16:00:00.250')).toBe(Date.UTC(2026, 10, 10, 16, 0, 0, 250));
  });
  it('leaves a stamp with an offset as it is, and refuses what is not a time', () => {
    expect(stampMs('2026-11-10T16:00:00-06:00')).toBe(Date.UTC(2026, 10, 10, 22, 0, 0));
    expect(stampMs(ARRIVED_AT)).toBe(NOW);
    expect(stampMs('')).toBeNull();
    expect(stampMs('6pm')).toBeNull();
    expect(stampMs(undefined)).toBeNull();
  });
  it('a desktop clock-in gets its record under the id the console asks for', async () => {
    seed();
    await onKinCareSessionLifecycleHandler(event(session(), session({ status: 'ARRIVED', arrivedAt: '2026-11-10T16:00:00' })));
    expect(outcomeDoc(visitStepNoticeId('s1', 'arrived', Date.UTC(2026, 10, 10, 16, 0, 0)))).toMatchObject({ notified: true });
  });
});

describe('writerUidOf', () => {
  it('reads the signed-in writer, then the row, and otherwise nobody', () => {
    expect(writerUidOf({ authType: 'unknown', authId: 'u1' }, {})).toBe('u1');
    expect(writerUidOf({ authType: 'service_account', authId: 'sa' }, { updatedBy: 'u2' })).toBe('u2');
    expect(writerUidOf({ authType: 'system' }, {})).toBeNull();
    // A client write never inherits the caller an earlier server write stamped.
    expect(writerUidOf({ authType: 'unknown' }, { updatedBy: 'u2' })).toBeNull();
  });
  it('stamps the owner or the Auntie on the line, as logActivity did (#1820)', async () => {
    mocks.authFn.mockReturnValue({ getUser: async () => ({ customClaims: { admin: true } }) });
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    expect(linesOf('VISIT_ARRIVED')[0]).toMatchObject({ actorRole: 'AUNTIE', payload: expect.objectContaining({ admin: true, staffRole: null }) });
  });
  it('a line that cannot be written does not hold the notice back', async () => {
    seed();
    const { writeAuditEntry } = await import('../src/lib/writeAuditEntry');
    (writeAuditEntry as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('chain busy'));
    await onKinCareSessionLifecycleHandler(arrive());
    expect(householdNotices()).toHaveLength(1);
    expect(mocks.logEventFn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audit.write.failed', severity: 'error' }));
  });

  it('an authId Auth has no user for (a console edit carries an email) is not filed under that string', async () => {
    mocks.authFn.mockReturnValue({
      getUser: async () => {
        throw Object.assign(new Error('no user record'), { code: 'auth/user-not-found' });
      },
    });
    seed();
    await onKinCareSessionLifecycleHandler(event(session(), session({ status: 'ARRIVED', arrivedAt: ARRIVED_AT }), { authId: 'owner@example.test' }));
    expect(linesOf('VISIT_ARRIVED')[0]).toMatchObject({ actorRole: 'SYSTEM' });
    expect(linesOf('VISIT_ARRIVED')[0]?.actorUid).toBeUndefined();
    expect(linesOf('NOTIFICATION_DISPATCHED')[0]?.actorUid).toBeUndefined();
    expect(householdNotices()).toHaveLength(1);
  });

  it('a passing Auth failure still names the writer, in the business band with no stamp', async () => {
    mocks.authFn.mockReturnValue({
      getUser: async () => {
        throw Object.assign(new Error('deadline'), { code: 'auth/internal-error' });
      },
    });
    seed();
    await onKinCareSessionLifecycleHandler(arrive());
    expect(linesOf('VISIT_ARRIVED')[0]).toMatchObject({ actorRole: 'AUNTIE', actorUid: 'uid_auntie' });
  });

  it('a step nobody can be named for is logged as the system and says "Your Auntie"', async () => {
    seed();
    await onKinCareSessionLifecycleHandler({ ...arrive(), authType: 'system', authId: undefined } as SessionLifecycleEvent);
    expect(linesOf('VISIT_ARRIVED')[0]).toMatchObject({ actorRole: 'SYSTEM' });
    expect(linesOf('VISIT_ARRIVED')[0]?.actorUid).toBeUndefined();
    expect(householdNotices()).toHaveLength(1);
  });
});
