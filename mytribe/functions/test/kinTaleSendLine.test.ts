import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #1821: sending a KinTale from the visit composer left no Activity Log line.
 * The send (`sendKinTaleReport`, the one send path of web, Android and the
 * desktop console since #2058) now stages the line in its own transaction:
 * one line per real send, none for a replay, none when the send is refused.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));

import { sendKinTaleReportHandler, SENT_KINTALE_WORDS } from '../src/admin/kinTaleDrafts';
import { CHAIN_HEAD_COLLECTION, CHAIN_HEAD_DOC_ID } from '../src/lib/writeAuditEntry';
import { isServerOnlyAuditEvent } from '../src/lib/auditEvents';
import { AUNTIE_LOGGABLE_EVENTS } from '../src/admin/logActivity';

const owner = (data: unknown) => callableRequest(data, { uid: 'owner1', token: { admin: true } });
const auntie = (data: unknown) => callableRequest(data, { uid: 'auntie1', token: { staffRole: 'auntie' } });
const kinfolk = (data: unknown) => callableRequest(data, { uid: 'kf-user', token: {} });

const HEAD = `${CHAIN_HEAD_COLLECTION}/${CHAIN_HEAD_DOC_ID}`;

function world(report: Record<string, unknown> | null = {}, session: Record<string, unknown> | null = {}) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'kin_care_reports/r1':
      report === null
        ? null
        : {
            kinfolkId: 'kf-t1',
            sessionId: 'sess-1',
            templateId: '',
            status: 'DRAFT',
            title: 'Park day',
            bodyCopy: 'Biscuit had a great walk.',
            ...report,
          },
    'kin_care_sessions/sess-1': session === null ? null : { kinfolkId: 'kf-t1', sentReportCount: 0, ...session },
    [HEAD]: { seq: 41, lastHash: 'a'.repeat(64), lastEntryId: 'prev' },
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs };
}

/** The activity_log docs this run wrote. */
function lines(docs: Record<string, Record<string, unknown> | null>) {
  return Object.entries(docs)
    .filter(([p, d]) => p.startsWith('activity_log/') && d !== null)
    .map(([, d]) => d!);
}

beforeEach(() => mocks.dbFn.mockReset());

describe('#1821 a sent KinTale leaves one Activity Log line', () => {
  it('writes the line in words with the send, sealed onto the chain', async () => {
    const { docs } = world();
    const res = await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(res.alreadySent).toBe(false);
    const written = lines(docs);
    expect(written).toHaveLength(1);
    const line = written[0]!;
    expect(line['actionType']).toBe('CONTENT_KINTALE_SENT');
    expect(line['description']).toBe(SENT_KINTALE_WORDS);
    expect(line['description']).toBe('Sent a KinTale');
    expect(line['status']).toBe('SUCCESS');
    expect(line['actorId']).toBe('owner1');
    expect(line['actorRole']).toBe('AUNTIE');
    expect(line['familyId']).toBe('kf-t1');
    expect(line['targetId']).toBe('r1');
    expect(line['targetCollection']).toBe('kin_care_reports');
    expect(line['payload']).toEqual({ reportId: 'r1', visitId: 'sess-1', admin: true, staffRole: null });
    expect(line['seq']).toBe(42);
    expect(line['prevHash']).toBe('a'.repeat(64));
    expect(docs[HEAD]!['seq']).toBe(42);
  });

  it('carries none of the tale: no title, no text, no ids in the sentence', async () => {
    const { docs } = world();
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    const flat = JSON.stringify(lines(docs)[0]);
    expect(flat).not.toContain('Park day');
    expect(flat).not.toContain('Biscuit');
    expect(lines(docs)[0]!['description']).not.toMatch(/r1|sess-1|kf-t1/);
  });

  it("names an Auntie's send as hers", async () => {
    const { docs } = world();
    await sendKinTaleReportHandler(auntie({ reportId: 'r1' }));
    const line = lines(docs)[0]!;
    expect(line['actorId']).toBe('auntie1');
    expect(line['payload']).toMatchObject({ admin: false, staffRole: 'auntie' });
  });

  it('writes no second line for a tale already sent', async () => {
    const { docs } = world({ status: 'SENT', sentAt: '2026-11-10T22:34:00.000Z' });
    const res = await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(res.alreadySent).toBe(true);
    expect(lines(docs)).toHaveLength(0);
    expect(docs[HEAD]!['seq']).toBe(41);
  });

  it('a double tap leaves one line', async () => {
    const { docs } = world();
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(lines(docs)).toHaveLength(1);
  });

  it('writes no line when the tale is gone', async () => {
    const { docs } = world(null);
    await expect(sendKinTaleReportHandler(owner({ reportId: 'r1' }))).rejects.toMatchObject({ code: 'not-found' });
    expect(lines(docs)).toHaveLength(0);
  });

  it('writes no line when the visit is gone', async () => {
    const { docs } = world({}, null);
    await expect(sendKinTaleReportHandler(owner({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(lines(docs)).toHaveLength(0);
  });

  it('writes no line for a caller who may not send', async () => {
    const { docs } = world();
    await expect(sendKinTaleReportHandler(kinfolk({ reportId: 'r1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(lines(docs)).toHaveLength(0);
  });

  it('a failed send transaction leaves neither the send nor a line', async () => {
    const { ctx, docs } = world();
    const real = ctx.db.runTransaction;
    (ctx.db as { runTransaction: unknown }).runTransaction = vi.fn(async () => {
      throw new Error('chain head contention');
    });
    await expect(sendKinTaleReportHandler(owner({ reportId: 'r1' }))).rejects.toThrow('chain head contention');
    expect(docs['kin_care_reports/r1']!['status']).toBe('DRAFT');
    expect(lines(docs)).toHaveLength(0);
    (ctx.db as { runTransaction: unknown }).runTransaction = real;
  });

  it('is the server\'s line: no client may write it through logActivity', () => {
    expect(isServerOnlyAuditEvent('CONTENT_KINTALE_SENT')).toBe(true);
    expect(AUNTIE_LOGGABLE_EVENTS.has('CONTENT_KINTALE_SENT')).toBe(false);
  });
});
