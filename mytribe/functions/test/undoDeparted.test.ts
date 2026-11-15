import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #2250, operator ruling 2026-11-14: "A short Undo departed. For a few minutes
 * after Departed, Undo departed puts the visit back to Arrived; the household
 * is not told."
 *
 * A departure completes the visit (#2123), so the undo has to take the
 * completion back with it: the status, the completion stamps, the KinTale
 * task, the household's copy, and it has to do so without a word to the
 * household. These tests drive the real callable, the real departure trigger
 * and the real bookings trigger over one in-memory database.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  authFn: vi.fn(),
  dispatch: vi.fn(),
  enqueue: vi.fn(),
  resolveKinfolkUid: vi.fn(),
  lines: [] as Array<Record<string, any>>,
  ids: new Set<string>(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: mocks.authFn, getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  // A fixed id is written once, as the real one does (#866).
  writeAuditEntry: vi.fn(async (args: Record<string, any>) => {
    if (typeof args.docId === 'string') {
      if (mocks.ids.has(args.docId)) return args.docId;
      mocks.ids.add(args.docId);
    }
    mocks.lines.push(args);
    return args.docId ?? `auto-${mocks.lines.length}`;
  }),
}));
// Every way a household is told: the clock-step notice and the booking notices.
vi.mock('../src/admin/dispatchVisitNotification', () => ({ dispatchVisitNotificationCore: mocks.dispatch }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__', delete: () => '__DEL__' } };
});

import { setVisitLifecycleHandler } from '../src/admin/setVisitLifecycle';
import { completeDepartedSession } from '../src/triggers/onKinCareSessionDeparted';
import { onKinCareSessionLifecycleHandler } from '../src/triggers/onKinCareSessionLifecycle';
import { onBookingsWrite } from '../src/triggers/onBookingsWrite';
import {
  UNDO_DEPARTED_WINDOW_MS,
  evaluateVisitLifecycle,
  notificationEventFor,
  undoDepartedWindowMessage,
} from '../src/lib/visitLifecycle';
import { undoDepartedOpen } from '../src/lib/undoDeparted';
import { visitStepOf } from '../src/lib/visitStepNotice';

const SESSION = 'kin_care_sessions/s1';
const SETTINGS = 'business_settings/business_settings';
const VISIT = 'families/kf1/bookings/b1/kinCares/v1';
const NOW = Date.parse('2026-11-14T15:31:00.000Z');
const ARRIVED_AT = '2026-11-14T15:00:00.000Z';
const DEPARTED_AT = '2026-11-14T15:30:00.000Z';
/** Four minutes left. */
const UNTIL = '2026-11-14T15:35:00.000Z';

const OWNER = { admin: true, name: 'Owner' };
const AUNTIE = { staffRole: 'auntie', name: 'Auntie Jo' };

function req(data: unknown, claims: Record<string, unknown> = AUNTIE, uid = 'uid1'): CallableRequest<unknown> {
  return { data, auth: { uid, token: claims }, rawRequest: {} } as unknown as CallableRequest<unknown>;
}

/** A visit the departure trigger has completed, as it leaves one. */
function completed(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'COMPLETED',
    kinfolkId: 'kf1',
    kinCareBatchId: 'b1',
    kinCareVisitId: 'v1',
    arrivedAt: ARRIVED_AT,
    departedAt: DEPARTED_AT,
    completedAt: DEPARTED_AT,
    undoDepartedUntil: UNTIL,
    householdStatusBeforeCompletion: 'approved',
    ...extra,
  };
}

let ctx: ReturnType<typeof buildDbMock>;

function seed(opts: {
  session?: Record<string, unknown> | null;
  visit?: Record<string, unknown> | null;
  settings?: Record<string, unknown>;
}) {
  const docs: Record<string, Record<string, unknown>> = {};
  if (opts.session !== null) docs[SESSION] = opts.session ?? completed();
  if (opts.visit !== null) docs[VISIT] = opts.visit ?? { status: 'completed' };
  if (opts.settings) docs[SETTINGS] = opts.settings;
  ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReset().mockReturnValue(ctx.db);
  return ctx;
}

const sessionWrites = () => ctx.writes.filter((w) => w.path === SESSION);
const visitWrites = () => ctx.writes.filter((w) => w.path === VISIT);
const linesOf = (event: string) => mocks.lines.filter((l) => l.event === event);
const undo = (claims: Record<string, unknown> = AUNTIE) =>
  setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_DEPARTED' }, claims));

/** The stored visit with the fields the mock's delete sentinel marks taken out, as Firestore would. */
async function storedSession(): Promise<Record<string, unknown>> {
  const data = ((await ctx.db.doc(SESSION).get()).data() ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== '__DEL__'));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.lines.length = 0;
  mocks.ids.clear();
  mocks.dispatch.mockReset().mockResolvedValue({ ok: true, dispatchIds: ['d1'], suppressed: false });
  mocks.enqueue.mockReset().mockResolvedValue(undefined);
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('uid-kinfolk');
  mocks.authFn.mockReset().mockReturnValue({ getUser: async () => ({ customClaims: AUNTIE }) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the state machine', () => {
  it('takes a Departed or a Completed visit back to Arrived', () => {
    for (const currentStatus of ['DEPARTED', 'COMPLETED', ' completed ']) {
      expect(evaluateVisitLifecycle({ currentStatus, action: 'UNDO_DEPARTED' })).toMatchObject({
        kind: 'apply',
        to: 'ARRIVED',
      });
    }
  });

  it('is already true on an Arrived visit, and refused before any departure', () => {
    expect(evaluateVisitLifecycle({ currentStatus: 'ARRIVED', action: 'UNDO_DEPARTED' })).toEqual({
      kind: 'noop',
      at: 'ARRIVED',
    });
    for (const currentStatus of ['SCHEDULED', 'ON_MY_WAY', 'CANCELLED']) {
      expect(evaluateVisitLifecycle({ currentStatus, action: 'UNDO_DEPARTED' }).kind).toBe('illegal');
    }
  });

  it('declares no household notice, and names its own Activity Log step', () => {
    expect(notificationEventFor('UNDO_DEPARTED')).toBeNull();
    expect(visitStepOf({ status: 'COMPLETED', departedAt: DEPARTED_AT }, { status: 'ARRIVED', departedAt: '' })).toEqual({
      action: 'UNDO_DEPARTED',
      from: 'COMPLETED',
      to: 'ARRIVED',
      atMs: Date.parse(DEPARTED_AT),
    });
  });

  it('the window is five minutes, held in code', () => {
    expect(UNDO_DEPARTED_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(undoDepartedWindowMessage()).toBe(
      'Undo departed is only there for 5 minutes after Departed. That time has passed.',
    );
  });
});

describe('the departure opens the window', () => {
  it('a completed departure is stamped with when the undo closes and what the household copy read', async () => {
    seed({
      session: { ...completed(), status: 'DEPARTED', completedAt: undefined, undoDepartedUntil: undefined, householdStatusBeforeCompletion: undefined },
      visit: { status: 'approved' },
    });
    expect((await completeDepartedSession('s1', '2026-11-14T15:30:02.000Z')).kind).toBe('completed');
    expect(sessionWrites().at(-1)?.data).toMatchObject({
      status: 'COMPLETED',
      undoDepartedUntil: '2026-11-14T15:35:02.000Z',
      householdStatusBeforeCompletion: 'approved',
    });
  });

  it('a departure the arrival rule refuses to complete is stamped too, and stays Departed', async () => {
    seed({
      session: { status: 'DEPARTED', kinfolkId: 'kf1', arrivedAt: '', departedAt: DEPARTED_AT },
      settings: { requireArrivalDepartureVerification: true },
    });
    expect((await completeDepartedSession('s1', '2026-11-14T15:30:02.000Z')).kind).toBe('refused');
    expect(sessionWrites().map((w) => w.data)).toEqual([{ undoDepartedUntil: '2026-11-14T15:35:02.000Z' }]);
  });

  it('is open until that moment and not after, and never on a visit that did not depart', () => {
    expect(undoDepartedOpen(completed(), Date.parse(UNTIL))).toBe(true);
    expect(undoDepartedOpen(completed(), Date.parse(UNTIL) + 1)).toBe(false);
    expect(undoDepartedOpen(completed({ undoDepartedUntil: undefined }), NOW)).toBe(false);
    expect(undoDepartedOpen(completed({ status: 'ARRIVED' }), NOW)).toBe(false);
  });
});

describe('undo inside the window', () => {
  it.each([
    ['an Auntie', AUNTIE],
    ['the owner', OWNER],
  ])('%s puts a Completed visit back to Arrived, with everything completion wrote taken off', async (_who, claims) => {
    seed({ session: completed({ kinTaleDue: true }) });

    const res = await undo(claims);

    expect(res).toEqual({
      ok: true,
      sessionId: 's1',
      action: 'UNDO_DEPARTED',
      from: 'COMPLETED',
      status: 'ARRIVED',
      changed: true,
      notified: false,
      notifySkipped: 'no_event_for_action',
    });
    expect(sessionWrites()).toHaveLength(1);
    expect(sessionWrites()[0]).toMatchObject({ merge: true });
    expect(sessionWrites()[0]?.data).toEqual({
      status: 'ARRIVED',
      departedAt: '',
      completedAt: '__DEL__',
      kinTaleDue: '__DEL__',
      completedOutsideRange: '__DEL__',
      undoDepartedUntil: '__DEL__',
      householdStatusBeforeCompletion: '__DEL__',
      // The arrival whose "has left" the household already heard.
      departedNoticeToldForArrival: ARRIVED_AT,
      updatedAt: '__TS__',
      updatedBy: 'uid1',
    });
    // The arrival it goes back to is the one it had.
    expect(await storedSession()).toMatchObject({ status: 'ARRIVED', arrivedAt: ARRIVED_AT, departedAt: '' });
    // The household's copy reads what it read before the departure.
    expect(visitWrites()).toHaveLength(1);
    expect(visitWrites()[0]?.data).toEqual({
      status: 'approved',
      officeNoticeStamp: expect.stringMatching(/.+/),
      updatedAt: '__TS__',
    });
    expect(linesOf('VISIT_UNDO_DEPARTED')).toEqual([
      expect.objectContaining({
        status: 'SUCCESS',
        actorUid: 'uid1',
        targetUid: 's1',
        description: 'Undid the departure: completed to arrived',
        docId: `visitstep__s1__UNDO_DEPARTED__${Date.parse(DEPARTED_AT)}`,
      }),
    ]);
  });

  it('a visit left Departed (its completion was refused) goes back to Arrived, household copy untouched', async () => {
    seed({
      session: completed({ status: 'DEPARTED', completedAt: undefined, householdStatusBeforeCompletion: undefined }),
      visit: { status: 'confirmed' },
    });
    expect(await undo()).toMatchObject({ from: 'DEPARTED', status: 'ARRIVED', changed: true });
    expect(visitWrites()).toEqual([]);
    expect(linesOf('VISIT_UNDO_DEPARTED')[0]?.description).toBe('Undid the departure: departed to arrived');
  });

  it('a household copy with no kept status goes back to confirmed; one already cancelled is left alone', async () => {
    seed({ session: completed({ householdStatusBeforeCompletion: undefined }) });
    await undo();
    expect(visitWrites()[0]?.data).toMatchObject({ status: 'confirmed' });

    seed({ visit: { status: 'cancelled' } });
    await undo();
    expect(visitWrites()).toEqual([]);
  });

  it('a visit with no booking record is put back without writing a household copy', async () => {
    seed({ session: completed({ kinCareBatchId: '', kinCareVisitId: '' }), visit: null });
    expect((await undo()).changed).toBe(true);
    expect(ctx.writes.map((w) => w.path)).toEqual([SESSION]);
  });

  it('landing before the departure trigger has completed the visit, it wins and the trigger writes nothing', async () => {
    seed({ session: completed({ status: 'DEPARTED', completedAt: undefined }), visit: { status: 'confirmed' } });
    await undo();
    const before = ctx.writes.length;
    expect(await completeDepartedSession('s1')).toEqual({ kind: 'skipped', status: 'ARRIVED' });
    expect(ctx.writes).toHaveLength(before);
  });
});

describe('the household is not told', () => {
  it('the undo sends no clock notice and no booking notice', async () => {
    seed({});
    await undo();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("the session trigger its write fires sends nothing and adds no second line", async () => {
    const before = completed();
    seed({ session: before });
    await undo();
    const after = await storedSession();
    await onKinCareSessionLifecycleHandler({
      id: 'evt-1',
      params: { sessionId: 's1' },
      data: { before: { data: () => before }, after: { data: () => after } },
      authType: 'service_account',
      authId: 'functions@example',
    } as never);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(linesOf('VISIT_UNDO_DEPARTED')).toHaveLength(1);
    expect(linesOf('VISIT_ARRIVED')).toEqual([]);
  });

  it("putting the household's copy back is not read as a new confirmation", async () => {
    seed({});
    await undo();
    const restored = (await ctx.db.doc(VISIT).get()).data() as Record<string, unknown>;
    const event = (after: Record<string, unknown>) =>
      ({
        params: { kinfolkId: 'kf1', batchId: 'b1', visitId: 'v1' },
        data: { before: { data: () => ({ status: 'completed' }), exists: true }, after: { data: () => after, exists: true } },
      }) as never;

    await onBookingsWrite.run(event(restored));
    expect(mocks.enqueue).not.toHaveBeenCalled();

    // The control: the same move without the undo's stamp does send, so the
    // silence above is the stamp's doing and not a trigger that never sends.
    await onBookingsWrite.run(event({ status: 'approved' }));
    expect(mocks.enqueue.mock.calls.map((c) => c[0].key)).toEqual(['kincare.booking.confirm']);
  });
});

describe('the real Departed after an undo', () => {
  const tap = (action: string, atIso: string) =>
    setVisitLifecycleHandler(req({ sessionId: 's1', action, atIso }));
  const told = () => mocks.dispatch.mock.calls.map((c) => c[0].event);
  it('the undo notes which arrival the household was told about', async () => {
    seed({});
    await undo();
    expect((await storedSession())['departedNoticeToldForArrival']).toBe(ARRIVED_AT);
  });
  it('tells the household nothing a second time, logs the step, and says why on the card', async () => {
    seed({});
    await undo();
    const res = await tap('DEPARTED', '2026-11-14T15:32:00.000Z');
    expect(res).toMatchObject({ status: 'DEPARTED', changed: true, notified: false, notifySkipped: 'already_notified' });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(linesOf('VISIT_DEPARTED')).toHaveLength(1);
    const atMs = Date.parse('2026-11-14T15:32:00.000Z');
    const record = (await ctx.db.doc(`visit_step_notices/s1__departed__${atMs}`).get()).data();
    expect(record).toMatchObject({ notified: false, reason: 'already_notified' });
  });
  it("a phone's own Departed write is not announced either", async () => {
    seed({});
    await undo();
    const before = await storedSession();
    const after = { ...before, status: 'DEPARTED', departedAt: '2026-11-14T15:32:00.000Z' };
    await onKinCareSessionLifecycleHandler({
      id: 'evt-2',
      params: { sessionId: 's1' },
      data: { before: { data: () => before }, after: { data: () => after } },
      authType: 'unauthenticated',
      authId: '',
    } as never);
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(linesOf('VISIT_DEPARTED')).toHaveLength(1);
  });
  it('a departure nobody undid is announced: the silence is the undo\'s doing', async () => {
    seed({ session: { ...completed(), status: 'ARRIVED', departedAt: '', undoDepartedUntil: undefined } });
    await tap('DEPARTED', '2026-11-14T15:32:00.000Z');
    expect(told()).toEqual(['departed']);
  });
  it('a new arrival is a new visit to the door: its Arrived and its Departed are both announced', async () => {
    seed({});
    await undo();
    await tap('UNDO_ARRIVAL', '2026-11-14T15:32:00.000Z');
    await tap('ARRIVED', '2026-11-14T15:33:00.000Z');
    await tap('DEPARTED', '2026-11-14T15:50:00.000Z');
    expect(told()).toEqual(['arrived', 'departed']);
  });
  it('undone twice, it stays quiet for the same arrival', async () => {
    seed({});
    await undo();
    await tap('DEPARTED', '2026-11-14T15:32:00.000Z');
    await completeDepartedSession('s1');
    await undo();
    await tap('DEPARTED', '2026-11-14T15:33:00.000Z');
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(linesOf('VISIT_DEPARTED')).toHaveLength(2);
  });
});
describe('after the window', () => {
  it('is refused in plain words, writes nothing, and the refusal is logged', async () => {
    seed({});
    vi.setSystemTime(Date.parse(UNTIL) + 1000);
    await expect(undo()).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Undo departed is only there for 5 minutes after Departed. That time has passed.',
      details: { code: 'undo_departed_window_passed', sessionId: 's1' },
    });
    expect(ctx.writes).toEqual([]);
    expect(linesOf('VISIT_LIFECYCLE_REFUSED')).toEqual([
      expect.objectContaining({
        status: 'FAILURE',
        description:
          'Could not undo the departure: Undo departed is only there for 5 minutes after Departed. That time has passed.',
      }),
    ]);
    expect(linesOf('VISIT_UNDO_DEPARTED')).toEqual([]);
  });

  it('the owner is refused the same as an Auntie', async () => {
    seed({});
    vi.setSystemTime(Date.parse(UNTIL) + 1000);
    await expect(undo(OWNER)).rejects.toMatchObject({ details: { code: 'undo_departed_window_passed' } });
  });

  it('a visit completed some other way, with no window on it, is refused', async () => {
    seed({ session: completed({ undoDepartedUntil: undefined }) });
    await expect(undo()).rejects.toMatchObject({ details: { code: 'undo_departed_window_passed' } });
    expect(ctx.writes).toEqual([]);
  });
});

describe('it is never a way to start a visit', () => {
  it('a visit with no arrival on record is refused: there is no Arrived to go back to', async () => {
    seed({ session: completed({ arrivedAt: '' }) });
    await expect(undo()).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'This visit has no arrival on record, so it cannot go back to Arrived.',
      details: { code: 'undo_departed_no_arrival' },
    });
    expect(ctx.writes).toEqual([]);
  });

  it('a visit that never departed is refused', async () => {
    for (const status of ['SCHEDULED', 'ON_MY_WAY', 'CANCELLED']) {
      seed({ session: completed({ status }) });
      await expect(undo()).rejects.toMatchObject({
        code: 'failed-precondition',
        message: 'This visit has no departure to undo.',
      });
      expect(ctx.writes).toEqual([]);
    }
  });

  it('a position sent with it is ignored: nothing is measured and the arrival evidence is not rewritten', async () => {
    seed({ session: completed({ arrivalDistanceMeters: 20, arrivalAccuracyMeters: 10 }) });
    await setVisitLifecycleHandler(req({ sessionId: 's1', action: 'UNDO_DEPARTED', lat: 1, lng: 2, accuracyMeters: 5 }));
    const written = Object.keys(sessionWrites()[0]?.data ?? {});
    expect(written.filter((k) => k.startsWith('arrival') || k === 'arrivedAt')).toEqual([]);
  });

  it("a visit the owner completed outside the range keeps the owner's arrival, and completes outside the range again", async () => {
    const outside = { arrivalDistanceMeters: 2000, arrivalAccuracyMeters: 10, arrivalCheckedByOwner: true };
    seed({
      session: completed({ ...outside, completedOutsideRange: true }),
      settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
    });

    await undo(AUNTIE);

    const back = await storedSession();
    expect(back).toMatchObject({ status: 'ARRIVED', arrivedAt: ARRIVED_AT, ...outside });
    expect(back).not.toHaveProperty('completedOutsideRange');
    expect(back).not.toHaveProperty('completedAt');

    // The real departure, later: the same recorded arrival decides it.
    seed({
      session: { ...back, status: 'DEPARTED', departedAt: '2026-11-14T15:50:00.000Z' },
      visit: { status: 'approved' },
      settings: { requireArrivalDepartureVerification: true, arrivalRadiusMeters: 150 },
    });
    expect(await completeDepartedSession('s1')).toMatchObject({
      kind: 'completed',
      outsideRange: { distanceMeters: 2000, radiusMeters: 150 },
    });
    expect(sessionWrites().at(-1)?.data).toMatchObject({ status: 'COMPLETED', completedOutsideRange: true });
  });
});

describe('a double tap', () => {
  it('writes once, logs once, and answers the second tap as already done', async () => {
    seed({});
    const first = await undo();
    const second = await undo();

    expect(first.changed).toBe(true);
    expect(second).toMatchObject({
      ok: true,
      from: 'ARRIVED',
      status: 'ARRIVED',
      changed: false,
      notified: false,
      notifySkipped: 'already_in_this_state',
    });
    expect(sessionWrites()).toHaveLength(1);
    expect(visitWrites()).toHaveLength(1);
    expect(linesOf('VISIT_UNDO_DEPARTED')).toHaveLength(1);
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe('what else it refuses', () => {
  it('a visit that does not exist', async () => {
    seed({ session: null });
    await expect(undo()).rejects.toMatchObject({ code: 'not-found', message: 'This visit could not be found.' });
  });

  it('a caller who is not signed in', async () => {
    seed({});
    await expect(
      setVisitLifecycleHandler({ data: { sessionId: 's1', action: 'UNDO_DEPARTED' } } as never),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
