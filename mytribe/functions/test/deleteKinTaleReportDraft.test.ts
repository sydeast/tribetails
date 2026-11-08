import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #1631: an unsent KinTale report draft (`kin_care_reports`, status DRAFT)
 * could not be deleted on any client. Only the purgeOldDrafts retention job
 * removed one. This handler is the delete every client calls, with the purge's
 * refusals.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));

import { deleteKinTaleReportDraftHandler } from '../src/admin/deleteKinTaleReportDraft';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUNTIE_ALLOWED_CALLABLES } from '../src/lib/auntieAccess';

const auditMock = writeAuditEntry as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.dbFn.mockReset();
  auditMock.mockClear();
});

const admin = (data: unknown) => callableRequest(data, { uid: 'admin1', token: { admin: true } });

const DRAFT = {
  status: 'DRAFT',
  kinfolkId: 'kf-robyn',
  kinfolkName: 'Robyn',
  bodyCopy: 'Biscuit had a great walk.',
  sentAt: '',
  sentVia: '',
  updatedAt: '2026-11-04T18:00:00.000Z',
};

function db(docs: Record<string, Record<string, unknown> | null>) {
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs };
}

describe('deleteKinTaleReportDraft', () => {
  it('deletes an unsent draft and audits it', async () => {
    const { ctx, docs } = db({ 'kin_care_reports/r1': { ...DRAFT } });
    const res = await deleteKinTaleReportDraftHandler(admin({ reportId: 'r1' }));
    expect(res).toEqual({ ok: true, reportId: 'r1' });
    expect(ctx.deletes).toContain('kin_care_reports/r1');
    expect(docs['kin_care_reports/r1']).toBeUndefined();
    const audit = auditMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(audit.find((a) => a['event'] === 'KINTALE_REPORT_DRAFT_DELETED')).toMatchObject({
      severity: 'warn',
      targetCollection: 'kin_care_reports',
      targetUid: 'r1',
      // #1747: words, never the `kin_care_reports/<id>` path.
      description: 'Deleted a KinTale draft',
      payload: { reportId: 'r1' },
    });
  });

  it('reads the status case-insensitively, as the purge does', async () => {
    const { ctx } = db({ 'kin_care_reports/r1': { ...DRAFT, status: 'draft' } });
    await deleteKinTaleReportDraftHandler(admin({ reportId: 'r1' }));
    expect(ctx.deletes).toContain('kin_care_reports/r1');
  });

  it('refuses a SENT KinTale', async () => {
    const { ctx } = db({ 'kin_care_reports/r1': { ...DRAFT, status: 'SENT', sentAt: '2026-11-04T19:00:00Z' } });
    await expect(deleteKinTaleReportDraftHandler(admin({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(ctx.deletes).toHaveLength(0);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('refuses a DRAFT that carries a sentAt: the send wins', async () => {
    const { ctx } = db({ 'kin_care_reports/r1': { ...DRAFT, sentAt: '2026-11-04T19:00:00Z' } });
    await expect(deleteKinTaleReportDraftHandler(admin({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(ctx.deletes).toHaveLength(0);
  });

  it('refuses an untriaged migration orphan', async () => {
    const { ctx } = db({
      'kin_care_reports/r1': { ...DRAFT, kinfolkId: '', sentVia: 'legacy_orphan' },
    });
    await expect(deleteKinTaleReportDraftHandler(admin({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('Needs triage') as unknown as string,
    });
    expect(ctx.deletes).toHaveLength(0);
  });

  it('a missing report is not-found', async () => {
    db({ 'kin_care_reports/gone': null });
    await expect(deleteKinTaleReportDraftHandler(admin({ reportId: 'gone' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a namespaced id and an unauthenticated caller', async () => {
    db({});
    await expect(
      deleteKinTaleReportDraftHandler(admin({ reportId: 'generated_drafts/x' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(deleteKinTaleReportDraftHandler(callableRequest({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('stays owner only: an Auntie may not call it', () => {
    expect(AUNTIE_ALLOWED_CALLABLES.has('deleteKinTaleReportDraft')).toBe(false);
  });
});
