import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
// #557: this suite drives handlers through the wrapper, which now checks session
// revocation. Stub it out — see test/_helpers/mockSessionRevocation.ts.
vi.mock('../src/lib/sessionRevocation', () => import('./_helpers/mockSessionRevocation'));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));

import { listOrphanReportsHandler } from '../src/admin/listOrphanReports';
import { wrapAdminCallable } from '../src/lib/wrapAdminCallable';

beforeEach(() => mocks.dbFn.mockReset());

function req(uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data: undefined,
    auth: uid ? ({ uid, token: { admin: true } } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function report(id: string, data: Record<string, unknown>) {
  return { id, data: { bodyCopy: 'A visit note.', createdAt: '2026-05-17T10:00:00.000Z', ...data } };
}

function seed(reports: Array<{ id: string; data: Record<string, unknown> }>) {
  return buildDbMock({ queryDocs: { kin_care_reports: reports } });
}

describe('listOrphanReports selection', () => {
  it('returns a report that is genuinely untriaged: sentVia marker, blank kinfolkId, blank triageStatus', async () => {
    const ctx = seed([
      report('legacy_79', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: '' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listOrphanReportsHandler(req());
    expect(res.reports).toHaveLength(1);
    expect(res.reports[0]!._id).toBe('legacy_79');
  });

  it('matches the Pass-1 "legacy_orphan" marker too, not only the Pass-2 rename', async () => {
    const ctx = seed([report('legacy_1', { sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '' })]);
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await listOrphanReportsHandler(req());
    expect(res.reports.map((r) => r._id)).toEqual(['legacy_1']);
  });

  it('EXCLUDES a report already assigned to a kinfolk', async () => {
    const ctx = seed([
      report('legacy_80', { sentVia: 'legacy_visit_logs', kinfolkId: 'kf1', triageStatus: '' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports).toHaveLength(0);
  });

  it('EXCLUDES a report already triaged (duplicate / archived), even with a blank kinfolkId', async () => {
    const ctx = seed([
      report('legacy_81', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: 'duplicate' }),
      report('legacy_82', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: 'archived_bad_data' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports).toHaveLength(0);
  });

  it('EXCLUDES an ordinary report whose sentVia is a real channel, not a migration marker', async () => {
    const ctx = seed([report('r1', { sentVia: 'email', kinfolkId: '', triageStatus: '' })]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports).toHaveLength(0);
  });

  it('treats an ABSENT kinfolkId/triageStatus field as blank, not merely an empty string', async () => {
    // THE TRAP (same shape as listUninvoicedSessions' invoiceId case): neither
    // field is guaranteed to exist on a legacy doc, and a doc that never had
    // the key written is exactly what "untriaged" means.
    const ctx = seed([report('legacy_83', { sentVia: 'legacy_visit_logs' })]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports.map((r) => r._id)).toEqual(['legacy_83']);
  });

  it('treats whitespace-only kinfolkId/triageStatus as blank too', async () => {
    const ctx = seed([
      report('legacy_84', { sentVia: 'legacy_visit_logs', kinfolkId: '   ', triageStatus: '  ' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports.map((r) => r._id)).toEqual(['legacy_84']);
  });
});

describe('listOrphanReports ordering + honesty', () => {
  it('sorts newest migration row first', async () => {
    const ctx = seed([
      report('older', { sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '', createdAt: '2026-05-01T00:00:00.000Z' }),
      report('newer', { sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '', createdAt: '2026-05-20T00:00:00.000Z' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports.map((r) => r._id)).toEqual(['newer', 'older']);
  });

  it('breaks the F7 tie on _legacySubmittedAt, so an all-imported set still has an order', async () => {
    // After the punchlist F7 redate every row the visit_logs migration produced
    // shares ONE ingest instant on createdAt, and that is the whole orphan set.
    // The primary sort alone would leave them tied and the order arbitrary.
    const ingest = '2026-05-16T20:36:39.000Z';
    const ctx = seed([
      report('legacy_57', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: '', createdAt: ingest, _legacySubmittedAt: '2025-09-03T14:02:00.000Z' }),
      report('legacy_10', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: '', createdAt: ingest, _legacySubmittedAt: '2026-04-03T23:26:00.000Z' }),
      report('legacy_55', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: '', createdAt: ingest, _legacySubmittedAt: '2025-11-08T13:34:00.000Z' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listOrphanReportsHandler(req());
    expect(res.reports.map((r) => r._id)).toEqual(['legacy_10', 'legacy_55', 'legacy_57']);
    // And the tie-break stays internal: the row renders id + channel + body.
    expect(res.reports[0]).not.toHaveProperty('_legacySubmittedAt');
  });

  it('a row with no _legacySubmittedAt sorts last within its tie, never ahead of a stamped one', async () => {
    const ingest = '2026-05-16T20:36:39.000Z';
    const ctx = seed([
      report('unstamped', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: '', createdAt: ingest }),
      report('stamped', { sentVia: 'legacy_visit_logs', kinfolkId: '', triageStatus: '', createdAt: ingest, _legacySubmittedAt: '2025-09-03T14:02:00.000Z' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports.map((r) => r._id)).toEqual(['stamped', 'unstamped']);
  });

  it('sorts a blank createdAt last, never treating it as "now"', async () => {
    const ctx = seed([
      report('dated', { sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '', createdAt: '2026-05-01T00:00:00.000Z' }),
      report('undated', { sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '', createdAt: '' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    expect((await listOrphanReportsHandler(req())).reports.map((r) => r._id)).toEqual(['dated', 'undated']);
  });

  it('reports how many rows the query itself matched, so an empty result is distinguishable from a truncated one', async () => {
    const ctx = seed([
      report('legacy_1', { sentVia: 'legacy_orphan', kinfolkId: 'kf1', triageStatus: '' }),
      report('legacy_2', { sentVia: 'legacy_orphan', kinfolkId: '', triageStatus: '' }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listOrphanReportsHandler(req());
    expect(res.scanned).toBe(2);
    expect(res.reports).toHaveLength(1);
  });

  it('carries the body a triage row previews, and the raw sentVia marker (pretty-printing is a client concern)', async () => {
    const ctx = seed([
      report('legacy_85', {
        sentVia: 'legacy_visit_logs',
        kinfolkId: '',
        triageStatus: '',
        bodyCopy: 'Fed and walked, all calm.',
      }),
    ]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const r = (await listOrphanReportsHandler(req())).reports[0]!;
    expect(r).toMatchObject({
      _id: 'legacy_85',
      sentVia: 'legacy_visit_logs',
      bodyCopy: 'Fed and walked, all calm.',
    });
  });
});

describe('listOrphanReports empty + auth', () => {
  it('returns an empty list, not an error, when nothing matches', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await listOrphanReportsHandler(req());
    expect(res.reports).toEqual([]);
    expect(res.scanned).toBe(0);
  });

  it('is unauthenticated with no caller and permission-denied for a non-admin', async () => {
    const ctx = seed([]);
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(listOrphanReportsHandler(req(null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });

    const guarded = wrapAdminCallable('listOrphanReports', listOrphanReportsHandler);
    await expect(
      guarded({ data: undefined, auth: { uid: 'kinfolk-9', token: {} } } as unknown as CallableRequest<unknown>),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
