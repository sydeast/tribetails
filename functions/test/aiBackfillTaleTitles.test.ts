import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
  batchCreateFn: vi.fn(),
  isStaffFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('../src/lib/staffGate', () => ({ isStaff: mocks.isStaffFn }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { batches: { create: mocks.batchCreateFn } },
  })),
}));

import { aiBackfillTaleTitlesHandler } from '../src/admin/aiBackfillTaleTitles';
import { resetAnthropicClientForTest } from '../src/lib/aiCopy';

function req(data: unknown, uid = 'staff1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any },
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * kin_care_reports fixture shapes mirror the REAL AuntieOS writer fields:
 * `bodyCopy` (not `body`), `title` (may be missing or ''), `sentAt` ISO string.
 * The mock's .where() is a pass-through, so queryDocs is pre-filtered to what
 * the sentAt>'' query would return.
 */
function taleDb() {
  return buildDbMock({
    queryDocs: {
      kin_care_reports: [
        { id: 't-untitled', data: { kinfolkId: 'f1', bodyCopy: 'Biscuit had a long walk in the park.', sentAt: '2026-07-10T12:00:00Z' } },
        { id: 't-empty-title', data: { kinfolkId: 'f1', bodyCopy: 'Two naps and dinner at five.', title: '  ', sentAt: '2026-07-09T12:00:00Z' } },
        { id: 't-titled', data: { kinfolkId: 'f2', bodyCopy: 'Bath day!', title: 'Bath day for Milo', sentAt: '2026-07-08T12:00:00Z' } },
        { id: 't-no-body', data: { kinfolkId: 'f2', sentAt: '2026-07-07T12:00:00Z' } },
      ],
    },
  });
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-id');
  mocks.batchCreateFn.mockReset();
  mocks.isStaffFn.mockReset().mockReturnValue(true);
  resetAnthropicClientForTest();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('aiBackfillTaleTitles (O-8 batch create)', () => {
  it('HAPPY: batches only untitled tales with bodies, records ai_batches doc', async () => {
    const ctx = taleDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.batchCreateFn.mockResolvedValue({ id: 'msgbatch_1', processing_status: 'in_progress' });

    const res = await aiBackfillTaleTitlesHandler(req({}));

    expect(res).toMatchObject({ ok: true, candidates: 2, batched: 2, batchId: 'msgbatch_1' });
    const requests = mocks.batchCreateFn.mock.calls[0][0].requests;
    expect(requests.map((r: { custom_id: string }) => r.custom_id)).toEqual(['t-untitled', 't-empty-title']);
    // Batch requests carry the real tale text and a bounded max_tokens.
    expect(requests[0].params.messages[0].content).toContain('Biscuit had a long walk');
    expect(requests[0].params.max_tokens).toBe(64);
    // Batch bookkeeping doc written at ai_batches/{batchId}.
    const write = ctx.writes.find((w) => w.path === 'ai_batches/msgbatch_1');
    expect(write?.data).toMatchObject({ type: 'tale_titles', status: 'processing', requestCount: 2 });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalled();
  });

  it('HAPPY dryRun: reports candidates, creates nothing', async () => {
    const ctx = taleDb();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await aiBackfillTaleTitlesHandler(req({ dryRun: true }));
    expect(res).toMatchObject({ ok: true, candidates: 2, batched: 0, batchId: null });
    expect(mocks.batchCreateFn).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });

  it('SAD: an in-flight tale_titles batch short-circuits (no double billing)', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        kin_care_reports: [],
        ai_batches: [{ id: 'msgbatch_prev', data: { type: 'tale_titles', status: 'processing' } }],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await aiBackfillTaleTitlesHandler(req({}));
    expect(res).toMatchObject({ ok: true, batched: 0, batchId: 'msgbatch_prev', alreadyProcessing: true });
    expect(mocks.batchCreateFn).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });

  it('SAD: no candidates -> no batch, ok result', async () => {
    const ctx = buildDbMock({ queryDocs: { kin_care_reports: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await aiBackfillTaleTitlesHandler(req({}));
    expect(res).toMatchObject({ ok: true, candidates: 0, batched: 0, batchId: null });
    expect(mocks.batchCreateFn).not.toHaveBeenCalled();
  });

  it('NEGATIVE: invalid args rejected', async () => {
    mocks.dbFn.mockReturnValue(taleDb().db);
    await expect(aiBackfillTaleTitlesHandler(req({ dryRun: 'yes' }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('ERROR: Anthropic batch create failure propagates (wrapCallable maps it)', async () => {
    mocks.dbFn.mockReturnValue(taleDb().db);
    mocks.batchCreateFn.mockRejectedValue(new Error('api down'));
    await expect(aiBackfillTaleTitlesHandler(req({}))).rejects.toThrow('api down');
  });
});
