import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

/**
 * #825: two attempts at ONE payment must record ONE payment, move ONE credit,
 * and consume ONE invoice number.
 *
 * What is being guarded is money in a direction that cannot be clawed back. A
 * replayed `recordPayment` with `autoApply` wrote a second `payments` row AND
 * incremented `families/{id}.accountBalanceCents` a second time, and account
 * balance is the only destination this business has for money owed back to a
 * household — so the second credit is spendable money made from nothing. A
 * replayed `createInvoice` bills the household twice and advances the shared
 * number sequence twice, and a consumed sequence value cannot be returned.
 *
 * THE MOCK RUNS IN `writeThrough` MODE, which is the whole point. The claim
 * under test is "the second attempt sees what the first one wrote", and against
 * the static fixture the rest of these suites use, the second attempt sees
 * nothing and every assertion below would pass for the wrong reason. In that
 * mode `create` really refuses a path that already exists, and the transaction
 * shim routes `tx.create` to it, so the race backstop is refereed here rather
 * than assumed.
 */

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
  resolveKinfolkUid: vi.fn(),
  enqueueNotification: vi.fn(),
  payMethodSnapshot: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return {
    ...actual,
    FieldValue: {
      serverTimestamp: () => '__TS__',
      // The mock cannot apply a real increment, so it records the INTENT.
      // Counting these is how "the balance moved once" is asserted below.
      increment: (n: number) => ({ __increment: n }),
    },
  };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveKinfolkUid }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueueNotification }));
vi.mock('../src/lib/payMethodSnapshot', () => ({
  payMethodSnapshotForIssue: mocks.payMethodSnapshot,
  readLivePayMethodSettings: vi.fn().mockResolvedValue({}),
}));

import { recordPaymentHandler } from '../src/admin/recordPayment';
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { createInvoiceHandler } from '../src/admin/createInvoice';
import { createQuoteHandler } from '../src/admin/createQuote';
import { INVOICE_NUMBER_COUNTER_PATH } from '../src/lib/invoiceNumber';

const PAY_A = 'pay_1757700000000_ab12cd';
const PAY_B = 'pay_1757700000001_ef34gh';
const IPAY_A = 'ipay_1757700000000_ab12cd';
const IPAY_B = 'ipay_1757700000001_ef34gh';
const INV_A = 'inv_1757700000000_ab12cd';
const INV_B = 'inv_1757700000001_ef34gh';
const QUOT_A = 'quot_1757700000000_ab12cd';
const QUOT_B = 'quot_1757700000001_ef34gh';

beforeEach(() => {
  mocks.dbFn.mockReset();
  mocks.resolveKinfolkUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.enqueueNotification.mockReset().mockResolvedValue(undefined);
  mocks.payMethodSnapshot.mockReset().mockResolvedValue({});
});

function req(data: unknown, uid = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: { uid, token: { admin: true } as any } as any,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * Payment ROWS written to the root `payments` collection, by path.
 *
 * Merge writes are excluded: they are updates to a row that already exists, not
 * a second row. Since #866 `recordPayment` stamps which notice copies went out
 * (`confirmationEmailSent`, `officeNoticeSentAt`) on its own row with `update`,
 * and counting that stamp as a payment would make "one key, one payment" fail
 * for a reason unrelated to money.
 */
const paymentRows = (ctx: { writes: Array<{ path: string; merge?: boolean }> }) =>
  ctx.writes.filter((w) => w.path.startsWith('payments/') && w.merge !== true).map((w) => w.path);

/** Writes that move `families/{id}.accountBalanceCents`. THE INVENTED-CREDIT CHECK. */
const balanceMoves = (ctx: { writes: Array<{ path: string; data: Record<string, unknown> }> }) =>
  ctx.writes.filter(
    (w) => w.path.startsWith('families/') && w.data['accountBalanceCents'] !== undefined,
  );

describe('#825 recordPayment: one key, one payment, one credit', () => {
  const args = (over: Record<string, unknown> = {}) => ({
    kinfolkId: 'fam1',
    amount: 100,
    paymentMethod: 'Venmo',
    // AUTO-APPLY ON: the whole payment has no invoice to land on, so all of it
    // becomes account credit. This is the setting that turns a replay into
    // money from nowhere.
    autoApply: true,
    ...over,
  });

  it('records ONE payment row and moves the balance ONCE when the same key is sent twice', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await recordPaymentHandler(req(args({ idempotencyKey: PAY_A })));
    const second = await recordPaymentHandler(req(args({ idempotencyKey: PAY_A })));

    expect(paymentRows(ctx)).toEqual([`payments/${PAY_A}`]);
    expect(balanceMoves(ctx)).toHaveLength(1);
    expect(balanceMoves(ctx)[0].data['accountBalanceCents']).toEqual({ __increment: 10_000 });
    // The retry is ANSWERED, not merely ignored: same row, same figures.
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.creditedToAccountCents).toBe(first.creditedToAccountCents);
    expect(second.amountCents).toBe(10_000);
  });

  it('records TWO payment rows and moves the balance TWICE for two different keys', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await recordPaymentHandler(req(args({ idempotencyKey: PAY_A })));
    await recordPaymentHandler(req(args({ idempotencyKey: PAY_B })));

    // Two genuinely separate payments are still two payments. A key that
    // deduped everything would be a different defect.
    expect(paymentRows(ctx)).toEqual([`payments/${PAY_A}`, `payments/${PAY_B}`]);
    expect(balanceMoves(ctx)).toHaveLength(2);
  });

  it('still writes twice with NO key, which is the unchanged legacy behaviour', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await recordPaymentHandler(req(args()));
    await recordPaymentHandler(req(args()));

    expect(paymentRows(ctx)).toHaveLength(2);
    expect(balanceMoves(ctx)).toHaveLength(2);
  });

  it('answers a replay instead of refusing it, on a payment whose apply settled the invoice', async () => {
    // THE HAZARD THE FAST PATH EXISTS FOR. Attempt 1 applies $100 to a $100
    // invoice. Attempt 2 re-planning that apply would hit
    // `alreadySettledRefusal` and report failed-precondition for a payment that
    // is stored and correct.
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': { kinfolkId: 'fam1', status: 'open', total: 100, invoiceNumber: '1029' } },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const payload = args({
      idempotencyKey: PAY_A,
      autoApply: false,
      apply: { invoiceId: 'inv1', amount: 100 },
    });

    const first = await recordPaymentHandler(req(payload));
    // The invoice doc is now stamped paid by the first attempt's own write, and
    // `writeThrough` means the second attempt reads that stamp. That is what
    // `alreadySettledRefusal` refuses on when there are no recorded payments to
    // reconcile against — so without the fast path this line throws
    // `failed-precondition` on a payment that is stored and correct.
    expect(ctx.writes.find((w) => w.path === 'invoices/inv1')?.data['status']).toBe('paid');

    const second = await recordPaymentHandler(req(payload));

    expect(second.paymentId).toBe(first.paymentId);
    expect(second.application?.invoiceId).toBe('inv1');
    expect(second.application?.state).toBe(first.application?.state);
    expect(second.appliedCents).toBe(10_000);
    expect(paymentRows(ctx)).toEqual([`payments/${PAY_A}`]);
  });

  it("refuses a key that belongs to a different operator rather than handing back their row", async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await recordPaymentHandler(req(args({ idempotencyKey: PAY_A }), 'admin1'));
    await expect(
      recordPaymentHandler(req(args({ idempotencyKey: PAY_A }), 'admin2')),
    ).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('refuses a key that is not the shape the server mints', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      recordPaymentHandler(req(args({ idempotencyKey: 'whatever-i-like' }))),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('#825 markInvoicePaid: one key, one partial payment', () => {
  // A PARTIAL is the case nothing caught before. A retried FULL payment was
  // refused by `alreadySettledRefusal` — badly, but refused. A retried partial
  // leaves a balance, so it looks exactly like a genuine second payment.
  const openInvoice = () => ({ kinfolkId: 'fam1', status: 'open', total: 100, invoiceNumber: '1029' });

  it('writes ONE subcollection row when the same key is sent twice', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': openInvoice() },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await markInvoicePaidHandler(
      req({ invoiceId: 'inv1', amount: 40, idempotencyKey: IPAY_A }),
    );
    const second = await markInvoicePaidHandler(
      req({ invoiceId: 'inv1', amount: 40, idempotencyKey: IPAY_A }),
    );

    const rows = ctx.writes.filter((w) => w.path.startsWith('invoices/inv1/payments/'));
    expect(rows.map((r) => r.path)).toEqual([`invoices/inv1/payments/${IPAY_A}`]);
    // The retry reports what the FIRST attempt did, not what is true now.
    expect(second.paymentId).toBe(first.paymentId);
    expect(second.paidCents).toBe(first.paidCents);
    expect(second.amountDueCents).toBe(first.amountDueCents);
    expect(second.state).toBe(first.state);
  });

  it('writes TWO subcollection rows for two different keys', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': openInvoice() },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: IPAY_A }));
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40, idempotencyKey: IPAY_B }));

    const rows = ctx.writes.filter((w) => w.path.startsWith('invoices/inv1/payments/'));
    expect(rows.map((r) => r.path)).toEqual([
      `invoices/inv1/payments/${IPAY_A}`,
      `invoices/inv1/payments/${IPAY_B}`,
    ]);
  });

  it('still writes twice with NO key', async () => {
    const ctx = buildDbMock({
      writeThrough: true,
      docs: { 'invoices/inv1': openInvoice() },
      queryDocs: { 'invoices/inv1/payments': [] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);

    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40 }));
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40 }));

    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/inv1/payments/'))).toHaveLength(2);
  });
});

describe('#825 createInvoice / createQuote: one key, one invoice, one number', () => {
  const invoiceArgs = (over: Record<string, unknown> = {}) => ({
    familyId: 'fam1',
    date: '2026-09-13',
    dueDate: '2026-09-27',
    total: 100,
    amountDue: 100,
    ...over,
  });

  /** Every write that advanced the shared sequence. THE BURNED-NUMBER CHECK. */
  const counterBumps = (ctx: { writes: Array<{ path: string }> }) =>
    ctx.writes.filter((w) => w.path === INVOICE_NUMBER_COUNTER_PATH);

  it('creates ONE invoice and consumes ONE number when the same key is sent twice', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await createInvoiceHandler(req(invoiceArgs({ idempotencyKey: INV_A })));
    const second = await createInvoiceHandler(req(invoiceArgs({ idempotencyKey: INV_A })));

    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/')).map((w) => w.path)).toEqual([
      `invoices/${INV_A}`,
    ]);
    // The number is the half a duplicate cannot give back. One call, one value.
    expect(counterBumps(ctx)).toHaveLength(1);
    expect(second.invoiceId).toBe(first.invoiceId);
    // And the household is not told about the same invoice twice.
    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('creates TWO invoices and consumes TWO numbers for two different keys', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await createInvoiceHandler(req(invoiceArgs({ idempotencyKey: INV_A })));
    await createInvoiceHandler(req(invoiceArgs({ idempotencyKey: INV_B })));

    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/')).map((w) => w.path)).toEqual([
      `invoices/${INV_A}`,
      `invoices/${INV_B}`,
    ]);
    expect(counterBumps(ctx)).toHaveLength(2);
  });

  it('creates ONE quote and issues it ONCE when the same key is sent twice', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    const first = await createQuoteHandler(
      req(invoiceArgs({ idempotencyKey: QUOT_A, sendToKinfolk: true })),
    );
    const second = await createQuoteHandler(
      req(invoiceArgs({ idempotencyKey: QUOT_A, sendToKinfolk: true })),
    );

    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/')).map((w) => w.path)).toEqual([
      `invoices/${QUOT_A}`,
    ]);
    expect(counterBumps(ctx)).toHaveLength(1);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(mocks.enqueueNotification).toHaveBeenCalledTimes(1);
  });

  it('creates TWO quotes for two different keys', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);

    await createQuoteHandler(req(invoiceArgs({ idempotencyKey: QUOT_A })));
    await createQuoteHandler(req(invoiceArgs({ idempotencyKey: QUOT_B })));

    expect(ctx.writes.filter((w) => w.path.startsWith('invoices/'))).toHaveLength(2);
    expect(counterBumps(ctx)).toHaveLength(2);
  });

  it('refuses a createInvoice key at createQuote, because both write `invoices`', async () => {
    const ctx = buildDbMock({ writeThrough: true, docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      createQuoteHandler(req(invoiceArgs({ idempotencyKey: INV_A }))),
    ).rejects.toThrow();
  });
});
