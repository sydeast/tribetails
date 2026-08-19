import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDbMock } from './_helpers/mockDb';
import { CallableRequest } from 'firebase-functions/v2/https';

const mocks = vi.hoisted(() => ({
  dbFn: vi.fn(),
}));
vi.mock('../src/lib/firestoreAdmin', () => ({ db: mocks.dbFn, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('firebase-admin/firestore', async () => {
  const actual = await vi.importActual<any>('firebase-admin/firestore');
  return { ...actual, FieldValue: { serverTimestamp: () => '__TS__' } };
});

import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function req(data: unknown, uid: string | null = 'admin1'): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: { admin: true } as any } as any) : undefined,
    rawRequest: {} as any, instanceIdToken: undefined, acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * @param payments the `invoices/inv1/payments` SUBCOLLECTION. The callable
 *   derives the invoice's whole state from the sum of these, so almost every
 *   test below is really a statement about this argument.
 */
function seed(
  invoice: Record<string, unknown> | null = {
    kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40,
  },
  payments: Array<{ id: string; data: Record<string, unknown> }> = [],
) {
  return buildDbMock({
    docs: { 'invoices/inv1': invoice },
    queryDocs: { 'invoices/inv1/payments': payments },
  });
}

function invoiceWriteOf(ctx: ReturnType<typeof seed>) {
  return ctx.writes.find((w) => w.path === 'invoices/inv1');
}

function paymentWriteOf(ctx: ReturnType<typeof seed>) {
  return ctx.writes.find((w) => w.path.startsWith('invoices/inv1/payments/'));
}

describe('markInvoicePaid happy path', () => {
  it('flips the invoice to paid + zeroes amountDue and returns a paymentId', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    expect(res.invoiceId).toBe('inv1');
    expect(res.paymentId).toBeTruthy();
    expect(res.state).toBe('settled');
    const w = invoiceWriteOf(ctx);
    expect(w?.data.status).toBe('paid');
    expect(w?.data.amountDue).toBe(0);
    expect(w?.data.paidBy).toBe('admin1');
  });

  it('writes a payments subcollection entry with method/reference/paidAt/recordedBy', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', method: 'check', reference: 'CK-100', amount: 40 }));
    const p = paymentWriteOf(ctx);
    expect(p).toBeTruthy();
    expect(p!.data.amount).toBe(40);
    expect(p!.data.amountCents).toBe(4000);
    expect(p!.data.method).toBe('check');
    expect(p!.data.reference).toBe('CK-100');
    expect(p!.data.recordedBy).toBe('admin1');
    expect(p!.data.paidAt).toBeTypeOf('string');
  });

  it('defaults the payment amount to what the recorded payments leave outstanding', async () => {
    // NOT to the `amountDue` scalar. On an invoice the old write already zeroed,
    // that scalar reads 0 while a real balance is owed, so defaulting to it
    // would record a $0 payment and change nothing at all.
    const ctx = seed(
      { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 0, total: 40 },
      [{ id: 'p1', data: { amount: 15 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1' }));
    expect(paymentWriteOf(ctx)!.data.amount).toBe(25);
  });

  it('writes a BILLING_INVOICE_PAID audit entry', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', method: 'cash' }));
    expect(writeAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'BILLING_INVOICE_PAID', targetUid: 'inv1', familyId: 'fam1' }),
    );
  });
});

describe('markInvoicePaid validation + sad paths', () => {
  it('rejects blank invoiceId (invalid-argument)', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: '' }))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects missing invoice (not-found)', async () => {
    const ctx = buildDbMock({ docs: {} });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'nope' }))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an invoice marked paid with no recorded payments to reconcile against', async () => {
    // The Stripe path (`stripeWebhook.ts`) records into the ROOT `payments`
    // collection, so a genuinely card-paid invoice has an EMPTY subcollection.
    // With no evidence of a partial, the label is the only evidence there is and
    // it is believed, or an operator would be invited to double-collect.
    const ctx = seed({ kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('rejects an invoice whose recorded payments already cover it', async () => {
    const ctx = seed(
      { kinfolkId: 'fam1', status: 'paid', amountDue: 0, total: 40 },
      [{ id: 'p1', data: { amount: 40 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('refuses a payment against a cancelled invoice', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'cancelled', amountDue: 40, total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('refuses a payment against a credit, whose money points the other way', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'credit', amountDue: -25, total: -25 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  it('rejects a draft invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'draft', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects a quote invoice (failed-precondition)', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'QUOTE', total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }))).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('rejects unauthenticated caller', async () => {
    mocks.dbFn.mockReturnValue(seed().db);
    await expect(markInvoicePaidHandler(req({ invoiceId: 'inv1' }, null))).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
/**
 * THE DEFECT THIS FILE'S SUBCOLLECTION ARGUMENT EXISTS FOR.
 *
 * Before 2026-07-25 the callable wrote `status: 'paid', amountDue: 0` with no
 * reference to how much was collected, so $20 against a $40 invoice read PAID
 * with $0 due, dropped out of Outstanding, and could never receive the balance
 * because the next call was refused as already-paid.
 */
describe('markInvoicePaid: partial payments', () => {
  const FORTY = { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40 };
  it('leaves a part-paid invoice OPEN with the real remaining balance', async () => {
    const ctx = seed(FORTY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20 }));
    expect(res.state).toBe('partial');
    expect(res.paidCents).toBe(2000);
    expect(res.amountDueCents).toBe(2000);
    expect(res.overpaidCents).toBe(0);
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('open');
    expect(w.data.amountDue).toBe(20);
    expect(w.data.amountDueCents).toBe(2000);
    expect(w.data.paidCents).toBe(2000);
    expect(w.data.totalCents).toBe(4000);
    expect(w.data.paymentStatus).toBe('PARTIAL');
  });
  it('does NOT stamp paidAt/paidBy on a partial, because the invoice is not paid', async () => {
    const ctx = seed(FORTY);
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20 }));
    const w = invoiceWriteOf(ctx)!;
    expect(w.data).not.toHaveProperty('paidAt');
    expect(w.data).not.toHaveProperty('paidBy');
    // The payment itself is still stamped, under a name that claims only what happened.
    expect(w.data.lastPaymentBy).toBe('admin1');
  });
  it('ACCEPTS THE SECOND PAYMENT and settles the invoice with it', async () => {
    // The refusal this replaces is what made the balance unrecoverable.
    const ctx = seed(
      { ...FORTY, status: 'open', amountDue: 20 },
      [{ id: 'p1', data: { amount: 20, amountCents: 2000 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20 }));
    expect(res.state).toBe('settled');
    expect(res.paidCents).toBe(4000);
    expect(res.amountDueCents).toBe(0);
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('paid');
    expect(w.data.amountDue).toBe(0);
    expect(w.data.paidBy).toBe('admin1');
  });
  it('collects the balance on an invoice ALREADY CORRUPTED by the old write', async () => {
    // status 'paid', amountDue 0, but only half the money on record. This is the
    // exact shape in production, and the callable must not refuse it.
    const ctx = seed(
      { kinfolkId: 'fam1', status: 'paid', paymentStatus: 'PAID', amountDue: 0, total: 40 },
      [{ id: 'p1', data: { amount: 20 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20 }));
    expect(res.state).toBe('settled');
    expect(res.amountDueCents).toBe(0);
    expect(invoiceWriteOf(ctx)!.data.amountDue).toBe(0);
  });
  it('settles in one payment when the amount matches the total exactly', async () => {
    const ctx = seed(FORTY);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40 }));
    expect(res.state).toBe('settled');
    expect(res.amountDueCents).toBe(0);
    expect(invoiceWriteOf(ctx)!.data.status).toBe('paid');
  });
  it('sums three partials rather than reading only the newest', async () => {
    const ctx = seed(
      { ...FORTY, amountDue: 25 },
      [
        { id: 'p1', data: { amount: 10 } },
        { id: 'p2', data: { amount: 5, amountCents: 500 } },
      ],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 5 }));
    expect(res.paidCents).toBe(2000);
    expect(res.amountDueCents).toBe(2000);
    expect(res.state).toBe('partial');
  });
  it('handles a fractional-dollar partial without float drift', async () => {
    const ctx = seed({ ...FORTY, total: 30.3 }, [{ id: 'p1', data: { amount: 10.1 } }]);
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 10.1 }));
    expect(res.paidCents).toBe(2020);
    expect(res.amountDueCents).toBe(1010);
    expect(invoiceWriteOf(ctx)!.data.amountDue).toBe(10.1);
  });
});
describe('markInvoicePaid: overpayment', () => {
  it('settles the invoice, clamps amountDue at zero, and reports the excess', async () => {
    // A negative amountDue is this codebase's CREDIT signal, so writing one here
    // would silently turn an over-collected invoice into a credit owed back to
    // the household. The excess is recorded as a fact instead.
    const ctx = seed({ kinfolkId: 'fam1', status: 'open', amountDue: 39.5, total: 39.5 });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40 }));
    expect(res.state).toBe('overpaid');
    expect(res.amountDueCents).toBe(0);
    expect(res.overpaidCents).toBe(50);
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('paid');
    expect(w.data.amountDue).toBe(0);
    expect(w.data.overpaidCents).toBe(50);
  });
  it('never writes a negative amountDue however large the overpayment', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'open', amountDue: 40, total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 500 }));
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.amountDue).toBe(0);
    expect(w.data.amountDueCents).toBe(0);
    expect(w.data.overpaidCents).toBe(46000);
  });
});
describe('markInvoicePaid audit trail', () => {
  it('says "partial" rather than "paid" when the invoice is not paid', async () => {
    const ctx = seed({ kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 40, total: 40 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20 }));
    const entry = (writeAuditEntry as any).mock.calls[0][0];
    expect(entry.description).toContain('Partial payment');
    expect(entry.payload.state).toBe('partial');
    expect(entry.payload.amountDueCents).toBe(2000);
  });
});
describe('markInvoicePaid state stamp (ADR-0002)', () => {
  it('a PARTIAL payment stamps open/all in the same batch: outstanding and fully editable', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 20 }));
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('open');
    expect(w.data.editScope).toBe('all');
  });
  it('a SETTLING payment stamps paid/none', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40 }));
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('paid');
    expect(w.data.editScope).toBe('none');
  });
  it('an OVERPAYMENT stamps paid/none off the clamped balance, never credit', async () => {
    const ctx = seed({ kinfolkId: 'fam1', status: 'open', amountDue: 39.5, total: 39.5 });
    mocks.dbFn.mockReturnValue(ctx.db);
    await markInvoicePaidHandler(req({ invoiceId: 'inv1', amount: 40 }));
    const w = invoiceWriteOf(ctx)!;
    // amountDue clamps at 0 (a negative is this codebase's credit signal), so
    // the classifier reads the persisted doc as paid, exactly as intended.
    expect(w.data.status).toBe('paid');
    expect(w.data.editScope).toBe('none');
    expect(w.data.amountDue).toBe(0);
  });
  it('settling the SECOND HALF of a part-paid invoice stamps paid/none from the summed evidence', async () => {
    const ctx = seed(
      { kinfolkId: 'fam1', invoiceNumber: 'INV-9', status: 'open', amountDue: 20, total: 40 },
      [{ id: 'p1', data: { amount: 20, amountCents: 2000 } }],
    );
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1' }));
    expect(res.state).toBe('settled');
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('paid');
    expect(w.data.editScope).toBe('none');
  });
});

/**
 * ISSUE #448: locking an accepted quote must not stop it being PAID.
 *
 * The lock is on editing what was agreed. The bill the household agreed to is
 * exactly the bill they are about to settle, and a quote that could be accepted
 * and then never collected would be a worse defect than the one #448 reports.
 */
describe('markInvoicePaid on a quote the household accepted', () => {
  it('collects it, and leaves the doc locked afterwards', async () => {
    const ctx = seed({
      kinfolkId: 'fam1',
      invoiceNumber: 'Q-1001',
      // What acceptQuote leaves: an open bill carrying the household answer.
      status: 'open',
      invoiceStatus: 'open',
      editScope: 'none',
      quoteDecision: 'accepted',
      amountDue: 240,
      total: 240,
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await markInvoicePaidHandler(req({ invoiceId: 'inv1' }));
    expect(res.ok).toBe(true);
    expect(res.state).toBe('settled');
    const w = invoiceWriteOf(ctx)!;
    expect(w.data.status).toBe('paid');
    expect(w.data.amountDue).toBe(0);
    // Still locked, now by the payment as well as by the agreement.
    expect(w.data.editScope).toBe('none');
  });
});
