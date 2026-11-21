import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldValue } from 'firebase-admin/firestore';
import { buildDbMock } from './_helpers/mockDb';
import { callableRequest } from './_helpers/callableRequest';

/**
 * #2052: "Back to my notes" survives closing the composer, because the notes
 * the Auntie typed are kept on the draft itself when she takes a draft Ask
 * Auntie wrote. Those notes are hers and the office's. These tests hold the two
 * promises that go with keeping them: the send removes them, and nothing the
 * household reads ever carries them, even on a tale an older build sent without
 * going through the send that removes them.
 */

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));

import { sendKinTaleReportHandler, KEPT_NOTES_FIELDS } from '../src/admin/kinTaleDrafts';
import { getMyKinTalesHandler } from '../src/portal/getMyKinTales';

beforeEach(() => mocks.dbFn.mockReset());

const owner = (data: unknown) => callableRequest(data, { uid: 'owner1', token: { admin: true } });
const auntie = (data: unknown) => callableRequest(data, { uid: 'auntie1', token: { staffRole: 'auntie' } });
const kinfolk = (data: unknown) => callableRequest(data, { uid: 'kf-user', token: {} });

const NOTES = 'biscuit limped a bit on the left, did not tell the household yet';
const TAKEN = 'Biscuit and I had a slow, sweet walk today.';

const DRAFT = {
  kinfolkId: 'kf-t1',
  sessionId: 'sess-1',
  templateId: '',
  status: 'DRAFT',
  sentAt: '',
  sentVia: '',
  bodyCopy: TAKEN,
  title: 'Slow walk',
  fieldResponses: {},
  keptNotes: NOTES,
  keptNotesDraft: TAKEN,
};

function world(report: Record<string, unknown> = DRAFT) {
  const docs: Record<string, Record<string, unknown> | null> = {
    'kin_care_reports/r1': { ...report },
    'kin_care_sessions/sess-1': { kinfolkId: 'kf-t1', sentReportCount: 0 },
    'clients/kf-user': { kinfolkIds: ['kf-t1'] },
  };
  const ctx = buildDbMock({ docs, writeThrough: true });
  mocks.dbFn.mockReturnValue(ctx.db);
  return { ctx, docs };
}

describe('#2052 the notes kept for "Back to my notes"', () => {
  it('are the two fields every admin composer writes', () => {
    expect([...KEPT_NOTES_FIELDS]).toEqual(['keptNotes', 'keptNotesDraft']);
  });

  it('are removed in the write that sends the tale, whoever sends it', async () => {
    for (const caller of [owner, auntie]) {
      const { ctx } = world();
      await sendKinTaleReportHandler(caller({ reportId: 'r1' }));
      const write = ctx.writes.find((w) => w.path === 'kin_care_reports/r1')!;
      expect(write.data['status']).toBe('SENT');
      for (const field of KEPT_NOTES_FIELDS) {
        expect(field in write.data).toBe(true);
        expect((write.data[field] as FieldValue).isEqual(FieldValue.delete())).toBe(true);
      }
      expect(JSON.stringify(write.data)).not.toContain('limped');
    }
  });

  it('a draft that never had them still sends', async () => {
    const { keptNotes: _a, keptNotesDraft: _b, ...plain } = DRAFT;
    const { docs } = world(plain);
    const res = await sendKinTaleReportHandler(owner({ reportId: 'r1' }));
    expect(res).toEqual({ ok: true, reportId: 'r1', alreadySent: false });
    expect(docs['kin_care_reports/r1']!['status']).toBe('SENT');
  });

  it('never reach the household, even on a sent tale that still carries them', async () => {
    const sent = { ...DRAFT, status: 'SENT', sentAt: '2026-11-14T10:00:00.000Z', sentVia: 'pending' };
    const docs: Record<string, Record<string, unknown> | null> = {
      'kin_care_reports/r1': sent,
      'kin_care_sessions/sess-1': { kinfolkId: 'kf-t1' },
      'clients/kf-user': { kinfolkIds: ['kf-t1'] },
    };
    const ctx = buildDbMock({ docs, queryDocs: { kin_care_reports: [{ id: 'r1', data: sent }] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await getMyKinTalesHandler(kinfolk({ kinfolkId: 'kf-t1' }) as never);
    expect(res.tales).toHaveLength(1);
    expect(res.tales[0]!.body).toBe(TAKEN);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain('limped');
    expect(wire).not.toContain('keptNotes');
  });
});
