import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), enqueue: vi.fn(), resolveKinfolkUid: vi.fn() }));
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  return { contentDedupeKey: actual.contentDedupeKey, enqueueNotification: mocks.enqueue };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { addKinToUpcomingVisitsHandler } from '../src/admin/addKinToUpcomingVisits';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';
import { onBookingsWrite } from '../src/triggers/onBookingsWrite';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('uid-household');
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, token: Record<string, unknown> | null = { admin: true }): CallableRequest<unknown> {
  return {
    data,
    auth: token ? ({ uid: 'owner1', token } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const AHEAD = '2099-03-01T15:00:00Z';
const AHEAD_END = '2099-03-01T15:30:00Z';
const PAST = '2020-03-01T15:00:00Z';
const ts = (iso: string) => ({ toMillis: () => Date.parse(iso) });

type Docs = Record<string, Record<string, unknown> | null>;

/**
 * A household with two Kin from before the bookings (Biscuit, Mochi) and one
 * adopted after them (Pepper: an admin record `kin/pepper` with its household
 * card `families/fam1/kin/pep-card`).
 */
function household(): Docs {
  return {
    'families/fam1/kin/biscuit': { name: 'Biscuit', legacyKinId: 'biscuit' },
    'families/fam1/kin/mochi': { name: 'Mochi', legacyKinId: 'mochi' },
    'families/fam1/kin/pep-card': { name: 'Pepper', legacyKinId: 'pepper' },
    'kin/biscuit': { name: 'Biscuit', kinfolkId: 'fam1' },
    'kin/mochi': { name: 'Mochi', kinfolkId: 'fam1' },
    'kin/pepper': { name: 'Pepper', kinfolkId: 'fam1' },
  };
}

const OLD_KIN = { kinIds: ['biscuit', 'mochi'], kinNames: ['Biscuit', 'Mochi'] };

/** One booked visit: envelope, the household's copy and the office row. */
function visit(docs: Docs, id: string, opts: { session?: Record<string, unknown>; copy?: Record<string, unknown>; batch?: string; family?: string } = {}) {
  const family = opts.family ?? 'fam1';
  const batch = opts.batch ?? `b_${id}`;
  docs[`families/${family}/bookings/${batch}`] ??= { familyId: family, envelopeStatus: 'confirmed', ...OLD_KIN };
  docs[`families/${family}/bookings/${batch}/kinCares/${id}`] = {
    familyId: family,
    status: 'confirmed',
    startTime: ts(AHEAD),
    endTime: ts(AHEAD_END),
    sessionId: `vis_${id}`,
    ...OLD_KIN,
    ...(opts.copy ?? {}),
  };
  docs[`kin_care_sessions/vis_${id}`] = {
    kinfolkId: family,
    status: 'SCHEDULED',
    startTime: AHEAD,
    endTime: AHEAD_END,
    kinCareBatchId: batch,
    kinCareVisitId: id,
    ...OLD_KIN,
    ...(opts.session ?? {}),
  };
}

/** Builds the mock from one doc map, so every query sees the same world. */
function mockFrom(docs: Docs) {
  const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
  const kinCares: Array<{ id: string; path: string; data: Record<string, unknown> }> = [];
  for (const [path, data] of Object.entries(docs)) {
    if (data == null) continue;
    const segs = path.split('/');
    if (segs.length === 6 && segs[4] === 'kinCares') {
      kinCares.push({ id: segs[5], path, data });
      continue;
    }
    const col = segs.slice(0, -1).join('/');
    (queryDocs[col] ??= []).push({ id: segs[segs.length - 1], data });
  }
  // The roster reads `kin` by kinfolkId and the sessions by kinfolkId: the
  // mock applies the `where` to these rows.
  const ctx = buildDbMock({ docs, queryDocs, collectionGroupDocs: { kinCares }, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return ctx;
}

function written(ctx: ReturnType<typeof buildDbMock>, path: string) {
  return ctx.writes.filter((w) => w.path === path).map((w) => w.data);
}

describe('addKinToUpcomingVisits: the count', () => {
  it('counts the upcoming visits that do not carry the Kin, and writes nothing', async () => {
    const docs = household();
    visit(docs, 'v1');
    visit(docs, 'v2');
    const ctx = mockFrom(docs);

    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper' }));

    expect(res).toEqual({ ok: true, kinId: 'pepper', kinName: 'Pepper', upcoming: 2, added: 0 });
    expect(ctx.writes.filter((w) => !w.path.startsWith('business_settings'))).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });

  it('reads the Kin by its household card id as well, and answers with the id a visit stores', async () => {
    const docs = household();
    visit(docs, 'v1');
    mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pep-card' }));
    expect(res.kinId).toBe('pepper');
    expect(res.upcoming).toBe(1);
  });

  it('leaves out past, started, cancelled and completed visits, and another household', async () => {
    const docs = household();
    visit(docs, 'ahead');
    visit(docs, 'past', { session: { startTime: PAST, endTime: PAST }, copy: { startTime: ts(PAST), endTime: ts(PAST) } });
    visit(docs, 'onway', { session: { status: 'ON_MY_WAY', onMyWayAt: '2099-03-01T14:50:00Z' } });
    visit(docs, 'arrived', { session: { status: 'ARRIVED', arrivedAt: '2099-03-01T15:01:00Z' } });
    visit(docs, 'cancelled', { session: { status: 'CANCELLED' }, copy: { status: 'cancelled' } });
    visit(docs, 'done', { session: { status: 'COMPLETED' }, copy: { status: 'completed' } });
    // A row filed under another household, even if its field claims this one.
    visit(docs, 'other', { family: 'fam2' });
    docs['families/fam2/bookings/b_other/kinCares/other']!['familyId'] = 'fam1';
    mockFrom(docs);

    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper' }));
    expect(res.upcoming).toBe(1);
  });

  it('counts a request still awaiting approval, and a night still awaiting its start time', async () => {
    const docs = household();
    docs['families/fam1/bookings/req1'] = { familyId: 'fam1', envelopeStatus: 'requested', ...OLD_KIN };
    docs['families/fam1/bookings/req1/kinCares/r1'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: ts(AHEAD),
      endTime: ts(AHEAD_END),
      sessionId: null,
      ...OLD_KIN,
    };
    docs['families/fam1/bookings/req1/kinCares/r2'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: null,
      endTime: null,
      startTimePending: true,
      requestedDate: '2099-04-02',
      sessionId: null,
      ...OLD_KIN,
    };
    docs['families/fam1/bookings/req1/kinCares/r3'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: null,
      startTimePending: true,
      requestedDate: '2020-04-02',
      sessionId: null,
      ...OLD_KIN,
    };
    mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper' }));
    expect(res.upcoming).toBe(2);
  });

  it('does not count a visit that already carries the Kin by either id', async () => {
    const docs = household();
    visit(docs, 'v1', {
      session: { kinIds: ['biscuit', 'mochi', 'pepper'] },
      copy: { kinIds: ['biscuit', 'mochi', 'pep-card'] },
    });
    mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper' }));
    expect(res.upcoming).toBe(0);
  });
});

describe('addKinToUpcomingVisits: applying', () => {
  it('adds the Kin to the office row, the household copy and the envelope, and nothing else', async () => {
    const docs = household();
    visit(docs, 'v1', { session: { notes: 'Gate sticks.', gpsSummary: { m: 1 } } });
    const ctx = mockFrom(docs);

    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));

    expect(res).toEqual({ ok: true, kinId: 'pepper', kinName: 'Pepper', upcoming: 1, added: 1 });
    const kin = { kinIds: ['biscuit', 'mochi', 'pepper'], kinNames: ['Biscuit', 'Mochi', 'Pepper'] };
    expect(written(ctx, 'kin_care_sessions/vis_v1')).toEqual([
      { ...kin, updatedAt: '__TS__', updatedBy: 'owner1' },
    ]);
    expect(written(ctx, 'families/fam1/bookings/b_v1/kinCares/v1')).toEqual([
      { ...kin, kinAddedStamp: expect.any(String), updatedAt: '__TS__' },
    ]);
    expect(written(ctx, 'families/fam1/bookings/b_v1')).toEqual([{ ...kin, updatedAt: '__TS__' }]);
    // A patch: the fields no edit form shows are still there.
    expect(docs['kin_care_sessions/vis_v1']).toMatchObject({ notes: 'Gate sticks.', gpsSummary: { m: 1 }, status: 'SCHEDULED' });
  });

  it('writes one Activity Log line naming the Kin and the count', async () => {
    const docs = household();
    visit(docs, 'v1');
    visit(docs, 'v2');
    visit(docs, 'v3');
    mockFrom(docs);
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect((writeAuditEntry as any).mock.calls[0][0]).toMatchObject({
      event: AUDIT_EVENTS.ADD_KIN_TO_UPCOMING_VISITS,
      status: 'SUCCESS',
      actorUid: 'owner1',
      familyId: 'fam1',
      description: 'Added Pepper to 3 upcoming visits',
      payload: { kinfolkId: 'fam1', kinId: 'pepper', visitCount: 3 },
    });
  });

  it('is idempotent: a second apply finds nothing to add and writes nothing', async () => {
    const docs = household();
    visit(docs, 'v1');
    visit(docs, 'v2');
    mockFrom(docs);
    const first = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(first.added).toBe(2);
    (writeAuditEntry as any).mockClear();

    // The same world, read again after the first call's writes.
    const ctx2 = mockFrom(docs);
    const second = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(second).toMatchObject({ upcoming: 0, added: 0 });
    expect(ctx2.writes.filter((w) => !w.path.startsWith('business_settings'))).toEqual([]);
    expect(writeAuditEntry).not.toHaveBeenCalled();
    expect(docs['kin_care_sessions/vis_v1']!['kinIds']).toEqual(['biscuit', 'mochi', 'pepper']);
  });

  it('adds the Kin to a request awaiting approval, so approval keeps it', async () => {
    const docs = household();
    docs['families/fam1/bookings/req1'] = { familyId: 'fam1', envelopeStatus: 'requested', ...OLD_KIN };
    docs['families/fam1/bookings/req1/kinCares/r1'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: ts(AHEAD),
      endTime: ts(AHEAD_END),
      sessionId: null,
      ...OLD_KIN,
    };
    mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(res.added).toBe(1);
    expect(docs['families/fam1/bookings/req1/kinCares/r1']!['kinIds']).toEqual(['biscuit', 'mochi', 'pepper']);
    expect(docs['families/fam1/bookings/req1']!['kinNames']).toEqual(['Biscuit', 'Mochi', 'Pepper']);
  });

  it('counts and adds to a visit whose arrival was undone (a blank stamp is no stamp)', async () => {
    const docs = household();
    // setVisitLifecycle's UNDO_ARRIVAL writes `arrivedAt: ''` and puts the row back to SCHEDULED.
    visit(docs, 'undone', { session: { status: 'SCHEDULED', arrivedAt: '', onMyWayAt: '' } });
    mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(res).toMatchObject({ upcoming: 1, added: 1 });
    expect(docs['kin_care_sessions/vis_undone']!['kinIds']).toEqual(['biscuit', 'mochi', 'pepper']);
  });

  it('never narrows a visit stored with no Kin (every Kin) down to the new Kin alone', async () => {
    const docs = household();
    // R1: an empty list on a booking means every Kin of the household, and an
    // approval materializes it as the whole roster (`materializeKinRoster`).
    docs['families/fam1/bookings/old1'] = { familyId: 'fam1', envelopeStatus: 'requested', kinIds: [], kinNames: [] };
    docs['families/fam1/bookings/old1/kinCares/o1'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: ts(AHEAD),
      endTime: ts(AHEAD_END),
      sessionId: null,
      kinIds: [],
      kinNames: [],
    };
    mockFrom(docs);
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    const sorted = (v: unknown) => [...(v as string[])].sort();
    expect(sorted(docs['families/fam1/bookings/old1/kinCares/o1']!['kinIds'])).toEqual(['biscuit', 'mochi', 'pepper']);
    expect(sorted(docs['families/fam1/bookings/old1/kinCares/o1']!['kinNames'])).toEqual(['Biscuit', 'Mochi', 'Pepper']);
    expect(sorted(docs['families/fam1/bookings/old1']!['kinIds'])).toEqual(['biscuit', 'mochi', 'pepper']);
  });

  /** Runs [change] once, after the visits were read and before the first write. */
  function betweenReadAndWrite(ctx: ReturnType<typeof buildDbMock>, change: () => void) {
    let done = false;
    const once = () => {
      if (!done) change();
      done = true;
    };
    const realBatch = ctx.db.batch;
    ctx.db.batch = () => {
      once();
      return realBatch();
    };
    const realTx = ctx.db.runTransaction;
    ctx.db.runTransaction = (fn: any) => {
      once();
      return realTx(fn);
    };
  }

  it('leaves alone a visit that started between the count and the write', async () => {
    const docs = household();
    visit(docs, 'v1');
    visit(docs, 'v2');
    const ctx = mockFrom(docs);
    // The Auntie taps On my way on v1 after the visits were read.
    betweenReadAndWrite(ctx, () => {
      docs['kin_care_sessions/vis_v1'] = {
        ...docs['kin_care_sessions/vis_v1'],
        status: 'ON_MY_WAY',
        onMyWayAt: '2099-03-01T14:50:00Z',
      };
    });
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(res.added).toBe(1);
    expect(docs['kin_care_sessions/vis_v1']!['kinIds']).toEqual(['biscuit', 'mochi']);
    expect(docs['families/fam1/bookings/b_v1/kinCares/v1']!['kinIds']).toEqual(['biscuit', 'mochi']);
    expect(docs['families/fam1/bookings/b_v1']!['kinIds']).toEqual(['biscuit', 'mochi']);
    expect(docs['kin_care_sessions/vis_v2']!['kinIds']).toEqual(['biscuit', 'mochi', 'pepper']);
    expect((writeAuditEntry as any).mock.calls[0][0]).toMatchObject({ description: 'Added Pepper to 1 upcoming visit' });
  });

  it('keeps a Kin another edit put on the visit between the count and the write', async () => {
    const docs = household();
    docs['kin/clover'] = { name: 'Clover', kinfolkId: 'fam1' };
    visit(docs, 'v1');
    const ctx = mockFrom(docs);
    betweenReadAndWrite(ctx, () => {
      for (const p of ['kin_care_sessions/vis_v1', 'families/fam1/bookings/b_v1/kinCares/v1']) {
        docs[p] = { ...docs[p], kinIds: ['biscuit', 'mochi', 'clover'], kinNames: ['Biscuit', 'Mochi', 'Clover'] };
      }
    });
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(docs['kin_care_sessions/vis_v1']!['kinIds']).toEqual(['biscuit', 'mochi', 'clover', 'pepper']);
    expect(docs['families/fam1/bookings/b_v1/kinCares/v1']!['kinNames']).toEqual(['Biscuit', 'Mochi', 'Clover', 'Pepper']);
  });

  it('never touches a past visit', async () => {
    const docs = household();
    visit(docs, 'past', { session: { startTime: PAST, endTime: PAST }, copy: { startTime: ts(PAST), endTime: ts(PAST) } });
    visit(docs, 'ahead');
    const ctx = mockFrom(docs);
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(written(ctx, 'kin_care_sessions/vis_past')).toEqual([]);
    expect(written(ctx, 'families/fam1/bookings/b_past/kinCares/past')).toEqual([]);
    expect(docs['kin_care_sessions/vis_past']!['kinIds']).toEqual(['biscuit', 'mochi']);
  });
});

describe('addKinToUpcomingVisits: refusals', () => {
  it('refuses a caller who is not signed in', async () => {
    mockFrom(household());
    await expect(addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('refuses an Auntie, even with apply off, and reads nothing', async () => {
    const ctx = mockFrom(household());
    await expect(
      addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }, { staffRole: 'auntie' })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes.filter((w) => !w.path.startsWith('business_settings'))).toEqual([]);
  });

  it('refuses a Kin that is not one of this household’s Kin in care', async () => {
    const docs = household();
    docs['families/fam1/kin/old'] = { name: 'Old Timer', status: 'noLongerWithUs' };
    visit(docs, 'v1');
    mockFrom(docs);
    for (const kinId of ['stranger', 'old']) {
      const err = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId, apply: true })).catch((e) => e);
      expect(err).toBeInstanceOf(HttpsError);
      expect(err.code).toBe('not-found');
    }
  });

  it('answers a count of 0 for a Kin no longer in care, so its page shows no error', async () => {
    const docs = household();
    docs['families/fam1/kin/old'] = { name: 'Old Timer', status: 'noLongerWithUs' };
    visit(docs, 'v1');
    const ctx = mockFrom(docs);
    for (const kinId of ['stranger', 'old']) {
      const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId }));
      expect(res).toEqual({ ok: true, kinId, kinName: null, upcoming: 0, added: 0 });
    }
    expect(ctx.writes.filter((w) => !w.path.startsWith('business_settings'))).toEqual([]);
  });

  it('refuses a call with no Kin named', async () => {
    mockFrom(household());
    await expect(addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('surfaces a failed write as an error, not a success', async () => {
    const docs = household();
    visit(docs, 'v1');
    const ctx = mockFrom(docs);
    ctx.db.runTransaction = async () => {
      throw new Error('write refused');
    };
    await expect(addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }))).rejects.toThrow(
      'write refused',
    );
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});

/**
 * #1822, lead decision 2026-11-21: adding a Kin to N upcoming visits is ONE
 * piece of news, told once to each recipient (the #532/#536 rule), not N
 * `kincare.changed` and N `assignment.changed` from the per-visit trigger.
 */
describe('addKinToUpcomingVisits: one notice per recipient for the whole change', () => {
  const sent = (key: string) => mocks.enqueue.mock.calls.map((c) => c[0]).filter((a: { key: string }) => a.key === key);
  const dayMs = 86_400_000;
  /** Six confirmed visits on six days: four Ada's, two Bea's. */
  function sixVisits(docs: Docs) {
    for (let i = 0; i < 6; i++) {
      const start = new Date(Date.parse(AHEAD) + i * dayMs).toISOString();
      const end = new Date(Date.parse(AHEAD_END) + i * dayMs).toISOString();
      visit(docs, `v${i}`, {
        batch: 'b_week',
        session: { startTime: start, endTime: end },
        copy: { startTime: ts(start), endTime: ts(end), assignedAuntieUid: i < 4 ? 'ada' : 'bea', serviceName: 'Drop-in' },
      });
    }
  }
  /** Runs each household-copy write the callable made through the real trigger. */
  async function throughTrigger(before: Docs, ctx: ReturnType<typeof buildDbMock>, after: Docs) {
    const paths = [...new Set(ctx.writes.map((w) => w.path).filter((p) => p.includes('/kinCares/')))];
    for (const path of paths) {
      const [, kinfolkId, , batchId, , visitId] = path.split('/');
      await onBookingsWrite.run({
        id: `evt-${visitId}`,
        params: { kinfolkId, batchId, visitId },
        data: {
          before: { data: () => before[path], exists: true },
          after: { data: () => after[path], exists: true },
        },
      } as never);
    }
    return paths.length;
  }
  it('six visits: one kincare.changed naming all six, one assignment.changed per Auntie, and the trigger sends none', async () => {
    const docs = household();
    sixVisits(docs);
    const before: Docs = Object.fromEntries(Object.entries(docs).map(([k, v]) => [k, v && { ...v }]));
    const ctx = mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(res.added).toBe(6);
    const household_ = sent('kincare.changed');
    expect(household_).toHaveLength(1);
    expect(household_[0]).toMatchObject({
      recipientUid: 'uid-household',
      targetType: 'kinfolk',
      targetId: 'fam1',
      data: { kinAdded: true, addedKinName: 'Pepper', kinName: 'Pepper', visitCount: 6, serviceName: 'Drop-in' },
    });
    expect(household_[0].data.visits.map((v: { visitId: string }) => v.visitId)).toEqual(['v0', 'v1', 'v2', 'v3', 'v4', 'v5']);
    expect(household_[0].data.visitId).toBeUndefined();
    expect(household_[0].data.bookingDate).toEqual(expect.any(String));
    const aunties = sent('assignment.changed');
    expect(aunties).toHaveLength(2);
    const byUid = Object.fromEntries(aunties.map((a: any) => [a.recipientUid, a.data]));
    expect(byUid['ada']).toMatchObject({ assignedAuntieUid: 'ada', visitCount: 4, kinAdded: true, changeKind: 'updated' });
    expect(byUid['bea']).toMatchObject({ assignedAuntieUid: 'bea', visitCount: 2 });
    expect(byUid['bea'].visits.map((v: { visitId: string }) => v.visitId)).toEqual(['v4', 'v5']);
    expect(mocks.enqueue).toHaveBeenCalledTimes(3);
    // Each of the six household-copy writes, delivered to the per-visit trigger, sends nothing.
    mocks.enqueue.mockClear();
    expect(await throughTrigger(before, ctx, docs)).toBe(6);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('a Kin change made any other way still sends from the trigger, to the household and the Auntie', async () => {
    const before = { status: 'confirmed', startTime: ts(AHEAD), assignedAuntieUid: 'ada', ...OLD_KIN };
    await onBookingsWrite.run({
      id: 'evt-plain',
      params: { kinfolkId: 'fam1', batchId: 'b1', visitId: 'v1' },
      data: {
        before: { data: () => before, exists: true },
        after: { data: () => ({ ...before, kinIds: ['biscuit'], kinNames: ['Biscuit'] }), exists: true },
      },
    } as never);
    expect(sent('kincare.changed')).toHaveLength(1);
    expect(sent('assignment.changed')).toHaveLength(1);
  });
  it('a reschedule (office notice stamp) still sends the Auntie her copy from the trigger', async () => {
    const before = { status: 'confirmed', startTime: ts(AHEAD), assignedAuntieUid: 'ada', ...OLD_KIN };
    await onBookingsWrite.run({
      id: 'evt-move',
      params: { kinfolkId: 'fam1', batchId: 'b1', visitId: 'v1' },
      data: {
        before: { data: () => before, exists: true },
        after: { data: () => ({ ...before, notes: 'Moved', officeNoticeStamp: 's-1' }), exists: true },
      },
    } as never);
    expect(sent('kincare.changed')).toHaveLength(0);
    expect(sent('assignment.changed')).toHaveLength(1);
  });
  it('a later edit by anyone else to a visit this call stamped still sends', async () => {
    const stamped = { status: 'confirmed', startTime: ts(AHEAD), kinAddedStamp: 's-1', ...OLD_KIN };
    await onBookingsWrite.run({
      id: 'evt-later',
      params: { kinfolkId: 'fam1', batchId: 'b1', visitId: 'v1' },
      data: {
        before: { data: () => stamped, exists: true },
        after: { data: () => ({ ...stamped, notes: 'Side gate' }), exists: true },
      },
    } as never);
    expect(sent('kincare.changed')).toHaveLength(1);
  });
  it('a request awaiting approval tells nobody, and a confirmed visit beside it is the only one named', async () => {
    const docs = household();
    visit(docs, 'c1', { copy: { assignedAuntieUid: 'ada' } });
    docs['families/fam1/bookings/req1'] = { familyId: 'fam1', envelopeStatus: 'requested', ...OLD_KIN };
    docs['families/fam1/bookings/req1/kinCares/r1'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: ts(AHEAD),
      endTime: ts(AHEAD_END),
      sessionId: null,
      assignedAuntieUid: 'ada',
      ...OLD_KIN,
    };
    mockFrom(docs);
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(res.added).toBe(2);
    expect(sent('kincare.changed')).toHaveLength(1);
    expect(sent('kincare.changed')[0].data.visitCount).toBe(1);
    expect(sent('assignment.changed')).toHaveLength(1);
    expect(sent('assignment.changed')[0].data.visitCount).toBe(1);
  });
  it('only requests changed: nothing is sent', async () => {
    const docs = household();
    docs['families/fam1/bookings/req1'] = { familyId: 'fam1', envelopeStatus: 'requested', ...OLD_KIN };
    docs['families/fam1/bookings/req1/kinCares/r1'] = {
      familyId: 'fam1',
      status: 'requested',
      startTime: ts(AHEAD),
      endTime: ts(AHEAD_END),
      sessionId: null,
      ...OLD_KIN,
    };
    mockFrom(docs);
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('a preview sends nothing, and neither does a second apply', async () => {
    const docs = household();
    sixVisits(docs);
    mockFrom(docs);
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper' }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(mocks.enqueue).toHaveBeenCalledTimes(3);
    mocks.enqueue.mockClear();
    mockFrom(docs);
    await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('a failed send is logged, never undoes the writes, and costs the Auntie nothing', async () => {
    const docs = household();
    sixVisits(docs);
    mockFrom(docs);
    mocks.enqueue.mockImplementation(async (a: { key: string }) => {
      if (a.key === 'kincare.changed') throw new Error('dispatcher down');
      return ['n1'];
    });
    const res = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(res.added).toBe(6);
    expect(sent('assignment.changed')).toHaveLength(2);
  });
});
/**
 * #1822 review: the two partial-failure gaps. (1) An envelope whose write
 * failed was never repaired: a retry found every visit carrying the Kin, so it
 * counted nothing and never reached the envelope pass. (2) A call that failed
 * part way told nobody about the visits it had changed, and the retry skipped
 * those visits, so nobody ever heard of them.
 */
describe('addKinToUpcomingVisits: a call that fails part way', () => {
  const sent = (key: string) => mocks.enqueue.mock.calls.map((c) => c[0]).filter((a: { key: string }) => a.key === key);
  it('an envelope whose write failed is put right by the next tap', async () => {
    const docs = household();
    visit(docs, 'v1', { batch: 'b1' });
    visit(docs, 'v2', { batch: 'b1' });
    const ctx = mockFrom(docs);
    const realTx = ctx.db.runTransaction;
    ctx.db.runTransaction = async (fn: any) => {
      // The envelope transaction is the one that reads `families/fam1/bookings/b1`.
      let envelope = false;
      const out = await realTx(async (tx: any) => {
        const get = tx.get.bind(tx);
        tx.get = async (ref: any) => {
          if (ref.path === 'families/fam1/bookings/b1') envelope = true;
          return get(ref);
        };
        const r = await fn(tx);
        if (envelope) throw new Error('envelope write refused');
        return r;
      });
      return out;
    };
    await expect(addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }))).rejects.toThrow(
      'envelope write refused',
    );
    expect(docs['kin_care_sessions/vis_v1']!['kinIds']).toEqual(['biscuit', 'mochi', 'pepper']);
    // The mock applied the set before the throw; put the envelope back as a failed write leaves it.
    docs['families/fam1/bookings/b1'] = { ...docs['families/fam1/bookings/b1'], ...OLD_KIN };
    mocks.enqueue.mockClear();
    mockFrom(docs);
    const retry = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(retry.added).toBe(2);
    expect(docs['families/fam1/bookings/b1']!['kinIds']).toEqual(['biscuit', 'mochi', 'pepper']);
    // The visits were told about by the first call; repairing the envelope tells nobody again.
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it('tells about the visits it did change, then reports the failure; the retry tells about the rest, once', async () => {
    const docs = household();
    for (let i = 0; i < 12; i++) visit(docs, `v${String(i).padStart(2, '0')}`, { batch: 'b1' });
    const ctx = mockFrom(docs);
    const realTx = ctx.db.runTransaction;
    let n = 0;
    ctx.db.runTransaction = async (fn: any) => {
      n += 1;
      if (n === 3) throw new Error('visit write refused');
      return realTx(fn);
    };
    await expect(addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }))).rejects.toThrow(
      'visit write refused',
    );
    const first = sent('kincare.changed');
    expect(first).toHaveLength(1);
    const firstIds: string[] = first[0].data.visits.map((v: { visitId: string }) => v.visitId);
    expect(firstIds).toHaveLength(9);
    mocks.enqueue.mockClear();
    mockFrom(docs);
    const retry = await addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }));
    expect(retry.added).toBe(3);
    const second = sent('kincare.changed');
    expect(second).toHaveLength(1);
    const secondIds: string[] = second[0].data.visits.map((v: { visitId: string }) => v.visitId);
    expect(secondIds).toHaveLength(3);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });
});
