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
  formatUsdCents,
  type PaymentAmount,
  type InvoiceSettlementState,
} from '../lib/invoiceMath';
import { invoiceStateStampOf } from '../lib/invoiceStateStamp';
import { INVOICE_WRITTEN_OFF_CODE, WRITTEN_OFF_PAYMENT_REFUSAL, isWrittenOff } from '../lib/invoiceArchive';
import {
  PAYMENT_APPLIED_OWNER_AT_FIELD,
  PAYMENT_APPLIED_OWNER_FIELD,
  SETTLEMENT_LEDGER_PENDING_AT_FIELD,
  SETTLEMENT_LEDGER_PENDING_FIELD,
  paymentAppliedOwner,
} from '../lib/paymentAppliedOwner';
import { InvoicePaymentIdempotencyKeyArg, assertSameCaller } from '../lib/moneyIdempotency';
import { validateResponse } from '../lib/callableResponse';
import {
  CentsSchema,
  InvoiceSettlementStateSchema,
  OkSchema,
} from '../lib/invoiceResponseSchema';

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
 * OVERPAYMENT: an `amount` above what is still owed is REFUSED (#1566,
 * `overBalanceRefusal` below): under the 2026-09-27 ruling the excess is tip,
 * and this callable has no tip to put it in. An invoice can still reach the
 * `overpaid` state another way (its total edited down after payment, or rows
 * written before the guard); then it settles, clamps `amountDue` at zero, and
 * records the excess as `overpaidCents` for the operator to act on
 * deliberately. It is never turned into a credit automatically. The full reasoning, and why a negative
 * balance would be actively wrong here, is on `settleInvoice` in invoiceMath.ts.
 *
 * Canonical store is the FLAT top-level `invoices` collection (the same one
 * createInvoice/postInvoiceEvent/sendInvoiceReminder read and write).
 *
 * #2269/#2230: THE ADMIN DIALOGS NO LONGER CALL THIS. Admin web, Android and
 * the desktop console record a payment as ONE `recordPayment` call carrying an
 * `apply`, which pays the bill, writes the ledger row and sends the notice from
 * one transaction. This callable stays, unchanged in its request and answer,
 * for the admin builds already installed, which still make the two calls.
 *
 * Notification: deliberately NOT enqueued here, and (#866) not by the invoice
 * trigger either. Older admin clients call this and then `recordPayment`, and
 * `recordPayment` carries the operator's Send Confirmation toggle. So a
 * settling payment stamps `paymentAppliedNoticeOwner` in the same write that
 * pays the bill, and `onInvoicesWrite` stays silent for it. Before #866 the
 * trigger sent on that write regardless, which doubled a ticked confirmation
 * and sent one the operator had left unticked. A PARTIAL payment leaves the
 * invoice open, so nothing is stamped and no trigger fires; its confirmation,
 * when ticked, also comes from `recordPayment`. Ownership table:
 * notifications/catalog.ts, on the `invoice.payment.applied` entry.
 *
 * #2230: a settling payment also stamps `settlementLedgerPending`, which that
 * `recordPayment` clears when it claims the settlement. When the app stops
 * before its second call, `lib/settlementLedgerSweep.ts` writes the ledger row
 * and sends the payoff notice instead.
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
  /**
   * #825: mint one per SUBMISSION, not per press, and this call becomes safe to
   * retry. It becomes the id of the `invoices/{invoiceId}/payments/{key}` row —
   * the money authority's own row, so the idempotency record and the payment
   * record are the same document and cannot drift apart.
   *
   * IT MATTERS MOST ON A PARTIAL. A retried full payment is caught by
   * `alreadySettledRefusal` — badly, with a `failed-precondition` for a payment
   * that worked, but caught. A retried PARTIAL is not caught by anything: the
   * invoice still has a balance, so the second attempt is a perfectly valid
   * second payment, and the household is recorded as having paid twice.
   *
   * OPTIONAL. Omitted, the row gets a server-minted auto id and there is no
   * dedupe, exactly as before.
   */
  idempotencyKey: InvoicePaymentIdempotencyKeyArg,
});

/**
 * THE GUARDS BELOW ARE EXPORTED, and this callable is still their only
 * definition.
 *
 * `lib/paymentApply.ts` puts one recorded payment across SEVERAL invoices, and
 * every invoice it touches has to be refused on exactly the grounds this
 * callable refuses one: a draft, a quote, a cancelled invoice, a credit, an
 * already-settled bill, or a paid-with-no-payments doc whose label is the only
 * evidence there is. Re-stating those five rules in a second file is how a
 * multi-invoice apply quietly grows a sixth opinion about what is payable, and
 * the shape of that bug is a household's credit note being collected against.
 *
 * Exported rather than moved into a lib: this module is where the reasoning
 * behind each refusal is written down, and the reasoning is the load-bearing
 * part of it.
 */
export type InvoiceDoc = {
  kinfolkId?: string;
  status?: string;
  paymentStatus?: string;
  invoiceNumber?: string;
  amountDue?: number;
  total?: number;
  totalCents?: number;
  [k: string]: unknown;
};

export function normalizedStatus(d: InvoiceDoc): string {
  return typeof d.status === 'string' ? d.status.trim().toLowerCase() : '';
}

/**
 * Whether the invoice's own labels CLAIM it is paid. A claim, not a finding:
 * what actually decides the refusal is this crossed with the recorded payments,
 * in [alreadySettledRefusal] below.
 */
export function claimsPaid(d: InvoiceDoc): boolean {
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
export function alreadySettledRefusal(
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

/**
 * #1566: NO MORE MAY GO ONTO AN INVOICE THAN IT STILL OWES.
 *
 * Operator ruling, 2026-09-27: an overpayment is all tip, the processor fee
 * comes out of the tip, and account credit exists only when she types an
 * amount. So the part of a payment that lands on the bill stops at the
 * balance, and whatever is over it is tip, booked by `recordPayment` on the
 * payment row where the fee can come out of it.
 *
 * Before this, an applied figure above the balance was accepted and the
 * invoice went `overpaid`: $100 typed against $78.50 put $100 on the bill and
 * $0.00 in the tip, so the $21.50 over was recorded as neither, and the fee had
 * nothing to come out of.
 *
 * REFUSED, NOT CLAMPED. This callable carries no tip, so clamping here would
 * drop the excess on the floor; and `paymentApply` is handed a tip the admin
 * typed, which the server never rewrites. The clients do the split before they
 * send (`paymentSplit` on admin web and Android, `recordPaymentSplit` on the
 * desktop console) and show it as she types; this is the guard behind them.
 *
 * `before` is the settlement from every recorded payment, the same figure the
 * already-settled guard reads, so a stale `amountDue` scalar cannot move it.
 * The `overpaid` state itself is kept: an invoice whose total is edited down
 * after it was paid, and rows written before this guard, still land there.
 */
export const OVER_BALANCE_REFUSAL_CODE = 'invoice_amount_exceeds_balance';
export function overBalanceRefusal(
  appliedCents: number,
  before: { amountDueCents: number },
): { code: string; message: string; amountDueCents: number } | null {
  if (appliedCents <= before.amountDueCents) return null;
  return {
    code: OVER_BALANCE_REFUSAL_CODE,
    amountDueCents: before.amountDueCents,
    message:
      `${formatUsdCents(appliedCents)} is more than the ${formatUsdCents(before.amountDueCents)} still owed on this invoice. ` +
      `Apply ${formatUsdCents(before.amountDueCents)} and record the rest of the payment as tip.`,
  };
}

export function isDraftOrQuote(d: InvoiceDoc): boolean {
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
export function refusedLifecycle(d: InvoiceDoc): string | null {
  const s = normalizedStatus(d);
  if (s === 'cancelled') return 'This invoice is cancelled, so a payment cannot be recorded against it.';
  if (s === 'credit') {
    return 'This is a credit owed to the household, not a bill. Redeeming it is its own flow.';
  }
  // #2090: the owner gave up what was left. Taking money against it now would
  // collect a balance the household was told it no longer owes.
  if (isWrittenOff(d)) return WRITTEN_OFF_PAYMENT_REFUSAL;
  return null;
}

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS type
 * below. The schema is the authority, so the hand-written interface it
 * replaced is gone rather than left beside it to drift.
 *
 * THESE FIGURES ARE DERIVED FROM EVERY RECORDED PAYMENT, not from the `amount`
 * in the request, which is why the caller cannot compute them and why this
 * response is the operator's only honest account of where the invoice now
 * stands. The React admin destructures all six fields
 * (`api/invoicesWrite.ts#markInvoicePaid`) and Android decodes `state`
 * (`decodeInvoiceSettlement`).
 *
 * `amountDueCents` is non-negative BY SCHEMA, not merely by convention: a
 * negative balance is this codebase's credit signal, so an over-collected
 * invoice leaking one here would read downstream as money owed BACK to the
 * household. The excess ships as `overpaidCents` instead.
 */
export const Result = z
  .object({
    ok: OkSchema,
    invoiceId: z.string().min(1),
    /** The `invoices/{id}/payments/{paymentId}` row written in the same batch. */
    paymentId: z.string().min(1),
    /** Where the invoice stands AFTER this payment, derived from every recorded payment. */
    state: InvoiceSettlementStateSchema,
    totalCents: CentsSchema,
    /** Every payment on record, including the one just written. */
    paidCents: CentsSchema,
    /** Still owed. Never negative; see the header. */
    amountDueCents: CentsSchema,
    /** Collected beyond the total. Zero unless `state` is 'overpaid'. */
    overpaidCents: CentsSchema,
  })
  .strict();
export type MarkInvoicePaidResult = z.infer<typeof Result>;

/** A stored number, or 0. Absent reads as zero, never as a guess. */
function storedCents(stored: Record<string, unknown>, field: string): number {
  const v = stored[field];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * THE ANSWER A RETRY GETS: where the invoice stood after the FIRST attempt's
 * payment, read off the row that attempt wrote.
 *
 * `settlement` is written by every payment row this callable creates, so the
 * only rows without one are rows written before #825 — and those cannot be
 * reached by a key, because a key-shaped id never collides with an auto id.
 * An absent map is still handled rather than assumed away: it reads as the
 * settlement of an invoice with this payment on it and nothing else, which is
 * the most this function can honestly say from the row alone.
 */
function replayResult(
  invoiceId: string,
  paymentId: string,
  stored: Record<string, unknown>,
): z.infer<typeof Result> {
  const raw = stored['settlement'];
  const s = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const state = s['state'];
  return validateResponse('markInvoicePaid', Result, {
    ok: true,
    invoiceId,
    paymentId,
    state: (typeof state === 'string' ? state : 'partial') as InvoiceSettlementState,
    totalCents: storedCents(s, 'totalCents'),
    paidCents: storedCents(s, 'paidCents'),
    amountDueCents: storedCents(s, 'amountDueCents'),
    overpaidCents: storedCents(s, 'overpaidCents'),
  });
}

export async function markInvoicePaidHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
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
  const paymentRef =
    args.idempotencyKey !== undefined
      ? ref.collection('payments').doc(args.idempotencyKey)
      : ref.collection('payments').doc();

  // ── THE FAST PATH (#825), BEFORE EVERY GUARD BELOW ──────────────────────
  //
  // A key whose row already exists is answered from that row. It has to run
  // here, ahead of the guards, because the guards are what a retry trips: the
  // first attempt settles the invoice, and the second is refused by
  // `alreadySettledRefusal` — `failed-precondition` reported for a payment that
  // is recorded and correct. The whole point of a key is that a retry cannot
  // turn a success into an error message.
  if (args.idempotencyKey !== undefined) {
    const existing = await paymentRef.get();
    if (existing.exists) {
      const stored = (existing.data() ?? {}) as Record<string, unknown>;
      assertSameCaller(stored, uid, 'recordedBy');
      logEvent({
        severity: 'info',
        function: 'markInvoicePaid',
        event: 'admin.invoice.payment.replay',
        uid,
        extra: { invoiceId: args.invoiceId, paymentId: paymentRef.id },
      });
      return replayResult(args.invoiceId, paymentRef.id, stored);
    }
  }

  const paidAtIso = args.paidAt ?? new Date().toISOString();

  // ── ONE TRANSACTION: EVERY READ, EVERY GUARD, THE ROW, THE INVOICE (#2269) ─
  //
  // Before #2269 the invoice and its payments were read OUTSIDE this
  // transaction, the new balance was worked out from that read, and the
  // transaction only re-read the invoice to refuse a write-off (#2090). Two
  // payments recorded at the same moment both read the same "before", and the
  // second one to commit wrote its balance from it: the invoice then said more
  // was owed than its payments left, and the first payment was missing from
  // `paidCents`.
  //
  // Now the invoice doc and its `payments` subcollection are read here, and
  // every figure written below is derived from those two reads. Every other
  // path that moves money onto an invoice (recordPayment's apply, the credit
  // draw, an unapplied card payment's decision, the Stripe webhook, the repair
  // pass) reads and writes the same invoice doc inside its own transaction, so
  // the invoice doc is the point they all serialise on: whichever commits
  // second re-runs against what the first committed, and its guards (already
  // settled, over the balance) run again on the new figures.
  //
  // Anything thrown in here aborts the attempt, so a refusal writes nothing.
  // Nothing is logged or audited from inside: an attempt can be discarded and
  // re-run, and a line written from a discarded attempt would report money
  // that never moved.
  const outcome = await db().runTransaction(async (tx) => {
    // Every read before every write, which Firestore requires and the guard
    // wants anyway.
    if (args.idempotencyKey !== undefined) {
      const existing = await tx.get(paymentRef);
      if (existing.exists) {
        const stored = (existing.data() ?? {}) as Record<string, unknown>;
        assertSameCaller(stored, uid, 'recordedBy');
        return { replayed: stored } as const;
      }
    }
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new HttpsError('not-found', `Invoice '${args.invoiceId}' not found.`);
    }
    const data = snap.data() as InvoiceDoc;
    // The payments SUBCOLLECTION is the only field that can say how much has
    // come in. Read in this transaction, after the invoice, so the balance
    // below and the payments it is summed from are the same snapshot.
    const paymentsSnap = await tx.get(ref.collection('payments'));

    if (isDraftOrQuote(data)) {
      throw new HttpsError(
        'failed-precondition',
        'Invoice is a draft or quote; send it first before recording a payment.',
      );
    }
    // #2090: the owner gave up what was left. Decided on this transaction's own
    // read, so a write-off committing first makes this attempt re-run and refuse.
    if (isWrittenOff(data)) {
      throw new HttpsError('failed-precondition', WRITTEN_OFF_PAYMENT_REFUSAL, { code: INVOICE_WRITTEN_OFF_CODE });
    }
    const lifecycleRefusal = refusedLifecycle(data);
    if (lifecycleRefusal) {
      throw new HttpsError('failed-precondition', lifecycleRefusal, { code: 'invoice_not_payable' });
    }

    const existingPayments = paymentsSnap.docs.map((d) => d.data() as PaymentAmount);
    const existingPaidCents = paidCentsFromPayments(existingPayments);
    const totalCents = invoiceTotalCentsOf(data);
    const before = settleInvoice(totalCents, existingPaidCents);

    const settledRefusal = alreadySettledRefusal(data, existingPayments.length, before.state);
    if (settledRefusal) {
      throw new HttpsError('failed-precondition', settledRefusal.message, { code: settledRefusal.code });
    }

    // Omitted `amount` means "settle the rest", and the rest is what the
    // payments leave outstanding. Reading `data.amountDue` here instead would
    // record a $0 payment on every invoice the old write had already zeroed.
    const paidCents = args.amount !== undefined ? Math.round(args.amount * 100) : before.amountDueCents;
    // #1566: what is over the balance is tip, and this callable has no tip to
    // put it in. Refused before anything is written.
    const overBalance = overBalanceRefusal(paidCents, before);
    if (overBalance) {
      throw new HttpsError('failed-precondition', overBalance.message, { code: overBalance.code });
    }
    const paidAmount = centsToDollars(paidCents);
    const after = settleInvoice(totalCents, existingPaidCents + paidCents);
    const settling = after.state === 'settled' || after.state === 'overpaid';

    const paymentRow = {
      // Both denominations. `amountCents` is what the settlement was computed
      // from and what future sums prefer; `amount` stays because every payment
      // recorded before this change carries only it, and the PDF and the
      // Android payments join both read dollars.
      amount: paidAmount,
      amountCents: paidCents,
      method: args.method ?? null,
      reference: args.reference ?? null,
      paidAt: paidAtIso,
      recordedBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      // #825, DENORMALIZED SO A REPLAY CAN BE ANSWERED FROM ONE READ. This is
      // where the invoice stood after THIS payment, which is what this call
      // reported and therefore what a retry of it must report. Recomputing on a
      // retry would answer with today's settlement instead, so the same call
      // would return different figures depending on how often it was retried.
      // `paidCentsFromPayments` reads only `amount`/`amountCents`, so an extra
      // map on the row changes no sum anywhere.
      settlement: {
        state: after.state,
        totalCents: after.totalCents,
        paidCents: after.paidCents,
        amountDueCents: after.amountDueCents,
        overpaidCents: after.overpaidCents,
      },
    };
    const invoiceUpdate = {
      // A PARTIAL PAYMENT LEAVES THE INVOICE OPEN with a real balance, so it
      // stays in Outstanding and someone chases the rest. Only a settling
      // payment writes 'paid'. (The state stamp below re-derives the same value
      // from the merged doc; writing it here too keeps the rule readable at the
      // point it is decided.)
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
        ? {
            paidAt: FieldValue.serverTimestamp(),
            paidBy: uid,
            // #866: the household's confirmation for this payment belongs to the
            // `recordPayment` step the older admin clients run next, which
            // carries the Send Confirmation toggle. Stamped in the write that
            // pays the bill, so `onInvoicesWrite` neither doubles a ticked
            // confirmation nor sends one the admin left unticked.
            [PAYMENT_APPLIED_OWNER_FIELD]: paymentAppliedOwner('markInvoicePaid', paymentRef.id),
            // When the stamp was written, so an older admin client that does not
            // send this settlement's id can still claim it moments later, and no
            // unrelated payment days later can (OLD_CLIENT_CLAIM_WINDOW_MS).
            [PAYMENT_APPLIED_OWNER_AT_FIELD]: Date.now(),
            // #2230: and until that step claims it, this settlement is owed a
            // ledger row and a notice. If the app is closed or reloaded before
            // its second call, the sweep finishes both
            // (`lib/settlementLedgerSweep.ts`); the claim clears this.
            [SETTLEMENT_LEDGER_PENDING_FIELD]: paymentAppliedOwner('markInvoicePaid', paymentRef.id),
            [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: Date.now(),
          }
        : {}),
      lastPaymentAt: FieldValue.serverTimestamp(),
      lastPaymentBy: uid,
      updatedAt: FieldValue.serverTimestamp(),
    };
    // `create` when there is a key, so two attempts reaching the write together
    // are refereed by the server. A keyless call keeps `set`: its id is
    // server-minted and cannot collide.
    if (args.idempotencyKey !== undefined) tx.create(paymentRef, paymentRow);
    else tx.set(paymentRef, paymentRow);
    tx.set(
      ref,
      {
        ...invoiceUpdate,
        // The state stamp (ADR-0002), in the SAME commit as the money it
        // describes. Derived from the doc as this write leaves it, with the new
        // payment included in paidCents: a settling payment stamps paid/none, a
        // partial stamps open/all (part-paid stays fully editable), and an
        // overpayment stamps paid off the CLAMPED zero balance, never credit.
        ...invoiceStateStampOf({ ...data, ...invoiceUpdate }, after.paidCents),
      },
      { merge: true },
    );
    return {
      replayed: null,
      familyId: data.kinfolkId,
      invoiceNumber: data.invoiceNumber,
      paidCents,
      paidAmount,
      after,
      settling,
    } as const;
  });

  if (outcome.replayed !== null) {
    logEvent({
      severity: 'info',
      function: 'markInvoicePaid',
      event: 'admin.invoice.payment.replay',
      uid,
      extra: { invoiceId: args.invoiceId, paymentId: paymentRef.id, raced: true },
    });
    return replayResult(args.invoiceId, paymentRef.id, outcome.replayed);
  }
  const { familyId, paidCents, paidAmount, after, settling } = outcome;
  const data = { invoiceNumber: outcome.invoiceNumber };

  await writeAuditEntry({
    status: 'SUCCESS',
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
      // Which submission this row belongs to. An audit trail that cannot tell a
      // second payment from a second attempt at one payment is the trail that
      // would have had to answer #825 after the fact.
      idempotencyKey: args.idempotencyKey ?? null,
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

  return validateResponse('markInvoicePaid', Result, {
    ok: true,
    invoiceId: args.invoiceId,
    paymentId: paymentRef.id,
    state: after.state,
    totalCents: after.totalCents,
    paidCents: after.paidCents,
    amountDueCents: after.amountDueCents,
    overpaidCents: after.overpaidCents,
  });
}

export const markInvoicePaid = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('markInvoicePaid', markInvoicePaidHandler),
);
