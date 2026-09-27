import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #977: AUTO-APPLY IN THE TWO-STEP ADMIN FLOW MUST NOT CREDIT THE INVOICE MONEY
 * A SECOND TIME.
 *
 * Admin web (`InvoiceDetail.tsx`, Mark paid) and admin Android
 * (`InvoiceDetailViewModel.recordPayment`) record a payment in two calls:
 *
 *   1. `markInvoicePaid` puts the applied part on the invoice.
 *   2. `recordPayment` writes the ledger row for the WHOLE transaction, with
 *      `invoiceId` as a display link, NO `apply`, `settledByInvoicePaymentId`
 *      naming step 1's row, and `autoApply` from the tick box.
 *
 * Step 2 used to compute the leftover as `amount - tip` (nothing applied, as
 * far as it knew), so with the box ticked the invoice money went into
 * `families/{id}.accountBalanceCents` as well. Account balance is the only
 * place money owed back can go (no refunds, ever), so that credit is spendable
 * and cannot be taken back cleanly.
 *
 * Both handlers run for real against one write-through Firestore mock, with
 * the exact payloads the two clients send (read off the clients, 2026-09-27).
 */

const mocks = vi.hoisted(() => ({
  db: { current: null as unknown },
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => mocks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));
vi.mock('../src/notifications/dispatcher', () => ({
  enqueueNotification: vi.fn().mockResolvedValue([]),
  enqueueNotificationDetailed: vi.fn().mockResolvedValue({ written: [], suppressed: [], unresolved: [] }),
}));
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

import { recordPaymentHandler } from '../src/admin/recordPayment';
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';

type Docs = Record<string, Record<string, unknown> | null>;
let docs: Docs;
let ctx: ReturnType<typeof buildDbMock>;

beforeEach(() => {
  docs = {
    // Invoice #1029: $127.50, open, nothing paid yet.
    'invoices/inv1': {
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      status: 'open',
      invoiceNumber: '1029',
      total: 127.5,
      totalCents: 12750,
      amountDue: 127.5,
      amountDueCents: 12750,
    },
  };
  ctx = buildDbMock({ docs, writeThrough: true });
  mocks.db.current = ctx.db;
});

function adminReq(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/** Every increment staged on the household's account balance, in cents. */
function creditedToFamily(): number {
  return ctx.writes
    .filter((w) => w.path === 'families/fam1')
    .reduce((sum, w) => sum + ((w.data['accountBalanceCents'] as { __increment?: number })?.__increment ?? 0), 0);
}

function ledgerRow(): Record<string, unknown> | undefined {
  return ctx.writes.find((w) => w.path.startsWith('payments/'))?.data;
}

/**
 * Admin web, `InvoiceDetail.tsx` Mark paid. Step 1 carries the Amount box (the
 * applied part); step 2 carries the Payment amount box when she filled it, and
 * otherwise applied + tip.
 */
async function webMarkPaid(opts: { applied: number; tip: number; fee: number; total?: number; autoApply: boolean }) {
  const settled = await markInvoicePaidHandler(
    adminReq({
      invoiceId: 'inv1',
      amount: opts.applied,
      method: 'venmo',
      reference: 'VN-1029',
      idempotencyKey: 'ipay_1759000000000_abc123',
    }),
  );
  const thisPaymentCents = Math.round(opts.applied * 100);
  const typedTotal = opts.total ?? 0;
  const res = await recordPaymentHandler(
    adminReq({
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      date: '2026-09-27',
      paymentMethod: 'venmo',
      referenceNumber: 'VN-1029',
      amount: typedTotal > 0 ? typedTotal : thisPaymentCents / 100 + opts.tip,
      tip: opts.tip,
      fee: opts.fee,
      notes: '',
      autoApply: opts.autoApply,
      sendConfirmationEmail: false,
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      settledByInvoicePaymentId: settled.paymentId,
      idempotencyKey: 'pay_1759000000000_abc123',
    }),
  );
  return { settled, res };
}

/**
 * Admin Android, `InvoiceDetailViewModel.recordPayment`. `buildInvoicePayment`
 * makes `Payment.amount` the TRANSACTION (Payment amount box, else Amount + tip),
 * and the view model sends that same `payment.amount` to BOTH steps.
 */
async function androidRecordPayment(opts: { applied: number; tip: number; fee: number; total?: number; autoApply: boolean }) {
  const paymentAmount = (opts.total ?? 0) > 0 ? opts.total! : opts.applied + opts.tip;
  const settled = await markInvoicePaidHandler(
    adminReq({
      invoiceId: 'inv1',
      amount: paymentAmount,
      method: 'venmo',
      reference: 'VN-1029',
      idempotencyKey: 'ipay_1759000000001_def456',
    }),
  );
  const res = await recordPaymentHandler(
    adminReq({
      settledByInvoicePaymentId: settled.paymentId,
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      address: '',
      date: '2026-09-27',
      paymentMethod: 'venmo',
      referenceNumber: 'VN-1029',
      email: '',
      amount: paymentAmount,
      tip: opts.tip,
      fee: opts.fee,
      notes: '',
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      autoApply: opts.autoApply,
      sendConfirmationEmail: false,
      idempotencyKey: 'pay_1759000000001_def456',
    }),
  );
  return { settled, res };
}

describe('#977 admin web two-step Mark paid, auto-apply ticked', () => {
  it('credits nothing when the payment is exactly the invoice plus the tip', async () => {
    // The issue's example: $127.50 invoice, $10 gross tip, $2.71 fee.
    const { settled, res } = await webMarkPaid({ applied: 127.5, tip: 10, fee: 2.71, autoApply: true });
    expect(settled.state).toBe('settled');
    expect(res.creditedToAccountCents).toBe(0);
    expect(creditedToFamily()).toBe(0);
    // The row says what happened to the money: the invoice took $127.50, the
    // tip is $10, nothing is left over.
    expect(res.appliedCents).toBe(12750);
    expect(res.unappliedCents).toBe(0);
    expect(ledgerRow()).toMatchObject({ appliedCents: 12750, unappliedCents: 0, creditedToAccountCents: 0 });
  });

  it('credits exactly the real leftover when the payment was larger', async () => {
    // $200 in: $127.50 on the invoice, $10 tip, $62.50 left over.
    const { res } = await webMarkPaid({ applied: 127.5, tip: 10, fee: 2.71, total: 200, autoApply: true });
    expect(res.unappliedCents).toBe(6250);
    expect(res.creditedToAccountCents).toBe(6250);
    expect(creditedToFamily()).toBe(6250);
  });

  it('keeps the gross tip and the fee on the row, fee out of the tip', async () => {
    const { res } = await webMarkPaid({ applied: 127.5, tip: 10, fee: 2.71, autoApply: true });
    expect(res.tipCents).toBe(1000);
    expect(res.feeCents).toBe(271);
    expect(res.tipNetCents).toBe(729);
    expect(res.proceedsCents).toBe(13750 - 271);
    expect(ledgerRow()).toMatchObject({ tip: 10, tipCents: 1000, fee: 2.71, feeCents: 271, tipBasis: 'gross' });
  });

  it('a partial payment credits nothing either', async () => {
    const { settled, res } = await webMarkPaid({ applied: 50, tip: 5, fee: 0, autoApply: true });
    expect(settled.state).toBe('partial');
    expect(res.creditedToAccountCents).toBe(0);
    expect(creditedToFamily()).toBe(0);
  });
});

describe('#977 admin Android two-step recordPayment, auto-apply ticked', () => {
  it('credits none of the invoice money to the account balance', async () => {
    const { res } = await androidRecordPayment({ applied: 127.5, tip: 10, fee: 2.71, autoApply: true });
    expect(res.creditedToAccountCents).toBe(0);
    expect(creditedToFamily()).toBe(0);
  });
});

describe('#977 a linked row whose applied part cannot be read gets no credit', () => {
  it('an install from before #866 (no settledByInvoicePaymentId) credits nothing', async () => {
    await markInvoicePaidHandler(adminReq({ invoiceId: 'inv1', amount: 127.5, method: 'venmo' }));
    const res = await recordPaymentHandler(
      adminReq({ kinfolkId: 'fam1', amount: 137.5, tip: 10, invoiceId: 'inv1', invoiceNumber: '1029', autoApply: true }),
    );
    expect(res.creditedToAccountCents).toBe(0);
    expect(creditedToFamily()).toBe(0);
    // Still recorded, with the figure she would need to credit it by hand.
    expect(ledgerRow()).toMatchObject({ amountCents: 13750, autoApply: true, creditedToAccountCents: 0 });
  });

  it('a settlement id that names no row under that invoice credits nothing', async () => {
    const res = await recordPaymentHandler(
      adminReq({
        kinfolkId: 'fam1',
        amount: 137.5,
        tip: 10,
        invoiceId: 'inv1',
        autoApply: true,
        settledByInvoicePaymentId: 'ipay_does_not_exist',
      }),
    );
    expect(res.creditedToAccountCents).toBe(0);
    expect(creditedToFamily()).toBe(0);
  });

  it('a standalone payment (no invoice) is untouched: no household, no credit, nothing read', async () => {
    const res = await recordPaymentHandler(adminReq({ amount: 300, autoApply: true }));
    expect(res.appliedCents).toBe(0);
    expect(res.unappliedCents).toBe(30000);
    expect(res.creditedToAccountCents).toBe(0);
  });
});

describe('#977 the single-call shape with `apply` (desktop after #881, PR #978) is unchanged', () => {
  /** The exact payload `recordPaymentPayload` builds on fix/881-desktop-record-payment. */
  function desktopPayload(over: Record<string, unknown> = {}) {
    return {
      kinfolkId: 'fam1',
      kinfolkName: 'The Riveras',
      client: 'Ana Rivera',
      date: '2026-09-27',
      paymentMethod: 'venmo',
      referenceNumber: 'VN-1029',
      amount: 200,
      tip: 10,
      fee: 2.71,
      notes: '',
      invoiceId: 'inv1',
      invoiceNumber: '1029',
      apply: { invoiceId: 'inv1', invoiceNumber: '1029', amount: 127.5 },
      autoApply: true,
      sendConfirmationEmail: false,
      idempotencyKey: 'pay_1759000000002_ghi789',
      ...over,
    };
  }

  it('applies once and credits amount - apply - tip', async () => {
    const res = await recordPaymentHandler(adminReq(desktopPayload()));
    expect(res.application).toMatchObject({ invoiceId: 'inv1', appliedCents: 12750, state: 'settled' });
    expect(res.appliedCents).toBe(12750);
    expect(res.unappliedCents).toBe(6250);
    expect(res.creditedToAccountCents).toBe(6250);
    expect(creditedToFamily()).toBe(6250);
    expect(ledgerRow()).toMatchObject({ appliedInvoiceId: 'inv1', settledByInvoicePaymentId: '' });
  });

  it('`apply` wins over a settlement id sent beside it: no second read, no second deduction', async () => {
    const res = await recordPaymentHandler(adminReq(desktopPayload({ settledByInvoicePaymentId: 'ipay_other' })));
    expect(res.appliedCents).toBe(12750);
    expect(res.creditedToAccountCents).toBe(6250);
  });
});

describe('#977 the stored row and a replay agree', () => {
  it('records which settlement the applied part came from', async () => {
    const { settled } = await webMarkPaid({ applied: 127.5, tip: 10, fee: 2.71, total: 200, autoApply: true });
    expect(ledgerRow()).toMatchObject({
      appliedInvoiceId: '',
      appliedCents: 12750,
      unappliedCents: 6250,
      creditedToAccountCents: 6250,
      settledByInvoicePaymentId: settled.paymentId,
    });
  });

  it('a same-key retry answers with the first figures and credits nothing more', async () => {
    const { settled, res: first } = await webMarkPaid({ applied: 127.5, tip: 10, fee: 2.71, total: 200, autoApply: true });
    const again = await recordPaymentHandler(
      adminReq({
        kinfolkId: 'fam1',
        amount: 200,
        tip: 10,
        fee: 2.71,
        invoiceId: 'inv1',
        autoApply: true,
        settledByInvoicePaymentId: settled.paymentId,
        idempotencyKey: 'pay_1759000000000_abc123',
      }),
    );
    expect(again.paymentId).toBe(first.paymentId);
    expect(again.appliedCents).toBe(12750);
    expect(again.unappliedCents).toBe(6250);
    expect(again.creditedToAccountCents).toBe(6250);
    expect(creditedToFamily()).toBe(6250);
  });
});
