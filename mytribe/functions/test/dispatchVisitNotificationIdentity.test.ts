import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: the visit-lifecycle callable over the REAL dispatcher.
 *
 * Every visit notification targets the visit, so the dispatcher can only tell a
 * re-arrival from a retry by the identity `dispatchVisitNotificationCore` hands
 * it. These cases drive the callable exactly as the clients do and count what
 * reaches the household: two arrivals with different stamped times both send,
 * a retry of one does not, and two reports for one visit both send.
 *
 * This is also the wiring test for the core's `dedupeKey`: drop it and every
 * notification for a visit collapses onto `booking:<visitId>`, and the
 * two-arrivals case delivers once.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveKinCareRefFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinCareRef', () => ({ resolveKinCareRef: mocks.resolveKinCareRefFn }));

import { dispatchVisitNotificationHandler } from '../src/admin/dispatchVisitNotification';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const VISIT_PATH = 'families/fam1/bookings/batch1/kinCares/visit1';

function tap(data: Record<string, unknown>) {
  return dispatchVisitNotificationHandler({
    data: { familyId: 'fam1', batchId: 'batch1', visitId: 'visit1', ...data },
    auth: { uid: 'uid_auntie', token: { name: 'TiTi' } },
  } as never);
}

function household(writes: Array<{ path: string; data: Record<string, unknown> }>, key: string) {
  return writes.filter(
    (w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk' && w.data.key === key,
  );
}

let ctx: ReturnType<typeof buildDbMock>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  ctx = buildDbMock({
    writeThrough: true,
    docs: {
      [VISIT_PATH]: { serviceType: 'Dog Walk', scheduledAtMs: NOW, kinfolkId: 'fam1' },
      'families/fam1': { displayName: 'The Rileys' },
      // #1794/#1802: the household login the notice routes to.
      'kinfolk/fam1': { uid: 'uid_kinfolk' },
      // #1840: a login is a household's only when it is an ACTIVE member.
      'families/fam1/members/uid_kinfolk': { role: 'PRIMARY', status: 'ACTIVE' },
      'clients/uid_kinfolk': { displayName: 'Dana' },
      'staff/uid_auntie': { displayName: 'TiTi' },
    },
  });
  mocks.dbFn.mockReset().mockReturnValue(ctx.db);
  mocks.resolveKinCareRefFn.mockReset().mockResolvedValue({
    ref: ctx.db.doc(VISIT_PATH),
    batchId: 'batch1',
    visitId: 'visit1',
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('dispatchVisitNotification names each lifecycle event (#832)', () => {
  it('two arrivals with different stamped times both reach the household; a retry of the first does not', async () => {
    const firstArrival = NOW - 60_000;
    await tap({ event: 'arrived', eventAtMs: firstArrival });
    // The arrival is undone and marked again two minutes later.
    vi.setSystemTime(NOW + 60_000);
    await tap({ event: 'arrived', eventAtMs: NOW + 60_000 });
    // A client retry of the first tap: same stamped time.
    vi.setSystemTime(NOW + 90_000);
    await tap({ event: 'arrived', eventAtMs: firstArrival });

    expect(household(ctx.writes, 'kincare.auntie.arrived')).toHaveLength(2);
  });

  it('a second departure after an undone one sends too', async () => {
    await tap({ event: 'departed', eventAtMs: NOW });
    vi.setSystemTime(NOW + 120_000);
    await tap({ event: 'departed', eventAtMs: NOW + 120_000 });

    expect(household(ctx.writes, 'kincare.auntie.departed')).toHaveLength(2);
  });

  // #2250: the call an installed client still makes after its own Departed
  // write. The server's send skips a departure that was announced and then
  // undone, so this call must skip it too or it becomes the second notice.
  // #2357: it asks the same question the server's send asks, of the same
  // records: was an earlier departure of this visit told, and was that today.
  const visitSession = (extra: Record<string, unknown>) =>
    ctx.db.doc('kin_care_sessions/s1').set({
      kinfolkId: 'fam1',
      kinCareBatchId: 'batch1',
      kinCareVisitId: 'visit1',
      arrivedAt: '2026-09-14T14:30:00.000Z',
      ...extra,
    });
  /** The first departure, sent by the client itself, with the record the session trigger leaves beside it. */
  async function firstDepartureTold(): Promise<void> {
    await visitSession({ status: 'DEPARTED', departedAt: new Date(NOW).toISOString() });
    await tap({ event: 'departed', eventAtMs: NOW });
    await ctx.db
      .doc(`visit_step_notices/s1__departed__${NOW}`)
      .set({ sessionId: 's1', event: 'departed', atMs: NOW, dispatchIds: [], recordedAtMs: NOW });
  }
  it('a departure announced once and then undone is not announced again the same day', async () => {
    await firstDepartureTold();
    vi.setSystemTime(NOW + 120_000);
    await visitSession({ status: 'DEPARTED', departedAt: new Date(NOW + 120_000).toISOString() });
    const res = await tap({ event: 'departed', eventAtMs: NOW + 120_000 });
    expect(household(ctx.writes, 'kincare.auntie.departed')).toHaveLength(1);
    expect(res).toMatchObject({ suppressed: true, reason: 'already_notified', dispatchIds: [] });
    expect(res.notice).toMatchObject({ told: false, reason: 'already_notified' });
  });
  it('the real departure on a later business day is announced, once', async () => {
    await firstDepartureTold();
    const nextDay = NOW + 24 * 60 * 60_000;
    vi.setSystemTime(nextDay);
    await visitSession({ status: 'DEPARTED', departedAt: new Date(nextDay).toISOString() });
    const res = await tap({ event: 'departed', eventAtMs: nextDay });
    expect(res).toMatchObject({ suppressed: false, reason: null });
    // A retry of the same tap is still the duplicate.
    const again = await tap({ event: 'departed', eventAtMs: nextDay });
    expect(again).toMatchObject({ suppressed: true, reason: 'already_notified' });
    expect(household(ctx.writes, 'kincare.auntie.departed')).toHaveLength(2);
  });
  it('an arrival of that visit is still announced', async () => {
    await firstDepartureTold();
    await visitSession({ status: 'ARRIVED', departedAt: '' });
    await tap({ event: 'arrived', eventAtMs: NOW + 60_000 });
    expect(household(ctx.writes, 'kincare.auntie.arrived')).toHaveLength(1);
  });
  it('two reports for one visit both send; a retry of one report does not', async () => {
    await tap({ event: 'report_sent', reportId: 'report-1' });
    vi.setSystemTime(NOW + 30_000);
    await tap({ event: 'report_sent', reportId: 'report-2' });
    vi.setSystemTime(NOW + 60_000);
    await tap({ event: 'report_sent', reportId: 'report-1' });

    // kincare.report.sent is a retired alias; the catalog writes the canonical key.
    const reports = ctx.writes.filter(
      (w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk',
    );
    expect(reports).toHaveLength(2);
  });

  // #2487: the KinTale notice opens that KinTale, but only one of this household's.
  it("a report notice carries the household's own KinTale, and never another household's", async () => {
    await ctx.db.doc('kin_care_reports/tale-own').set({ kinfolkId: 'fam1' });
    await ctx.db.doc('kin_care_reports/tale-other').set({ kinfolkId: 'fam2' });
    await tap({ event: 'report_sent', reportId: 'tale-own' });
    vi.setSystemTime(NOW + 30_000);
    await tap({ event: 'report_sent', reportId: 'tale-other' });
    vi.setSystemTime(NOW + 60_000);
    await tap({ event: 'report_sent', reportId: 'tale-missing' });

    const sent = ctx.writes.filter((w) => w.path.startsWith('notifications/') && w.data.recipientUid === 'uid_kinfolk');
    expect(sent).toHaveLength(3);
    const [own, other, missing] = sent.map((w) => w.data as Record<string, unknown>);
    expect(own).toMatchObject({ targetType: 'kintale', targetId: 'tale-own' });
    expect((own!.data as Record<string, unknown>).taleId).toBe('tale-own');
    for (const w of [other!, missing!]) {
      expect((w.data as Record<string, unknown>).taleId).toBeUndefined();
      expect(w.targetType).not.toBe('kintale');
      expect(w.targetId).not.toBe('tale-other');
    }
  });

  it('different steps of one visit never collide with each other', async () => {
    await tap({ event: 'on_my_way', etaMinutes: 10, eventAtMs: NOW });
    await tap({ event: 'arrived', eventAtMs: NOW });
    await tap({ event: 'departed', eventAtMs: NOW });

    expect(household(ctx.writes, 'kincare.auntie.on_my_way')).toHaveLength(1);
    expect(household(ctx.writes, 'kincare.auntie.arrived')).toHaveLength(1);
    expect(household(ctx.writes, 'kincare.auntie.departed')).toHaveLength(1);
  });
});
