import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #2058: deleting a KinTale template for good took "Care tasks done this visit"
 * off every sent tale written from it, because every reader looked the labels
 * up in the template at read time. Operator ruling 2026-11-12: STAMP AT SEND. A
 * sent tale keeps its own copy, and template edits and deletes never reach it.
 *
 * The first suite is the walk's own steps on the server: send a tale with two
 * ticks, delete the template, read the household feed.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));

import { sendKinTaleReportHandler, publishGeneratedDraftHandler } from '../src/admin/kinTaleDrafts';
import { getMyKinTalesHandler } from '../src/portal/getMyKinTales';
import {
  buildCareTaskStamp,
  plannedStamp,
  readCareTaskStamp,
  syncCareTaskStamp,
  CARE_TASKS_FIELD,
  type CareTaskStamp,
} from '../src/lib/careTaskStamp';

beforeEach(() => mocks.dbFn.mockReset());

const owner = (data: unknown) => callableRequest(data, { uid: 'owner1', token: { admin: true } });
const auntie = (data: unknown) => callableRequest(data, { uid: 'auntie1', token: { staffRole: 'auntie' } });
const testAdmin = (data: unknown, tribe: string) =>
  callableRequest(data, { uid: 'tester1', token: { testTribeId: tribe } });
const kinfolk = (data: unknown) => callableRequest(data, { uid: 'kf-user', token: {} });

const TEMPLATE = {
  name: 'Dog Walk',
  checklistEnabled: true,
  checklistItems: [
    { key: 'moment_walk', text: 'Long walk in the park', scope: 'PER_PET', order: 0 },
    { key: 'moment_treat', text: 'Treat after the walk', scope: 'PER_PET', order: 1 },
    { key: 'moment_mail', text: 'Brought the mail in', scope: 'PER_VISIT', order: 2 },
  ],
};

function tick(fieldKey: string, kinId: string, extra: Record<string, unknown> = {}) {
  return {
    [kinId === '' ? fieldKey : `${kinId}|${fieldKey}`]: {
      fieldKey,
      kinId,
      sectionKey: '',
      boolValue: true,
      intValue: null,
      stringValue: '',
      mediaIds: [],
      ...extra,
    },
  };
}

const DRAFT = {
  kinfolkId: 'kf-t1',
  sessionId: 'sess-1',
  templateId: 'tpl-walk',
  status: 'DRAFT',
  sentAt: '',
  sentVia: '',
  bodyCopy: 'Biscuit had a great walk.',
  title: 'Park day',
  fieldResponses: { ...tick('moment_walk', 'kin-biscuit'), ...tick('moment_mail', '') },
};

function world(extra: Record<string, Record<string, unknown> | null> = {}) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'kin_care_reports/r1': { ...DRAFT },
    'kin_care_sessions/sess-1': { kinfolkId: 'kf-t1', sentReportCount: 0 },
    'kintale_templates/tpl-walk': { ...TEMPLATE },
    'clients/kf-user': { kinfolkIds: ['kf-t1'] },
    ...extra,
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs };
}

/** The household feed as the walk read it: the sent tales from `docs`. */
async function feed(docs: Record<string, Record<string, unknown> | null>) {
  const rows = Object.entries(docs)
    .filter(([p, d]) => p.startsWith('kin_care_reports/') && d !== null)
    .map(([p, d]) => ({ id: p.split('/')[1]!, data: d! }));
  const ctx = buildDbMock({ docs, queryDocs: { kin_care_reports: rows } });
  mocks.dbFn.mockReturnValue(ctx.db);
  const res = await getMyKinTalesHandler(kinfolk({ kinfolkId: 'kf-t1' }) as never);
  return res.tales;
}

describe('#2058 send, then delete the template for good, then the household reads the tale', () => {
  it('keeps "care tasks done this visit" on the sent tale', async () => {
    const { docs } = world();
    const res = await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(res).toEqual({ ok: true, reportId: 'r1', alreadySent: false });

    // The operator archives the template, then deletes it for good.
    delete docs['kintale_templates/tpl-walk'];

    const tales = await feed(docs);
    expect(tales).toHaveLength(1);
    expect(tales[0]!.checklist).toEqual([
      { key: 'moment_walk', text: 'Long walk in the park' },
      { key: 'moment_mail', text: 'Brought the mail in' },
    ]);
  });

  it('keeps the labels it was sent with when the template is edited afterwards', async () => {
    const { docs } = world();
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    docs['kintale_templates/tpl-walk'] = {
      ...TEMPLATE,
      checklistItems: [{ key: 'moment_walk', text: 'Renamed later', scope: 'PER_PET', order: 0 }],
    };
    const tales = await feed(docs);
    expect(tales[0]!.checklist).toEqual([
      { key: 'moment_walk', text: 'Long walk in the park' },
      { key: 'moment_mail', text: 'Brought the mail in' },
    ]);
  });

  it('an unstamped tale sent before #2058 still reads its template (until the backfill runs)', async () => {
    const legacy = { ...DRAFT, status: 'SENT', sentAt: '2026-11-01T10:00:00.000Z' };
    const tales = await feed({
      'kin_care_reports/old': legacy,
      'kintale_templates/tpl-walk': { ...TEMPLATE },
      'clients/kf-user': { kinfolkIds: ['kf-t1'] },
    });
    expect(tales[0]!.checklist).toEqual([
      { key: 'moment_walk', text: 'Long walk in the park' },
      { key: 'moment_mail', text: 'Brought the mail in' },
    ]);
  });

  it('a stamped tale never reads its template at all', async () => {
    const stamp = buildCareTaskStamp({
      templateId: 'tpl-walk',
      template: TEMPLATE,
      fieldResponses: DRAFT.fieldResponses,
      now: '2026-11-12T10:00:00.000Z',
      by: 'send',
    });
    const docs = {
      'kin_care_reports/r1': { ...DRAFT, status: 'SENT', sentAt: '2026-11-12T10:00:00.000Z', careTasks: stamp },
      'kintale_templates/tpl-walk': { ...TEMPLATE },
      'clients/kf-user': { kinfolkIds: ['kf-t1'] },
    };
    const rows = [{ id: 'r1', data: docs['kin_care_reports/r1'] }];
    const ctx = buildDbMock({ docs, queryDocs: { kin_care_reports: rows } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await getMyKinTalesHandler(kinfolk({ kinfolkId: 'kf-t1' }) as never);
    const templateReads = (ctx.db.getAll as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .filter((ref: { path: string }) => ref.path.startsWith('kintale_templates/'));
    expect(templateReads).toEqual([]);
  });
});

describe('sendKinTaleReport', () => {
  it('marks the tale SENT, stamps the copy and records the send on the visit in one transaction', async () => {
    const { ctx, docs } = world();
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
    const report = docs['kin_care_reports/r1']!;
    expect(report['status']).toBe('SENT');
    expect(typeof report['sentAt']).toBe('string');
    expect((report['sentAt'] as string).length).toBeGreaterThan(0);
    expect(report['sentVia']).toBe('pending');
    expect(report['deliveryReceiptId']).toBe('');
    const stamp = readCareTaskStamp(report[CARE_TASKS_FIELD])!;
    expect(stamp.source).toBe('template');
    expect(stamp.templateId).toBe('tpl-walk');
    expect(stamp.templateName).toBe('Dog Walk');
    expect(stamp.items.map((i) => i.key)).toEqual(['moment_walk', 'moment_treat', 'moment_mail']);
    expect(stamp.done).toEqual([
      { key: 'moment_walk', kinId: 'kin-biscuit', text: 'Long walk in the park', note: '' },
      { key: 'moment_mail', kinId: '', text: 'Brought the mail in', note: '' },
    ]);
    // The same write that sent it carries the copy.
    const reportWrite = ctx.writes.find((w) => w.path === 'kin_care_reports/r1')!;
    expect(reportWrite.data['status']).toBe('SENT');
    expect(reportWrite.data[CARE_TASKS_FIELD]).toBeDefined();
    const sessionWrite = ctx.writes.find((w) => w.path === 'kin_care_sessions/sess-1')!;
    expect(sessionWrite.data['autoCompleteEligible']).toBe(true);
    expect(sessionWrite.data['kinTaleDue']).toBe(false);
    expect(sessionWrite.data['reportIds']).toBeDefined();
    expect(sessionWrite.data['sentReportCount']).toBeDefined();
  });

  it('carries sentVia catalog and the dispatch id when the client already told the household', async () => {
    const { docs } = world();
    await sendKinTaleReportHandler(auntie({ reportId: 'r1', sentVia: 'catalog', deliveryReceiptId: 'disp-9' }));
    expect(docs['kin_care_reports/r1']!['sentVia']).toBe('catalog');
    expect(docs['kin_care_reports/r1']!['deliveryReceiptId']).toBe('disp-9');
  });

  it('a second call for a sent tale writes nothing and keeps the first copy', async () => {
    const { ctx, docs } = world();
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    const firstStamp = docs['kin_care_reports/r1']![CARE_TASKS_FIELD];
    const writesAfterFirst = ctx.writes.length;
    delete docs['kintale_templates/tpl-walk'];
    const again = await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(again.alreadySent).toBe(true);
    expect(ctx.writes.length).toBe(writesAfterFirst);
    expect(docs['kin_care_reports/r1']![CARE_TASKS_FIELD]).toEqual(firstStamp);
  });

  it('stamps the built-in Standard Visit list for a blank templateId', async () => {
    const { docs } = world({
      'kin_care_reports/r1': { ...DRAFT, templateId: '', fieldResponses: tick('fed', 'kin-biscuit') },
    });
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    const stamp = readCareTaskStamp(docs['kin_care_reports/r1']![CARE_TASKS_FIELD])!;
    expect(stamp.source).toBe('builtIn');
    expect(stamp.done).toEqual([{ key: 'fed', kinId: 'kin-biscuit', text: 'Fed', note: '' }]);
  });

  it('labels a desktop built-in tick the feed used to drop', async () => {
    const { docs } = world({
      'kin_care_reports/r1': { ...DRAFT, templateId: '', fieldResponses: tick('plants', '') },
    });
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    const stamp = readCareTaskStamp(docs['kin_care_reports/r1']![CARE_TASKS_FIELD])!;
    expect(stamp.done).toEqual([{ key: 'plants', kinId: '', text: 'Plants watered', note: '' }]);
  });

  it('keeps the note typed against a task', async () => {
    const { docs } = world({
      'kin_care_reports/r1': {
        ...DRAFT,
        fieldResponses: tick('moment_treat', 'kin-biscuit', { stringValue: '  just one  ' }),
      },
    });
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    const stamp = readCareTaskStamp(docs['kin_care_reports/r1']![CARE_TASKS_FIELD])!;
    expect(stamp.done).toEqual([
      { key: 'moment_treat', kinId: 'kin-biscuit', text: 'Treat after the walk', note: 'just one' },
    ]);
  });

  it('refuses a stranger, and a kinfolk account', async () => {
    world();
    await expect(sendKinTaleReportHandler(kinfolk({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(sendKinTaleReportHandler(callableRequest({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('lets a test admin send only in her own test household', async () => {
    const { docs } = world();
    await expect(sendKinTaleReportHandler(testAdmin({ reportId: 'r1' }, 'kf-other'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(docs['kin_care_reports/r1']!['status']).toBe('DRAFT');
    await sendKinTaleReportHandler(testAdmin({ reportId: 'r1' }, 'kf-t1'));
    expect(docs['kin_care_reports/r1']!['status']).toBe('SENT');
  });

  it('refuses a missing tale, a tale with no visit, a gone visit and a bad id', async () => {
    world({ 'kin_care_reports/r2': { ...DRAFT, sessionId: '' }, 'kin_care_reports/r3': { ...DRAFT, sessionId: 'gone' } });
    await expect(sendKinTaleReportHandler(owner({ reportId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
    await expect(sendKinTaleReportHandler(owner({ reportId: 'r2' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await expect(sendKinTaleReportHandler(owner({ reportId: 'r3' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    await expect(sendKinTaleReportHandler(owner({ reportId: 'a/b' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(sendKinTaleReportHandler(owner({ reportId: 'r1', sentVia: 'sms' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('a template deleted before the send leaves an empty copy marked templateMissing, never invented labels', async () => {
    const { docs } = world({ 'kintale_templates/tpl-walk': null });
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    const stamp = readCareTaskStamp(docs['kin_care_reports/r1']![CARE_TASKS_FIELD])!;
    expect(stamp.source).toBe('templateMissing');
    expect(stamp.done).toEqual([]);
  });
});

describe('publishGeneratedDraft stamps in the write that sends', () => {
  it('the created SENT tale carries a copy', async () => {
    const ctx = buildDbMock({
      docs: {
        'generated_drafts/d1': { status: 'pending', kinfolkId: 'kf-t1', generatedCopy: 'x' },
        'kinfolk/kf-t1': { firstName: 'T', lastName: 'One' },
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await publishGeneratedDraftHandler(owner({ draftId: 'd1', bodyCopy: 'Hello' }));
    const created = ctx.writes.find((w) => w.path.startsWith('kin_care_reports/'))!;
    expect(created.data['status']).toBe('SENT');
    const stamp = readCareTaskStamp(created.data[CARE_TASKS_FIELD]);
    expect(stamp).not.toBeNull();
    expect(stamp!.done).toEqual([]);
  });
});

describe('a tick changed on a sent tale (edit after send)', () => {
  function sentWithStamp(): Record<string, unknown> {
    const stamp = buildCareTaskStamp({
      templateId: 'tpl-walk',
      template: TEMPLATE,
      fieldResponses: DRAFT.fieldResponses,
      now: '2026-11-12T10:00:00.000Z',
      by: 'send',
    });
    return { ...DRAFT, status: 'SENT', sentAt: '2026-11-12T10:00:00.000Z', careTasks: stamp };
  }

  it('relabels the copy from its own items, even with the template gone', async () => {
    const tale = sentWithStamp();
    tale['fieldResponses'] = {
      ...(tale['fieldResponses'] as Record<string, unknown>),
      ...tick('moment_treat', 'kin-biscuit'),
      'kin-biscuit|moment_walk': { fieldKey: 'moment_walk', kinId: 'kin-biscuit', boolValue: false, stringValue: '' },
    };
    const ctx = buildDbMock({ docs: { 'kin_care_reports/r1': tale }, writeThrough: true });
    const outcome = await syncCareTaskStamp(ctx.db, ctx.db.doc('kin_care_reports/r1'));
    expect(outcome).toBe('stamped');
    const stamp = readCareTaskStamp(tale[CARE_TASKS_FIELD]) as CareTaskStamp;
    const stored = readCareTaskStamp(
      (ctx.writes.find((w) => w.path === 'kin_care_reports/r1')!.data as Record<string, unknown>)[CARE_TASKS_FIELD],
    )!;
    expect(stored.stampedBy).toBe('edit');
    expect(stored.done.map((d) => d.text)).toEqual(['Treat after the walk', 'Brought the mail in']);
    expect(stored.items).toEqual(stamp.items);
  });

  it('a body edit on a sent tale leaves the copy alone', () => {
    const tale = sentWithStamp();
    tale['bodyCopy'] = 'Edited after send';
    expect(plannedStamp(tale, null, '2026-11-13T00:00:00.000Z')).toBeNull();
  });

  it('a template edit after the send does not reach the copy', () => {
    const tale = sentWithStamp();
    const renamed = { ...TEMPLATE, checklistItems: [{ key: 'moment_walk', text: 'Renamed', scope: 'PER_PET', order: 0 }] };
    expect(plannedStamp(tale, renamed, '2026-11-13T00:00:00.000Z')).toBeNull();
  });

  it('writes nothing a second time (the re-entered trigger stops)', async () => {
    const tale = sentWithStamp();
    tale['fieldResponses'] = { ...tick('moment_treat', 'kin-biscuit') };
    const ctx = buildDbMock({ docs: { 'kin_care_reports/r1': tale }, writeThrough: true });
    expect(await syncCareTaskStamp(ctx.db, ctx.db.doc('kin_care_reports/r1'))).toBe('stamped');
    expect(await syncCareTaskStamp(ctx.db, ctx.db.doc('kin_care_reports/r1'))).toBe('unchanged');
    expect(ctx.writes).toHaveLength(1);
  });
});

describe('drafts still follow the template', () => {
  it('a draft is never stamped', async () => {
    const ctx = buildDbMock({ docs: { 'kin_care_reports/r1': { ...DRAFT } }, writeThrough: true });
    expect(await syncCareTaskStamp(ctx.db, ctx.db.doc('kin_care_reports/r1'))).toBe('unchanged');
    expect(ctx.writes).toEqual([]);
  });
});

describe('backstop: a tale an installed app sent itself', () => {
  it('gets a copy from its template', async () => {
    const tale = { ...DRAFT, status: 'SENT', sentAt: '2026-11-12T10:00:00.000Z', sentVia: 'catalog' };
    const ctx = buildDbMock({
      docs: { 'kin_care_reports/r1': tale, 'kintale_templates/tpl-walk': { ...TEMPLATE } },
      writeThrough: true,
    });
    expect(await syncCareTaskStamp(ctx.db, ctx.db.doc('kin_care_reports/r1'))).toBe('stamped');
    const stamp = readCareTaskStamp(ctx.writes[0]!.data[CARE_TASKS_FIELD])!;
    expect(stamp.stampedBy).toBe('backstop');
    expect(stamp.done.map((d) => d.key)).toEqual(['moment_walk', 'moment_mail']);
  });

  it('whose template is already gone is left for the backfill report, not stamped empty', async () => {
    const tale = { ...DRAFT, status: 'SENT', sentAt: '2026-11-12T10:00:00.000Z' };
    const ctx = buildDbMock({ docs: { 'kin_care_reports/r1': tale }, writeThrough: true });
    expect(await syncCareTaskStamp(ctx.db, ctx.db.doc('kin_care_reports/r1'))).toBe('unchanged');
    expect(ctx.writes).toEqual([]);
  });
});
