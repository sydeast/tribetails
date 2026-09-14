import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #832: `resendQuote` over the REAL dispatcher, on one write-through mock.
 *
 * `createQuote` issues a quote with `invoice.new` for `invoice:<id>`, and the
 * resend uses the same key for the same invoice. Without a resend identity of
 * its own, a resend inside the dispatcher window of the issue was refused as a
 * duplicate and returned nothing, silently. These cases prove the resend sends,
 * that a retry of the same resend is deduped and refused loudly, and that the
 * next real resend sends again.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));

import { resendQuoteHandler } from '../src/admin/resendQuote';
import { enqueueNotification } from '../src/notifications/dispatcher';

const NOW = Date.UTC(2026, 8, 14, 15, 0, 0);

function req(): CallableRequest<unknown> {
  return {
    data: { invoiceId: 'q1' },
    auth: { uid: 'admin1', token: { admin: true } } as any,
    rawRequest: {} as any,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function declined(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kinfolkId: 'fam1',
    invoiceNumber: 'Q-1001',
    status: 'quote',
    invoiceStatus: 'quote',
    editScope: 'all',
    quoteDecision: 'denied',
    total: 240,
    amountDue: 240,
    ...over,
  };
}

function householdQuoteMessages(writes: Array<{ path: string; data: Record<string, unknown> }>) {
  return writes.filter(
    (w) => w.path.startsWith('notifications/') && w.data.key === 'invoice.new' && w.data.recipientUid === 'kin-uid-1',
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('resendQuote over the real dispatcher', () => {
  it('a resend one minute after the quote was issued still reaches the household', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/q1': declined() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    // What createQuote sent when it issued the quote.
    await enqueueNotification({
      key: 'invoice.new',
      recipientUid: 'kin-uid-1',
      data: { kinfolkId: 'fam1', invoiceId: 'q1', isQuote: true },
      targetType: 'invoice',
      targetId: 'q1',
    });
    vi.setSystemTime(NOW + 60_000);
    await expect(resendQuoteHandler(req())).resolves.toMatchObject({ ok: true });

    expect(householdQuoteMessages(ctx.writes)).toHaveLength(2);
    expect(householdQuoteMessages(ctx.writes)[1].data.data).toMatchObject({ resent: true });
  });

  it('a retry of a resend that already reached the household reopens the quote without a second copy', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/q1': declined() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await resendQuoteHandler(req());
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);

    // The retry: the quote reads as it did before the first attempt's
    // transaction (declined, count unchanged), i.e. that commit never landed
    // although the household was already told.
    await ctx.db.collection('invoices').doc('q1').set(declined());
    vi.setSystemTime(NOW + 20_000);
    await expect(resendQuoteHandler(req())).resolves.toMatchObject({ ok: true });
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);

    // The quote is open again, so a later press is refused by the quote's own
    // state and still sends nothing.
    vi.setSystemTime(NOW + 30_000);
    const later = await resendQuoteHandler(req()).catch((e) => e);
    expect(later.code).toBe('failed-precondition');
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);

    // The household declines the revised quote and the office resends again,
    // still inside the dispatcher window: a new resend, a new message.
    await ctx.db.collection('invoices').doc('q1').set(declined({ quoteResendCount: 1 }));
    vi.setSystemTime(NOW + 40_000);
    await expect(resendQuoteHandler(req())).resolves.toMatchObject({ ok: true });
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(2);
  });

  it('a household with no portal account: nothing sent, quote left declined, even though the office would get a copy', async () => {
    const { resolveKinfolkUid } = await import('../src/lib/resolveKinfolkUid');
    vi.mocked(resolveKinfolkUid).mockResolvedValueOnce(null);
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/q1': declined(), 'businessSettings/admins': { uids: ['admin1'] } },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await resendQuoteHandler(req()).catch((e) => e);

    expect(err.details).toMatchObject({ code: 'quote_resend_unreachable' });
    expect(ctx.writes.some((w) => w.path.startsWith('notifications/'))).toBe(false);
    expect((await ctx.db.collection('invoices').doc('q1').get()).data()?.quoteDecision).toBe('denied');
  });
});
