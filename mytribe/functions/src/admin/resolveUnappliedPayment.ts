import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { TRIBETAILS_CORS } from '../lib/cors';
import { refuseAuntie } from '../lib/staffGate';
import { resolveInvoiceWriteActor, testOwnsDoc } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import { CentsSchema, OkSchema, SignedCentsSchema } from '../lib/invoiceResponseSchema';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { assertSameCaller } from '../lib/moneyIdempotency';
import { sendIdempotencyKeyRe } from '../lib/sendIdempotency';
import { ACCOUNT_BALANCE_FIELD, readAccountBalanceCents } from '../lib/accountCredit';
import { MAX_CREDIT_REASON_LENGTH, stageGivenCredit } from '../lib/creditLedger';
import { planApply, stageApply, type ApplyOutcome } from '../lib/paymentApply';
import { invoiceIsPaid, PAID_INVOICE_REFUSAL, PAID_INVOICE_REFUSAL_CODE } from '../lib/invoicePaidGate';
import { paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import type { InvoiceDoc } from './markInvoicePaid';

/**
 * DECIDE WHAT AN UNAPPLIED CARD PAYMENT BECOMES (#1003).
 *
 * Since docket Q5 (PR #1001) a card checkout that completes on an invoice that
 * is already paid, or on a stale checkout round, is recorded by the Stripe
 * webhook as a root `payments/{eventId}` row with `appliedTo: 'unapplied'` and
 * `needsAdminDecision: true`. The money is on nobody's bill and in nobody's
 * account balance until the owner decides. This is that decision.
 *
 * THE PARTS, each optional, together at most the payment:
 *
 *   creditCents   put into the household's account credit, with a reason.
 *                 Written through `stageGivenCredit`, the same path as
 *                 `giveAccountCredit` (docket Q6), so the credit history shows
 *                 it with its reason and the balance moves in the same
 *                 transaction. Account credit only when the admin enters an
 *                 amount (#988): nothing here picks an amount for her.
 *   applyCents    put on ONE other OPEN invoice of the same household, through
 *                 `planApply`/`stageApply`, the same rows `recordPayment`
 *                 writes. One payment, one invoice (ruling 2026-08-04).
 *   the rest      `keptCents`, stays recorded on the payment and goes nowhere.
 *                 No refunds, ever (ruling 2026-08-06), so "the rest" is not
 *                 sent back. An all-zero decision is allowed: it is the admin
 *                 saying "leave it as it is", and it clears the flag.
 *
 * REFUSALS, all `failed-precondition` with a `details.code`:
 *   - `decision_exceeds_payment`  credit + apply is more than the payment.
 *   - `payment_amount_unknown`    Stripe reported no amount (`amountResolved:
 *                                 false`), so no part may be more than zero.
 *   - `invoice_already_paid`      the target invoice is paid, by label or by
 *                                 money (`lib/invoicePaidGate.ts`, docket Q5).
 *                                 Checked BEFORE `planApply`, because
 *                                 `alreadySettledRefusal` keeps one admin
 *                                 exception (label paid, partial payments
 *                                 recorded) that this path must not use.
 *   - `apply_exceeds_due`         more is applied than the invoice owes. The
 *                                 rest belongs in account credit.
 *   - every `planApply` refusal: other household, draft or quote, cancelled,
 *     credit note, missing invoice.
 *   - `already_decided`           the payment was decided under another key.
 *   - `no_decision_needed`        the payment was never flagged.
 *
 * WHO. The owner, or a sandbox test admin inside their own test tribe
 * (`resolveInvoiceWriteActor`). An Auntie never sees money: `refuseAuntie`
 * refuses her by role first. Kinfolk are refused by the actor gate.
 *
 * IDEMPOTENCY. The key (`upd_<millis>_<suffix>`) is required and stored on the
 * payment's decision. A replay of the same key answers the stored decision and
 * writes nothing. The same key from another admin is refused. The decision is
 * made inside one transaction that re-reads the payment, so two attempts that
 * overlap cannot both decide. The credit event's id is fixed per payment
 * (`unapplied_<paymentId>`) and created with `create`, a second backstop.
 *
 * NOTICES. None is sent from here. When the apply pays the target invoice off,
 * no notice owner is stamped (`stageApply`'s `noticeOwner: null`), so
 * `onInvoicesWrite` sends the household the ordinary `invoice.payment.applied`
 * on the open-to-paid transition, as for any other payment that clears a bill.
 * A credit sends nothing, the same as `giveAccountCredit`.
 *
 * THE ORIGINAL INVOICE is not touched. Its `unappliedPaymentIds` stays as the
 * record that a second charge came in.
 */

export const RESOLVE_UNAPPLIED_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('upd');

/** The ledger event id a payment's credit part is written under. One per payment, ever. */
export function unappliedCreditEventId(paymentId: string): string {
  return `unapplied_${paymentId}`;
}

export const Args = z
  .object({
    paymentId: z.string().min(1).max(200),
    /** Integer cents to put into account credit. 0 for none. */
    creditCents: z.number().int().min(0),
    /** Why, when `creditCents` is more than zero. Shown in the credit history. */
    creditReason: z.string().trim().max(MAX_CREDIT_REASON_LENGTH),
    /** The OPEN invoice of the same household to apply to, or '' for none. */
    applyInvoiceId: z.string().max(200),
    /** Integer cents to put on `applyInvoiceId`. 0 for none. */
    applyCents: z.number().int().min(0),
    idempotencyKey: z
      .string()
      .regex(RESOLVE_UNAPPLIED_IDEMPOTENCY_KEY_RE, 'idempotencyKey must look like upd_<millis>_<suffix>'),
  })
  .strict();

export const Result = z
  .object({
    ok: OkSchema,
    paymentId: z.string().min(1),
    kinfolkId: z.string(),
    /** The whole payment, or 0 when Stripe reported no amount. */
    paymentCents: CentsSchema,
    creditedCents: CentsSchema,
    /** The `given` event's id in the credit history, '' when no credit was given. */
    creditId: z.string(),
    appliedCents: CentsSchema,
    /** '' when nothing was applied. */
    appliedInvoiceId: z.string(),
    appliedInvoiceNumber: z.string(),
    /** Where the applied-to invoice stands afterwards: 'settled', 'partial', ... or '' when none. */
    appliedInvoiceState: z.string(),
    appliedInvoiceAmountDueCents: CentsSchema,
    /** What stays recorded on the payment and goes nowhere. */
    keptCents: CentsSchema,
    /** The household balance after the credit. Only meaningful when `creditedCents > 0`. */
    newAccountBalanceCents: SignedCentsSchema,
    replayed: z.boolean(),
  })
  .strict();

export type ResolveUnappliedPaymentArgs = z.infer<typeof Args>;
export type ResolveUnappliedPaymentResult = z.infer<typeof Result>;

/** The decision as stored on the payment row, and replayed from it. */
type StoredDecision = Omit<ResolveUnappliedPaymentResult, 'ok' | 'replayed'> & {
  idempotencyKey: string;
  decidedBy: string;
  decidedAtMs: number;
  creditReason: string;
};

function refuse(code: string, message: string): never {
  throw new HttpsError('failed-precondition', message, { code });
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function replayOf(stored: Record<string, unknown>): ResolveUnappliedPaymentResult {
  const d = (stored['adminDecision'] ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    paymentId: str(d['paymentId']),
    kinfolkId: str(d['kinfolkId']),
    paymentCents: num(d['paymentCents']),
    creditedCents: num(d['creditedCents']),
    creditId: str(d['creditId']),
    appliedCents: num(d['appliedCents']),
    appliedInvoiceId: str(d['appliedInvoiceId']),
    appliedInvoiceNumber: str(d['appliedInvoiceNumber']),
    appliedInvoiceState: str(d['appliedInvoiceState']),
    appliedInvoiceAmountDueCents: num(d['appliedInvoiceAmountDueCents']),
    keptCents: num(d['keptCents']),
    newAccountBalanceCents: num(d['newAccountBalanceCents']),
    replayed: true,
  };
}

/**
 * The replay test for a payment row already decided. Returns the stored answer
 * for the same key from the same admin, and refuses anything else.
 */
function replayOrRefuse(stored: Record<string, unknown>, key: string, uid: string): ResolveUnappliedPaymentResult {
  const decision = stored['adminDecision'];
  if (decision && typeof decision === 'object') {
    const d = decision as Record<string, unknown>;
    if (d['idempotencyKey'] === key) {
      assertSameCaller(d, uid, 'decidedBy');
      return replayOf(stored);
    }
    refuse('already_decided', 'A decision has already been made for this payment.');
  }
  refuse('no_decision_needed', 'This payment is not waiting for a decision.');
}

/** What the payment has to give, or null when Stripe reported no amount. */
function paymentCentsOf(row: Record<string, unknown>): number | null {
  if (row['amountResolved'] === false) return null;
  const cents = row['amountCents'];
  if (typeof cents === 'number' && Number.isFinite(cents) && cents > 0) return Math.round(cents);
  return null;
}

export async function resolveUnappliedPaymentHandler(
  req: CallableRequest<unknown>,
): Promise<ResolveUnappliedPaymentResult> {
  initSentry();
  // Before the actor gate, so her refusal is logged as a caretaker refusal.
  refuseAuntie(req.auth, 'resolveUnappliedPayment');
  const actor = resolveInvoiceWriteActor(req, 'resolveUnappliedPayment');

  let args: ResolveUnappliedPaymentArgs;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'resolveUnappliedPayment validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }
  const applyInvoiceId = args.applyInvoiceId.trim();
  if (args.creditCents > 0 && args.creditReason === '') {
    throw new HttpsError('invalid-argument', 'Enter a reason for the account credit.');
  }
  if (args.applyCents > 0 && applyInvoiceId === '') {
    throw new HttpsError('invalid-argument', 'Choose the invoice to apply the payment to.');
  }
  if (args.applyCents === 0 && applyInvoiceId !== '') {
    throw new HttpsError('invalid-argument', 'Enter the amount to apply to the invoice.');
  }

  const firestore = db();
  const paymentRef = firestore.collection('payments').doc(args.paymentId);

  // THE FAST PATH. A decided payment is answered before anything else runs.
  const first = await paymentRef.get();
  if (!first.exists) throw new HttpsError('not-found', 'Payment not found.');
  const firstRow = (first.data() ?? {}) as Record<string, unknown>;
  const kinfolkId = str(firstRow['kinfolkId']);
  if (!testOwnsDoc(actor.testMode, kinfolkId)) {
    throw new HttpsError('permission-denied', 'This household is outside your test sandbox.');
  }
  if (firstRow['needsAdminDecision'] !== true) {
    const replay = replayOrRefuse(firstRow, args.idempotencyKey, actor.uid);
    logEvent({
      severity: 'info',
      function: 'resolveUnappliedPayment',
      event: 'admin.unapplied.decided.replay',
      uid: actor.uid,
      extra: { paymentId: args.paymentId, kinfolkId },
    });
    return validateResponse('resolveUnappliedPayment', Result, replay);
  }

  const atMs = Date.now();
  const famRef = firestore.collection('families').doc(kinfolkId);
  const invRef = applyInvoiceId !== '' ? firestore.collection('invoices').doc(applyInvoiceId) : null;

  const committed = await firestore.runTransaction(async (tx) => {
    // ALL READS BEFORE WRITES.
    const paySnap = await tx.get(paymentRef);
    if (!paySnap.exists) throw new HttpsError('not-found', 'Payment not found.');
    const row = (paySnap.data() ?? {}) as Record<string, unknown>;
    if (row['needsAdminDecision'] !== true) {
      return { kind: 'replay' as const, replay: replayOrRefuse(row, args.idempotencyKey, actor.uid) };
    }
    const famSnap = args.creditCents > 0 ? await tx.get(famRef) : null;
    const invSnap = invRef ? await tx.get(invRef) : null;
    const invPaymentsSnap = invRef && invSnap?.exists ? await tx.get(invRef.collection('payments')) : null;

    // THE BOUND. Every part is measured against what the card actually paid.
    const paymentCents = paymentCentsOf(row);
    const decided = args.creditCents + args.applyCents;
    if (paymentCents === null) {
      if (decided > 0) {
        refuse(
          'payment_amount_unknown',
          'Stripe reported no amount for this payment, so none of it can be credited or applied.',
        );
      }
    } else if (decided > paymentCents) {
      refuse(
        'decision_exceeds_payment',
        `The credit and the applied amount add up to ${usd(decided)}, but this payment is ${usd(paymentCents)}.`,
      );
    }

    let plannedApply: ReturnType<typeof planApply> | null = null;
    if (invRef && invSnap) {
      const doc = invSnap.exists ? ((invSnap.data() ?? {}) as InvoiceDoc) : null;
      const existingPayments = (invPaymentsSnap?.docs ?? []).map((d) => d.data() as PaymentAmount);
      // THE RULING FIRST (docket Q5): a paid invoice takes no payment, and the
      // label alone is enough. See the header for why this precedes planApply.
      if (doc !== null && invoiceIsPaid(doc as never, paidCentsFromPayments(existingPayments))) {
        refuse(PAID_INVOICE_REFUSAL_CODE, PAID_INVOICE_REFUSAL);
      }
      plannedApply = planApply({
        invoice: { invoiceId: applyInvoiceId, doc, existingPayments },
        appliedCents: args.applyCents,
        kinfolkId,
        spendableCents: (paymentCents ?? 0) - args.creditCents,
      });
      if (!plannedApply.ok) refuse(plannedApply.refusal.code, plannedApply.refusal.message);
      // NO OVERPAYMENT BY DECISION. What the invoice does not owe belongs in
      // account credit, where the admin can see it and say why; putting it on
      // a bill would leave an overpaid invoice nobody chose.
      if (args.applyCents > plannedApply.step.before.amountDueCents) {
        refuse(
          'apply_exceeds_due',
          `Invoice ${plannedApply.step.invoiceNumber || applyInvoiceId} owes ${usd(plannedApply.step.before.amountDueCents)}, ` +
            `so no more than that can be applied to it.`,
        );
      }
      // planApply lets a standalone payment ('' household) through; this one
      // always names its household, and the invoice must name the same one.
      const invKin = str((doc as Record<string, unknown> | null)?.['kinfolkId']);
      if (invKin !== kinfolkId) {
        refuse('apply_wrong_household', 'That invoice belongs to a different household than this payment.');
      }
    }
    if (famSnap && !famSnap.exists) throw new HttpsError('not-found', 'Household not found.');

    // ── WRITES ─────────────────────────────────────────────────────────────
    let creditId = '';
    let newBalance = 0;
    if (args.creditCents > 0 && famSnap) {
      const before = readAccountBalanceCents((famSnap.data() ?? {})[ACCOUNT_BALANCE_FIELD]);
      creditId = unappliedCreditEventId(args.paymentId);
      newBalance = stageGivenCredit(firestore, tx, {
        kinfolkId,
        eventId: creditId,
        amountCents: args.creditCents,
        reason: args.creditReason,
        givenBy: actor.uid,
        balanceBeforeCents: before,
        atMs,
        testMode: actor.testMode.active,
        sourcePaymentId: args.paymentId,
      }).balanceAfterCents;
    }

    let application: ApplyOutcome | null = null;
    if (plannedApply && plannedApply.ok) {
      application = stageApply(firestore, tx, {
        step: plannedApply.step,
        sourcePaymentId: args.paymentId,
        method: str(row['paymentMethod']) || 'stripe',
        reference: str(row['referenceNumber']) || null,
        paidAtIso: new Date(atMs).toISOString(),
        uid: actor.uid,
        noticeOwner: null,
      });
    }

    const decision: StoredDecision = {
      paymentId: args.paymentId,
      kinfolkId,
      paymentCents: paymentCents ?? 0,
      creditedCents: args.creditCents,
      creditId,
      creditReason: args.creditCents > 0 ? args.creditReason : '',
      appliedCents: args.applyCents,
      appliedInvoiceId: application?.invoiceId ?? '',
      appliedInvoiceNumber: application?.invoiceNumber ?? '',
      appliedInvoiceState: application?.state ?? '',
      appliedInvoiceAmountDueCents: application?.amountDueCents ?? 0,
      keptCents: Math.max(0, (paymentCents ?? 0) - decided),
      newAccountBalanceCents: newBalance,
      idempotencyKey: args.idempotencyKey,
      decidedBy: actor.uid,
      decidedAtMs: atMs,
    };

    tx.set(
      paymentRef,
      {
        needsAdminDecision: false,
        appliedTo: 'adminDecision',
        appliedToInvoice: args.applyCents > 0,
        // The fields the admin ledgers read (`getInvoiceLedger`,
        // `listPayments`), so the row reconciles: amount = applied + unapplied.
        appliedInvoiceId: application?.invoiceId ?? '',
        appliedInvoiceNumber: application?.invoiceNumber ?? '',
        appliedCents: args.applyCents,
        creditedToAccountCents: args.creditCents,
        application,
        adminDecision: decision,
        decidedBy: actor.uid,
        decidedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    return { kind: 'decided' as const, decision, application };
  });

  if (committed.kind === 'replay') {
    logEvent({
      severity: 'info',
      function: 'resolveUnappliedPayment',
      event: 'admin.unapplied.decided.replay',
      uid: actor.uid,
      extra: { paymentId: args.paymentId, kinfolkId, raced: true },
    });
    return validateResponse('resolveUnappliedPayment', Result, committed.replay);
  }
  const d = committed.decision;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_UNAPPLIED_PAYMENT_DECIDED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: actor.uid,
    targetUid: args.paymentId,
    targetCollection: 'payments',
    familyId: kinfolkId || undefined,
    description:
      `Unapplied payment ${args.paymentId} decided: ${d.creditedCents} cents to account credit, ` +
      `${d.appliedCents} cents to invoice ${d.appliedInvoiceNumber || d.appliedInvoiceId || '(none)'}, ` +
      `${d.keptCents} cents kept as recorded`,
    payload: {
      paymentId: args.paymentId,
      kinfolkId,
      paymentCents: d.paymentCents,
      creditedCents: d.creditedCents,
      creditId: d.creditId,
      creditReason: d.creditReason,
      appliedCents: d.appliedCents,
      appliedInvoiceId: d.appliedInvoiceId,
      appliedInvoiceState: d.appliedInvoiceState,
      keptCents: d.keptCents,
      newAccountBalanceCents: d.creditedCents > 0 ? d.newAccountBalanceCents : null,
      testMode: actor.testMode.active,
      idempotencyKey: args.idempotencyKey,
    },
    docId: `unapplied_payment_decided_${args.paymentId}`,
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'resolveUnappliedPayment',
      event: 'audit.write.failed',
      uid: actor.uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'resolveUnappliedPayment',
    event: 'admin.unapplied.decided',
    uid: actor.uid,
    extra: {
      paymentId: args.paymentId,
      kinfolkId,
      creditedCents: d.creditedCents,
      appliedCents: d.appliedCents,
      appliedInvoiceId: d.appliedInvoiceId,
      keptCents: d.keptCents,
      testMode: actor.testMode.active,
    },
  });

  const { idempotencyKey: _k, decidedBy: _b, decidedAtMs: _t, creditReason: _r, ...answer } = d;
  return validateResponse('resolveUnappliedPayment', Result, { ok: true, ...answer, replayed: false });
}

export const resolveUnappliedPayment = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped test
  // admin, same as every other callable on the invoice surface.
  wrapCallable('resolveUnappliedPayment', resolveUnappliedPaymentHandler),
);
