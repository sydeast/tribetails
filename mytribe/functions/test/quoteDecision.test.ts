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
import { logEvent } from '../src/lib/logger';
import { BILLING_ACTION_REFUSAL } from '../src/lib/memberGate';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  (writeAuditEntry as any).mockClear();
  (logEvent as any).mockClear();
  delete process.env.AUNTIE_OPERATOR_UIDS;
});

const PRIMARY_MEMBER = { role: 'PRIMARY', status: 'ACTIVE', permissions: {} };
const NO_BILLING_SECONDARY = {
  role: 'SECONDARY',
  status: 'ACTIVE',
  permissions: { billing_full: false, kintales_only: true },
};
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
    // Far in the future, from when quotes expired (#2088 ended that); kept so
    // the fixture is a quote with an ordinary due date.
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
    // #1039: neither the fixture's member doc nor its client doc carries a
    // display name, which is the same shape a pre-#1039 account has. Null,
    // never a guessed name.
    expect(data.quoteDecidedByName).toBeNull();
    expect(data.quoteDecidedAt).toBe('__TS__');
    // Both spellings move together, or the two sides bucket the doc differently.
    expect(data.status).toBe('open');
    expect(data.invoiceStatus).toBe('open');
    // The ADR-0002 stamp rides the same write, and since issue #448 it locks
    // the doc: the household has agreed to this figure, so it is no longer the
    // office's to change. (This read 'all' until 2026-08-19, which is the
    // defect #448 reports.)
    expect(data.editScope).toBe('none');
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

  // #2088 (operator ruling 2026-11-12): a quote has no expiry and no "good
  // through". Its due date is when the invoice it becomes is due.
  it('#2088 ACCEPTS a quote whose due date has passed: a quote does not expire', async () => {
    const ctx = ctxFor(quoteDoc({ dueDate: '2020-01-01' }));
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res.status).toBe('open');
    expect(quoteWrite(ctx).quoteDecision).toBe('accepted');
  });

  it('ALLOWS declining a quote whose due date has passed', async () => {
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

  it('REFUSES a secondary without billing access, and logs the refusal', async () => {
    const ctx = ctxFor(quoteDoc(), { 'families/fam1/members/u1': NO_BILLING_SECONDARY });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(acceptQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'permission-denied',
      message: BILLING_ACTION_REFUSAL,
    });
    expect(ctx.writes).toHaveLength(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ function: 'acceptQuote', event: 'portal.billing.refused', uid: 'u1', familyId: 'fam1' }),
    );
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

describe('quoteDecisionRefusal', () => {
  it('reports the already-decided refusal before the not-a-quote one', () => {
    // An accepted quote is no longer in QUOTE status, so checking the status
    // first would tell the household "this is an invoice, not a quote" when the
    // true answer is "you accepted this already".
    const refusal = quoteDecisionRefusal({ status: 'open', quoteDecision: 'accepted' });
    expect(refusal?.code).toBe('quote_already_decided');
  });

  it('passes a sent quote waiting for an answer, whatever its due date', () => {
    expect(quoteDecisionRefusal({ status: 'quote', dueDate: '2020-01-01' })).toBeNull();
  });

  it('#2087 a quote saved unsent, or turned into an invoice not sent yet, reads as missing', () => {
    expect(quoteDecisionRefusal({ status: 'draft', quoteDraft: true })).toEqual({
      code: 'quote_not_found',
      message: 'Quote not found.',
    });
    expect(quoteDecisionRefusal({ status: 'draft', quoteConvertedAt: '__TS__' })?.code).toBe('quote_not_found');
  });

  it('#2195 an archived quote cannot be answered, in words the household reads', () => {
    expect(quoteDecisionRefusal({ status: 'quote', archivedAt: '__TS__' })).toEqual({
      code: 'quote_archived',
      message: 'This quote is not open for an answer right now. Ask your Auntie about it.',
    });
  });

  it('#2088 a withdrawn quote has nothing left to answer', () => {
    expect(quoteDecisionRefusal({ status: 'cancelled', quoteWithdrawnAt: '__TS__' })?.code).toBe('quote_withdrawn');
  });
});

describe('D-2026-09-28-BILLING-ACCESS-PAYS: a secondary with billing access answers quotes', () => {
  it('accepts, and the audit entry and notice name the secondary as the actor', async () => {
    const ctx = ctxFor(quoteDoc(), { 'families/fam1/members/u1': SECONDARY_MEMBER });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(res.status).toBe('open');
    expect(quoteWrite(ctx)['quoteDecidedByUid']).toBe('u1');
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: 'SECONDARY', actorUid: 'u1', familyId: 'fam1' }),
    );
    // The recipient is still whoever the billing-recipient rule picks; the
    // secondary is named as the actor, never added as a new recipient.
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'quote.accepted', recipientUid: 'kin-uid-1', actorUid: 'u1' }),
    );
  });

  it('declines, and the audit entry names the secondary', async () => {
    const ctx = ctxFor(quoteDoc(), { 'families/fam1/members/u1': SECONDARY_MEMBER });
    mocks.dbFn.mockReturnValue(ctx.db);

    await denyQuoteHandler(req({ invoiceId: 'q1' }));

    expect(quoteWrite(ctx)['quoteDecision']).toBe('denied');
    expect(writeAuditEntry).toHaveBeenCalledWith(expect.objectContaining({ actorRole: 'SECONDARY', actorUid: 'u1' }));
  });

  it('refuses the decline too for a secondary without billing access', async () => {
    const ctx = ctxFor(quoteDoc(), { 'families/fam1/members/u1': NO_BILLING_SECONDARY });
    mocks.dbFn.mockReturnValue(ctx.db);

    await expect(denyQuoteHandler(req({ invoiceId: 'q1' }))).rejects.toMatchObject({
      code: 'permission-denied',
      message: BILLING_ACTION_REFUSAL,
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('lets the operator through (bypass, no member doc)', async () => {
    process.env.AUNTIE_OPERATOR_UIDS = 'op-uid';
    const ctx = ctxFor(quoteDoc(), { 'clients/op-uid': { kinfolkIds: ['fam1'] } });
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }, 'op-uid'));

    expect(res.status).toBe('open');
    expect(quoteWrite(ctx)['quoteDecidedByUid']).toBe('op-uid');
  });
});

describe('issue #1039: naming who acted', () => {
  it('stores the first name off the member doc, and passes it to the notification', async () => {
    const ctx = ctxFor(quoteDoc(), {
      'families/fam1/members/u1': { ...PRIMARY_MEMBER, displayName: 'Alicia Rivera' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(quoteWrite(ctx).quoteDecidedByName).toBe('Alicia');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorName: 'Alicia', actorUid: 'u1' }) }),
    );
  });

  it('falls back to the client doc display name when there is no member doc (legacy primary)', async () => {
    const ctx = ctxFor(quoteDoc(), {
      'clients/u1': { kinfolkIds: ['fam1'], displayName: 'Jordan Lee' },
      'families/fam1/members/u1': null,
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(quoteWrite(ctx).quoteDecidedByName).toBe('Jordan');
  });

  it('names the SECONDARY as the actor when she is the one who answered', async () => {
    const ctx = ctxFor(quoteDoc(), {
      'families/fam1/members/u1': { ...SECONDARY_MEMBER, displayName: 'Sam Rivera' },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await denyQuoteHandler(req({ invoiceId: 'q1' }));

    expect(quoteWrite(ctx).quoteDecidedByName).toBe('Sam');
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorName: 'Sam', actorUid: 'u1' }) }),
    );
  });

  it('stores null, and tells the notification "Someone", when no display name exists anywhere', async () => {
    const ctx = ctxFor(quoteDoc());
    mocks.dbFn.mockReturnValue(ctx.db);

    await acceptQuoteHandler(req({ invoiceId: 'q1' }));

    expect(quoteWrite(ctx).quoteDecidedByName).toBeNull();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ actorName: 'Someone' }) }),
    );
  });
});
