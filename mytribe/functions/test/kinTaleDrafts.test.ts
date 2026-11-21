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

describe('publishGeneratedDraft: an Auntie sends KinTale drafts only', () => {
  const auntie = (data: unknown) =>
    callableRequest(data, { uid: 'auntie1', token: { staffRole: 'auntie', name: 'Tia' } });
  const HOUSEHOLDS = {
    'kinfolk/kf-olivia': { firstName: 'Olivia' },
    'kinfolk/kf-robyn': { firstName: 'Robyn' },
  };

  async function notThereForHer(draft: Record<string, unknown>) {
    const before = { ...draft };
    const { ctx, docs } = db({ 'generated_drafts/d1': draft, ...HOUSEHOLDS });
    await expect(publishGeneratedDraftHandler(auntie({ draftId: 'd1', bodyCopy: 'Her words' }))).rejects.toMatchObject({
      code: 'not-found',
      message: 'This draft no longer exists. It may have been deleted.',
    });
    // Nothing was sent and the draft is as it was.
    expect(ctx.writes).toEqual([]);
    expect(docs['generated_drafts/d1']).toEqual(before);
    expect(auditMock).not.toHaveBeenCalled();
  }

  it('HAPPY: an Auntie sends a KinTale draft', async () => {
    const { ctx, docs } = db({ 'generated_drafts/d1': { ...GENERATE_JS_DRAFT }, ...HOUSEHOLDS });
    const res = await publishGeneratedDraftHandler(auntie({ draftId: 'd1', bodyCopy: 'Mochi napped in the sun.' }));
    expect(res.alreadyPublished).toBe(false);
    expect(reportWrites(ctx)).toHaveLength(1);
    expect(reportWrites(ctx)[0]!.data).toMatchObject({ kinfolkId: 'kf-olivia', status: 'SENT', authorId: 'auntie1' });
    expect(docs['generated_drafts/d1']).toMatchObject({ status: DRAFT_STATUS_PUBLISHED, publishedReportId: res.reportId });
  });

  it('HAPPY: both spellings saying visit_report is still a KinTale draft', async () => {
    const { ctx } = db({
      'generated_drafts/d1': { ...GENERATE_JS_DRAFT, communicationType: 'visit_report' },
      ...HOUSEHOLDS,
    });
    await publishGeneratedDraftHandler(auntie({ draftId: 'd1', bodyCopy: 'x' }));
    expect(reportWrites(ctx)).toHaveLength(1);
  });

  it.each([
    ['a Push draft', 'push'],
    ['an Email draft', 'email'],
    ['a Text draft', 'sms'],
  ])('NEGATIVE: %s is not there for an Auntie', async (_label, type) => {
    await notThereForHer({ ...GENERATE_JS_DRAFT, communication_type: type });
  });

  it('NEGATIVE: a draft whose type is not exactly visit_report is not there for an Auntie', async () => {
    for (const type of ['Visit_Report', ' visit_report', 'visit_report ', 'visit_report\u00a0', 7, null]) {
      auditMock.mockClear();
      await notThereForHer({ ...GENERATE_JS_DRAFT, communication_type: type });
    }
  });

  it('NEGATIVE: a draft whose two type fields disagree is not there for an Auntie', async () => {
    await notThereForHer({ ...GENERATE_JS_DRAFT, communicationType: 'push' });
    await notThereForHer({ ...GENERATE_JS_DRAFT, communicationType: '' });
  });

  it('NEGATIVE: a draft with no type is not there for an Auntie', async () => {
    const { communication_type: _dropped, ...untyped } = GENERATE_JS_DRAFT;
    await notThereForHer(untyped);
  });

  it('NEGATIVE: a draft carrying only the older spelling is not there for an Auntie', async () => {
    await notThereForHer({ ...MIGRATED_DRAFT });
  });

  it('NEGATIVE: a sent draft of another type does not answer her with its KinTale', async () => {
    await notThereForHer({ ...GENERATE_JS_DRAFT, communication_type: 'email', publishedReportId: 'r9' });
  });

  it('NEGATIVE: an account carrying both roles is held to KinTale drafts too', async () => {
    const { ctx } = db({ 'generated_drafts/d1': { ...GENERATE_JS_DRAFT, communication_type: 'push' }, ...HOUSEHOLDS });
    const both = callableRequest(
      { draftId: 'd1', bodyCopy: 'x' },
      { uid: 'confused1', token: { admin: true, staffRole: 'auntie' } },
    );
    await expect(publishGeneratedDraftHandler(both)).rejects.toMatchObject({ code: 'not-found' });
    expect(ctx.writes).toEqual([]);
  });

  it('the owner still sends a draft of any type, and one with only the older spelling', async () => {
    const typed = db({ 'generated_drafts/d1': { ...GENERATE_JS_DRAFT, communication_type: 'general' }, ...HOUSEHOLDS });
    await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'x' }));
    expect(reportWrites(typed.ctx)).toHaveLength(1);

    const older = db({ 'generated_drafts/d1': { ...MIGRATED_DRAFT }, ...HOUSEHOLDS });
    await publishGeneratedDraftHandler(admin({ draftId: 'd1', bodyCopy: 'x' }));
    expect(reportWrites(older.ctx)).toHaveLength(1);
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
