import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * `acceptQuote` / `denyQuote` — the two callables issue #385 says were missing.
 *
 * THE TEST THAT WOULD HAVE CAUGHT THE BUG is the last describe block: it asserts
 * that answering a quote emits `quote.accepted` / `quote.denied`. Before this
 * change no code in the repo emitted either key, so the catalog's two switches
 * controlled nothing and this assertion had nothing to attach to.
 */
const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveUid: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { acceptQuoteHandler, denyQuoteHandler, quoteDecisionRefusal } from '../src/portal/quoteDecision';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { quoteHasExpired } from '../src/lib/quoteDecision';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const SECONDARY_MEMBER = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: { billing_full: true, kintales_only: false },
};

/** A quote as `createQuote` writes one: both status spellings, a real balance. */
function quoteDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kinfolkId: 'fam1',
    invoiceNumber: 'Q-1001',
    status: 'quote',
    invoiceStatus: 'quote',
    editScope: 'all',
    total: 240,
    amountDue: 240,
    // Deliberately far in the future: the expiry guard is exercised on its own
    // below, and every other case here would otherwise depend on today's date.
    dueDate: '2999-12-31',
    ...over,
  };
}

function ctxFor(invoice: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return buildDbMock({
    docs: {
      'clients/u1': { kinfolkIds: ['fam1'] },
      'families/fam1/members/u1': PRIMARY_MEMBER,
      'business_settings/business_settings': { timeZone: 'America/Chicago' },
      ...(invoice ? { 'invoices/q1': invoice } : {}),
      ...over,
    },
  });
}

function req(data: unknown, uid: string | null = 'u1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: {} as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** The one write this flow makes, so a test never asserts against a stale one. */
function quoteWrite(ctx: ReturnType<typeof buildDbMock>): Record<string, unknown> {
  const write = ctx.writes.find((w) => w.path === 'invoices/q1');
  expect(write, 'expected a write to invoices/q1').toBeDefined();
  return write!.data;
}

describe('acceptQuote happy path', () => {
  it('records the decision and re-stamps the quote as an open bill', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res).toEqual({ ok: true, invoiceId: 'q1', status: 'open' });
    const data = quoteWrite(ctx);
    expect(data.quoteDecision).toBe('accepted');
    expect(data.quoteDecidedByUid).toBe('u1');
    expect(data.quoteDecidedAt).toBe('__TS__');
    // Both spellings move together, or the two sides bucket the doc differently.
    expect(data.status).toBe('open');
    expect(data.invoiceStatus).toBe('open');
    // The ADR-0002 stamp rides the same write.
    expect(data.editScope).toBe('all');
  });

  it('writes a BILLING_QUOTE_ACCEPTED audit entry attributed to the household', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_QUOTE_ACCEPTED',
        actorRole: 'PRIMARY',
        actorUid: 'u1',
        familyId: 'fam1',
      }),
    );
  });

  it('lands a quote billed at nothing on `zero`, because the classifier decides the state', async () => {
    const ctx = ctxFor(quoteDoc({ total: 0, amountDue: 0 }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res.status).toBe('zero');
  });
});

describe('denyQuote happy path', () => {
  it('records the decision and leaves the doc a quote, NOT a cancelled invoice', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await denyQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res).toEqual({ ok: true, invoiceId: 'q1', status: 'quote' });
    const data = quoteWrite(ctx);
    expect(data.quoteDecision).toBe('denied');
    expect(data.quoteDecidedByUid).toBe('u1');
    // `cancelled` would mean the OPERATOR withdrew the bill, and would drop the
    // row out of every bucket `getMyInvoices` returns — off the household's own
    // screen, as the immediate result of their own tap.
    expect(data.status).toBe('quote');
    expect(data.invoiceStatus).toBeUndefined();
  });

  it('writes a BILLING_QUOTE_DENIED audit entry', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    await denyQuoteHandler(req({ invoiceId: 'q1' }));

    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_QUOTE_DENIED', actorUid: 'u1' }),
    );
  });
});

describe('the guards', () => {
  it('REFUSES an invoice that is not a quote', async () => {
    const ctx = ctxFor(quoteDoc({ status: 'open', invoiceStatus: 'open' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('not a quote'),
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES a second accept on an already accepted quote', async () => {
    const ctx = ctxFor(quoteDoc({ status: 'open', quoteDecision: 'accepted' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('already been accepted'),
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES accepting a quote the household already declined', async () => {
    const ctx = ctxFor(quoteDoc({ quoteDecision: 'denied' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('already been declined'),
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES a second decline', async () => {
    const ctx = ctxFor(quoteDoc({ quoteDecision: 'denied' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(denyQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES accepting a quote whose due date has passed', async () => {
    const ctx = ctxFor(quoteDoc({ dueDate: '2020-01-01' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
      message: expect.stringContaining('2020-01-01'),
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('ALLOWS declining an expired quote, so the household is not stuck with it', async () => {
    const ctx = ctxFor(quoteDoc({ dueDate: '2020-01-01' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await denyQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res.ok).toBe(true);
    expect(quoteWrite(ctx).quoteDecision).toBe('denied');
  });

  it('ACCEPTS an undated quote, which does not expire', async () => {
    const ctx = ctxFor(quoteDoc({ dueDate: '' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res.status).toBe('open');
  });

  it('REFUSES an unsigned-in caller', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('REFUSES a quote belonging to another household', async () => {
    const ctx = ctxFor(quoteDoc({ kinfolkId: 'fam2' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES a secondary member: answering a quote is the primary kinfolk’s call', async () => {
    const ctx = ctxFor(quoteDoc(), { 'families/fam1/members/u1': SECONDARY_MEMBER });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES a quote that does not exist', async () => {
    const ctx = ctxFor(null);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(denyQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('the notifications issue #385 is about', () => {
  it('emits quote.accepted to the household, targeted at the invoice', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'quote.accepted',
        // The catalog row resolves kinfolkAcct first (the household's own
        // confirmation) and businessAdmins second, so the household uid has to
        // be on the call.
        recipientUid: 'kin-uid-1',
        actorUid: 'u1',
        targetType: 'invoice',
        targetId: 'q1',
        data: expect.objectContaining({ kinfolkId: 'fam1', invoiceId: 'q1', invoiceNumber: 'Q-1001' }),
      }),
    );
  });

  it('emits quote.denied, which is business-audience and resolves its own recipients', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    await denyQuoteHandler(req({ invoiceId: 'q1' }));

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'quote.denied', targetType: 'invoice', targetId: 'q1' }),
    );
    // No kinfolk uid lookup: the catalog resolves businessAdmins for this key.
    expect(mocks.resolveUid).not.toHaveBeenCalled();
  });

  it('keeps the decision when the notification cannot be sent', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValue(new Error('no recipients resolved from any resolver'));

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res.ok).toBe(true);
    expect(quoteWrite(ctx).quoteDecision).toBe('accepted');
  });
});

describe('quoteHasExpired', () => {
  it('is good THROUGH the due day and expired the day after', () => {
    expect(quoteHasExpired('2026-08-18', '2026-08-17')).toBe(false);
    expect(quoteHasExpired('2026-08-18', '2026-08-18')).toBe(false);
    expect(quoteHasExpired('2026-08-18', '2026-08-19')).toBe(true);
  });

  it('never expires on evidence it does not have', () => {
    // No due date at all: most quotes in this collection.
    expect(quoteHasExpired('', '2026-08-19')).toBe(false);
    expect(quoteHasExpired(undefined, '2026-08-19')).toBe(false);
    // Free text left over from before `invoiceDay.ts` pinned the shape.
    expect(quoteHasExpired('Aug 18, 2026', '2026-08-19')).toBe(false);
    // An unreadable business time zone: skip the check rather than guess.
    expect(quoteHasExpired('2026-08-18', '')).toBe(false);
  });
});

describe('quoteDecisionRefusal', () => {
  it('reports the already-decided refusal before the not-a-quote one', () => {
    // An accepted quote is no longer in QUOTE status, so checking the status
    // first would tell the household "this is an invoice, not a quote" when the
    // true answer is "you accepted this already".
    const refusal = quoteDecisionRefusal(
      { status: 'open', quoteDecision: 'accepted' },
      'accepted',
      '2026-08-18',
    );
    expect(refusal?.code).toBe('quote_already_decided');
  });

  it('passes a fresh, in-date quote', () => {
    expect(quoteDecisionRefusal({ status: 'quote', dueDate: '2026-08-18' }, 'accepted', '2026-08-18')).toBeNull();
  });
});
