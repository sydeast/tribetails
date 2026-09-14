import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallableRequest } from 'firebase-functions/v2/https';
import { buildDbMock } from './_helpers/mockDb';

/**
 * #866: ONE `invoice.payment.applied` PER PAYMENT, counted across every sender.
 *
 * Each unit suite (recordPayment, markInvoicePaid, stripeWebhook, the credit
 * draw) mocks the invoice trigger away, so each one can only count its own
 * enqueues. The defect lived in the SUM: the webhook or recordPayment sent one,
 * and `onInvoicesWrite` sent another off the write that paid the invoice.
 *
 * So every test here runs the real handler against a write-through Firestore
 * mock, then feeds the invoice's before and after to the real trigger, exactly
 * as Firestore would, and counts every `invoice.payment.applied` the two
 * produced together.
 */

const mocks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  event: { current: null as unknown },
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => mocks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/notifications/dispatcher', () => ({ enqueueNotification: mocks.enqueue }));
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: vi.fn().mockResolvedValue('kin-uid-1') }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', () => ({ writeAuditEntry: vi.fn().mockResolvedValue('audit-1') }));
vi.mock('../src/lib/wrapTrigger', () => ({
  wrapTrigger: (_name: string, fn: (...a: unknown[]) => unknown) => fn,
}));
vi.mock('../src/lib/stripe', () => ({
  // The fee hop fails soft; nothing here is about the fee.
  getStripe: async () => ({ paymentIntents: { retrieve: vi.fn().mockRejectedValue(new Error('offline')) } }),
  verifyStripeWebhook: () => mocks.event.current,
}));

import { onInvoicesWriteHandler } from '../src/triggers/onInvoicesWrite';
import { recordPaymentHandler } from '../src/admin/recordPayment';
import { markInvoicePaidHandler } from '../src/admin/markInvoicePaid';
import { stripeWebhookHandler } from '../src/billing/stripeWebhook';
import { drawAccountCredit } from '../src/lib/accountCredit';

type Docs = Record<string, Record<string, unknown> | null>;
let docs: Docs;

beforeEach(() => {
  mocks.enqueue.mockReset().mockResolvedValue(['n1']);
  docs = {};
  mocks.db.current = buildDbMock({ docs, writeThrough: true }).db;
});

const INVOICE = 'invoices/inv1';

function seedInvoice(over: Record<string, unknown> = {}) {
  docs[INVOICE] = {
    kinfolkId: 'fam1',
    status: 'open',
    invoiceNumber: '1029',
    total: 40,
    totalCents: 4000,
    amountDue: 40,
    amountDueCents: 4000,
    ...over,
  };
}

/** Every `invoice.payment.applied` enqueued so far, from any sender. */
function appliedCount(): number {
  return mocks.enqueue.mock.calls.filter((c) => (c[0] as { key?: string }).key === 'invoice.payment.applied').length;
}

/**
 * Runs one server action, then delivers the invoice write it made to the real
 * trigger. Each action here writes the invoice at most once, which is what
 * Firestore turns into one trigger event.
 */
async function withTrigger(action: () => Promise<unknown>): Promise<void> {
  const before = docs[INVOICE] ? { ...docs[INVOICE] } : undefined;
  await action();
  const after = docs[INVOICE] ? { ...docs[INVOICE] } : undefined;
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await onInvoicesWriteHandler({
    params: { invoiceId: 'inv1' },
    data: { before: { data: () => before }, after: { data: () => after } },
  } as any);
}

function adminReq(data: unknown): CallableRequest<unknown> {
  return {
    data,
    auth: { uid: 'admin1', token: { admin: true } },
    rawRequest: {},
    acceptsStreaming: false,
  } as unknown as CallableRequest<unknown>;
}

/**
 * The React admin and Android Record Payment flow: `markInvoicePaid` settles
 * the bill, then `recordPayment` writes the ledger row and carries the toggle.
 */
async function adminTwoStep(amount: number, sendConfirmationEmail: boolean) {
  await withTrigger(() => markInvoicePaidHandler(adminReq({ invoiceId: 'inv1', amount, method: 'cash' })));
  await withTrigger(() =>
    recordPaymentHandler(
      adminReq({ kinfolkId: 'fam1', amount, paymentMethod: 'cash', invoiceId: 'inv1', sendConfirmationEmail }),
    ),
  );
}

/** `recordPayment` doing the apply itself. */
async function adminApply(amount: number, sendConfirmationEmail: boolean) {
  await withTrigger(() =>
    recordPaymentHandler(
      adminReq({
        kinfolkId: 'fam1',
        amount,
        paymentMethod: 'venmo',
        apply: { invoiceId: 'inv1', amount },
        sendConfirmationEmail,
      }),
    ),
  );
}

function stripeEvent(id: string, type: string, amountCents: number, paymentIntent = 'pi_1') {
  const object =
    type === 'payment_intent.succeeded'
      ? { id: paymentIntent, amount_received: amountCents, metadata: { familyId: 'fam1', invoiceId: 'inv1' } }
      : {
          id: 'cs_1',
          payment_intent: paymentIntent,
          payment_status: 'paid',
          amount_total: amountCents,
          metadata: { familyId: 'fam1', invoiceId: 'inv1' },
        };
  return { id, type, created: 1_000, data: { object } };
}

async function deliver(event: unknown) {
  mocks.event.current = event;
  const status = vi.fn().mockReturnThis();
  await withTrigger(() =>
    (stripeWebhookHandler as any)(
      { method: 'POST', headers: { 'stripe-signature': 'sig' }, rawBody: Buffer.from('{}') },
      { status, json: vi.fn(), end: vi.fn() },
    ),
  );
  return status;
}

describe('#866 card payments', () => {
  it('a full card payment sends exactly one', async () => {
    seedInvoice();
    const status = await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000));
    expect(status).toHaveBeenCalledWith(200);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
  });

  it('a card payment of the balance left after an admin partial sends exactly one', async () => {
    seedInvoice();
    await adminTwoStep(15, false);
    expect(appliedCount()).toBe(0);
    expect(docs[INVOICE]!['status']).toBe('open');

    await deliver(stripeEvent('evt_1', 'checkout.session.completed', 2500));
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
  });

  it('a Stripe retry of the same event, and the sibling event of the same charge, add nothing', async () => {
    seedInvoice();
    await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000));
    await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000));
    await deliver(stripeEvent('evt_2', 'payment_intent.succeeded', 4000));
    expect(appliedCount()).toBe(1);
  });
});

describe('#866 admin-recorded payments (markInvoicePaid then recordPayment)', () => {
  it('full, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminTwoStep(40, true);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
  });

  it('full, confirmation unticked: none from any path', async () => {
    seedInvoice();
    await adminTwoStep(40, false);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(0);
  });

  it('partial, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminTwoStep(15, true);
    expect(docs[INVOICE]!['status']).toBe('open');
    expect(appliedCount()).toBe(1);
  });

  it('partial, confirmation unticked: none', async () => {
    seedInvoice();
    await adminTwoStep(15, false);
    expect(appliedCount()).toBe(0);
  });
});

describe('#866 admin-recorded payments (recordPayment applying the money itself)', () => {
  it('full, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminApply(40, true);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
  });

  it('full, confirmation unticked: none from any path', async () => {
    seedInvoice();
    await adminApply(40, false);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(0);
  });

  it('partial, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminApply(15, true);
    expect(docs[INVOICE]!['status']).toBe('open');
    expect(appliedCount()).toBe(1);
  });

  it('partial, confirmation unticked: none', async () => {
    seedInvoice();
    await adminApply(15, false);
    expect(appliedCount()).toBe(0);
  });
});

describe('#866 account credit', () => {
  it('credit that pays the invoice off sends exactly one', async () => {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 5000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
  });

  it('credit that pays off a bill a card paid once before still sends exactly one', async () => {
    // The card's owner stamp is still on the invoice from its first settlement.
    // It says nothing about this write, so the trigger must not read it as an owner.
    seedInvoice({ paymentAppliedNoticeOwner: 'stripe:evt_old' });
    docs['families/fam1'] = { accountBalanceCents: 5000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
  });
});
