import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  writeAuditEntryFn: vi.fn(),
  batchRetrieveFn: vi.fn(),
  batchResultsFn: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: mocks.writeAuditEntryFn }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { batches: { retrieve: mocks.batchRetrieveFn, results: mocks.batchResultsFn } },
  })),
}));

import { runAiBatchPoll, normalizeTitle, MAX_TITLE_CHARS } from '../src/scheduled/aiBatchPollCron';
import { resetAnthropicClientForTest } from '../src/lib/aiCopy';

/** Async-iterable over canned batch results, like batches.results() returns. */
function resultsIter(items: unknown[]) {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

function succeeded(customId: string, text: string) {
  return {
    custom_id: customId,
    result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } },
  };
}

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.writeAuditEntryFn.mockReset().mockResolvedValue('audit-id');
  mocks.batchRetrieveFn.mockReset();
  mocks.batchResultsFn.mockReset();
  resetAnthropicClientForTest();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('aiBatchPollCron (O-8 batch apply)', () => {
  it('HAPPY: applies titles to still-untitled tales and closes the batch doc', async () => {
    const ctx = buildDbMock({
      queryDocs: { ai_batches: [{ id: 'msgbatch_1', data: { type: 'tale_titles', status: 'processing' } }] },
      docs: {
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'walk day', sentAt: '2026-07-10T12:00:00Z' },
        // Auntie hand-titled this one while the batch ran — the human wins.
        'kin_care_reports/t2': { kinfolkId: 'f1', bodyCopy: 'nap day', title: 'Nap champion', sentAt: '2026-07-09T12:00:00Z' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.batchRetrieveFn.mockResolvedValue({ id: 'msgbatch_1', processing_status: 'ended' });
    mocks.batchResultsFn.mockResolvedValue(
      resultsIter([
        succeeded('t1', 'A Long Park Walk'),
        succeeded('t2', 'Sleepy Afternoon'),
        { custom_id: 't3', result: { type: 'errored', error: { type: 'api_error' } } },
      ]),
    );

    await runAiBatchPoll();

    const t1 = ctx.writes.find((w) => w.path === 'kin_care_reports/t1');
    expect(t1?.data).toMatchObject({ title: 'A Long Park Walk', titleGeneratedByAi: true });
    // t2 untouched (already titled), t3 errored.
    expect(ctx.writes.find((w) => w.path === 'kin_care_reports/t2')).toBeUndefined();
    const done = ctx.writes.find((w) => w.path === 'ai_batches/msgbatch_1');
    expect(done?.data).toMatchObject({
      status: 'done',
      counts: { applied: 1, skippedTitled: 1, skippedMissing: 0, errored: 1 },
    });
    expect(mocks.writeAuditEntryFn).toHaveBeenCalled();
  });

  it('SAD: batch still in progress -> nothing written', async () => {
    const ctx = buildDbMock({
      queryDocs: { ai_batches: [{ id: 'msgbatch_1', data: { status: 'processing' } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.batchRetrieveFn.mockResolvedValue({ id: 'msgbatch_1', processing_status: 'in_progress' });

    await runAiBatchPoll();

    expect(mocks.batchResultsFn).not.toHaveBeenCalled();
    expect(ctx.writes).toHaveLength(0);
  });

  it('SAD: no processing batches -> no Anthropic calls at all', async () => {
    const ctx = buildDbMock({ queryDocs: { ai_batches: [] } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await runAiBatchPoll();
    expect(mocks.batchRetrieveFn).not.toHaveBeenCalled();
  });

  it('ERROR: one broken batch never wedges the run — the next batch still processes', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        ai_batches: [
          { id: 'msgbatch_bad', data: { status: 'processing', createdAtMs: Date.now() } },
          { id: 'msgbatch_good', data: { status: 'processing', createdAtMs: Date.now() } },
        ],
      },
      docs: {
        'kin_care_reports/t1': { kinfolkId: 'f1', bodyCopy: 'walk day', sentAt: '2026-07-10T12:00:00Z' },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.batchRetrieveFn.mockImplementation(async (id: string) => {
      if (id === 'msgbatch_bad') throw new Error('api 500');
      return { id, processing_status: 'ended' };
    });
    mocks.batchResultsFn.mockResolvedValue(resultsIter([succeeded('t1', 'A Long Park Walk')]));

    await runAiBatchPoll();

    // Bad batch: fresh, so left processing (no stale write). Good batch: applied + closed.
    expect(ctx.writes.find((w) => w.path === 'ai_batches/msgbatch_bad')).toBeUndefined();
    expect(ctx.writes.find((w) => w.path === 'kin_care_reports/t1')?.data).toMatchObject({
      title: 'A Long Park Walk',
    });
    expect(ctx.writes.find((w) => w.path === 'ai_batches/msgbatch_good')?.data).toMatchObject({ status: 'done' });
  });

  it('ERROR: a wedged batch past the stale window is marked stale and stops repolling', async () => {
    const ctx = buildDbMock({
      queryDocs: {
        ai_batches: [
          { id: 'msgbatch_old', data: { status: 'processing', createdAtMs: Date.now() - 27 * 60 * 60 * 1000 } },
        ],
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    // Still not ended a full day past the 24h Anthropic expiry.
    mocks.batchRetrieveFn.mockResolvedValue({ id: 'msgbatch_old', processing_status: 'in_progress' });

    await runAiBatchPoll();

    expect(ctx.writes.find((w) => w.path === 'ai_batches/msgbatch_old')?.data).toMatchObject({ status: 'stale' });
  });

  it('ERROR: a result for a deleted tale counts skippedMissing, batch still closes', async () => {
    const ctx = buildDbMock({
      queryDocs: { ai_batches: [{ id: 'msgbatch_1', data: { status: 'processing' } }] },
      docs: {},
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.batchRetrieveFn.mockResolvedValue({ id: 'msgbatch_1', processing_status: 'ended' });
    mocks.batchResultsFn.mockResolvedValue(resultsIter([succeeded('gone', 'Orphan Title')]));

    await runAiBatchPoll();

    const done = ctx.writes.find((w) => w.path === 'ai_batches/msgbatch_1');
    expect(done?.data).toMatchObject({ status: 'done', counts: { applied: 0, skippedMissing: 1 } });
  });
});

describe('normalizeTitle', () => {
  it('strips markup, quotes, trailing punctuation and collapses whitespace', () => {
    expect(normalizeTitle('<b>"A  Long\n Park Walk."</b>')).toBe('A Long Park Walk');
  });
  it('hard-caps runaway titles', () => {
    expect(normalizeTitle('word '.repeat(60)).length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
  });
  it('returns empty for markup-only output', () => {
    expect(normalizeTitle('<p></p>')).toBe('');
  });
});
