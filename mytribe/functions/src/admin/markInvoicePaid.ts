import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import {
  paidCentsFromPayments,
  invoiceTotalCentsOf,
  settleInvoice,
  centsToDollars,
  type PaymentAmount,
  type InvoiceSettlementState,
} from '../lib/invoiceMath';

/**
 * Dedicated manual-payment callable, replacing the AuntieOS admin's prior
 * `postInvoiceEvent({ payload: { status: 'paid', amountDue: 0 } })` workaround
 * (see auntieos-admin/src/api/invoicesWrite.ts's pre-existing header note).
 * That path merged a status flip with no dedicated guard and, critically, no
 * payment record: `postInvoiceEvent` only ever merges an arbitrary payload
 * onto the invoice doc, so a manually-recorded payment left no trace of who
 * recorded it, by what method, or against what reference number.
 *
 * This callable closes that gap: it writes a `payments` subcollection entry
 * (the audit-grade record: amount/method/reference/paidAt/recordedBy) in the
 * SAME batch as the invoice money write, so the two either both land or
 * neither does, there is never a "marked paid with no payment record" state.
 *
 * THE INVOICE'S STATE IS DERIVED FROM THE SUM OF ITS RECORDED PAYMENTS, never
 * from the single payment being written. That sentence is the 2026-07-25 fix.
 * What it replaced was an unconditional
 *
 *     batch.set(ref, { status: 'paid', amountDue: 0, ... }, { merge: true })
 *
 * with no reference at all to how much had actually been collected. A $20
 * payment against a $40 invoice therefore wrote it PAID with $0 due: it dropped
 * out of Outstanding so nobody chased the rest, `isAlreadyPaid` then refused the
 * second call as already-paid, and PR #72's edit gating froze the money fields
 * the moment any payment existed, so `updateInvoice` could not repair it either.
 * The remaining balance was unrecoverable by every available path. Deriving the
 * state from the subcollection is what makes each of those three doors open
 * again, and it is why nothing below branches on `args.amount` alone.
 *
 * ALL ARITHMETIC IS INTEGER CENTS, through `lib/invoiceMath.ts`. The float
 * dollar `total`/`amountDue` fields on the doc are a SERVER-DERIVED PROJECTION
 * written from the same cents figures in the same pass, never an input.
 *
 * OVERPAYMENT: settles the invoice, clamps `amountDue` at zero, and records the
 * excess as `overpaidCents` for the operator to act on deliberately. It is never
 * turned into a credit automatically. The full reasoning, and why a negative
 * balance would be actively wrong here, is on `settleInvoice` in invoiceMath.ts.
 *
 * Canonical store is the FLAT top-level `invoices` collection (the same one
 * createInvoice/postInvoiceEvent/sendInvoiceReminder read and write).
 *
 * Notification: deliberately NOT enqueued here. `onInvoicesWrite` (the
 * invoices-collection trigger) already fires `invoice.payment.applied`
 * whenever a Firestore write to ANY invoice doc flips its resolved lifecycle
 * into 'paid' (admin UI direct write, callable, or the Stripe webhook, per
 * that trigger's own header comment). Enqueuing the same notification again
 * here would double-send it for this write path specifically. The trigger
 * reacts to the actual persisted state, so it can never fire out of step
 * with what this callable really wrote. One consequence of this fix is worth
 * naming: a PARTIAL payment leaves `amountDue` above zero, so that trigger no
 * longer resolves the invoice to 'paid' and no "payment applied" notification
 * goes out for it. That is correct. The invoice is not paid, and telling a
 * household it was is the same lie the doc write used to tell the operator.
 */
// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  invoiceId: z.string().min(1).max(200),
  /**
   * Dollar amount actually collected. May be PARTIAL. Omit to settle whatever
   * is still outstanding, which is derived from the total minus the payments
   * already recorded, NOT read off the `amountDue` scalar: on any invoice
   * touched before this fix that scalar reads 0 while a real balance is owed,
   * so defaulting to it would record a $0 payment and change nothing.
   */
  amount: z.number().nonnegative().optional(),
  /** Free-text payment method, e.g. "check", "cash", "venmo". */
  method: z.string().trim().min(1).max(200).optional(),
  /** Free-text reference/confirmation number for the payment. */
  reference: z.string().trim().min(1).max(200).optional(),
  /** ISO-8601 timestamp for when the payment was actually received (for recording a past payment). Defaults to now. */
  paidAt: z.string().optional(),
});

type InvoiceDoc = {
  kinfolkId?: string;
  status?: string;
  paymentStatus?: string;
  invoiceNumber?: string;
  amountDue?: number;
  total?: number;
  totalCents?: number;
  [k: string]: unknown;
};

function normalizedStatus(d: InvoiceDoc): string {
  return typeof d.status === 'string' ? d.status.trim().toLowerCase() : '';
}

/**
 * Whether the invoice's own labels CLAIM it is paid. A claim, not a finding:
 * what actually decides the refusal is this crossed with the recorded payments,
 * in [alreadySettledRefusal] below.
 */
function claimsPaid(d: InvoiceDoc): boolean {
  return d.paymentStatus === 'PAID' || normalizedStatus(d) === 'paid';
}

/**
 * Why a second payment is refused, or null when it must be allowed. THE GUARD
 * THE OLD `isAlreadyPaid` GOT WRONG, and the reason the balance on a part-paid
 * invoice could not be collected.
 *
 * The old rule was `paymentStatus === 'PAID' || status === 'paid'` and nothing
 * else, so the moment the buggy write stamped `paid` on a part-paid invoice,
 * every subsequent attempt to collect the rest threw `failed-precondition`. The
 * refusal fired on a LABEL the same function had just written, never on the
 * money.
 *
 * The money decides now, with one deliberate exception:
 *
 *   RECORDED PAYMENTS COVER THE TOTAL -> refuse. Settled is settled, and this
 *   holds regardless of what the status field says, so a stale or missing label
 *   cannot re-open a paid invoice for a second collection either.
 *
 *   LABELLED PAID WITH NO RECORDED PAYMENTS AT ALL -> refuse. This is the
 *   exception, and it is load-bearing. `stripeWebhook.ts` records card payments
 *   into the ROOT `payments` collection (`db().collection('payments')`), NOT
 *   into `invoices/{id}/payments`, and `postInvoiceEvent` can flip a status with
 *   no payment record whatsoever. On those invoices the subcollection sums to
 *   zero while the money genuinely arrived, so trusting the sum alone would
 *   invite an operator to collect an already-paid bill a second time. With no
 *   evidence of a partial, the label is the only evidence there is, and it is
 *   believed.
 *
 * What is left over is precisely the corrupt shape the handoff describes: a doc
 * labelled paid that HAS payments summing to less than its total. That is not
 * refused. It is exactly the invoice whose balance is owed.
 */
function alreadySettledRefusal(
  d: InvoiceDoc,
  paymentCount: number,
  state: InvoiceSettlementState,
): { code: string; message: string } | null {
  if (state === 'settled' || state === 'overpaid') {
    return {
      code: 'invoice_already_settled',
      message: 'The payments recorded against this invoice already cover it in full.',
    };
  }
  if (claimsPaid(d) && paymentCount === 0) {
    return {
      code: 'invoice_already_paid',
      message:
        'This invoice is already marked paid and carries no recorded payments to reconcile against, so a further payment would double-collect it.',
    };
  }
  return null;
}

function isDraftOrQuote(d: InvoiceDoc): boolean {
  const s = normalizedStatus(d);
  return s === 'draft' || s === 'quote';
}

/**
 * States that cannot take a payment at all. Withdrawn, or money that points the
 * other way: a credit is owed TO the household, so "collecting" against it is
 * not a smaller version of a normal payment, it is a different operation with a
 * negative total that the settlement arithmetic would read as an instant
 * overpayment. Refused explicitly rather than allowed to produce a plausible
 * number. Redemption is its own flow (`redeemCredit`).
 */
function refusedLifecycle(d: InvoiceDoc): string | null {
  const s = normalizedStatus(d);
  if (s === 'cancelled') return 'This invoice is cancelled, so a payment cannot be recorded against it.';
  if (s === 'credit') {
    return 'This is a credit owed to the household, not a bill. Redeeming it is its own flow.';
  }
  return null;
}

export interface MarkInvoicePaidResult {
  ok: true;
  invoiceId: string;
  paymentId: string;
  /** Where the invoice stands AFTER this payment, derived from every recorded payment. */
  state: InvoiceSettlementState;
  totalCents: number;
  /** Every payment on record, including the one just written. */
  paidCents: number;
  /** Still owed. Never negative. */
  amountDueCents: number;
  /** Collected beyond the total. Zero unless [state] is 'overpaid'. */
  overpaidCents: number;
}

export async function markInvoicePaidHandler(
  req: CallableRequest<unknown>,
): Promise<MarkInvoicePaidResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'markInvoicePaid validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().collection('invoices').doc(args.invoiceId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
  }
  const data = snap.data() as InvoiceDoc;

  if (isDraftOrQuote(data)) {
    throw new HttpsError(
      'failed-precondition',
      'Invoice is a draft or quote; send it first before recording a payment.',
    );
  }
  const lifecycleRefusal = refusedLifecycle(data);
  if (lifecycleRefusal) {
    throw new HttpsError('failed-precondition', lifecycleRefusal, { code: 'invoice_not_payable' });
  }

  // The payments SUBCOLLECTION is the only field that can say how much has come
  // in. Read BEFORE the guard, because the guard's whole job is to compare the
  // doc's claim against it.
  const paymentsSnap = await ref.collection('payments').get();
  const existingPayments = paymentsSnap.docs.map((d) => d.data() as PaymentAmount);
  const existingPaidCents = paidCentsFromPayments(existingPayments);
  const totalCents = invoiceTotalCentsOf(data);
  const before = settleInvoice(totalCents, existingPaidCents);

  const settledRefusal = alreadySettledRefusal(data, existingPayments.length, before.state);
  if (settledRefusal) {
    throw new HttpsError('failed-precondition', settledRefusal.message, { code: settledRefusal.code });
  }

  const familyId = data.kinfolkId;
  // Omitted `amount` means "settle the rest", and the rest is what the payments
  // leave outstanding. Reading `data.amountDue` here instead would record a $0
  // payment on every invoice the old write had already zeroed.
  const paidCents = args.amount !== undefined ? Math.round(args.amount * 100) : before.amountDueCents;
  const paidAmount = centsToDollars(paidCents);
  const paidAtIso = args.paidAt ?? new Date().toISOString();

  const after = settleInvoice(totalCents, existingPaidCents + paidCents);
  const settling = after.state === 'settled' || after.state === 'overpaid';

  const paymentRef = ref.collection('payments').doc();
  const batch = db().batch();
  batch.set(paymentRef, {
    // Both denominations. `amountCents` is what the settlement was computed
    // from and what future sums prefer; `amount` stays because every payment
    // recorded before this change carries only it, and the PDF and the Android
    // payments join both read dollars.
    amount: paidAmount,
    amountCents: paidCents,
    method: args.method ?? null,
    reference: args.reference ?? null,
    paidAt: paidAtIso,
    recordedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  batch.set(
    ref,
    {
      // A PARTIAL PAYMENT LEAVES THE INVOICE OPEN with a real balance, so it
      // stays in Outstanding and someone chases the rest. Only a settling
      // payment writes 'paid'.
      status: settling ? 'paid' : 'open',
      paymentStatus: settling ? 'PAID' : 'PARTIAL',
      // Integer cents: the truth. Written even on an un-itemized invoice, where
      // `totalCents` is projected from the dollar `total`, so every downstream
      // reader has an exact figure instead of re-deriving one from a float.
      totalCents: after.totalCents,
      paidCents: after.paidCents,
      amountDueCents: after.amountDueCents,
      overpaidCents: after.overpaidCents,
      // The legacy dollar scalar, projected from the SAME cents figure in the
      // same pass so the two can never disagree. Never negative: see
      // settleInvoice's note on why an overpayment must not read as a credit.
      amountDue: centsToDollars(after.amountDueCents),
      paymentMethod: args.method ?? null,
      paymentReference: args.reference ?? null,
      // `paidAt`/`paidBy` mean "when this invoice was PAID", so they are stamped
      // only by the payment that actually settles it. A partial stamps
      // `lastPaymentAt`/`lastPaymentBy` instead, which is a different claim and
      // deserves a different field rather than a premature version of this one.
      ...(settling
        ? { paidAt: FieldValue.serverTimestamp(), paidBy: uid }
        : {}),
      lastPaymentAt: FieldValue.serverTimestamp(),
      lastPaymentBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
  await batch.commit();

  await writeAuditEntry({
    event: AUDIT_EVENTS.BILLING_INVOICE_PAID,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.invoiceId,
    targetCollection: 'invoices',
    familyId,
    // The description says which of the two things happened. An audit line
    // reading "marked paid" for a $20 payment against a $40 invoice is how the
    // original defect stayed invisible in the audit trail as well as in the UI.
    description: settling
      ? `Invoice ${data.invoiceNumber ?? args.invoiceId} settled by a manually-recorded payment`
      : `Partial payment recorded against invoice ${data.invoiceNumber ?? args.invoiceId}; a balance is still owed`,
    payload: {
      invoiceId: args.invoiceId,
      kinfolkId: familyId ?? null,
      amount: paidAmount,
      amountCents: paidCents,
      method: args.method ?? null,
      reference: args.reference ?? null,
      paymentId: paymentRef.id,
      state: after.state,
      totalCents: after.totalCents,
      paidCents: after.paidCents,
      amountDueCents: after.amountDueCents,
      overpaidCents: after.overpaidCents,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'markInvoicePaid',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'markInvoicePaid',
    event: settling ? 'admin.invoice.paid.recorded' : 'admin.invoice.partial.recorded',
    uid,
    extra: {
      invoiceId: args.invoiceId,
      kinfolkId: familyId,
      paymentId: paymentRef.id,
      state: after.state,
      paidCents: after.paidCents,
      amountDueCents: after.amountDueCents,
      overpaidCents: after.overpaidCents,
    },
  });

  // An overpayment is reported, never absorbed. The operator sees the excess in
  // the response and decides what to do with it.
  if (after.state === 'overpaid') {
    logEvent({
      severity: 'warn',
      function: 'markInvoicePaid',
      event: 'admin.invoice.overpaid',
      uid,
      extra: {
        invoiceId: args.invoiceId,
        totalCents: after.totalCents,
        paidCents: after.paidCents,
        overpaidCents: after.overpaidCents,
      },
    });
  }

  return {
    ok: true,
    invoiceId: args.invoiceId,
    paymentId: paymentRef.id,
    state: after.state,
    totalCents: after.totalCents,
    paidCents: after.paidCents,
    amountDueCents: after.amountDueCents,
    overpaidCents: after.overpaidCents,
  };
}

export const markInvoicePaid = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('markInvoicePaid', markInvoicePaidHandler),
);
