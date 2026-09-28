import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallableRequest } from 'firebase-functions/v2/https';

import { buildDbMock } from './_helpers/mockDb';

const mocks = vi.hoisted(() => ({ dbFn: vi.fn() }));
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
      increment: (n: number) => ({ __increment: n }),
    },
  };
});

import {
  resolveUnappliedPaymentHandler,
  Result,
  unappliedCreditEventId,
} from '../src/admin/resolveUnappliedPayment';
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../src/lib/auditEvents';
import { PAYMENT_APPLIED_OWNER_FIELD } from '../src/lib/paymentAppliedOwner';
import { readCreditLedgerEvent, creditHistoryOf } from '../src/lib/creditLedger';

/**
 * #1003: the owner decides what an unapplied card payment becomes. Account
 * credit (through the Q6 ledger), another open invoice of the same household,
 * a mix, or kept as recorded. Never a refund; never a paid invoice.
 */

const KEY = 'upd_1790000000000_abc123';
const PAY = 'evt_dup_1';

function req(
  data: unknown,
  token: Record<string, unknown> = { admin: true },
  uid: string | null = 'owner1',
): CallableRequest<unknown> {
  return {
    data,
    auth: uid ? ({ uid, token: token as any } as any) : undefined,
    rawRequest: {} as any,
    instanceIdToken: undefined,
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

const unappliedRow = {
  kinfolkId: 'fam1',
  invoiceId: 'inv_paid',
  amount: 50,
  amountCents: 5000,
  amountResolved: true,
  amountSource: 'stripe-event',
  paymentMethod: 'stripe',
  referenceNumber: 'pi_2',
  appliedToInvoice: false,
  appliedTo: 'unapplied',
  needsAdminDecision: true,
  creditedToAccountCents: 0,
  duplicateCheckoutReason: 'invoice-marked-paid',
};

const openInvoice = {
  kinfolkId: 'fam1',
  invoiceNumber: 'INV-2',
  status: 'open',
  totalCents: 3000,
  amountDueCents: 3000,
};

function seed(opts: {
  payment?: Record<string, unknown> | null;
  family?: Record<string, unknown> | null;
  invoices?: Record<string, Record<string, unknown> | null>;
  invoicePayments?: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
} = {}) {
  const docs: Record<string, Record<string, unknown> | null> = {
    [`payments/${PAY}`]: opts.payment === undefined ? { ...unappliedRow } : opts.payment,
    'families/fam1': opts.family === undefined ? { accountBalanceCents: 1200 } : opts.family,
    'invoices/inv_open': { ...openInvoice },
    'invoices/inv_paid': { kinfolkId: 'fam1', invoiceNumber: 'INV-1', status: 'paid', totalCents: 5000, amountDueCents: 0 },
  };
  for (const [k, v] of Object.entries(opts.invoices ?? {})) docs[`invoices/${k}`] = v;
  const queryDocs: Record<string, Array<{ id: string; data: Record<string, unknown> }>> = {};
  for (const [k, v] of Object.entries(opts.invoicePayments ?? {})) queryDocs[`invoices/${k}/payments`] = v;
  return buildDbMock({ docs, queryDocs, writeThrough: true });
}

const creditOnly = {
  paymentId: PAY,
  creditCents: 5000,
  creditReason: 'Second card charge on a paid bill',
  applyInvoiceId: '',
  applyCents: 0,
  idempotencyKey: KEY,
};

beforeEach(() => {
  mocks.dbFn.mockReset();
  (writeAuditEntry as any).mockClear();
});

function paymentWrite(ctx: ReturnType<typeof seed>) {
  return ctx.writes.filter((w) => w.path === `payments/${PAY}`).at(-1);
}

describe('resolveUnappliedPayment: account credit', () => {
  it('puts all of it into account credit through the Q6 ledger, and clears the flag', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await resolveUnappliedPaymentHandler(req(creditOnly));

    expect(Result.parse(res)).toEqual({
      ok: true,
      paymentId: PAY,
      kinfolkId: 'fam1',
      paymentCents: 5000,
      creditedCents: 5000,
      creditId: unappliedCreditEventId(PAY),
      appliedCents: 0,
      appliedInvoiceId: '',
      appliedInvoiceNumber: '',
      appliedInvoiceState: '',
      appliedInvoiceAmountDueCents: 0,
      keptCents: 0,
      newAccountBalanceCents: 6200,
      replayed: false,
    });
    const event = ctx.writes.find((w) => w.path === `families/fam1/creditLedger/unapplied_${PAY}`);
    expect(event?.data).toMatchObject({
      kind: 'given',
      amountCents: 5000,
      reason: 'Second card charge on a paid bill',
      givenBy: 'owner1',
      balanceBeforeCents: 1200,
      balanceAfterCents: 6200,
      sourcePaymentId: PAY,
    });
    // The history reads it like any other given credit, reason and all.
    const read = readCreditLedgerEvent(event!.id ?? `unapplied_${PAY}`, event!.data);
    expect(creditHistoryOf(read ? [read] : []).credits[0]).toMatchObject({
      amountCents: 5000,
      reason: 'Second card charge on a paid bill',
      remainingCents: 5000,
    });
    const fam = ctx.writes.find((w) => w.path === 'families/fam1');
    expect(fam?.data['accountBalanceCents']).toBe(6200);

    const row = paymentWrite(ctx);
    expect(row?.merge).toBe(true);
    expect(row?.data).toMatchObject({
      needsAdminDecision: false,
      appliedTo: 'adminDecision',
      appliedToInvoice: false,
      appliedInvoiceId: '',
      appliedCents: 0,
      creditedToAccountCents: 5000,
      decidedBy: 'owner1',
      adminDecision: { creditedCents: 5000, keptCents: 0, idempotencyKey: KEY, decidedBy: 'owner1' },
    });
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('credits part of it and keeps the rest recorded on the payment', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await resolveUnappliedPaymentHandler(req({ ...creditOnly, creditCents: 1500 }));
    expect(res).toMatchObject({ creditedCents: 1500, keptCents: 3500, newAccountBalanceCents: 2700 });
  });

  it('writes one audit entry at a fixed id', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await resolveUnappliedPaymentHandler(req(creditOnly));
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
    expect((writeAuditEntry as any).mock.calls[0][0]).toMatchObject({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.BILLING_UNAPPLIED_PAYMENT_DECIDED,
      actorUid: 'owner1',
      familyId: 'fam1',
      targetCollection: 'payments',
      docId: `unapplied_payment_decided_${PAY}`,
      payload: { creditedCents: 5000, appliedCents: 0, keptCents: 0, idempotencyKey: KEY },
    });
  });

  it('refuses a credit with no reason, before any read', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...creditOnly, creditReason: '   ' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(ctx.writes).toHaveLength(0);
  });
});

describe('resolveUnappliedPayment: apply to another open invoice', () => {
  const applyOnly = { ...creditOnly, creditCents: 0, creditReason: '', applyInvoiceId: 'inv_open', applyCents: 3000 };

  it('applies to an open invoice of the same household through the recordPayment rows', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);

    const res = await resolveUnappliedPaymentHandler(req(applyOnly));

    expect(res).toMatchObject({
      creditedCents: 0,
      creditId: '',
      appliedCents: 3000,
      appliedInvoiceId: 'inv_open',
      appliedInvoiceNumber: 'INV-2',
      appliedInvoiceState: 'settled',
      appliedInvoiceAmountDueCents: 0,
      keptCents: 2000,
    });
    const sub = ctx.writes.find((w) => w.path.startsWith('invoices/inv_open/payments/'));
    expect(sub?.data).toMatchObject({ amountCents: 3000, sourcePaymentId: PAY, method: 'stripe', reference: 'pi_2' });
    const inv = ctx.writes.find((w) => w.path === 'invoices/inv_open');
    expect(inv?.data).toMatchObject({ status: 'paid', paymentStatus: 'PAID', amountDueCents: 0 });
    // No notice owner is stamped, so onInvoicesWrite tells the household as for
    // any other payment that clears a bill (this callable sends nothing).
    expect(inv?.data).not.toHaveProperty(PAYMENT_APPLIED_OWNER_FIELD);
    // No credit was given, so the ledger and the balance are untouched.
    expect(ctx.writes.some((w) => w.path.startsWith('families/fam1'))).toBe(false);
    expect(paymentWrite(ctx)?.data).toMatchObject({
      needsAdminDecision: false,
      appliedToInvoice: true,
      appliedInvoiceId: 'inv_open',
      appliedInvoiceNumber: 'INV-2',
      appliedCents: 3000,
      creditedToAccountCents: 0,
    });
  });

  it('a partial apply leaves the invoice open with what is still due', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await resolveUnappliedPaymentHandler(req({ ...applyOnly, applyCents: 1000 }));
    expect(res).toMatchObject({ appliedInvoiceState: 'partial', appliedInvoiceAmountDueCents: 2000, keptCents: 4000 });
    const inv = ctx.writes.find((w) => w.path === 'invoices/inv_open');
    expect(inv?.data).toMatchObject({ status: 'open', paymentStatus: 'PARTIAL' });
  });

  it('REFUSES a paid invoice, by label, even with partial payments recorded (the admin exception planApply keeps)', async () => {
    const ctx = seed({
      invoices: {
        inv_label_paid: { kinfolkId: 'fam1', invoiceNumber: 'INV-3', status: 'paid', paymentStatus: 'PAID', totalCents: 4000, amountDueCents: 2000 },
      },
      invoicePayments: { inv_label_paid: [{ id: 'p1', data: { amountCents: 2000, amount: 20 } }] },
    });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyInvoiceId: 'inv_label_paid', applyCents: 1000 })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_already_paid' } });
    expect(ctx.writes).toHaveLength(0);
  });

  it('REFUSES the paid invoice the charge came in on', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyInvoiceId: 'inv_paid', applyCents: 1000 })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'invoice_already_paid' } });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses another household’s invoice', async () => {
    const ctx = seed({ invoices: { inv_other: { ...openInvoice, kinfolkId: 'fam2' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyInvoiceId: 'inv_other' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'apply_wrong_household' } });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a draft, and a missing invoice', async () => {
    const ctx = seed({ invoices: { inv_draft: { ...openInvoice, status: 'draft' } } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyInvoiceId: 'inv_draft' })),
    ).rejects.toMatchObject({ details: { code: 'apply_invoice_not_sent' } });
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyInvoiceId: 'inv_none' })),
    ).rejects.toMatchObject({ details: { code: 'apply_invoice_not_found' } });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses more than the invoice owes', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyCents: 3001 })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'apply_exceeds_due' } });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses an amount with no invoice, and an invoice with no amount', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyInvoiceId: '' })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(
      resolveUnappliedPaymentHandler(req({ ...applyOnly, applyCents: 0 })),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

describe('resolveUnappliedPayment: a mix, and the bound', () => {
  const mix = {
    ...creditOnly,
    creditCents: 2000,
    creditReason: 'Rest of the second charge',
    applyInvoiceId: 'inv_open',
    applyCents: 3000,
  };

  it('credits part and applies part in one transaction', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await resolveUnappliedPaymentHandler(req(mix));
    expect(res).toMatchObject({
      creditedCents: 2000,
      appliedCents: 3000,
      appliedInvoiceState: 'settled',
      keptCents: 0,
      newAccountBalanceCents: 3200,
    });
    expect(ctx.writes.some((w) => w.path === `families/fam1/creditLedger/unapplied_${PAY}`)).toBe(true);
    expect(ctx.writes.some((w) => w.path.startsWith('invoices/inv_open/payments/'))).toBe(true);
    expect(ctx.db.runTransaction).toHaveBeenCalledTimes(1);
  });

  it('REFUSES parts that add up to more than the payment, and writes nothing', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req({ ...mix, creditCents: 2001 })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'decision_exceeds_payment' } });
    await expect(
      resolveUnappliedPaymentHandler(req({ ...creditOnly, creditCents: 5001 })),
    ).rejects.toMatchObject({ details: { code: 'decision_exceeds_payment' } });
    expect(ctx.writes).toHaveLength(0);
  });

  it('an all-zero decision keeps it as recorded and clears the flag', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const res = await resolveUnappliedPaymentHandler(req({ ...creditOnly, creditCents: 0, creditReason: '' }));
    expect(res).toMatchObject({ creditedCents: 0, appliedCents: 0, keptCents: 5000, creditId: '' });
    expect(ctx.writes.map((w) => w.path)).toEqual([`payments/${PAY}`]);
    expect(paymentWrite(ctx)?.data).toMatchObject({ needsAdminDecision: false, creditedToAccountCents: 0 });
  });

  it('a payment Stripe gave no amount for takes only the all-zero decision', async () => {
    const ctx = seed({ payment: { ...unappliedRow, amount: null, amountCents: null, amountResolved: false } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveUnappliedPaymentHandler(req({ ...creditOnly, creditCents: 1 }))).rejects.toMatchObject({
      details: { code: 'payment_amount_unknown' },
    });
    expect(ctx.writes).toHaveLength(0);
    const res = await resolveUnappliedPaymentHandler(req({ ...creditOnly, creditCents: 0, creditReason: '' }));
    expect(res).toMatchObject({ paymentCents: 0, keptCents: 0 });
  });
});

describe('resolveUnappliedPayment: idempotency', () => {
  it('the same key replays the stored decision and writes nothing more', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    const first = await resolveUnappliedPaymentHandler(req(creditOnly));
    const writes = ctx.writes.length;
    const again = await resolveUnappliedPaymentHandler(req(creditOnly));
    expect(again).toEqual({ ...first, replayed: true });
    expect(ctx.writes).toHaveLength(writes);
    expect(writeAuditEntry).toHaveBeenCalledTimes(1);
  });

  it('a different key on a decided payment is refused, not replayed, and adds no credit', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await resolveUnappliedPaymentHandler(req(creditOnly));
    const writes = ctx.writes.length;
    await expect(
      resolveUnappliedPaymentHandler(req({ ...creditOnly, idempotencyKey: 'upd_1790000000001_zzz' })),
    ).rejects.toMatchObject({ code: 'failed-precondition', details: { code: 'already_decided' } });
    expect(ctx.writes).toHaveLength(writes);
  });

  it('the same key from another admin is refused', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await resolveUnappliedPaymentHandler(req(creditOnly));
    await expect(
      resolveUnappliedPaymentHandler(req(creditOnly, { admin: true }, 'owner2')),
    ).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('a payment that never needed a decision is refused', async () => {
    const ctx = seed({ payment: { kinfolkId: 'fam1', amountCents: 5000, appliedTo: 'invoice' } });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveUnappliedPaymentHandler(req(creditOnly))).rejects.toMatchObject({
      details: { code: 'no_decision_needed' },
    });
  });

  it('a missing payment is not-found', async () => {
    const ctx = seed({ payment: null });
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveUnappliedPaymentHandler(req(creditOnly))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a key of the wrong shape', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const idempotencyKey of ['crd_1790000000000_abc', 'upd_12_x', '']) {
      await expect(resolveUnappliedPaymentHandler(req({ ...creditOnly, idempotencyKey }))).rejects.toMatchObject({
        code: 'invalid-argument',
      });
    }
  });
});

describe('resolveUnappliedPayment: who', () => {
  it('refuses an Auntie before any read, even with an admin claim beside it', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    for (const token of [{ staffRole: 'auntie' }, { staffRole: 'auntie', admin: true }]) {
      await expect(resolveUnappliedPaymentHandler(req(creditOnly, token, 'auntie1'))).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'This is not available to caretaker accounts.',
      });
    }
    expect(mocks.dbFn).not.toHaveBeenCalled();
  });

  it('refuses kinfolk, and a signed-out caller', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(resolveUnappliedPaymentHandler(req(creditOnly, {}, 'kin1'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(resolveUnappliedPaymentHandler(req(creditOnly, {}, null))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(ctx.writes).toHaveLength(0);
  });

  it('refuses a sandbox admin outside their test tribe, and admits one inside it', async () => {
    const ctx = seed();
    mocks.dbFn.mockReturnValue(ctx.db);
    await expect(
      resolveUnappliedPaymentHandler(req(creditOnly, { testTribeId: 'test-kinfolk-001' }, 'tester')),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(ctx.writes).toHaveLength(0);

    const inside = buildDbMock({
      docs: {
        [`payments/${PAY}`]: { ...unappliedRow, kinfolkId: 'test-kinfolk-001' },
        'families/test-kinfolk-001': {},
      },
      writeThrough: true,
    });
    mocks.dbFn.mockReturnValue(inside.db);
    const res = await resolveUnappliedPaymentHandler(
      req(creditOnly, { testTribeId: 'test-kinfolk-001' }, 'tester'),
    );
    expect(res.creditedCents).toBe(5000);
  });
});
