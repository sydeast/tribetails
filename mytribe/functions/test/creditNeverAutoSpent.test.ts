import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #1872, operator ruling 2026-11-11: ACCOUNT CREDIT IS NEVER SPENT
 * AUTOMATICALLY. Not on send, not on quote acceptance, not by any trigger.
 *
 * The report: invoices 1020, 1021 and 1023 were each paid from account credit
 * within seconds of Review and send. The send itself never touched the credit;
 * a second trigger on the same collection did, the moment the invoice became
 * collectable, and the same trigger fired when a household accepted a quote.
 *
 * So each case here runs the REAL callable against a household that holds
 * credit, then hands the before and after of the write it made to the REAL
 * trigger, with the real credit module behind it (nothing here mocks
 * `lib/accountCredit`). The household's credit and the invoice's balance must
 * come out exactly as the callable left them.
 */
const mocks = vi.hoisted(() => ({ dbFn: vi.fn(), resolveUid: vi.fn(), enqueue: vi.fn() }));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', async () => ({
  ...(await vi.importActual<any>('../src/lib/writeAuditEntry')),
  writeAuditEntry: vi.fn().mockResolvedValue('audit-1'),
}));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: mocks.enqueue,
  enqueueNotificationDetailed: async (args: unknown) => ({
    written: ((await mocks.enqueue(args)) as string[] | undefined) ?? [],
    suppressed: [],
    unresolved: [],
    appOnly: [],
  }),
}));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});
import { reviewAndSendDraftInvoiceHandler } from '../src/admin/reviewAndSendDraftInvoice';
import { acceptQuoteHandler } from '../src/portal/quoteDecision';
import { onInvoiceAutoApplyHandler } from '../src/triggers/onInvoiceAutoApply';
import { collectableForAutoApply } from '../src/lib/invoiceCollectable';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
});

function req(data: unknown, uid: string, token: Record<string, unknown>): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** The trigger event Firestore would deliver for the callable's write. */
function writeEvent(invoiceId: string, before: Record<string, unknown>, after: Record<string, unknown>) {
  return {
    params: { invoiceId },
    data: { before: { data: () => before }, after: { data: () => after } },
  } as any;
}

/** Everything a credit draw would have written. */
function moneyWrites(ctx: ReturnType<typeof buildDbMock>, invoiceId: string) {
  return ctx.writes.filter(
    (w) =>
      w.path.startsWith(`invoices/${invoiceId}/payments/`) ||
      w.path === 'families/fam1' ||
      w.path.startsWith('families/fam1/creditLedger/'),
  );
}

describe('Review and send leaves account credit untouched (#1872)', () => {
  const DRAFT = { kinfolkId: 'fam1', invoiceNumber: '1020', status: 'draft', total: 40, amountDue: 40 };

  it('a household holding more credit than the bill gets an OPEN invoice, still owed in full', async () => {
    const ctx = buildDbMock({
      docs: { 'invoices/inv1': { ...DRAFT }, 'families/fam1': { accountBalanceCents: 12000 } },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }, 'admin1', { admin: true }));
    expect(res.ok).toBe(true);
    const sent = ctx.writes.find((w) => w.path === 'invoices/inv1')!.data;
    expect(sent.status).toBe('open');
    const after = { ...DRAFT, ...sent };

    // This IS the transition the old trigger drew on.
    expect(collectableForAutoApply(DRAFT)).toBe(false);
    expect(collectableForAutoApply(after)).toBe(true);
    const writesBeforeTrigger = ctx.writes.length;
    await onInvoiceAutoApplyHandler(writeEvent('inv1', DRAFT, after));
    expect(ctx.writes).toHaveLength(writesBeforeTrigger);
    expect(moneyWrites(ctx, 'inv1')).toEqual([]);

    // The send's own write is the only invoice write, and it says open, unpaid.
    const invoiceWrites = ctx.writes.filter((w) => w.path === 'invoices/inv1');
    expect(invoiceWrites).toHaveLength(1);
    expect(invoiceWrites[0]!.data.paidCents).toBeUndefined();
    expect(invoiceWrites[0]!.data.paymentStatus).toBeUndefined();
  });

  it('tells the household about a new invoice, and nothing about a payment', async () => {
    const ctx = buildDbMock({
      docs: { 'invoices/inv1': { ...DRAFT }, 'families/fam1': { accountBalanceCents: 12000 } },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await reviewAndSendDraftInvoiceHandler(req({ invoiceId: 'inv1' }, 'admin1', { admin: true }));
    const sent = ctx.writes.find((w) => w.path === 'invoices/inv1')!.data;
    await onInvoiceAutoApplyHandler(writeEvent('inv1', DRAFT, { ...DRAFT, ...sent }));
    const keys = mocks.enqueue.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).toContain('invoice.new');
    expect(keys).not.toContain('invoice.payment.applied');
  });
});

describe('Accepting a quote leaves account credit untouched (#1872)', () => {
  const QUOTE = {
    kinfolkId: 'fam1',
    invoiceNumber: '1021',
    status: 'quote',
    invoiceStatus: 'quote',
    editScope: 'all',
    total: 240,
    amountDue: 240,
    dueDate: '2999-12-31',
  };

  it('the quote becomes an open invoice owed in full, and the credit stays on account', async () => {
    const ctx = buildDbMock({
      docs: {
        'clients/u1': { kinfolkIds: ['fam1'] },
        'families/fam1': { accountBalanceCents: 30000 },
        'families/fam1/members/u1': { role: 'PRIMARY', status: 'ACTIVE', permissions: {} },
        'business_settings/business_settings': { timeZone: 'America/Chicago' },
        'invoices/q1': { ...QUOTE },
      },
      queryDocs: { 'invoices/q1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await acceptQuoteHandler(req({ invoiceId: 'q1' }, 'u1', {}));
    expect(res).toEqual({ ok: true, invoiceId: 'q1', status: 'open' });
    const accepted = ctx.writes.find((w) => w.path === 'invoices/q1')!.data;
    const after = { ...QUOTE, ...accepted };
    expect(collectableForAutoApply(QUOTE)).toBe(false);
    expect(collectableForAutoApply(after)).toBe(true);
    const writesBeforeTrigger = ctx.writes.length;
    await onInvoiceAutoApplyHandler(writeEvent('q1', QUOTE, after));
    expect(ctx.writes).toHaveLength(writesBeforeTrigger);
    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/q1/payments/'))).toEqual([]);
    expect(ctx.writes.filter((w) => w.path.startsWith('families/fam1') && !w.path.includes('/members/'))).toEqual([]);
    expect(ctx.writes.filter((w) => w.path === 'invoices/q1')).toHaveLength(1);
  });
});
