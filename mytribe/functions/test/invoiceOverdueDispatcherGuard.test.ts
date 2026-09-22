import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #871: EXACTLY ONE OVERDUE NOTICE PER INVOICE, over the REAL dispatcher and
 * its dedupe ledger (one write-through mock, so each run sees what the last
 * one wrote). The per-state table is invoiceOverdueSenders.test.ts.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));

import { processOverdueInvoice } from '../src/scheduled/invoiceRemindersCron';
import { onInvoicesWriteHandler } from '../src/triggers/onInvoicesWrite';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);
const TODAY = '2026-09-14';
const DAY = 24 * 60 * 60 * 1000;
const OPEN = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40, dueDate: '2026-09-01' };

function overdueNotices(writes: Array<{ path: string; data: Record<string, unknown> }>) {
  return writes.filter(
    (w) =>
      (w.path.startsWith('scheduledNotifications/') || w.path.startsWith('notifications/')) &&
      w.data.key === 'invoice.overdue',
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function run(ctx: ReturnType<typeof buildDbMock>, at: number, today: string): Promise<boolean> {
  vi.setSystemTime(at);
  const snap = await ctx.db.collection('invoices').doc('inv1').get();
  return processOverdueInvoice(snap as never, at, today);
}

describe('#871 exactly one overdue notice, over the real dispatcher', () => {
  it('a second run the same day, and daily runs after it, send nothing more', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { ...OPEN } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    expect(await run(ctx, NOW, TODAY)).toBe(true);
    expect(await run(ctx, NOW + 60_000, TODAY)).toBe(false);
    expect(await run(ctx, NOW + DAY, '2026-09-15')).toBe(false);
    expect(await run(ctx, NOW + 30 * DAY, '2026-10-14')).toBe(false);

    expect(overdueNotices(ctx.writes)).toHaveLength(1);
    expect((await ctx.db.collection('invoices').doc('inv1').get()).data()?.overdueNotifiedAtMs).toBe(NOW);
  });

  it('a run that delivered and lost its stamp: the rerun inside the week records the first send and sends nothing', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { ...OPEN } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    expect(await run(ctx, NOW, TODAY)).toBe(true);
    // The stamp write never landed.
    await ctx.db.collection('invoices').doc('inv1').set({ overdueNotifiedAtMs: null }, { merge: true });

    // Six days of reruns: each meets the ledger, not the household.
    expect(await run(ctx, NOW + DAY, '2026-09-15')).toBe(false);
    expect(overdueNotices(ctx.writes)).toHaveLength(1);
    expect((await ctx.db.collection('invoices').doc('inv1').get()).data()?.overdueNotifiedAtMs).toBe(NOW);

    await ctx.db.collection('invoices').doc('inv1').set({ overdueNotifiedAtMs: null }, { merge: true });
    expect(await run(ctx, NOW + 6 * DAY, '2026-09-20')).toBe(false);
    expect(overdueNotices(ctx.writes)).toHaveLength(1);
  });

  it('trigger redelivery of a past-due label writes no overdue notice, and the cron still sends its one', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { ...OPEN } } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const event = {
      params: { invoiceId: 'inv1' },
      data: { before: { data: () => OPEN }, after: { data: () => ({ ...OPEN, status: 'past_due' }) } },
    };
    await onInvoicesWriteHandler(event as never);
    await onInvoicesWriteHandler(event as never);
    expect(overdueNotices(ctx.writes)).toHaveLength(0);

    expect(await run(ctx, NOW, TODAY)).toBe(true);
    expect(await run(ctx, NOW + 60_000, TODAY)).toBe(false);
    expect(overdueNotices(ctx.writes)).toHaveLength(1);
  });

  it('a cancelled invoice never reaches the ledger at all', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/inv1': { ...OPEN, status: 'cancelled' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    expect(await run(ctx, NOW, TODAY)).toBe(false);
    expect(ctx.writes).toHaveLength(0);
  });
});
