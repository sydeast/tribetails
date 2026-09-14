import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * `resendQuote` — the office's answer to a decline (issue #448).
 *
 * THE TESTS THAT WOULD HAVE CAUGHT THE BUG are the last two blocks: a declined
 * quote is answerable again after a resend, and the household is told. Before
 * this callable existed a decline was a dead end — `portal/quoteDecision.ts`
 * refused every further decision on the doc with `quote_already_decided`, and
 * the only documented way forward was minting a second quote, which leaves the
 * declined one sitting on the household's screen.
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
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotificationDetailed: mocks.enqueue }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      delete: () => '__DELETE__',
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import { resendQuoteHandler, resendQuoteRefusal } from '../src/admin/resendQuote';
import { acceptQuoteHandler } from '../src/portal/quoteDecision';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue({ written: ['n1'], suppressed: [] });
  (writeAuditEntry as any).mockClear();
});

/** A quote the household declined, as `denyQuote` leaves it. */
function declinedQuote(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kinfolkId: 'fam1',
    invoiceNumber: 'Q-1001',
    status: 'quote',
    invoiceStatus: 'quote',
    editScope: 'all',
    quoteDecision: 'denied',
    quoteDecidedAt: '__OLD_TS__',
    quoteDecidedByUid: 'u1',
    total: 240,
    amountDue: 240,
    // Far in the future: the expiry guard is exercised on its own below, and
    // every other case here would otherwise depend on today's date.
    dueDate: '2999-12-31',
    ...over,
  };
}

function ctxFor(invoice: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return buildDbMock({
    docs: {
      'business_settings/business_settings': { timeZone: 'America/Chicago' },
      ...(invoice ? { 'invoices/q1': invoice } : {}),
      ...over,
    },
  });
}

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

function quoteWrite(ctx: ReturnType<typeof buildDbMock>): Record<string, unknown> | undefined {
  return ctx.writes.find((w) => w.path === 'invoices/q1')?.data;
}

describe('resendQuote happy path', () => {
  it('CLEARS the household answer, so the quote is waiting on them again', async () => {
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await resendQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res).toEqual({ ok: true, invoiceId: 'q1', status: 'quote' });
    const data = quoteWrite(ctx)!;
    // The three decision fields are DELETED, not overwritten with a value: an
    // answer that is not there is what every client's `quoteDecision == null`
    // gate reads as "still waiting".
    expect(data.quoteDecision).toBe('__DELETE__');
    expect(data.quoteDecidedAt).toBe('__DELETE__');
    expect(data.quoteDecidedByUid).toBe('__DELETE__');
    // Still a quote on both spellings, so neither side re-buckets it.
    expect(data.status).toBe('quote');
    expect(data.invoiceStatus).toBe('quote');
    // The ADR-0002 stamp rides the same write, and it says the quote is fully
    // editable again rather than carrying a stale scope from the decline.
    expect(data.editScope).toBe('all');
  });

  it('records who sent it back, when, and how many times round it has been', async () => {
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);

    await resendQuoteHandler(req({ invoiceId: 'q1' }));

    const data = quoteWrite(ctx)!;
    expect(data.quoteResentByUid).toBe('admin1');
    expect(data.quoteResentAt).toBe('__TS__');
    // The decline is gone off the doc, so the count is the only thing left
    // saying this quote has been round before.
    expect(data.quoteResendCount).toEqual({ __increment: 1 });
  });

  it('TELLS THE HOUSEHOLD, on the same catalog key that issued the quote', async () => {
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);

    await resendQuoteHandler(req({ invoiceId: 'q1' }));

    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'invoice.new',
        recipientUid: 'kin-uid-1',
        targetType: 'invoice',
        targetId: 'q1',
        data: expect.objectContaining({ kinfolkId: 'fam1', invoiceId: 'q1', isQuote: true, resent: true }),
        // #832: its own identity, distinct from createQuote's invoice:q1.
        dedupeKey: 'quote:q1:resend:1',
      }),
    );
  });

  it('#832: the resend ordinal follows the stored count, so the next real resend is a new identity', async () => {
    const ctx = ctxFor(declinedQuote({ quoteResendCount: 2 }));
    mocks.dbFn.mockReturnValue(ctx.db);

    await resendQuoteHandler(req({ invoiceId: 'q1' }));

    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: 'quote:q1:resend:3' }));
  });

  it('#832: FAILS LOUD, and leaves the quote declined, when the dispatcher refuses a duplicate', async () => {
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockResolvedValue({
      written: [],
      suppressed: [{ recipientUid: 'kin-uid-1', reason: 'duplicate', existingId: 'n0', lastAtMs: 1 }],
    });

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.code).toBe('failed-precondition');
    expect(err.details).toMatchObject({ code: 'quote_resend_duplicate' });
    expect(quoteWrite(ctx)).toBeUndefined();
  });

  it('#832: FAILS LOUD when the household copy was suppressed by prefs, even though the office copy went', async () => {
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockResolvedValue({
      written: ['admin-copy'],
      suppressed: [{ recipientUid: 'kin-uid-1', reason: 'prefs' }],
    });

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.code).toBe('failed-precondition');
    expect(err.details).toMatchObject({ code: 'quote_resend_suppressed' });
    expect(quoteWrite(ctx)).toBeUndefined();
  });

  it('writes a BILLING_QUOTE_RESENT audit entry, the only lasting record of the decline', async () => {
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);

    await resendQuoteHandler(req({ invoiceId: 'q1' }));

    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'BILLING_QUOTE_RESENT',
        actorUid: 'admin1',
        familyId: 'fam1',
        payload: expect.objectContaining({ invoiceId: 'q1', invoiceNumber: 'Q-1001' }),
      }),
    );
  });
});

describe('resendQuote refusals', () => {
  it('REFUSES a quote the household accepted, and says why in the operator words', async () => {
    const ctx = ctxFor(
      declinedQuote({ status: 'open', invoiceStatus: 'open', quoteDecision: 'accepted', editScope: 'none' }),
    );
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.code).toBe('failed-precondition');
    expect(err.details).toMatchObject({ code: 'quote_accepted_locked' });
    expect(err.message).toContain('accepted this quote');
    expect(quoteWrite(ctx)).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('refuses a quote still waiting for an answer, and points at the reminder instead', async () => {
    const ctx = ctxFor(declinedQuote({ quoteDecision: undefined, quoteDecidedAt: undefined }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.details).toMatchObject({ code: 'quote_not_declined' });
    expect(err.message).toContain('reminder');
    expect(quoteWrite(ctx)).toBeUndefined();
  });

  it('refuses an ordinary invoice', async () => {
    const ctx = ctxFor({ kinfolkId: 'fam1', status: 'open', total: 40, amountDue: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.details).toMatchObject({ code: 'quote_not_a_quote' });
  });

  it('REFUSES AN EXPIRED QUOTE rather than sending out one that can only be declined', async () => {
    // The dead end this guard exists for: `quoteDecisionRefusal` refuses to
    // ACCEPT a quote past its due date but still allows a decline, so resending
    // an expired one unchanged hands the household a screen whose only working
    // button says no.
    const ctx = ctxFor(declinedQuote({ dueDate: '2020-01-01' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.details).toMatchObject({ code: 'quote_expired' });
    expect(err.message).toContain('2020-01-01');
    // And it names the fix, which is an ordinary edit: a declined quote is
    // fully editable, so a new due date is one save away.
    expect(err.message).toContain('new due date');
    expect(quoteWrite(ctx)).toBeUndefined();
  });

  it('refuses a quote with no household to send it to', async () => {
    const ctx = ctxFor(declinedQuote({ kinfolkId: undefined }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const err = await resendQuoteHandler(req({ invoiceId: 'q1' })).catch((e) => e);

    expect(err.code).toBe('failed-precondition');
    expect(err.message).toContain('household');
  });

  it('answers not-found for a quote that is not there', async () => {
    const ctx = ctxFor(null);
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(resendQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('requires a signed-in caller', async () => {
    await expect(resendQuoteHandler(req({ invoiceId: 'q1' }, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  it('LEAVES THE QUOTE DECLINED when the notification could not be sent', async () => {
    // Fail loud, and before the write. A resend that reopened the quote while
    // reaching nobody would look like it worked, and the retry would then
    // refuse as "not declined" because the first attempt cleared the answer.
    const ctx = ctxFor(declinedQuote());
    mocks.dbFn.mockReturnValue(ctx.db);
    mocks.enqueue.mockRejectedValue(new Error('dispatcher down'));

    await expect(resendQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toThrow('dispatcher down');
    expect(quoteWrite(ctx)).toBeUndefined();
  });
});

describe('resendQuoteRefusal (pure)', () => {
  it('never guesses at expiry when the business day could not be resolved', () => {
    const doc = { status: 'quote', quoteDecision: 'denied', dueDate: '2020-01-01' };
    expect(resendQuoteRefusal(doc, '')).toBeNull();
    expect(resendQuoteRefusal(doc, '2026-08-19')!.code).toBe('quote_expired');
  });

  it('treats the due date as the last GOOD day, not the first expired one', () => {
    const doc = { status: 'quote', quoteDecision: 'denied', dueDate: '2026-08-19' };
    expect(resendQuoteRefusal(doc, '2026-08-19')).toBeNull();
    expect(resendQuoteRefusal(doc, '2026-08-20')!.code).toBe('quote_expired');
  });

  it('names the acceptance before the status, because an accepted quote is not a quote any more', () => {
    // status 'open' would otherwise answer "this is an invoice, not a quote",
    // which is true and tells the operator nothing about why.
    const doc = { status: 'open', quoteDecision: 'accepted' };
    expect(resendQuoteRefusal(doc, '')!.code).toBe('quote_accepted_locked');
  });
});

describe('a resent quote is answerable again (issue #448, end to end)', () => {
  /** Applies a merge write the way Firestore would, deletes and all. */
  function applyMerge(
    base: Record<string, unknown>,
    write: Record<string, unknown>,
  ): Record<string, unknown> {
    const out = { ...base };
    for (const [k, v] of Object.entries(write)) {
      if (v === '__DELETE__') delete out[k];
      else out[k] = v;
    }
    return out;
  }

  it('lets the household accept the revision, where the decline used to be final', async () => {
    const before = declinedQuote();
    const ctx = ctxFor(before);
    mocks.dbFn.mockReturnValue(ctx.db);
    await resendQuoteHandler(req({ invoiceId: 'q1' }));
    const after = applyMerge(before, quoteWrite(ctx)!);

    // The doc as the resend leaves it, handed to the household's own callable.
    const portal = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam1'] },
        'families/fam1/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
        'business_settings/business_settings': { timeZone: 'America/Chicago' },
        'invoices/q1': after,
      },
    });
    mocks.dbFn.mockReturnValue(portal.db);

    const res = await acceptQuoteHandler({
      data: { invoiceId: 'q1' },
      auth: { uid: 'u1', token: {} as any } as any,
      rawRequest: {} as any,
    } as unknown as CallableRequest<unknown>);

    // Accepted, not `quote_already_decided`: the resend really did put the
    // quote back into a state the household can answer.
    expect(res).toEqual({ ok: true, invoiceId: 'q1', status: 'open' });
    const accepted = portal.writes.find((w) => w.path === 'invoices/q1')!.data;
    expect(accepted.quoteDecision).toBe('accepted');
    // And the acceptance locks it, which is the other half of issue #448.
    expect(accepted.editScope).toBe('none');
  });
});
