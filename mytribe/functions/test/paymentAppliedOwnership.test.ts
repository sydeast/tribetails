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
 * recipient. It fans out the way these keys do: the household copy only when a
 * recipientUid is given, and one office copy through `businessAdmins`. The
 * office roster has three states, the three the real dispatcher tells apart
 * since #866: on; empty (with no household uid, `NoRecipientsError`, final);
 * and a failed read (the read's own error, retryable).
 *
 * THE AUDIT LOG IS REAL. `writeAuditEntry` runs against the same mock, so an
 * audit entry written twice is two documents, not two mock calls.
 */

const mocks = vi.hoisted(() => ({
  db: { current: null as unknown },
  enqueue: vi.fn(),
  event: { current: null as unknown },
  resolveUid: vi.fn(),
  audit: vi.fn(),
  roster: { state: 'on' as 'on' | 'empty' | 'readError' },
}));

vi.mock('../src/lib/firestoreAdmin', () => ({ db: () => mocks.db.current, auth: vi.fn(), getAdmin: vi.fn() }));
vi.mock('../src/notifications/dispatcher', async () => {
  const actual = await vi.importActual<typeof import('../src/notifications/dispatcher')>('../src/notifications/dispatcher');
  // Both entry points go through ONE counted mock, which answers with an
  // EnqueueOutcome (written, suppressed, unresolved) like the real dispatcher.
  return {
    ...actual,
    enqueueNotificationDetailed: mocks.enqueue,
    enqueueNotification: async (args: unknown) => ((await mocks.enqueue(args)) as { written: string[] }).written,
  };
});
vi.mock('../src/lib/resolveKinfolkUid', () => ({ resolveKinfolkUid: mocks.resolveUid }));
vi.mock('../src/lib/logger', () => ({ logEvent: vi.fn() }));
vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), captureFunctionError: vi.fn() }));
vi.mock('../src/lib/writeAuditEntry', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/writeAuditEntry')>('../src/lib/writeAuditEntry');
  return { ...actual, writeAuditEntry: mocks.audit };
});
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
import { CREDIT_NOTICE_SWEEP_GRACE_MS, drawAccountCredit, sweepPendingCreditNotices } from '../src/lib/accountCredit';
import { updateInvoiceHandler } from '../src/admin/updateInvoice';
import { dedupeIdentityOf, dedupeWindowOf, resolveTargetRef } from '../src/notifications/dispatcher';
import { NoRecipientsError } from '../src/notifications/recipientErrors';
import type { EnqueueArgs } from '../src/notifications/types';

const realAudit = (await vi.importActual<typeof import('../src/lib/writeAuditEntry')>('../src/lib/writeAuditEntry'))
  .writeAuditEntry;

type Docs = Record<string, Record<string, unknown> | null>;
let docs: Docs;

const STAFF_UID = 'staff-uid-1';
/** One row per copy that actually reached a person. */
let delivered: Array<{ key: string; recipientUid: string; household: boolean }>;
let ledger: Map<string, number>;

type FakeOutcome = { written: string[]; suppressed: never[]; unresolved: Array<{ resolver: string; error: string }> };

function fakeEnqueue(args: EnqueueArgs): FakeOutcome {
  const recipients: Array<{ uid: string; household: boolean }> = [];
  const unresolved: FakeOutcome['unresolved'] = [];
  if (args.recipientUid) recipients.push({ uid: args.recipientUid, household: true });
  if (mocks.roster.state === 'on') recipients.push({ uid: STAFF_UID, household: false });
  if (mocks.roster.state === 'readError') {
    // As the real dispatcher does: the failed lookup costs only its own audience.
    // With nobody else to deliver to, the read error itself is thrown (retryable).
    const readError = Object.assign(new Error('14 UNAVAILABLE: businessSettings/admins read failed'), { code: 14 });
    if (recipients.length === 0) throw readError;
    unresolved.push({ resolver: 'businessAdmins', error: readError.message });
  }
  if (recipients.length === 0) {
    throw new NoRecipientsError(`enqueueNotification(${args.key}): no recipients resolved from any resolver`);
  }
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
  return { written: ids, suppressed: [], unresolved };
}

beforeEach(() => {
  delivered = [];
  ledger = new Map();
  mocks.roster.state = 'on';
  mocks.enqueue.mockReset().mockImplementation(async (args: EnqueueArgs) => fakeEnqueue(args));
  mocks.resolveUid.mockReset().mockResolvedValue('kin-uid-1');
  mocks.audit.mockReset().mockImplementation((args: Parameters<typeof realAudit>[0]) => realAudit(args));
  docs = {};
  mocks.db.current = buildDbMock({ docs, writeThrough: true }).db;
});

afterEach(() => {
  vi.useRealTimers();
});

const INVOICE = 'invoices/inv1';
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const KEY = 'pay_1757860000000_abcdef';

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

/** Household copies of `key` that reached the household. */
function appliedCount(key = 'invoice.payment.applied'): number {
  return delivered.filter((d) => d.key === key && d.household).length;
}

/** Office copies of `key`. */
function staffCount(key = 'invoice.payment.applied'): number {
  return delivered.filter((d) => d.key === key && !d.household).length;
}

/** Audit DOCUMENTS the webhook wrote for Stripe events, of one action type. */
function stripeAudits(actionType: 'BILLING_INVOICE_PAID' | 'BILLING_INVOICE_FAILED'): number {
  return Object.entries(docs).filter(
    ([p, d]) =>
      p.startsWith('activity_log/') &&
      d !== null &&
      d['actionType'] === actionType &&
      typeof (d['payload'] as Record<string, unknown> | undefined)?.['stripeEventId'] === 'string',
  ).length;
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

/** Step 1 of the React admin and Android Record Payment flow. Returns its payment id. */
async function settleStep(amount: number): Promise<string> {
  const res = await withTrigger(() => markInvoicePaidHandler(adminReq({ invoiceId: 'inv1', amount, method: 'cash' })));
  return res.paymentId;
}

/** Step 2: the ledger row, carrying the toggle and (for a current client) step 1's payment id. */
function ledgerStep(amount: number, sendConfirmationEmail: boolean, settledByInvoicePaymentId?: string, idempotencyKey?: string) {
  return withTrigger(() =>
    recordPaymentHandler(
      adminReq({
        kinfolkId: 'fam1',
        amount,
        paymentMethod: 'cash',
        invoiceId: 'inv1',
        sendConfirmationEmail,
        ...(settledByInvoicePaymentId ? { settledByInvoicePaymentId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
    ),
  );
}

/** The whole two-step flow, as a current client runs it. */
async function adminTwoStep(amount: number, sendConfirmationEmail: boolean) {
  const settledBy = await settleStep(amount);
  await ledgerStep(amount, sendConfirmationEmail, settledBy);
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
    type === 'payment_intent.succeeded' || type === 'payment_intent.payment_failed'
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
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);
    expect(docs['stripeEvents/evt_1']).toMatchObject({ followupTracked: true });
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
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);
  });

  it('a retry of an event whose notice is stamped makes no enqueue attempt at all', async () => {
    // The 4-day ledger would hide a second attempt from the counts above, so
    // this counts dispatcher CALLS: the stamp alone must stop the retry.
    seedInvoice();
    await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000));
    later(HOUR);
    await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
});

describe('#866 card payments: a crash between the commit and the follow-up', () => {
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
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);
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

  it('a failed audit write after the commit answers 500, and the retry writes one audit and sends one notice', async () => {
    mocks.audit.mockRejectedValueOnce(new Error('audit down'));
    seedInvoice();
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(appliedCount()).toBe(0);
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(0);
    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(1);
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);
  });

  it('the audit is written, its stamp fails, then the enqueue throws: the retry writes no second audit entry', async () => {
    seedInvoice();
    const eventRef = (mocks.db.current as any).doc('stripeEvents/evt_1');
    eventRef.set.mockRejectedValueOnce(new Error('stamp lost'));
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);
    expect(docs['stripeEvents/evt_1']!['auditWrittenAt']).toBeUndefined();

    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);
    expect(appliedCount()).toBe(1);
  });

  it('an event recorded before this deploy (no followupTracked, no stamps) is never followed up again', async () => {
    // A Stripe retry or a dashboard Resend of an event the old code handled in full.
    seedInvoice({ status: 'paid', amountDue: 0, amountDueCents: 0 });
    docs['stripeEvents/evt_old'] = {
      type: 'checkout.session.completed',
      appliedOutcome: 'PAID',
      familyId: 'fam1',
      invoiceId: 'inv1',
    };
    expect(await deliver(stripeEvent('evt_old', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(0);
  });

  it('a notice nobody can receive (no household account, no office roster) is final: 200, stamped, never retried', async () => {
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    mocks.roster.state = 'empty';
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(docs['stripeEvents/evt_1']).toMatchObject({ noticeSkippedReason: 'no-recipients' });
    expect(stripeAudits('BILLING_INVOICE_PAID')).toBe(1);

    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a roster that could not be READ is not "nobody": 500, nothing stamped, and the retry sends', async () => {
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    mocks.roster.state = 'readError';
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(docs['stripeEvents/evt_1']!['noticeSkippedReason']).toBeUndefined();
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeUndefined();

    mocks.roster.state = 'on';
    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(staffCount()).toBe(1);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeTruthy();
  });
});

describe('#866 failed charges: the same follow-up', () => {
  const failed = () => stripeEvent('evt_f', 'payment_intent.payment_failed', 4000, 'pi_9');

  it('a failed charge sends one invoice.charge.failed and writes one failure audit', async () => {
    seedInvoice();
    expect(await deliver(failed())).toBe(200);
    expect(appliedCount('invoice.charge.failed')).toBe(1);
    expect(stripeAudits('BILLING_INVOICE_FAILED')).toBe(1);
    expect(appliedCount()).toBe(0);
    later(HOUR);
    expect(await deliver(failed())).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(stripeAudits('BILLING_INVOICE_FAILED')).toBe(1);
  });

  it('a throw after the commit answers 500, and the retry sends the notice it would have lost', async () => {
    seedInvoice();
    mocks.audit.mockRejectedValueOnce(new Error('audit down'));
    expect(await deliver(failed())).toBe(500);
    expect(appliedCount('invoice.charge.failed')).toBe(0);
    later(HOUR);
    expect(await deliver(failed())).toBe(200);
    expect(appliedCount('invoice.charge.failed')).toBe(1);
    expect(stripeAudits('BILLING_INVOICE_FAILED')).toBe(1);
    expect(docs['stripeEvents/evt_f']!['noticeSentAt']).toBeTruthy();
  });

  it('a failed-charge notice nobody can receive is final too: 200, stamped, one enqueue call after a retry', async () => {
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    mocks.roster.state = 'empty';
    expect(await deliver(failed())).toBe(200);
    expect(docs['stripeEvents/evt_f']).toMatchObject({ noticeSkippedReason: 'no-recipients' });
    expect(stripeAudits('BILLING_INVOICE_FAILED')).toBe(1);

    later(HOUR);
    expect(await deliver(failed())).toBe(200);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a failed-charge event recorded before this deploy is never followed up again', async () => {
    seedInvoice();
    docs['stripeEvents/evt_f'] = { type: 'payment_intent.payment_failed', appliedOutcome: 'FAILED', familyId: 'fam1', invoiceId: 'inv1' };
    expect(await deliver(failed())).toBe(200);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(stripeAudits('BILLING_INVOICE_FAILED')).toBe(0);
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

  it('ticked, settling, household has no portal account: a retry 25 hours later sends no second office copy', async () => {
    // Past the old 24h ledger window, so the row's own `officeNoticeSentAt` stops it.
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    await adminApply(40, true, KEY);
    expect(staffCount()).toBe(1);
    later(25 * HOUR);
    await adminApply(40, true, KEY);
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
  });

  it('the household gains a portal account between attempts: a retry 25 hours later tells the household once and the office no more', async () => {
    // The retry owes the household its copy, and the office copy rides that same
    // enqueue. The 7-day ledger window is what keeps the office at one.
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    await adminApply(40, true, KEY);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(1);

    later(25 * HOUR);
    mocks.resolveUid.mockResolvedValue('kin-uid-1');
    const retry = await adminApply(40, true, KEY);
    expect(retry.confirmationEmailSent).toBe(true);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('an office copy nobody can receive is stamped skipped, and a retry makes no second enqueue call', async () => {
    seedInvoice();
    mocks.roster.state = 'empty';
    await adminApply(40, false, KEY);
    expect(staffCount()).toBe(0);
    expect(docs[`payments/${KEY}`]).toMatchObject({ officeNoticeSkippedReason: 'no-recipients' });

    later(HOUR);
    await adminApply(40, false, KEY);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });

  it('an office roster that could not be READ is retried: nothing stamped, and the same-key retry sends', async () => {
    seedInvoice();
    mocks.roster.state = 'readError';
    await adminApply(40, false, KEY);
    expect(staffCount()).toBe(0);
    expect(docs[`payments/${KEY}`]!['officeNoticeSkippedReason']).toBeUndefined();
    expect(docs[`payments/${KEY}`]!['officeNoticeSentAt']).toBeUndefined();

    mocks.roster.state = 'on';
    later(HOUR);
    await adminApply(40, false, KEY);
    expect(staffCount()).toBe(1);
  });
});

describe('#866 office copy: only for a payment that pays the invoice off (as on main)', () => {
  const OFFICE_KEY = 'pay_1757860000000_offc01';

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
    const settledBy = await settleStep(40);
    await ledgerStep(40, false, settledBy);
    expect(staffCount()).toBe(1);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toBe(`markInvoicePaid:${settledBy}`);
    // Even naming the same settlement, or as an old client inside the window, a
    // second claim is refused.
    await ledgerStep(5, false, settledBy);
    await ledgerStep(5, false);
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
  });

  it('step 2 never ran: an unrelated linked payment 30 days later does not claim the settlement', async () => {
    seedInvoice();
    await settleStep(40);
    expect(staffCount()).toBe(0);
    later(30 * 24 * HOUR);
    // No settlement id, as any other payment linked to this invoice would send.
    await ledgerStep(5, false);
    // And a wrong one.
    await ledgerStep(5, false, 'some-other-payment');
    expect(staffCount()).toBe(0);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toBeUndefined();
    const rows = Object.entries(docs).filter(([p, d]) => p.startsWith('payments/') && d !== null);
    expect(rows.every(([, d]) => d!['settlesInvoice'] === false)).toBe(true);
  });

  it('an older installed client (no settlement id) claims its own settlement a minute later', async () => {
    seedInvoice();
    await settleStep(40);
    expect(typeof docs[INVOICE]!['paymentAppliedNoticeOwnerAtMs']).toBe('number');
    later(1 * MIN);
    await ledgerStep(40, false);
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toMatch(/^markInvoicePaid:/);
  });

  it('an older installed client 10 minutes after the settlement claims nothing', async () => {
    seedInvoice();
    await settleStep(40);
    later(10 * MIN);
    await ledgerStep(40, false);
    expect(staffCount()).toBe(0);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toBeUndefined();
  });

  it('a current client naming the wrong settlement claims nothing, even at once', async () => {
    seedInvoice();
    await settleStep(40);
    await ledgerStep(40, false, 'not-this-settlement');
    expect(staffCount()).toBe(0);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toBeUndefined();
  });

  it('unticked full, recordPayment applying, first enqueue fails: a same-key retry sends the office copy once', async () => {
    seedInvoice();
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    await adminApply(40, false, OFFICE_KEY);
    expect(staffCount()).toBe(0);
    expect(docs[`payments/${OFFICE_KEY}`]!['officeNoticeSentAt']).toBeFalsy();

    later(HOUR);
    await adminApply(40, false, OFFICE_KEY);
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
    expect(docs[`payments/${OFFICE_KEY}`]!['officeNoticeSentAt']).toBeTruthy();

    later(HOUR);
    await adminApply(40, false, OFFICE_KEY);
    expect(staffCount()).toBe(1);
  });

  it('unticked full, two-step flow, first enqueue fails: a same-key retry sends the office copy once', async () => {
    seedInvoice();
    const settledBy = await settleStep(40);
    mocks.enqueue.mockRejectedValueOnce(new Error('dispatcher down'));
    await ledgerStep(40, false, settledBy, OFFICE_KEY);
    expect(staffCount()).toBe(0);

    later(HOUR);
    await ledgerStep(40, false, settledBy, OFFICE_KEY);
    expect(staffCount()).toBe(1);

    later(HOUR);
    await ledgerStep(40, false, settledBy, OFFICE_KEY);
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
  });

  it('unticked partial retried with the same key still tells nobody', async () => {
    seedInvoice();
    await adminApply(15, false, OFFICE_KEY);
    later(HOUR);
    await adminApply(15, false, OFFICE_KEY);
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
  });
});

describe('#866 a failed office-roster READ costs only the office copy, and only until a retry', () => {
  it('webhook: the household is told, the office is not, 500, nothing stamped; the retry tells the office once', async () => {
    seedInvoice();
    mocks.roster.state = 'readError';
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(500);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(0);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeUndefined();

    mocks.roster.state = 'on';
    later(HOUR);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 4000))).toBe(200);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(docs['stripeEvents/evt_1']!['noticeSentAt']).toBeTruthy();
  });

  it('recordPayment: the household copy is stamped sent, the office copy stays pending, and a same-key retry sends it', async () => {
    seedInvoice();
    mocks.roster.state = 'readError';
    const first = await adminApply(15, true, KEY);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(0);
    expect(first.confirmationEmailSent).toBe(true);
    expect(first.officeNoticePending).toBe(true);
    expect(first.householdNoPortalAccount).toBe(false);
    expect(docs[`payments/${KEY}`]!['confirmationEmailSent']).toBe(true);
    expect(docs[`payments/${KEY}`]!['officeNoticeSentAt']).toBeUndefined();

    mocks.roster.state = 'on';
    later(HOUR);
    const retry = await adminApply(15, true, KEY);
    // A partial: the office copy is owed because the first attempt was ticked.
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(1);
    expect(retry.officeNoticePending).toBe(false);
    expect(docs[`payments/${KEY}`]!['officeNoticeSentAt']).toBeTruthy();
  });

  it('recordPayment: a ticked payment for a household with no portal account says so, and nothing is pending', async () => {
    seedInvoice();
    mocks.resolveUid.mockResolvedValue(null);
    const res = await adminApply(15, true, KEY);
    expect(res.confirmationEmailSent).toBe(false);
    expect(res.householdNoPortalAccount).toBe(true);
    expect(res.officeNoticePending).toBe(false);
  });
});

describe('#866 old-client claim window and clock skew', () => {
  it('a settlement stamp that reads 1 second in the future (instance clock skew) is still claimed', async () => {
    seedInvoice();
    await settleStep(40);
    // The claiming instance's clock runs a second behind the stamping one.
    later(-1000);
    await ledgerStep(40, false);
    expect(staffCount()).toBe(1);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toMatch(/^markInvoicePaid:/);
  });

  it('a settlement stamp that reads 10 seconds in the future is not trusted', async () => {
    seedInvoice();
    await settleStep(40);
    later(-10_000);
    await ledgerStep(40, false);
    expect(staffCount()).toBe(0);
    expect(docs[INVOICE]!['paymentAppliedNoticeClaim']).toBeUndefined();
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

describe('#884 review: updateInvoice decides and writes in one transaction', () => {
  /**
   * An optimistic transaction over the write-through store, as Firestore runs
   * one: every read is remembered, writes are staged, and a commit whose reads
   * changed underneath it discards the attempt and runs the callback again.
   */
  function optimisticTransactions(store: Docs) {
    const db = mocks.db.current as any;
    const stateOf = (path: string) =>
      JSON.stringify(Object.entries(store).filter(([k]) => k === path || k.startsWith(`${path}/`)).sort());
    db.runTransaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const seen = new Map<string, string>();
        const staged: Array<() => Promise<unknown>> = [];
        const tx = {
          get: async (ref: any) => {
            seen.set(ref.path, stateOf(ref.path));
            return ref.get();
          },
          set: (ref: any, data: any, options?: any) => void staged.push(() => ref.set(data, options)),
          update: (ref: any, data: any) => void staged.push(() => ref.update(data)),
          create: (ref: any, data: any) => void staged.push(() => ref.create(data)),
          delete: (ref: any) => void staged.push(() => ref.delete()),
        };
        const result = await fn(tx);
        if ([...seen].some(([path, before]) => stateOf(path) !== before)) continue;
        for (const write of staged) await write();
        return result;
      }
      throw new Error('ABORTED: contention');
    };
  }

  it("a markInvoicePaid that commits between the edit's read and its write keeps its owner stamp", async () => {
    // Admin A lowers the lines to the $60 already paid. Admin B's markInvoicePaid
    // for the remaining $40 commits right after A has read the invoice.
    const store: Docs = {
      [INVOICE]: {
        kinfolkId: 'fam1',
        status: 'open',
        invoiceNumber: '1029',
        total: 100,
        totalCents: 10000,
        amountDue: 40,
        amountDueCents: 4000,
        lineItems: [{ description: 'Dog walking', qty: 4, unitCents: 2500 }],
      },
      'invoices/inv1/payments/p1': { amountCents: 6000, amount: 60 },
    };
    docs = store;
    // B commits once A has read BOTH the invoice and its payments: the first
    // time a payment row is read through the store, which is A's payments read.
    let raced = false;
    const racing = new Proxy(store, {
      get(target, p, receiver) {
        const value = Reflect.get(target, p, receiver);
        if (!raced && p === 'invoices/inv1/payments/p1') {
          raced = true;
          target[INVOICE] = {
            ...(target[INVOICE] as Record<string, unknown>),
            status: 'paid',
            paymentStatus: 'PAID',
            amountDue: 0,
            amountDueCents: 0,
            paidCents: 10000,
            paymentAppliedNoticeOwner: 'markInvoicePaid:p2',
            paymentAppliedNoticeOwnerAtMs: Date.now(),
          };
          target['invoices/inv1/payments/p2'] = { amountCents: 4000, amount: 40 };
        }
        return value;
      },
    });
    mocks.db.current = buildDbMock({ docs: racing, writeThrough: true }).db;
    optimisticTransactions(store);

    // A's retry reads the invoice B paid off, which is frozen, so A is refused.
    await expect(
      updateInvoiceHandler(
        adminReq({ invoiceId: 'inv1', patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 6000 }] } }),
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(raced).toBe(true);
    expect(store[INVOICE]!['paymentAppliedNoticeOwner']).toBe('markInvoicePaid:p2');
    expect(store[INVOICE]!['paidCents']).toBe(10000);
    expect(store[INVOICE]!['status']).toBe('paid');
    expect(mocks.enqueue).not.toHaveBeenCalled();

    // B's recordPayment step can still claim its settlement, so the office is told.
    await recordPaymentHandler(
      adminReq({
        kinfolkId: 'fam1',
        amount: 40,
        paymentMethod: 'cash',
        invoiceId: 'inv1',
        sendConfirmationEmail: false,
        settledByInvoicePaymentId: 'p2',
      }),
    );
    expect(staffCount()).toBe(1);
    expect(appliedCount()).toBe(0);
  });
});

describe('#884 second review: the credit notice survives a crash', () => {
  const draw = () =>
    withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
  const pending = () => docs[INVOICE]!['paymentAppliedNoticePending'];
  const sweep = () => sweepPendingCreditNotices(mocks.db.current as any, Date.now());

  function seedPayable() {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 5000 };
  }

  it('the normal path sends one and clears the pending stamp; a redelivery and a later sweep send nothing', async () => {
    seedPayable();
    await draw();
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(pending()).toBe('');
    expect(docs[INVOICE]!['paymentAppliedNoticeSentAt']).toBeTruthy();
    const calls = mocks.enqueue.mock.calls.length;

    expect((await draw()).skipped).toBe('invoice_not_collectable');
    later(HOUR);
    expect(await sweep()).toBe(0);
    expect(mocks.enqueue.mock.calls.length).toBe(calls);
    expect(appliedCount()).toBe(1);
  });

  it('a crash after the commit and before the send: the redelivered pass sends exactly one', async () => {
    seedPayable();
    mocks.resolveUid.mockRejectedValueOnce(new Error('instance stopped'));
    await draw();
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(pending()).toMatch(/^accountCredit:.+/);

    expect((await draw()).skipped).toBe('invoice_not_collectable');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(pending()).toBe('');

    await draw();
    expect(appliedCount()).toBe(1);
  });

  it('a crash after the send and before its stamp: the retry is stopped by the ledger, still one', async () => {
    seedPayable();
    const db = mocks.db.current as any;
    const realTransaction = db.runTransaction;
    let calls = 0;
    // The pass's own transaction is the first; the pending-clear is the second.
    db.runTransaction = (fn: unknown) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('instance stopped'));
      return realTransaction(fn);
    };
    await draw();
    expect(appliedCount()).toBe(1);
    expect(pending()).toMatch(/^accountCredit:.+/);

    db.runTransaction = realTransaction;
    await draw();
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(pending()).toBe('');
  });

  it('no retry ever arrives: the scheduled sweep sends it after the grace period, once', async () => {
    seedPayable();
    mocks.resolveUid.mockRejectedValueOnce(new Error('instance stopped'));
    await draw();
    expect(await sweep()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();

    later(CREDIT_NOTICE_SWEEP_GRACE_MS + MIN);
    expect(await sweep()).toBe(1);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
    expect(await sweep()).toBe(0);
    await draw();
    expect(appliedCount()).toBe(1);
  });

  it('the sweep and a redelivered pass racing over one pending notice deliver it once', async () => {
    seedPayable();
    mocks.resolveUid.mockRejectedValueOnce(new Error('instance stopped'));
    await draw();
    later(CREDIT_NOTICE_SWEEP_GRACE_MS + MIN);
    await Promise.all([sweep(), drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' })]);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('a notice nobody can receive is final: stamped skipped, never swept again', async () => {
    seedPayable();
    mocks.roster.state = 'empty';
    mocks.resolveUid.mockResolvedValue(null);
    await draw();
    expect(docs[INVOICE]!['paymentAppliedNoticeSkippedReason']).toBe('no-recipients');
    expect(pending()).toBe('');
    later(CREDIT_NOTICE_SWEEP_GRACE_MS + MIN);
    expect(await sweep()).toBe(0);
  });

  it('a partial credit draw, then a card payment of the rest, sends exactly one', async () => {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 1000 };
    await draw();
    expect(appliedCount()).toBe(0);
    expect(await deliver(stripeEvent('evt_1', 'checkout.session.completed', 3000))).toBe(200);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('a partial credit draw, then recordPayment (ticked) of the rest, sends exactly one', async () => {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 1000 };
    await draw();
    await adminApply(30, true);
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });
});

describe('#884 review: the credit draw owns its notice', () => {
  it('a legacy invoice with a total and no amountDue, paid off by account credit, sends exactly one', async () => {
    // invoiceStateOf reads this doc as paid before the draw, so the trigger sees
    // paid to paid. The draw is a real payment and sends the notice itself.
    docs[INVOICE] = { kinfolkId: 'fam1', status: 'open', invoiceNumber: '1029', total: 40 };
    docs['families/fam1'] = { accountBalanceCents: 5000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(docs[INVOICE]!['paymentAppliedNoticeOwner']).toMatch(/^accountCredit:.+/);
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  it('credit that covers only part of the bill tells nobody, as before', async () => {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 1000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(docs[INVOICE]!['status']).toBe('open');
    expect(docs[INVOICE]!['paymentAppliedNoticeOwner']).toBeUndefined();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a second pass over the same paid invoice draws nothing and sends nothing more', async () => {
    seedInvoice();
    docs['families/fam1'] = { accountBalanceCents: 5000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });

  for (const label of ['past_due', 'overdue']) {
    it(`a ${label} bill with a balance, paid off by account credit, sends exactly one`, async () => {
      seedInvoice({ status: label });
      docs['families/fam1'] = { accountBalanceCents: 5000 };
      await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
      expect(docs[INVOICE]!['status']).toBe('paid');
      expect(appliedCount()).toBe(1);
      expect(staffCount()).toBe(1);
    });

    it(`a ${label} bill with a balance, paid off by recordPayment (ticked), sends exactly one`, async () => {
      seedInvoice({ status: label });
      await adminApply(40, true);
      expect(docs[INVOICE]!['status']).toBe('paid');
      expect(appliedCount()).toBe(1);
      expect(staffCount()).toBe(1);
    });
  }
});

describe('#884 settling a balance by editing the invoice, not by paying it', () => {
  function seedPartPaid(over: Record<string, unknown> = {}) {
    seedInvoice({
      total: 100,
      totalCents: 10000,
      amountDue: 40,
      amountDueCents: 4000,
      lineItems: [{ description: 'Dog walking', qty: 4, unitCents: 2500 }],
      ...over,
    });
    docs['invoices/inv1/payments/p1'] = { amountCents: 6000, amount: 60 };
  }

  function editAudits(): number {
    return Object.values(docs).filter((d) => d !== null && d['actionType'] === 'BILLING_INVOICE_UPDATED').length;
  }

  it('lowering the total to what was already paid tells nobody, and the audit is the record', async () => {
    seedPartPaid();
    await withTrigger(() =>
      updateInvoiceHandler(
        adminReq({ invoiceId: 'inv1', patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 6000 }] } }),
      ),
    );
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(0);
    expect(staffCount()).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(editAudits()).toBe(1);
  });

  it('lowering it BELOW what was paid tells nobody either', async () => {
    seedPartPaid();
    await withTrigger(() =>
      updateInvoiceHandler(
        adminReq({ invoiceId: 'inv1', patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 2500 }] } }),
      ),
    );
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('a bill a card paid once, reopened, then settled by an edit: the card stamp does not make the trigger send', async () => {
    seedPartPaid({ paymentAppliedNoticeOwner: 'stripe:evt_old' });
    await withTrigger(() =>
      updateInvoiceHandler(
        adminReq({ invoiceId: 'inv1', patch: { lineItems: [{ description: 'Dog walking', qty: 1, unitCents: 6000 }] } }),
      ),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('an edit stamp left on an open bill does not silence a later real payment (account credit)', async () => {
    // A settled-by-edit invoice is frozen, so no edit reopens it; the stamp can
    // still sit on an open bill (a repair reopening it). The credit draw stamps
    // nothing, so the trigger owns that notice and must still send it.
    seedInvoice({ paymentAppliedNoticeOwner: 'updateInvoice:earlier' });
    docs['families/fam1'] = { accountBalanceCents: 5000 };
    await withTrigger(() => drawAccountCredit(mocks.db.current as any, { invoiceId: 'inv1', actorUid: 'system' }));
    expect(docs[INVOICE]!['status']).toBe('paid');
    expect(appliedCount()).toBe(1);
    expect(staffCount()).toBe(1);
  });
});
