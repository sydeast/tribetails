import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #1563: a generated KinTale draft could be counted on Home and listed under
 * KinTales > Drafts, but nothing could send it to its household or delete it.
 * These handlers are that path; every client calls them.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  enqueue: vi.fn().mockResolvedValue(undefined),
  resolveUid: vi.fn().mockResolvedValue('uid_robyn'),
  claim: vi.fn().mockResolvedValue(true),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
// For the last publish test, which hands the written report to the real
// onKinTaleCreate handler. Only its outbound seams are doubled.
vi.mock('../src/lib/reconcileStatus', () => ({ seedReconcileStatus: vi.fn().mockResolvedValue('seeded') }));
vi.mock('../src/lib/wrapTrigger', () => ({ wrapTrigger: (_n: string, fn: (...a: unknown[]) => unknown) => fn }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/kinTalePublishClaim', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/kinTalePublishClaim')>()),
  claimKinTalePublish: mocks.claim,
}));

import {
  publishGeneratedDraftHandler,
  deleteGeneratedDraftHandler,
  DRAFT_STATUS_PUBLISHED,
} from '../src/admin/kinTaleDrafts';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { onKinTaleCreateHandler } from '../src/triggers/onKinTaleCreate';

const auditMock = writeAuditEntry as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.enqueue.mockClear();
  auditMock.mockClear();
});

const admin = (data: unknown) => callableRequest(data, { uid: 'admin1', token: { admin: true, name: 'Syd' } });

/** A May-era n8n draft: camelCase, `pending`, the shape the walk's five drafts carry. */
const MIGRATED_DRAFT = {
  status: 'pending',
  communicationType: 'visit_report',
  kinfolkId: 'kf-robyn',
  kinfolkName: 'Robyn',
  generatedCopy: 'Biscuit had a great walk.',
  createdOn: '2026-05-23T22:23:00.000Z',
};

/** A generate.js draft: snake_case, `generated`. */
const GENERATE_JS_DRAFT = {
  status: 'generated',
  communication_type: 'visit_report',
  kinfolk_id: 'kf-olivia',
  kinfolk_name: 'Olivia',
  generated_copy: 'Mochi napped in the sun.',
  generated_title: 'A sunny nap',
  generated_at: '2026-05-23T22:47:00.000Z',
};

function db(docs: Record<string, Record<string, unknown> | null>) {
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs };
}

function reportWrites(ctx: ReturnType<typeof buildDbMock>) {
  return ctx.writes.filter((w: { path: string }) => w.path.startsWith('kin_care_reports/'));
}

describe('publishGeneratedDraft', () => {
  it('writes a SENT kin_care_reports doc for the household and stamps the draft, in one go', async () => {
    const { ctx, docs } = db({
      'generated_drafts/d1': { ...MIGRATED_DRAFT },
      'kinfolk/kf-robyn': { firstName: 'Robyn', lastName: 'Hale' },
    });

    const res = await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: '  Edited: Biscuit had a great walk.  ' }));

    expect(res.ok).toBe(true);
    expect(res.alreadyPublished).toBe(false);
    const writes = reportWrites(ctx);
    expect(writes).toHaveLength(1);
    const report = writes[0]!.data as Record<string, unknown>;
    expect(writes[0]!.path).toBe(`kin_care_reports/${res.reportId}`);
    expect(report).toMatchObject({
      kinfolkId: 'kf-robyn',
      kinfolkName: 'Robyn Hale',
      bodyCopy: 'Edited: Biscuit had a great walk.',
      status: 'SENT',
      sentVia: 'pending',
      sessionId: '',
      sourceDraftId: 'd1',
      authorId: 'admin1',
      authorDisplayName: 'Syd',
    });
    // getMyKinTales lists a tale only when `sentAt > ''`.
    expect(typeof report['sentAt']).toBe('string');
    expect((report['sentAt'] as string) > '').toBe(true);

    expect(docs['generated_drafts/d1']).toMatchObject({
      status: DRAFT_STATUS_PUBLISHED,
      publishedReportId: res.reportId,
      generatedCopy: 'Edited: Biscuit had a great walk.',
      approvedBy: 'admin1',
    });
    const audit = auditMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(audit.find((a) => a['event'] === 'KINTALE_DRAFT_PUBLISHED')).toBeDefined();
  });

  it('#1747: the published entry says what happened in words, the ids stay in the payload', async () => {
    db({ 'generated_drafts/d1': { ...MIGRATED_DRAFT }, 'kinfolk/kf-robyn': { firstName: 'Robyn', lastName: 'Hale' } });
    const res = await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'Biscuit had a great walk.' }));
    const audit = auditMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const entry = audit.find((a) => a['event'] === 'KINTALE_DRAFT_PUBLISHED');
    expect(entry?.['description']).toBe('Sent a KinTale draft');
    expect(entry?.['payload']).toMatchObject({ draftId: 'd1', reportId: res.reportId });
  });

  it('reads the snake_case spelling generate.js writes, title included', async () => {
    const { ctx } = db({
      'generated_drafts/d2': { ...GENERATE_JS_DRAFT },
      'kinfolk/kf-olivia': { firstName: 'Olivia' },
    });

    const res = await publishGeneratedDraftHandler(admin({ draftId: 'd2', bodyCopy: 'Mochi napped in the sun.' }));

    const report = reportWrites(ctx)[0]!.data as Record<string, unknown>;
    expect(res.alreadyPublished).toBe(false);
    expect(report['kinfolkId']).toBe('kf-olivia');
    expect(report['title']).toBe('A sunny nap');
    expect(report['titleGeneratedByAi']).toBe(true);
  });

  it('a typed headline wins over the generated one and is not labelled as the machine\'s', async () => {
    const { ctx } = db({
      'generated_drafts/d2': { ...GENERATE_JS_DRAFT },
      'kinfolk/kf-olivia': { firstName: 'Olivia' },
    });
    await publishGeneratedDraftHandler(admin({ draftId: 'd2', bodyCopy: 'x', title: 'Nap report' }));
    const report = reportWrites(ctx)[0]!.data as Record<string, unknown>;
    expect(report['title']).toBe('Nap report');
    expect(report['titleGeneratedByAi']).toBe(false);
  });

  it('a second call for the same draft returns the first report and writes nothing new', async () => {
    const { ctx } = db({
      'generated_drafts/d1': { ...MIGRATED_DRAFT },
      'kinfolk/kf-robyn': { firstName: 'Robyn' },
    });
    const first = await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'one' }));
    auditMock.mockClear();
    const second = await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'two' }));

    expect(second).toEqual({ ok: true, reportId: first.reportId, alreadyPublished: true });
    expect(reportWrites(ctx)).toHaveLength(1);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('publishes a draft that an earlier approve left at `approved` (it reached nobody)', async () => {
    const { ctx } = db({
      'generated_drafts/d1': { ...MIGRATED_DRAFT, status: 'approved' },
      'kinfolk/kf-robyn': { firstName: 'Robyn' },
    });
    const res = await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'x' }));
    expect(res.alreadyPublished).toBe(false);
    expect(reportWrites(ctx)).toHaveLength(1);
  });

  it('refuses a draft with no household', async () => {
    const { ctx } = db({ 'generated_drafts/d3': { ...MIGRATED_DRAFT, kinfolkId: '' } });
    await expect(publishGeneratedDraftHandler(admin({ draftId: 'd3', bodyCopy: 'x' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(reportWrites(ctx)).toHaveLength(0);
  });

  it('refuses a draft whose household no longer exists', async () => {
    const { ctx } = db({ 'generated_drafts/d1': { ...MIGRATED_DRAFT }, 'kinfolk/kf-robyn': null });
    await expect(publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'x' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(reportWrites(ctx)).toHaveLength(0);
  });

  it('refuses an empty body', async () => {
    db({ 'generated_drafts/d1': { ...MIGRATED_DRAFT }, 'kinfolk/kf-robyn': { firstName: 'Robyn' } });
    await expect(publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: '   ' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('a missing draft is not-found', async () => {
    db({ 'generated_drafts/gone': null });
    await expect(publishGeneratedDraftHandler(admin({ draftId: 'gone', bodyCopy: 'x' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a namespaced list-row id: the client must send the bare doc id', async () => {
    db({});
    await expect(
      publishGeneratedDraftHandler(admin({ draftId: 'generated_drafts/d1', bodyCopy: 'x' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('refuses an unauthenticated caller', async () => {
    db({});
    await expect(publishGeneratedDraftHandler(callableRequest({ draftId: 'd1', bodyCopy: 'x' }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('the report it writes is one onKinTaleCreate announces to the household', async () => {
    const { ctx } = db({
      'generated_drafts/d1': { ...MIGRATED_DRAFT },
      'kinfolk/kf-robyn': { firstName: 'Robyn' },
    });
    const res = await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'x' }));
    const report = reportWrites(ctx)[0]!.data as Record<string, unknown>;
    mocks.dbFn.mockReturnValue(buildDbMock({}).db);
    await onKinTaleCreateHandler({ params: { reportId: res.reportId }, data: { data: () => report } });
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'kintale.published',
        recipientUid: 'uid_robyn',
        data: expect.objectContaining({ kinfolkId: 'kf-robyn', taleId: res.reportId }),
      }),
    );
  });
});

describe('deleteGeneratedDraft', () => {
  it('deletes an unsent draft and audits it', async () => {
    const { ctx, docs } = db({ 'generated_drafts/d1': { ...MIGRATED_DRAFT } });
    const res = await deleteGeneratedDraftHandler(admin({ draftId: 'd1' }));
    expect(res).toEqual({ ok: true, draftId: 'd1' });
    expect(ctx.deletes).toContain('generated_drafts/d1');
    expect(docs['generated_drafts/d1']).toBeUndefined();
    const audit = auditMock.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(audit.find((a) => a['event'] === 'KINTALE_DRAFT_DELETED')).toMatchObject({
      severity: 'warn',
      targetCollection: 'generated_drafts',
      // #1747: words, never the `generated_drafts/<id>` path.
      description: 'Deleted a KinTale draft',
      payload: { draftId: 'd1' },
    });
  });

  it('keeps a draft that has already been sent as a KinTale', async () => {
    const { ctx } = db({ 'generated_drafts/d1': { ...MIGRATED_DRAFT, publishedReportId: 'r9' } });
    await expect(deleteGeneratedDraftHandler(admin({ draftId: 'd1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(ctx.deletes).toHaveLength(0);
  });

  it('a missing draft is not-found', async () => {
    db({ 'generated_drafts/gone': null });
    await expect(deleteGeneratedDraftHandler(admin({ draftId: 'gone' }))).rejects.toMatchObject({ code: 'not-found' });
  });
});
