import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest, HttpsError } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
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

beforeEach(() => {
  mocks.dbFn.mockReset();
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
    expect(written(ctx, 'families/fam1/bookings/b_v1/kinCares/v1')).toEqual([{ ...kin, updatedAt: '__TS__' }]);
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
    const realBatch = ctx.db.batch;
    ctx.db.batch = () => {
      const b = realBatch();
      return { ...b, commit: async () => { throw new Error('write refused'); } };
    };
    await expect(addKinToUpcomingVisitsHandler(req({ kinfolkId: 'fam1', kinId: 'pepper', apply: true }))).rejects.toThrow(
      'write refused',
    );
    expect(writeAuditEntry).not.toHaveBeenCalled();
  });
});
