import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
 * as Firestore would, and counts what reached people.
 *
 * THE DISPATCHER DOUBLE KEEPS THE LEDGER'S RULE. It is not the real dispatcher
 * (that one needs the catalog, prefs, templates and a roster), but it decides
 * "already delivered" exactly as `writeOnce` does, with the real
 * `dedupeIdentityOf`, `resolveTargetRef` and `dedupeWindowOf`, keyed per
 * recipient. It fans out the way `invoice.payment.applied` does: the household
 * copy only when a recipientUid is given (the `kinfolkAcct` resolver throws on
 * '' and the dispatcher skips it), and one office copy through `businessAdmins`.
 * That is what lets the retry tests below say "zero extra" and mean it.
 */

const mocks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  event: { current: null as unknown },
  resolveUid: vi.fn(),
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => mocks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  return { ...actual, enqueueNotification: mocks.enqueue };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
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
import { writeAuditEntry } from '../src/lib/writeAuditEntry';
import { dedupeIdentityOf, dedupeWindowOf, resolveTargetRef } from '../src/notifications/dispatcher';
import type { EnqueueArgs } from '../src/notifications/types';

type Docs = Record<string, Record<string, unknown> | null>;
let docs: Docs;

const STAFF_UID = 'staff-uid-1';
/** One row per copy that actually reached a person. */
let delivered: Array<{ key: string; recipientUid: string; household: boolean }>;
let ledger: Map<string, number>;

function fakeEnqueue(args: EnqueueArgs): string[] {
  const recipients: Array<{ uid: string; household: boolean }> = [];
  if (args.recipientUid) recipients.push({ uid: args.recipientUid, household: true });
  recipients.push({ uid: STAFF_UID, household: false });
  const identity = dedupeIdentityOf(args, resolveTargetRef(args));
  const windowMs = dedupeWindowOf(args);
  const ids: string[] = [];
  for (const r of recipients) {
    const k = `${args.key}|${identity}|${r.uid}`;
    const last = ledger.get(k);
    if (identity !== '' && last !== undefined && Date.now() - last < windowMs) continue;
    ledger.set(k, Date.now());
    delivered.push({ key: args.key, recipientUid: r.uid, household: r.household });
    ids.push(`n${delivered.length}`);
  }
  return ids;
}

beforeEach(() => {
  delivered = [];
  ledger = new Map();
  mocks.enqueue.mockReset().mockImplementation(async (args: EnqueueArgs) => fakeEnqueue(args));
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  (writeAuditEntry as any).mockReset().mockResolvedValue('audit-1');
  docs = {};
  mocks.db.current = buildDbMock({ docs, writeThrough: true }).db;
});

afterEach(() => {
  vi.useRealTimers();
});

const INVOICE = 'invoices/inv1';
const HOUR = 60 * 60 * 1000;

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

/** Household copies of `invoice.payment.applied` that reached the household. */
function appliedCount(): number {
  return delivered.filter((d) => d.key === 'invoice.payment.applied' && d.household).length;
}

/** Office copies ("Invoice Paid") of `invoice.payment.applied`. */
function staffCount(): number {
  return delivered.filter((d) => d.key === 'invoice.payment.applied' && !d.household).length;
}

/** Moves the clock forward, so a retry lands outside the dispatcher's default 5-minute window. */
function later(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

/**
 * Runs one server action, then delivers the invoice write it made to the real
 * trigger. Each action here writes the invoice at most once, which is what
 * Firestore turns into one trigger event.
 */
async function withTrigger<T>(action: () => Promise<T>): Promise<T> {
  const before = docs[INVOICE] ? { ...docs[INVOICE] } : undefined;
  const out = await action();
  const after = docs[INVOICE] ? { ...docs[INVOICE] } : undefined;
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    await onInvoicesWriteHandler({
      params: { invoiceId: 'inv1' },
      data: { before: { data: () => before }, after: { data: () => after } },
    } as any);
  }
  return out;
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
async function adminApply(amount: number, sendConfirmationEmail: boolean, idempotencyKey?: string) {
  return withTrigger(() =>
    recordPaymentHandler(
      adminReq({
        kinfolkId: 'fam1',
        amount,
        paymentMethod: 'venmo',
        apply: { invoiceId: 'inv1', amount },
        sendConfirmationEmail,
        ...(idempotencyKey ? { idempotencyKey } : {}),
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

/**
 * One delivery to the real webhook handler. An escaped throw is what `wrapHttp`
 * turns into a 500, and Stripe retries a 500, so it is reported as one.
 */
async function deliver(event: unknown): Promise<number> {
  mocks.event.current = event;
  let code = 0;
  const res: any = {
    status: vi.fn((c: number) => {
      code = c;
      return res;
    }),
    json: vi.fn(),
    end: vi.fn(),
  };
  try {
    await withTrigger(() =>
      (stripeWebhookHandler as any)(
        { method: 'POST', headers: { 'stripe-signature': 'sig' }, rawBody: Buffer.from('{}') },
        res,
      ),
    );
  } catch {
    code = 500;
  }
  return code;
}

describe('#866 card payments', () => {
  it('a full card payment sends exactly one household notice and one office copy', async () => {
    seedInvoice();
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeTruthy();
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
    later(HOUR);
    await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000));
    await deliver(stripeEvent('evt_2', 'payment_intent.succeeded', 4000));
    await deliver(stripeEvent('evt_2', 'payment_intent.succeeded', 4000));
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });
});

describe('#866 card payments: a crash between the commit and the notice', () => {
  it('a failure after the commit and before the enqueue answers 500, and the retry sends exactly one', async () => {
    seedInvoice();
    mocks.resolveUid.mockRejectedValueOnce(new Error('firestore unavailable'));
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(0);

    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeTruthy();

    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(1);
  });

  it('a crash after the enqueue and before the stamp: the retry, an hour later, sends zero extra', async () => {
    seedInvoice();
    // The notification lands, then the instance dies before `noticeSentAt` is written.
    mocks.enqueue.mockImplementationOnce(async (args: EnqueueArgs) => {
      fakeEnqueue(args);
      throw new Error('instance terminated');
    });
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(appliedCount()).toBe(1);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeUndefined();

    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeTruthy();
  });

  it('a failed audit write after the commit answers 500, and the retry still sends exactly one', async () => {
    (writeAuditEntry as any).mockRejectedValueOnce(new Error('audit down'));
    seedInvoice();
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(appliedCount()).toBe(0);
    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(1);
  });

  it('a failed charge event is never recovered as a payment notice', async () => {
    seedInvoice();
    const failed = { id: 'evt_f', type: 'payment_intent.payment_failed', created: 1_000, data: { object: { id: 'pi_9', metadata: { familyId: 'fam1', invoiceId: 'inv1' } } } };
    await deliver(failed);
    await deliver(failed);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
  });
});

describe('#866 admin-recorded payments (markInvoicePaid then recordPayment)', () => {
  it('full, confirmation ticked: exactly one to the household', async () => {
    seedInvoice();
    await adminTwoStep(40, true);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('full, confirmation unticked: none to the household, and the office still gets its copy', async () => {
    seedInvoice();
    await adminTwoStep(40, false);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(1);
  });

  it('partial, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminTwoStep(15, true);
    expect(docs[INVOICE]!['status']).toBe('open');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('partial, confirmation unticked: none to the household', async () => {
    seedInvoice();
    await adminTwoStep(15, false);
    expect(appliedCount()).toBe(0);
  });

  it('ticked for a household with no portal account: the office copy still goes out', async () => {
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    await adminTwoStep(40, true);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(1);
  });
});

describe('#866 admin-recorded payments (recordPayment applying the money itself)', () => {
  it('full, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminApply(40, true);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('full, confirmation unticked: none to the household, one office copy', async () => {
    seedInvoice();
    await adminApply(40, false);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(1);
  });

  it('partial, confirmation ticked: exactly one', async () => {
    seedInvoice();
    await adminApply(15, true);
    expect(docs[INVOICE]!['status']).toBe('open');
    expect(appliedCount()).toBe(1);
  });

  it('partial, confirmation unticked: none to the household', async () => {
    seedInvoice();
    await adminApply(15, false);
    expect(appliedCount()).toBe(0);
  });
});

describe('#866 recordPayment: a retry of the same submission', () => {
  const KEY = 'pay_1757860000000_abcdef';

  it('a ticked confirmation that failed the first time is sent by the retry, and only once', async () => {
    seedInvoice();
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    const first = await adminApply(40, true, KEY);
    expect(first.confirmationEmailSent).toBe(false);
    expect(appliedCount()).toBe(0);

    later(HOUR);
    const second = await adminApply(40, true, KEY);
    expect(second.confirmationEmailSent).toBe(true);
    expect(appliedCount()).toBe(1);
    expect(docs[`payments/${KEY}`]!['confirmationEmailSent']).toBe(true);

    later(HOUR);
    const third = await adminApply(40, true, KEY);
    expect(third.confirmationEmailSent).toBe(true);
    expect(appliedCount()).toBe(1);
  });

  it('a retry of a submission whose confirmation went out sends nothing more', async () => {
    seedInvoice();
    await adminApply(40, true, KEY);
    later(HOUR);
    await adminApply(40, true, KEY);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('a retry of an unticked submission sends the household nothing', async () => {
    seedInvoice();
    await adminApply(40, false, KEY);
    await adminApply(40, false, KEY);
    expect(appliedCount()).toBe(0);
  });
});

describe('#866 office copy: only for a payment that pays the invoice off (as on main)', () => {
  const KEY = 'pay_1757860000000_offc01';

  it('unticked partial, two-step flow: nobody is told', async () => {
    seedInvoice();
    await adminTwoStep(15, false);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
  });

  it('unticked partial, recordPayment applying: nobody is told', async () => {
    seedInvoice();
    await adminApply(15, false);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
  });

  it('ticked partial: household and office are both told, as on main', async () => {
    // The staff copy is the same "Payment received" template the household gets
    // (seedCorpus), not an "Invoice Paid" message, so a partial may carry it.
    seedInvoice();
    await adminTwoStep(15, true);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('ticked partial for a household with no portal account: nobody is told', async () => {
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    await adminTwoStep(15, true);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
  });

  it('a later payment linked to an invoice already paid off sends no second office copy', async () => {
    seedInvoice();
    await adminTwoStep(40, false);
    expect(staffCount()).toBe(1);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toMatch(/^markInvoicePaid:/);
    await withTrigger(() =>
      recordPaymentHandler(adminReq({ kinfolkId: 'fam1', amount: 5, paymentMethod: 'cash', invoiceId: 'inv1' })),
    );
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
  });

  it('unticked full, recordPayment applying, first enqueue fails: a same-key retry sends the office copy once', async () => {
    seedInvoice();
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    await adminApply(40, false, KEY);
    expect(staffCount()).toBe(0);
    expect(docs[`payments/${KEY}`]!['officeNoticeSentAt']).toBeFalsy();

    later(HOUR);
    await adminApply(40, false, KEY);
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
    expect(docs[`payments/${KEY}`]!['officeNoticeSentAt']).toBeTruthy();

    later(HOUR);
    await adminApply(40, false, KEY);
    expect(staffCount()).toBe(1);
  });

  it('unticked full, two-step flow, first enqueue fails: a same-key retry sends the office copy once', async () => {
    seedInvoice();
    const step2 = () =>
      withTrigger(() =>
        recordPaymentHandler(
          adminReq({ kinfolkId: 'fam1', amount: 40, paymentMethod: 'cash', invoiceId: 'inv1', idempotencyKey: KEY }),
        ),
      );
    await withTrigger(() => markInvoicePaidHandler(adminReq({ invoiceId: 'inv1', amount: 40, method: 'cash' })));
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    await step2();
    expect(staffCount()).toBe(0);

    later(HOUR);
    await step2();
    expect(staffCount()).toBe(1);

    later(HOUR);
    await step2();
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
  });

  it('unticked partial retried with the same key still tells nobody', async () => {
    seedInvoice();
    await adminApply(15, false, KEY);
    later(HOUR);
    await adminApply(15, false, KEY);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
  });
});

describe('#866 account credit', () => {
  it('credit that pays the invoice off sends exactly one', async () => {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 5000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
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
