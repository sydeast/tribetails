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

  it('a client retry after a completed resend answers ok inside the window, and is refused once the window has passed', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/q1': declined() } });
    mocks.dbFn.mockReturnValue(ctx.db);

    await resendQuoteHandler(req());
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);

    // The quote as the completed resend left it: reopened, resend count 1.
    const reopened: Record<string, unknown> = { ...declined({ quoteResendCount: 1 }) };
    delete reopened.quoteDecision;
    await ctx.db.collection('invoices').doc('q1').set(reopened);

    vi.setSystemTime(NOW + 60_000);
    await expect(resendQuoteHandler(req())).resolves.toMatchObject({ ok: true, invoiceId: 'q1' });
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);

    vi.setSystemTime(NOW + 6 * 60_000);
    const late = await resendQuoteHandler(req()).catch((e) => e);
    expect(late.details).toMatchObject({ code: 'quote_not_declined' });
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);
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

  /**
   * THE PRE-LAUNCH HOUSEHOLD GATE. A resend that reaches nobody must not reopen
   * the quote: the household still has a declined quote and no message about
   * it, and reopening would leave the operator believing they had asked again.
   *
   * Its own refusal code rather than `quote_resend_suppressed`, because the
   * operator's next move is different. `suppressed` points at this household's
   * notification settings; `gated` points at one switch that has nothing to do
   * with them.
   */
  it('GATED: household notifications off refuses the resend and leaves the quote declined', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: {
        'business_settings/business_settings': { householdNotificationsLive: false },
        'invoices/q1': declined(),
        'businessSettings/admins': { uids: ['admin1'] },
      },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const err = await resendQuoteHandler(req()).catch((e) => e);
    expect(err.details).toMatchObject({ code: 'quote_resend_gated' });
    expect(householdQuoteMessages(ctx.writes), 'the household heard nothing').toHaveLength(0);
    expect((await ctx.db.collection('invoices').doc('q1').get()).data()?.quoteDecision).toBe('denied');
  });
  // #866 fourth review: a failed office-roster read must not stop the resend.
  // The household resolved, so it gets its copy and the quote reopens, as on
  // main; only the office copy is missed, and that is logged by the dispatcher.
  it('only the office roster read fails: the household still gets the resend and the quote reopens', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: { 'invoices/q1': declined() } });
    const readError = Object.assign(new Error('14 UNAVAILABLE: deadline exceeded'), { code: 14 });
    mocks.dbFn.mockReturnValue({
      ...ctx.db,
      collection: (path: string) => {
        const real = ctx.db.collection(path);
        if (path !== 'businessSettings') return real;
        return { ...real, doc: (id?: string) => (id === 'admins' ? { get: async () => { throw readError; } } : real.doc(id)) };
      },
    });

    await expect(resendQuoteHandler(req())).resolves.toMatchObject({ ok: true });
    expect(householdQuoteMessages(ctx.writes)).toHaveLength(1);
    expect((await ctx.db.collection('invoices').doc('q1').get()).data()?.quoteDecision).not.toBe('denied');
  });
});
