import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import type { DocumentReference } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { resolveInvoiceWriteActor, scopedKinfolkId } from '../lib/testMode';
import { validateResponse } from '../lib/callableResponse';
import {
  CentsSchema,
  InvoiceSettlementStateSchema,
  OkSchema,
  SignedCentsSchema,
} from '../lib/invoiceResponseSchema';
import { TIP_BASES, dollarsToCents, paymentMoneyOf } from '../lib/paymentMoney';
import {
  balanceToSettle,
  planApply,
  readInvoiceForApplyInTransaction,
  type InvoiceForApply,
  stageApply,
  type ApplyOutcome,
  type ApplyStep,
} from '../lib/paymentApply';
import { creditAccount } from '../lib/accountCredit';
import { stageCreditInEvent } from '../lib/creditLedger';
import { hiddenFromHousehold } from '../lib/quoteDecision';
import { centsToDollars, formatUsdCents, paidCentsFromPayments, type PaymentAmount } from '../lib/invoiceMath';
import { PaymentIdempotencyKeyArg, assertSameCaller } from '../lib/moneyIdempotency';
// #1005: money notices go to a member with billing access, not the last-synced account.
import { resolveBillingRecipientUid } from '../lib/resolveBillingRecipientUid';
import {
  deliverListedCopy,
  enqueueNotificationDetailed,
  hasDeliveredCopy,
  type ListedCopyDelivery,
} from '../notifications/dispatcher';
import type { HouseholdSendGateState } from '../notifications/householdSendGate';
import { reachedAppOnly } from '../notifications/appOnly';
import { isNoRecipientsError } from '../notifications/recipientErrors';
import {
  PAYMENT_APPLIED_CLAIM_FIELD,
  SETTLEMENT_LEDGER_PENDING_AT_FIELD,
  SETTLEMENT_LEDGER_PENDING_FIELD,
  SETTLEMENT_LEDGER_ROW_FIELD,
  SETTLEMENT_LEDGER_SWEEP_WRITER,
  SETTLEMENT_NOTICE_UID_FIELD,
  claimableMarkInvoicePaidOwner,
  markInvoicePaidSettlementOf,
  paymentAppliedOwner,
  settlementLedgerRowId,
} from '../lib/paymentAppliedOwner';
import { INVOICE_WRITTEN_OFF_CODE, WRITTEN_OFF_PAYMENT_REFUSAL, isWrittenOff } from '../lib/invoiceArchive';
import { invoiceLeadName, invoiceNumberText } from '../lib/invoiceNaming';

/**
 * Creates a row in the ROOT `payments` collection. W2-1 of ADR-0002
 * (docs/adr/0002-callable-only-invoice-writes.md): this absorbs
 * `AuntieRepository.createPayment`, Android's last direct Firestore write on
 * money data.
 *
 * THIS IS NOT `markInvoicePaid`, AND DELIBERATELY DOES NOT CALL IT. The two
 * write different collections with different jobs, and Android's own
 * record-payment flow (`InvoiceDetailViewModel.recordPayment`) already calls
 * them as two steps:
 *
 *   1. `markInvoicePaid`, the MONEY AUTHORITY. Writes the
 *      `invoices/{id}/payments` SUBCOLLECTION entry and re-derives the
 *      invoice's settlement from the sum of every recorded payment, in one
 *      batch. Requires an invoice; refuses drafts, quotes, cancelled invoices,
 *      credits and settled invoices.
 *   2. The ROOT `payments` row, a DISPLAY RECORD. The payments screens
 *      (`getPayments`, `getPaymentsForKinfolk`, the invoice detail's
 *      linked-payments list joined on `invoiceId`) read this collection and
 *      nothing else; the server's settlement arithmetic never reads it, so the
 *      two cannot double-count. `stripeWebhook.ts` writes card payments here
 *      too. It can also exist with NO invoice at all (the admin Payments tab
 *      records standalone payments through `AdminDataViewModel.createPayment`).
 *
 * Step 1 already goes through a callable; step 2 is the direct write this
 * callable replaces. Folding step 1 into this one was considered and rejected:
 * `markInvoicePaid`'s refusal surface (already-settled, draft, credit) is
 * wrong for a standalone display row, and a combined callable would force the
 * standalone flow to skip those guards with a flag, which is how guards stop
 * being guards.
 *
 * TESTMODE SCOPING IS SERVER-SIDE now (lib/testMode.ts). Android's version was
 * client-side: `mode.scopedKinfolkId(payment.kinfolkId)` rewrote the field
 * before the write, which any modified client could skip. Here a sandbox
 * caller's row is stamped `kinfolkId = testTribeId` no matter what the request
 * says.
 *
 * NO CLASSIFIER STATE IS PERSISTED HERE: `status`/`editScope` live on invoice
 * docs and this callable writes none (the invoice side of a payment is
 * `markInvoicePaid`'s write, which the feat/invoice-state-persist sweep
 * covers).
 *
 * The field set mirrors Android's `Payment` model (data/model/Models.kt)
 * verbatim, dollars-as-floats included: this is the legacy display shape,
 * per the money-units note in CALLABLE_CONTRACT.md. `date` and `email` are
 * free text like the rest of the legacy billing fields. The server adds
 * `recordedBy` + `createdAt`, which the direct write never had: a payment row
 * nobody signed was fine when only admins could write it, and is not fine as
 * an audit-relevant record.
 *
 * ── WHAT THE 2026-08-04 FEE TRANCHE ADDED, AND WHY IT IS ALL ADDITIVE ─────
 *
 * The operator is paid through Venmo and PayPal, records each payment by hand,
 * and is charged a processor fee she takes out of the tip. Her previous system
 * had a Fees field on this exact screen; this one had no fee at any layer, so
 * the fee was dropped and the rows it was dropped from can no longer be made to
 * add up. `lib/paymentMoney.ts` carries the full reasoning and the worked
 * example (invoice #1029).
 *
 * Five new request fields, EVERY ONE optional with a default, so the thirteen
 * -field payload Android and the React admin already send validates unchanged
 * and behaves identically:
 *
 *   `fee`                    the processor's cut. Stored as `fee` + `feeCents`.
 *   `apply`                  the "Apply: $" box. ONE invoice, never a list.
 *   `autoApply`              moves no money since #988; the credit is the
 *                            admin's `creditToAccountCents`, into the
 *                            household's EXISTING account credit.
 *   `sendConfirmationEmail`  enqueue the existing `invoice.payment.applied`
 *                            notification to the household.
 *   (`notes` already existed and is STAFF ONLY. Nothing kinfolk-facing reads
 *    the root `payments` collection: the portal builds from `getMyInvoices`
 *    and the PDF from the invoice doc.)
 *
 * `tip` KEEPS ITS NAME AND CHANGES ITS MEANING, from "whatever the source
 * recorded" to "the GROSS tip". That is only safe because `tipBasis` is written
 * beside it saying which convention the row follows; see paymentMoney.ts for
 * why an unmarked legacy row reads as `unknown` rather than as `net`.
 *
 * ── #825: WHY THIS CALLABLE IS THE ONE THAT HAD TO BE FIXED FIRST ─────────
 *
 * It wrote an auto-id row with no dedupe of any kind, and with `autoApply` it
 * ALSO incremented `families/{id}.accountBalanceCents`. A replayed call
 * therefore recorded the payment twice AND credited the household twice, and by
 * standing ruling account balance is the only destination this business has for
 * money owed back — so the second credit is spendable money made from nothing,
 * in a direction nothing can claw back.
 *
 * A replay is not hypothetical. `functions/internal` is what the SDK reports
 * for any transport failure, so the client cannot tell "never arrived" from
 * "committed, reply lost"; this callable is the SECOND step of the admin's own
 * record-payment sequence, which is the position most likely to be retried; and
 * a cold start here measures up to nine seconds, which is how long a person
 * waits before pressing the button again.
 *
 * THE FIX IS `idempotencyKey`, AND THE KEY IS THE ROW'S ID. `payments/{key}`
 * is the idempotency record — there is no second collection to keep in step.
 * The existence check, the payment row, the apply and the balance increment all
 * happen in ONE TRANSACTION, so a replay does none of them and a half-commit
 * cannot leave a credited balance whose payment row never landed.
 * `lib/moneyIdempotency.ts` carries the argument for a transaction rather than
 * #814's bare `create()` claim.
 */

// Exported so the callable-contract drift guard can freeze this request shape.
export const Args = z.object({
  /** Household the payment belongs to. May be blank (legacy standalone rows). Overridden by the sandbox scope in test mode. */
  kinfolkId: z.string().max(120).default(''),
  kinfolkName: z.string().max(200).default(''),
  client: z.string().max(200).default(''),
  address: z.string().max(500).default(''),
  /** Free text, like every legacy billing date field. */
  date: z.string().max(40).default(''),
  paymentMethod: z.string().max(200).default(''),
  referenceNumber: z.string().max(200).default(''),
  email: z.string().max(200).default(''),
  /** DOLLARS, floating point: the legacy shape of this collection. */
  amount: z.number().min(0).max(10_000_000),
  /**
   * The GROSS tip: what the client actually tipped, before the processor took
   * its cut. DOLLARS, like `amount`.
   *
   * THE MEANING OF THIS FIELD CHANGED HERE, which is why `tipBasis` exists.
   * The operator's ruling, 2026-08-04: "store both, and display the latter.
   * itll help with taxes." The gross tip is income and the fee is a deductible
   * expense, so both have to survive; a net tip alone loses one line of her
   * return and understates the other. See `lib/paymentMoney.ts` for the full
   * arithmetic and for why an unmarked legacy tip reads as `unknown` rather
   * than as `net`.
   */
  tip: z.number().min(0).max(10_000_000).default(0),
  /**
   * The processor's cut, deducted from what the operator receives. DOLLARS.
   *
   * NOT part of `amount`. The client paid `amount`; the operator banks
   * `amount - fee`. It is subtracted on her side of the ledger, never from the
   * money applied to the household's bill, which is why the reconciliation
   * identity (`amount = applied + tipGross + unapplied`) does not mention it.
   */
  fee: z.number().min(0).max(10_000_000).default(0),
  /** Staff-only. Never rendered on a kinfolk-facing surface; see the header. */
  notes: z.string().max(4000).default(''),
  /** Confident payment->invoice link; '' for a standalone payment. */
  invoiceId: z.string().max(200).default(''),
  invoiceNumber: z.string().max(200).default(''),
  /**
   * THE "Apply: $" BOX: how much of this payment goes onto one invoice.
   *
   * ONE PAYMENT, ONE INVOICE. Operator ruling, 2026-08-04, on being offered a
   * split across several: "this is not something i want." So this is a single
   * optional object and NOT a list, deliberately: a shape that can express a
   * three-way split invites one.
   *
   * OMITTED (the default) means no invoice balance is touched at all, which is
   * exactly what this callable did before it could apply anything, so every
   * existing caller keeps its behaviour to the byte.
   *
   * `invoiceId` ABOVE IS NOT AN APPLY and never becomes one. It is the display
   * link the Payments screens join on, and the React admin already sets it on
   * the row it writes AFTER `markInvoicePaid` has settled the invoice. If this
   * callable applied money whenever that field was set, that flow would collect
   * the same payment twice.
   */
  apply: z
    .object({
      invoiceId: z.string().min(1).max(200),
      /** Denormalized for display. Blank is fine; the invoice doc is the authority. */
      invoiceNumber: z.string().max(200).default(''),
      /** DOLLARS applied to that invoice. Sent as 0 with `settleBalance`. */
      amount: z.number().min(0).max(10_000_000),
      /**
       * #2299: "PAY WHAT IS OWED". The admin left the Amount box blank, so the
       * applied part is the invoice's balance AS THIS CALL'S TRANSACTION READS
       * IT, not a figure the screen worked out from an older read. Before
       * #2281 a blank Amount meant exactly this (`markInvoicePaid` with no
       * amount settled the rest). The one-call panel then sent its own figure,
       * which could be $0 or an out-of-date smaller sum when the payments
       * list had not loaded.
       *
       * The screen cannot add up a payment whose applied part it does not
       * know, so with this intent it sends only what was typed and the server
       * finishes the sum. With B the balance read, and the credit as entered:
       *
       *   `amount` 0 (Payment amount blank)   the payment is B + tip + credit
       *   `amount` typed, `tip` 0             the tip is the rest:
       *                                       amount - B - credit (ruling
       *                                       2026-09-27, the extra is tip)
       *   both typed                          they must add up to
       *                                       B + tip + credit, or the call is
       *                                       refused. A typed tip is never
       *                                       rewritten.
       *
       * A payment that does not cover B is refused, never booked as a part
       * payment: blank means the whole balance. Every refusal carries
       * `amountDueCents`, so the screen can show what is owed now. The row,
       * the audit entry and the answer hold the figures as resolved.
       *
       * `amount` above must be 0 with it. A number and "whatever is owed" are
       * two different instructions, and a call carrying both is refused.
       */
      settleBalance: z.boolean().optional(),
    })
    .optional(),
  /**
   * "Will automatically apply any Unapplied amount to FUTURE invoices."
   *
   * A DECISION RECORDED ON THE PAYMENT, with a real behaviour behind it. When
   * it is on, the unapplied remainder is added to the household's EXISTING
   * account credit (`families/{id}.accountBalanceCents`, the balance
   * `redeemCredit` fills and the portal already shows), and
   * `triggers/onInvoiceAutoApply.ts` spends it down on the next invoice that
   * becomes collectable. See `lib/accountCredit.ts`.
   *
   * A stored boolean nothing acts on is a switch wired to nothing, which is
   * exactly what the operator's feature-flag ruling forbids.
   *
   * #988: IT NO LONGER MOVES MONEY BY ITSELF. Operator ruling, 2026-09-27: an
   * overpayment is all tip, and account credit happens only when she enters an
   * amount. The amount is `creditToAccountCents` below. This flag is still
   * accepted (new clients send it as `creditToAccountCents > 0`), and an install
   * from before #988 that sends `true` with no amount credits NOTHING, where it
   * used to credit the whole leftover. The row stores whether credit was
   * actually given; the request's own flag goes to the audit payload.
   */
  autoApply: z.boolean().default(false),
  /**
   * #988: HOW MUCH OF THIS PAYMENT THE ADMIN CHOSE TO LEAVE AS ACCOUNT CREDIT,
   * in integer CENTS. This, and only this, goes into
   * `families/{id}.accountBalanceCents`.
   *
   * It comes out of the leftover after the applied part, which the dialogs
   * otherwise record as tip: `amount = applied + tip + credit`. The server
   * refuses a credit larger than `amount - applied - tip`, a credit for a
   * payment with no household, and a credit on an invoice-linked payment whose
   * applied part it cannot read. It never rewrites the tip the admin entered.
   *
   * OPTIONAL. Omitted means no credit, whatever `autoApply` says.
   */
  creditToAccountCents: z.number().int().min(0).max(1_000_000_000).optional(),
  /**
   * "Send Confirmation Email". Enqueues the EXISTING `invoice.payment.applied`
   * notification to the household, honouring their own channel preferences.
   *
   * OFF BY DEFAULT, and deliberately not derived from anything. A confirmation
   * is a message to a real person, so it is sent because the operator ticked a
   * box, never because the server inferred she probably meant to.
   */
  sendConfirmationEmail: z.boolean().default(false),
  /**
   * #825: mint one of these per SUBMISSION, not per press, and this call
   * becomes safe to retry. It becomes the id of the `payments/{key}` row, so a
   * second attempt at the same payment finds the first attempt's row and is
   * answered from it instead of recording a second payment and a second
   * credit.
   *
   * OPTIONAL. Omitted, the row gets a server-minted auto id and there is no
   * dedupe, exactly as before — which is what keeps the frozen legacy payload
   * valid while the three admin clients adopt this one at a time.
   */
  idempotencyKey: PaymentIdempotencyKeyArg,
  /**
   * #866: the `paymentId` that `markInvoicePaid` returned to THIS submission,
   * in the two-step admin flow (settle first, then this ledger row).
   *
   * It is how this call learns that its own first step paid the invoice off, so
   * the office is told "paid" exactly once, under this payment. The server
   * claims the invoice's `markInvoicePaid:<id>` owner stamp only when it matches
   * this id. A call without it claims only its own settlement of the last few
   * minutes, or one still waiting for its ledger row that this row covers
   * (#2281 review), so a later, unrelated payment linked to the same invoice
   * cannot.
   *
   * #2281 review: when the sweep has already written the ledger row for that
   * settlement (`payments/settle_<id>`), this call's row takes its place.
   * #2300: only a call that sends this id does that. A row without it never
   * deletes or replaces a ledger row.
   *
   * OPTIONAL, like every addition here. A client that does not send it gets the
   * household confirmation it ticked, and the office is not told for its
   * settlement.
   *
   * #977: it is also where this call reads the part of the payment step 1
   * applied, so `autoApply` credits only the real leftover. A call linked to an
   * invoice without it gets no account credit (see `twoStepAppliedCents`).
   */
  settledByInvoicePaymentId: z.string().min(1).max(200).optional(),
});

/**
 * The RESPONSE shape (ADR-0001 step W3-1), and the source of the TS type
 * below. The schema is the authority, so the hand-written interface it
 * replaced is gone rather than left beside it to drift.
 *
 * `kinfolkId` IS NOT AN ECHO. A sandbox caller's row is stamped with their
 * `testTribeId` no matter what the request said, so this field is the only
 * way that caller learns which household the row actually landed under. It is
 * a plain string and MAY BE EMPTY: a standalone payment (the admin Payments
 * tab's no-invoice flow) belongs to no household, and `''` is what is stored.
 */
/**
 * What the apply did to THE invoice. Mirrors `paymentApply.ts#ApplyOutcome`.
 *
 * Nullable on the response, not an empty array: one payment applies to one
 * invoice, and "no invoice was touched" is a different fact from "a list of
 * invoices, which happens to be empty".
 */
const PaymentApplicationSchema = z
  .object({
    invoiceId: z.string().min(1),
    /** Denormalized from the invoice doc. `''` when it carries no number. */
    invoiceNumber: z.string(),
    /** The `invoices/{id}/payments/{id}` row this apply wrote. THE MONEY AUTHORITY. */
    paymentId: z.string().min(1),
    appliedCents: CentsSchema,
    /** Where the invoice stands AFTER the apply, from every payment on it. */
    state: InvoiceSettlementStateSchema,
    totalCents: CentsSchema,
    paidCents: CentsSchema,
    amountDueCents: CentsSchema,
    overpaidCents: CentsSchema,
  })
  .strict();

export const Result = z
  .object({
    ok: OkSchema,
    /** The SERVER-minted `payments/{id}`. */
    paymentId: z.string().min(1),
    /** What was actually stored: the sandbox id for a test admin, `''` for a standalone row. */
    kinfolkId: z.string(),
    /** The whole sum collected, in integer cents. `amount` above, exactly. */
    amountCents: CentsSchema,
    /** The GROSS tip inside it. */
    tipCents: CentsSchema,
    /** The processor's cut, off the operator's proceeds. */
    feeCents: CentsSchema,
    /** Which convention `tipCents` follows. Always `'gross'` on a row this callable wrote. */
    tipBasis: z.enum(TIP_BASES),
    /** Sum of the applications below. Zero when nothing was applied. */
    appliedCents: CentsSchema,
    /**
     * What is left on account: `amount - applied - tipGross`.
     *
     * SIGNED, not clamped. The callable refuses an over-application outright,
     * so a negative can only reach a client through a row written before this
     * field existed; reporting it as 0 would hide the one condition an operator
     * has to see.
     */
    unappliedCents: SignedCentsSchema,
    /** What the operator banks: `amount - fee`. */
    proceedsCents: CentsSchema,
    /** What she keeps of the tip: `tipGross - fee`. Signed; a fee can exceed a small tip. */
    tipNetCents: SignedCentsSchema,
    /** #988: whether account credit was given, i.e. `creditedToAccountCents > 0`. Not an echo of the request flag. */
    autoApply: z.boolean(),
    /** What the apply did, or null when no invoice balance was touched. */
    application: PaymentApplicationSchema.nullable(),
    /**
     * The unapplied remainder actually moved into
     * `families/{kinfolkId}.accountBalanceCents`, the EXISTING credit ledger
     * `redeemCredit` fills and the portal already shows, not a new one.
     *
     * #988: exactly the `creditToAccountCents` the admin entered, and zero when
     * she entered none. It is reported separately from `unappliedCents` because
     * those are two different facts: what is left over, and what she chose to
     * leave as credit.
     */
    creditedToAccountCents: CentsSchema,
    /**
     * Whether the household confirmation actually went out.
     *
     * FALSE IS A REAL ANSWER, not an error. The operator may not have asked for
     * one, and a household with no portal account has no uid to send to. Either
     * way the payment is recorded; saying "sent" when nothing was is the class
     * of lie this whole surface is being cleaned of.
     *
     * #1511: false as well when the confirmation reached the household in the
     * app only; `confirmationAppOnly` says so. Before that this read true for
     * any household with a portal account, channels or no channels.
     */
    confirmationEmailSent: z.boolean(),
    /**
     * #1511: the household's confirmation was written to their notifications
     * list and nothing was emailed, texted or pushed, because every delivery
     * channel is off for them (#1505). Present when this call, or the first
     * attempt a replay reports, wrote the household's copy; absent when no
     * household copy was owed or sent. A client that says "confirmation email"
     * reads it so the admin is not shown an email that does not exist.
     */
    confirmationAppOnly: z.boolean().optional(),
    /**
     * #866: Send Confirmation was ticked, and the household has no portal
     * account, so there was no household copy to send. Lets a client say that,
     * rather than guess it from `confirmationEmailSent: false`.
     */
    householdNoPortalAccount: z.boolean(),
    /**
     * #866: the office copy of this payment's notice is owed and did not go out,
     * because the office roster could not be read. The household copy, if any,
     * is unaffected. A retry of the same submission (same `idempotencyKey`) sends
     * the office copy; nothing else resends it.
     */
    officeNoticePending: z.boolean(),
    /**
     * #2297 review: true when this answer came from the row an earlier call
     * with the same `idempotencyKey` wrote, so nothing was recorded by this
     * call. Absent when this call recorded the payment. A client that let the
     * figures change under one key reads it to say which payment is on record,
     * rather than reporting the earlier payment as the one just typed.
     */
    replayed: z.boolean().optional(),
  })
  .strict();
export type RecordPaymentResult = z.infer<typeof Result>;

export async function recordPaymentHandler(
  req: CallableRequest<unknown>,
): Promise<z.infer<typeof Result>> {
  initSentry();
  const actor = resolveInvoiceWriteActor(req, 'recordPayment');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'recordPayment validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const kinfolkId = scopedKinfolkId(actor.testMode, args.kinfolkId);

  // ── THE FAST PATH (#825), AND IT IS NOT AN OPTIMISATION ─────────────────
  //
  // A key whose row already exists is answered from that row, BEFORE any guard
  // runs. Re-running the guards on a retry is the hazard, not the cost: attempt
  // 1 with an `apply` can settle the invoice, and attempt 2 re-planning the
  // same apply hits `alreadySettledRefusal` and reports `failed-precondition`
  // for a payment that is already stored and entirely fine. A retry must never
  // be able to turn a success into an error message.
  //
  // The in-transaction check below is the RACE backstop, for the second attempt
  // that arrives while the first is still running. This is the one that makes a
  // retry deterministic.
  const ref =
    args.idempotencyKey !== undefined
      ? db().collection('payments').doc(args.idempotencyKey)
      : db().collection('payments').doc();
  if (args.idempotencyKey !== undefined) {
    const existing = await ref.get();
    if (existing.exists) {
      const stored = (existing.data() ?? {}) as Record<string, unknown>;
      assertSameCaller(stored, actor.uid, 'recordedBy');
      logEvent({
        severity: 'info',
        function: 'recordPayment',
        event: 'admin.payment.recorded.replay',
        uid: actor.uid,
        extra: { paymentId: ref.id, kinfolkId: stored['kinfolkId'], idempotencyKey: args.idempotencyKey },
      });
      return replayWithConfirmation(ref, stored, args.sendConfirmationEmail, actor.uid);
    }
  }

  // ONE HOUSEHOLD. The invoice a payment is linked to belongs to the household
  // the payment is recorded for, the rule `planApply` already holds an apply
  // to. Checked here, ahead of every other guard, so the reason given is this
  // one and not a sentence about credit or a leftover. It covers the display
  // link beside an `apply` to a different invoice too. A link that names the
  // very invoice being applied to is left to `planApply`, whose refusal code
  // the clients already know. A retry of a stored row was answered above and
  // never reaches this.
  if (args.invoiceId !== '' && kinfolkId !== '' && args.apply?.invoiceId !== args.invoiceId) {
    const linkSnap = await db().collection('invoices').doc(args.invoiceId).get();
    if (linkSnap.exists) refuseLinkToAnotherHousehold((linkSnap.data() ?? {}) as Record<string, unknown>, kinfolkId);
  }
  // EVERY FIGURE IN INTEGER CENTS, ONCE, HERE. The dollar floats the request
  // carries are the collection's legacy shape and are still stored verbatim
  // below; nothing downstream re-derives cents from them, so no two readers can
  // round the same dollar differently.
  // #2299: with `apply.settleBalance` the applied part, and with it the whole
  // amount or the tip, is not known until the transaction has read the
  // invoice. These four are then provisional here and resolved in the
  // transaction (`resolveSettleBalance`), before anything is staged.
  const settleBalance = args.apply?.settleBalance === true;
  if (settleBalance && dollarsToCents(args.apply?.amount ?? 0) !== 0) {
    throw new HttpsError(
      'invalid-argument',
      'This payment asks to pay what the invoice owes and also names an amount. Send one or the other.',
      { code: 'settle_balance_with_amount' },
    );
  }
  let amountCents = dollarsToCents(args.amount);
  let tipCents = dollarsToCents(args.tip);
  const feeCents = dollarsToCents(args.fee);
  // #977: in the two-step admin flow the applied part was put on the invoice by
  // `markInvoicePaid`, not by this call, so it is read off the settlement row
  // this call names. See `twoStepAppliedCents`.
  const twoStep = args.apply ? null : await twoStepAppliedCents(args);
  let appliedCents = args.apply ? dollarsToCents(args.apply.amount) : (twoStep?.appliedCents ?? 0);
  const moneyOf = () =>
    paymentMoneyOf({
      amountCents,
      tipCents,
      feeCents,
      appliedCents,
      // Stamped, not inferred: this server writes gross tips and says so, which
      // is the whole point of the field.
      tipBasis: 'gross',
    });
  let money = moneyOf();
  // A TIP LARGER THAN THE PAYMENT is refused up front rather than stored as a
  // negative unapplied balance. It is a keying slip (the tip typed into the
  // amount box, or dollars mistaken for cents), and every later reader of the
  // row would have to decide what a payment that is more tip than money means.
  // #2299: not checked here for a "pay what is owed" call, whose amount may be
  // blank until the transaction fills it in; the sum is checked there.
  if (!settleBalance && tipCents > amountCents) {
    throw new HttpsError(
      'invalid-argument',
      `A tip of ${dollars(tipCents)} does not fit inside a payment of ${dollars(amountCents)}. ` +
        `The tip is part of what the client paid, not an addition to it.`,
      { code: 'tip_exceeds_amount' },
    );
  }
  // #1975: A FEE LARGER THAN THE PAYMENT is refused for the same reason. The fee is
  // what the processor kept out of what was paid, so it cannot be more than
  // that. A fee larger than the tip is ordinary (a card payment of exactly the
  // balance, no tip) and is not refused. For "pay what is owed" the amount is
  // not known yet; it is checked in the transaction.
  if (!settleBalance) refuseFeeOverAmount(feeCents, amountCents);
  const paidAtIso = new Date().toISOString();
  // THE APPLY IS PLANNED INSIDE THE TRANSACTION BELOW (#2269). Refusing there
  // still means no payment row either: an operator who mis-keyed the Apply box
  // gets the whole form back to correct, not a stored payment whose apply
  // silently did not happen.
  //
  // It used to be planned here, from a read of the invoice and its payments
  // taken outside the transaction (#825), and `stageApply` wrote the new
  // balance from that plan. Two payments on one invoice at the same moment
  // then both planned from the same "before", and the second to commit wrote
  // a balance that left the first one out.
  // ── ACCOUNT CREDIT: EXACTLY THE AMOUNT THE ADMIN ENTERED (#988) ─────────
  //
  // Operator ruling, 2026-09-27: "any overpayment made by the kinfolk, it is
  // assumed the extra is all tip ... I as admin should be able to decide if any
  // money remains as credit and how much." So nothing here turns a leftover
  // into credit by itself. Before #988 a ticked `autoApply` credited the whole
  // `unappliedCents`; now the credit is `creditToAccountCents`, checked and then
  // credited to the cent, and `triggers/onInvoiceAutoApply.ts` still spends it
  // on the next invoice that becomes collectable.
  //
  // Every refusal below happens BEFORE any write, so a refused call stores no
  // row and credits nothing. In the two-step admin flow `markInvoicePaid` has
  // already settled the invoice by now; the dialog checks the same bounds
  // first, so a refusal here means a client and the server disagree, and the
  // admin gets the form back to correct.
  //
  // #977 still holds: a row linked to an invoice whose applied part could not be
  // read has an unknown leftover, so a chosen credit cannot be checked against
  // it and is refused rather than guessed.
  const leftoverKnown = twoStep === null || twoStep.known;
  const chosenCreditCents = args.creditToAccountCents ?? 0;
  if (chosenCreditCents > 0) {
    if (kinfolkId === '') {
      throw new HttpsError(
        'invalid-argument',
        `Account credit of ${dollars(chosenCreditCents)} needs a household. This payment is not linked to one.`,
        { code: 'credit_without_household' },
      );
    }
    if (!leftoverKnown) {
      throw new HttpsError(
        'failed-precondition',
        `Account credit of ${dollars(chosenCreditCents)} cannot be checked: the part of this payment applied to ` +
          `the invoice could not be read. Record it with no account credit.`,
        { code: 'credit_leftover_unknown' },
      );
    }
    // #2299: a "pay what is owed" call has no leftover to check yet. Its sum
    // is made to add up, credit included, in the transaction.
    if (!settleBalance && chosenCreditCents > money.unappliedCents) {
      throw new HttpsError(
        'invalid-argument',
        `Account credit of ${dollars(chosenCreditCents)} is more than the ${dollars(Math.max(0, money.unappliedCents))} ` +
          `left after ${dollars(money.appliedCents)} applied and a ${dollars(tipCents)} tip.`,
        { code: 'credit_exceeds_leftover' },
      );
    }
  }
  const creditedToAccountCents = chosenCreditCents;
  // WHAT THE ROW AND THE ANSWER CALL `autoApply`: whether credit was actually
  // given. The ledger screens on web and Android say "held as credit" off this
  // flag, so storing an old install's bare tick would have them claim a credit
  // that was never made. What the client sent is kept in the audit payload as
  // `autoApplyRequested`.
  const autoApplied = creditedToAccountCents > 0;
  if (args.autoApply && args.creditToAccountCents === undefined) {
    // An install from before #988: the tick used to mean "credit the whole
    // leftover". It now credits nothing; logged so those submissions can be found.
    logEvent({
      severity: 'info',
      function: 'recordPayment',
      event: 'admin.payment.autoapply.no_amount',
      uid: actor.uid,
      extra: {
        kinfolkId,
        invoiceId: args.invoiceId,
        unappliedCents: money.unappliedCents,
        settledByInvoicePaymentId: args.settledByInvoicePaymentId ?? null,
      },
    });
  }

  // ── ONE TRANSACTION: THE DEDUPE, THE APPLY, THE CREDIT, THE ROW ─────────
  //
  // This was a `WriteBatch`, which was already atomic. What it could not do is
  // make any of those writes CONDITIONAL on what is already stored, and that is
  // the whole of #825: the second attempt at one payment has to find the first
  // attempt's row and do nothing. The read that finds it and the writes it
  // cancels now share one snapshot, and Firestore's lock on `payments/{key}`
  // serialises two attempts that overlap, so the loser sees the winner's row
  // rather than racing a check-then-write.
  //
  // A credited balance whose payment row failed to write would be money from
  // nowhere, which is why the increment was already staged beside the row; it
  // still is, and now a replay stages neither.
  // #2453: the number on the linked invoice as this transaction read it, for the
  // Activity Log line. The caller's `invoiceNumber` is not used for that line: it
  // defaults to '' and is whatever the app sent.
  let linkedInvoiceNumber = '';
  const committed = await db().runTransaction(async (tx) => {
    // FIRESTORE REQUIRES EVERY READ BEFORE EVERY WRITE, which happens to be the
    // order the guard needs anyway.
    if (args.idempotencyKey !== undefined) {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const stored = (snap.data() ?? {}) as Record<string, unknown>;
        assertSameCaller(stored, actor.uid, 'recordedBy');
        return {
          replayed: stored,
          replayedRef: ref as DocumentReference | null,
          application: null as ApplyOutcome | null,
          settlesInvoice: false,
          replacedSweepRow: null as { id: string; data: Record<string, unknown> } | null,
          possibleDuplicateOf: null as string | null,
        };
      }
    }
    // #866: DID THIS SUBMISSION'S OWN `markInvoicePaid` STEP PAY THE INVOICE OFF?
    // Both admin clients settle with `markInvoicePaid` and then call this with
    // the invoice as a display link, passing the payment id that step returned.
    // The office is told only for a payment that paid the bill off, so this call
    // claims THAT settlement's owner stamp (`markInvoicePaid:<id>`), in the same
    // transaction, and only once.
    // An older installed client sends no id; it may still claim a settlement
    // stamped within the last few minutes, which is its own step 1 landing just
    // before this (OLD_CLIENT_CLAIM_WINDOW_MS in lib/paymentAppliedOwner.ts).
    // Past that window see the #2281 review note below.
    // #2269: THE APPLY, PLANNED FROM THIS TRANSACTION'S OWN READ of the invoice
    // and every payment on it. `stageApply` writes the new balance from this
    // plan, so the plan and the payments it is summed from must be one
    // snapshot. The invoice doc is read here and written by `stageApply`, so a
    // second payment (or credit draw, or write-off) on the same invoice
    // committing first makes this attempt re-run and re-plan against it, and
    // its guards (already settled, over the balance) run on the new figures.
    let plannedStep: ApplyStep | null = null;
    if (args.apply) {
      const invoice = await readInvoiceForApplyInTransaction(db(), tx, args.apply.invoiceId);
      // #2090: a written-off invoice refuses with its own code, the one every
      // admin client reads, before the general "not payable" refusal can.
      if (invoice.doc !== null && isWrittenOff(invoice.doc as Record<string, unknown>)) {
        throw new HttpsError('failed-precondition', WRITTEN_OFF_PAYMENT_REFUSAL, { code: INVOICE_WRITTEN_OFF_CODE });
      }
      if (settleBalance) {
        // #2299: the applied part is the balance this transaction just read.
        // A re-run after a competing payment reads the new balance and
        // resolves again, so the figures always belong to the commit.
        const resolved = resolveSettleBalance({
          invoice,
          kinfolkId,
          typedAmountCents: dollarsToCents(args.amount),
          typedTipCents: dollarsToCents(args.tip),
          creditCents: chosenCreditCents,
        });
        amountCents = resolved.amountCents;
        tipCents = resolved.tipCents;
        appliedCents = resolved.appliedCents;
        money = moneyOf();
        // #1975: the fee against the amount this transaction resolved.
        refuseFeeOverAmount(feeCents, amountCents);
      }
      const plan = planApply({
        invoice,
        appliedCents,
        kinfolkId,
        // What the payment has to give: everything except the gross tip. The
        // tip is the operator's, never the household's bill.
        spendableCents: amountCents - tipCents,
      });
      if (!plan.ok) {
        throw new HttpsError('failed-precondition', plan.refusal.message, {
          code: plan.refusal.code,
          // #1566: the balance an over-balance apply ran into, so a client can
          // say what is still owed now, not what the dialog loaded.
          ...(plan.refusal.amountDueCents !== undefined ? { amountDueCents: plan.refusal.amountDueCents } : {}),
        });
      }
      plannedStep = plan.step;
    }
    const linkedInvoiceRef =
      !plannedStep && args.invoiceId !== '' ? db().collection('invoices').doc(args.invoiceId) : null;
    const linkedInvoiceSnap = linkedInvoiceRef ? await tx.get(linkedInvoiceRef) : null;
    const linkedInvoice = linkedInvoiceSnap?.exists
      ? ((linkedInvoiceSnap.data() ?? {}) as Record<string, unknown>)
      : undefined;
    // The same rule as before the transaction, on this transaction's own read.
    if (linkedInvoice) refuseLinkToAnotherHousehold(linkedInvoice, kinfolkId);
    linkedInvoiceNumber = invoiceNumberText(linkedInvoice?.['invoiceNumber']);
    // #2296: THE SETTLEMENT THIS CALL NAMES ALREADY HAS ITS LEDGER ROW. A call
    // naming a settlement records that one payment's row, and a settlement is
    // one payment. An older two-call build that sends its second step again
    // with a new key (or none) is that same payment, so it is answered from
    // the row the first call wrote: no second row, no second credit. Not
    // refused, because those builds cannot read a new refusal and the payment
    // is recorded. The settlement row carries the id
    // (SETTLEMENT_LEDGER_ROW_FIELD) and every call naming it writes it below,
    // so two such calls racing conflict on it and the second re-runs and
    // finds the first's row. The sweep's stand-in row is not found this way:
    // it is replaced, as below.
    // Only for the household the invoice belongs to: a call for another
    // household naming this settlement neither stamps it nor is answered
    // from its row.
    const namedSettlementRef =
      linkedInvoiceRef !== null &&
      args.settledByInvoicePaymentId !== undefined &&
      twoStep?.known === true &&
      kinfolkId !== '' &&
      linkedInvoice?.['kinfolkId'] === kinfolkId
        ? db().collection('invoices').doc(args.invoiceId).collection('payments').doc(args.settledByInvoicePaymentId)
        : null;
    const namedSettlementSnap = namedSettlementRef ? await tx.get(namedSettlementRef) : null;
    if (namedSettlementSnap?.exists) {
      const priorId = (namedSettlementSnap.data() ?? {})[SETTLEMENT_LEDGER_ROW_FIELD];
      if (typeof priorId === 'string' && priorId !== '' && priorId !== ref.id) {
        const priorRef = db().collection('payments').doc(priorId);
        const priorSnap = await tx.get(priorRef);
        const prior = (priorSnap.data() ?? {}) as Record<string, unknown>;
        if (
          priorSnap.exists &&
          prior['settledByInvoicePaymentId'] === args.settledByInvoicePaymentId &&
          prior['invoiceId'] === args.invoiceId &&
          prior['kinfolkId'] === kinfolkId
        ) {
          return {
            replayed: prior,
            replayedRef: priorRef as DocumentReference | null,
            application: null as ApplyOutcome | null,
            settlesInvoice: false,
            replacedSweepRow: null as { id: string; data: Record<string, unknown> } | null,
            possibleDuplicateOf: null as string | null,
          };
        }
      }
      // #2296 review: A ROW WRITTEN BEFORE THE STAMP EXISTED. A row from before
      // this deploy names the settlement but the settlement does not name it
      // back, so it is found by the settlement id it carries. Only
      // `recordPayment` and the sweep write that id on a ledger row, and the
      // sweep's stand-in is replaced below, not answered from. One equality
      // filter, so no composite index; the rest is checked here.
      const earlier = await tx.get(
        db().collection('payments').where('settledByInvoicePaymentId', '==', args.settledByInvoicePaymentId),
      );
      const legacy = earlier.docs
        .filter((d) => {
          const r = (d.data() ?? {}) as Record<string, unknown>;
          return (
            d.id !== ref.id &&
            r['invoiceId'] === args.invoiceId &&
            r['kinfolkId'] === kinfolkId &&
            r['recordedByServer'] !== SETTLEMENT_LEDGER_SWEEP_WRITER
          );
        })
        .sort((a, b) => (a.createTime?.toMillis?.() ?? 0) - (b.createTime?.toMillis?.() ?? 0))[0];
      if (legacy !== undefined) {
        return {
          replayed: (legacy.data() ?? {}) as Record<string, unknown>,
          replayedRef: legacy.ref as DocumentReference | null,
          application: null as ApplyOutcome | null,
          settlesInvoice: false,
          replacedSweepRow: null as { id: string; data: Record<string, unknown> } | null,
          possibleDuplicateOf: null as string | null,
        };
      }
    }
    let claimedOwner = linkedInvoice
      ? claimableMarkInvoicePaidOwner(linkedInvoice, kinfolkId, args.settledByInvoicePaymentId, Date.now())
      : null;
    // #2281 review: THE SETTLEMENT'S LEDGER ROW IS WRITTEN ONCE, WHOEVER GETS
    // THERE FIRST. `settlementLedgerSweep` finishes a settlement whose second
    // call never came by writing `payments/settle_<id>` and taking the claim.
    // A second call that then does come (the operator pressing Record again
    // after a lost reply) found the claim taken and wrote its own row beside
    // the sweep's: one payment, two ledger rows.
    //
    // A CALL THAT NAMES THE SETTLEMENT REPLACES THE SWEEP'S ROW, AND ONLY SUCH
    // A CALL. Its row is the true one: it carries the tip, the fee and any
    // credit the admin entered, and the sweep's row is a stand-in built from
    // the settlement alone (`tipBasis: 'unknown'`). So it deletes the sweep's
    // row and writes its own in the same commit, and keeps the sweep row's
    // notice stamps so the copies it already sent are not sent again. The
    // settlement id is the proof that both rows are one payment.
    //
    // A ROW WITH NO SETTLEMENT ID NEVER DELETES OR REPLACES A LEDGER ROW
    // (#2300, lead ruling 2026-11-14). It is a row added by hand or a
    // pre-#866 build's second call, and nothing on it says which payment it
    // is. Until this change one that covered the settled amount replaced the
    // sweep's row with no time limit, so a household that paid the same $40
    // twice, months apart, lost the first payment's ledger row.
    //   - AFTER THE SWEEP it is written as its own payment and the sweep's row
    //     is left exactly as it is. When it covers the settled amount it may
    //     be that same payment recorded twice, so the owner gets one Activity
    //     Log warning (`possibleDuplicateOf` below). A smaller row (a tip sent
    //     the next day) gets none.
    //   - BEFORE THE SWEEP, past OLD_CLIENT_CLAIM_WINDOW_MS, a row that covers
    //     the settled amount still takes the claim, so the sweep finds the
    //     settlement claimed and writes nothing. That writes one row where
    //     there would be two, and deletes nothing. It ends when the sweep
    //     finishes the settlement, about SETTLEMENT_LEDGER_SWEEP_GRACE_MS
    //     after the payoff.
    //
    // WHY THIS IS SAFE AGAINST THE SWEEP RUNNING AT THE SAME MOMENT. Both
    // transactions read the invoice doc and write it (the claim), and the
    // sweep's row lives at an id made from the invoice's own owner stamp, read
    // here by id. Whichever commits second re-runs and sees the other's write.
    // No query is involved, so there is no row for either to miss.
    let replacedSweepRow: { id: string; data: Record<string, unknown> } | null = null;
    let possibleDuplicateOf: string | null = null;
    const settlement =
      claimedOwner === null ? markInvoicePaidSettlementOf(linkedInvoice, kinfolkId, args.settledByInvoicePaymentId) : null;
    if (settlement !== null && linkedInvoiceRef) {
      const named = args.settledByInvoicePaymentId !== undefined;
      const coverCents = amountCents - tipCents;
      if (settlement.claimed) {
        const sweepRowRef = db().collection('payments').doc(settlementLedgerRowId(settlement.settlementId));
        const sweepRowSnap = await tx.get(sweepRowRef);
        const sweepRow = (sweepRowSnap.data() ?? {}) as Record<string, unknown>;
        const settledCents = storedCents(sweepRow, 'amountCents');
        const isSweepRow =
          sweepRowSnap.exists &&
          sweepRow['recordedByServer'] === SETTLEMENT_LEDGER_SWEEP_WRITER &&
          sweepRow['invoiceId'] === args.invoiceId &&
          sweepRow['kinfolkId'] === kinfolkId;
        if (isSweepRow && named) {
          replacedSweepRow = { id: sweepRowRef.id, data: sweepRow };
        } else if (isSweepRow && settledCents > 0 && coverCents >= settledCents) {
          possibleDuplicateOf = sweepRowRef.id;
        }
      } else if (!named && settlement.pending) {
        const settlementSnap = await tx.get(linkedInvoiceRef.collection('payments').doc(settlement.settlementId));
        const settledCents = settlementSnap.exists
          ? paidCentsFromPayments([(settlementSnap.data() ?? {}) as PaymentAmount])
          : 0;
        if (settledCents > 0 && coverCents >= settledCents) claimedOwner = settlement.owner;
      }
    }
    // THE INVOICE HAS MOVED ON SINCE THE SETTLEMENT THIS CALL NAMES: an edit
    // reopened it, or a later payment paid it off again and holds the owner
    // stamp now. Nothing above matches, and the call's row would land beside
    // the sweep's, or the sweep's beside it. The call names its settlement and
    // that row exists under this invoice (`twoStep.known`), so the sweep's row
    // is read by the id made from that name, and a stamp still waiting on that
    // settlement is cleared below. The notice claim is left alone: the invoice
    // is not this settlement's to speak for any more.
    let namedPendingOwner: string | null = null;
    if (
      claimedOwner === null &&
      settlement === null &&
      linkedInvoice !== undefined &&
      args.settledByInvoicePaymentId !== undefined &&
      twoStep?.known === true &&
      kinfolkId !== '' &&
      linkedInvoice['kinfolkId'] === kinfolkId
    ) {
      const sweepRowRef = db().collection('payments').doc(settlementLedgerRowId(args.settledByInvoicePaymentId));
      const sweepRowSnap = await tx.get(sweepRowRef);
      const sweepRow = (sweepRowSnap.data() ?? {}) as Record<string, unknown>;
      if (
        sweepRowSnap.exists &&
        sweepRow['recordedByServer'] === SETTLEMENT_LEDGER_SWEEP_WRITER &&
        sweepRow['invoiceId'] === args.invoiceId &&
        sweepRow['kinfolkId'] === kinfolkId
      ) {
        replacedSweepRow = { id: sweepRowRef.id, data: sweepRow };
      }
      const named = paymentAppliedOwner('markInvoicePaid', args.settledByInvoicePaymentId);
      if (linkedInvoice[SETTLEMENT_LEDGER_PENDING_FIELD] === named) namedPendingOwner = named;
    }
    // THE APPLY AND THE PAYMENT ROW LAND TOGETHER. `markInvoicePaid` and this
    // callable were two steps on purpose (the money first, the display row
    // second and best-effort), and that stays true for the flow that calls them
    // in sequence. But when THIS call is the one doing the applying, a
    // half-commit would leave an invoice balance moved by a payment with no
    // record, which is precisely the "marked paid with no payment record" state
    // `markInvoicePaid` exists to make impossible.
    const staged = plannedStep
      ? stageApply(db(), tx, {
          step: plannedStep,
          sourcePaymentId: ref.id,
          method: args.paymentMethod || null,
          reference: args.referenceNumber || null,
          paidAtIso,
          uid: actor.uid,
        })
      : null;
    creditAccount(db(), tx, { kinfolkId, cents: creditedToAccountCents });
    // #1939: and the credit's line in the household's credit history, on the
    // same transaction, so the history lists where this balance came from.
    // The number is the one this transaction read off the invoice, never the
    // caller's `invoiceNumber` (#2453: that is whatever the app sent), so the
    // household's line reads "From a payment" when no invoice was read.
    // The household reads this line, so a display link only lends its number
    // when that invoice is this household's own and one it may see: an unsent
    // draft (or a withdrawn or archived quote) is never named to it, and nor
    // is an invoice stamped with no household. An apply already refuses both.
    const householdLinkNumber =
      linkedInvoice !== undefined && linkedInvoice['kinfolkId'] === kinfolkId && !hiddenFromHousehold(linkedInvoice)
        ? linkedInvoiceNumber
        : '';
    stageCreditInEvent(db(), tx, {
      kinfolkId,
      source: 'payment',
      sourceId: ref.id,
      invoiceId: staged?.invoiceId || args.invoiceId,
      invoiceNumber: staged?.invoiceNumber || householdLinkNumber,
      amountCents: creditedToAccountCents,
      actorUid: actor.uid,
      atMs: Date.now(),
    });
    // No `id` field inside the doc: Android's `@DocumentId` property is
    // excluded from serialization, so the direct write never stored one either.
    const row: Record<string, unknown> = {
      kinfolkId,
      kinfolkName: args.kinfolkName,
      client: args.client,
      address: args.address,
      date: args.date,
      paymentMethod: args.paymentMethod,
      referenceNumber: args.referenceNumber,
      email: args.email,
      // #2299: for a "pay what is owed" call the request's own figures may be
      // blank, so the row holds the resolved ones, from the same cents as the
      // fields below. Every other call stores what it sent, as before.
      amount: settleBalance ? centsToDollars(amountCents) : args.amount,
      tip: settleBalance ? centsToDollars(tipCents) : args.tip,
      notes: args.notes,
      invoiceId: args.invoiceId,
      invoiceNumber: args.invoiceNumber,
      // ── THE 2026-08-04 FEE TRANCHE, ALL ADDITIVE ─────────────────────────
      // BOTH DENOMINATIONS, the same rule `markInvoicePaid` writes its
      // subcollection row by: the cents are the truth every sum reads, and the
      // dollar float is the projection the legacy PDF and Android joins read.
      // Written from the one cents figure in one pass, so they cannot disagree.
      fee: args.fee,
      feeCents,
      tipCents,
      amountCents,
      // WHICH CONVENTION THE TIP ABOVE FOLLOWS. Absent on every row written
      // before today, and absent reads as 'unknown', never as 'net'. See
      // lib/paymentMoney.ts.
      tipBasis: 'gross',
      // WHICH INVOICE THIS PAYMENT WAS APPLIED TO, and how much of it. Two flat
      // fields rather than a list: one payment, one invoice (operator ruling,
      // 2026-08-04). `''` means no invoice balance was touched.
      appliedInvoiceId: staged?.invoiceId ?? '',
      appliedInvoiceNumber: staged?.invoiceNumber ?? '',
      // PROJECTIONS of the figures above, written in the same pass from the same
      // cents, so no reader has to re-derive them and no two readers can round
      // the same dollar differently.
      appliedCents: money.appliedCents,
      unappliedCents: money.unappliedCents,
      proceedsCents: money.proceedsCents,
      // #988: true only when the admin chose a credit and it was given.
      autoApply: autoApplied,
      // What of the leftover actually reached the household's account credit:
      // since #988, exactly the amount the admin entered.
      creditedToAccountCents,
      // #977: the `invoices/{invoiceId}/payments` row `appliedCents` was read
      // from in the two-step flow; '' when this call applied (or linked)
      // nothing. `appliedInvoiceId` stays '' for that flow: this call moved no
      // invoice balance, `markInvoicePaid` did.
      settledByInvoicePaymentId: twoStep?.known ? (args.settledByInvoicePaymentId ?? '') : '',
      recordedBy: actor.uid,
      createdAt: FieldValue.serverTimestamp(),
      // ── #825, DENORMALIZED SO A REPLAY CAN BE ANSWERED FROM ONE READ ─────
      //
      // The two fields below are the parts of this call's answer that cannot be
      // recovered from the row's other fields: which `invoices/{id}/payments`
      // row the apply wrote, and where the invoice stood afterwards. #644
      // denormalized `visitIds` onto a booking envelope for exactly this
      // reason, and the alternative is worse — recomputing the settlement on a
      // retry reports where the invoice stands NOW, which is a different claim
      // from what this call did.
      //
      // Written on every row, with or without a key. A stored shape that
      // depended on whether the caller sent a key would be two shapes.
      application: staged,
      // Stamped `false` here and updated after the commit, because whether the
      // household's confirmation went out is not known until it has been tried,
      // and it is tried only once the money has landed. A replay reports what
      // is stored and sends nothing new: "the reply to her first attempt was
      // lost" is not her ticking the box twice. The one exception (#866) is a
      // ticked confirmation this field does not record as sent, which the
      // replay finishes because nothing else will; see `replayWithConfirmation`.
      confirmationEmailSent: false,
      // #1511: its companion, stamped true after the commit when the household's
      // copy was written with every delivery channel off. Written false on
      // every row for the same reason `confirmationEmailSent` is.
      confirmationAppOnly: false,
    };
    // #866: WHETHER THIS PAYMENT PAID THE INVOICE OFF, decided in this
    // transaction and stored, so a same-key retry that finishes a lost office
    // copy reads the same answer instead of re-deriving it from a later state.
    // Either this call's own apply settled it, or it claimed the settlement
    // `markInvoicePaid` stamped just before it.
    // A sweep row exists only for a settlement that paid the invoice off, and
    // the row taking its place is that same payment's.
    const settlesInvoice = staged
      ? staged.state === 'settled' || staged.state === 'overpaid'
      : claimedOwner !== null || replacedSweepRow !== null;
    row['settlesInvoice'] = settlesInvoice;
    if (replacedSweepRow !== null) {
      // The copies the sweep already sent for this payment, so they are not
      // sent again; what is still owed is worked out from these after the commit.
      for (const field of CARRIED_NOTICE_STAMPS) {
        if (replacedSweepRow.data[field] != null) row[field] = replacedSweepRow.data[field];
      }
      // Which row this one replaced, and the id its notice goes out under: the
      // sweep's, so both senders share one dedupe identity for the settlement.
      row['replacedSettlementLedgerRowId'] = replacedSweepRow.id;
      row['noticePaymentId'] = replacedSweepRow.id;
      // Who the sweep listed the payoff for, so a same-key retry can still
      // tell when the household's copy belongs to an earlier billing member.
      const listedFor = replacedSweepRow.data[SETTLEMENT_NOTICE_UID_FIELD];
      if (typeof listedFor === 'string') row[SETTLEMENT_NOTICE_UID_FIELD] = listedFor;
    }
    const settledOwner = claimedOwner ?? (replacedSweepRow !== null ? (settlement?.owner ?? null) : null);
    if (linkedInvoiceRef && settledOwner !== null) {
      const linked = linkedInvoice ?? {};
      tx.set(
        linkedInvoiceRef,
        {
          // Already this value when the sweep took the claim first.
          [PAYMENT_APPLIED_CLAIM_FIELD]: settledOwner,
          // #2230: this is the second call that settlement was waiting for, so
          // the ledger row and the notice are this call's now, and the sweep
          // that finishes an abandoned settlement stands down. Cleared only
          // when it names this settlement, never a later one.
          ...(linked[SETTLEMENT_LEDGER_PENDING_FIELD] === settledOwner
            ? { [SETTLEMENT_LEDGER_PENDING_FIELD]: '', [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null }
            : {}),
        },
        { merge: true },
      );
    }
    if (linkedInvoiceRef && settledOwner === null && namedPendingOwner !== null) {
      tx.set(
        linkedInvoiceRef,
        { [SETTLEMENT_LEDGER_PENDING_FIELD]: '', [SETTLEMENT_LEDGER_PENDING_AT_FIELD]: null },
        { merge: true },
      );
    }
    if (replacedSweepRow !== null) tx.delete(db().collection('payments').doc(replacedSweepRow.id));
    // #2296: this row is the settlement's ledger row now.
    if (namedSettlementRef && namedSettlementSnap?.exists) {
      tx.set(namedSettlementRef, { [SETTLEMENT_LEDGER_ROW_FIELD]: ref.id }, { merge: true });
    }
    // `create` WHEN THERE IS A KEY, so two attempts that somehow reach the
    // write together are refereed by the server rather than by the read above.
    // A keyless call keeps `set`: its id is server-minted and cannot collide.
    if (args.idempotencyKey !== undefined) tx.create(ref, row);
    else tx.set(ref, row);
    return {
      replayed: null,
      replayedRef: null,
      application: staged,
      settlesInvoice,
      replacedSweepRow,
      possibleDuplicateOf,
    };
  });

  if (committed.replayed !== null && committed.replayedRef !== null) {
    const answeredRef = committed.replayedRef;
    if (answeredRef.id !== ref.id) {
      // #2296: a second call for a settlement that has its row. Nothing was
      // written, and any credit it asked for was not given.
      logEvent({
        severity: 'warn',
        function: 'recordPayment',
        event: 'settlement.ledger.second_call.answered',
        uid: actor.uid,
        extra: {
          paymentId: answeredRef.id,
          idempotencyKey: args.idempotencyKey ?? null,
          kinfolkId,
          invoiceId: args.invoiceId,
          settledByInvoicePaymentId: args.settledByInvoicePaymentId ?? null,
          creditToAccountCentsRequested: args.creditToAccountCents ?? null,
        },
      });
    } else {
      logEvent({
        severity: 'info',
        function: 'recordPayment',
        event: 'admin.payment.recorded.replay',
        uid: actor.uid,
        extra: { paymentId: ref.id, kinfolkId, idempotencyKey: args.idempotencyKey, raced: true },
      });
    }
    return replayWithConfirmation(answeredRef, committed.replayed, args.sendConfirmationEmail, actor.uid);
  }
  const application = committed.application;
  const replacedSweepRow = committed.replacedSweepRow;
  if (replacedSweepRow !== null) {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'settlement.ledger.replaced',
      uid: actor.uid,
      extra: { paymentId: ref.id, replacedPaymentId: replacedSweepRow.id, kinfolkId, invoiceId: args.invoiceId },
    });
  }

  // #2300: this row has no settlement id and landed beside the sweep's row for
  // a payoff it is large enough to be. Both rows are kept. The payment's one
  // Activity Log line is a warning in plain words, so the owner can check
  // whether the same payment was recorded twice.
  const possibleDuplicateOf = committed.possibleDuplicateOf;
  // Loaded only on this path, as every other writer loads its words, so the
  // entrypoint's cold start does not pay for the module.
  const duplicateWords =
    possibleDuplicateOf !== null
      ? (await import('../lib/activityWords.js')).paymentPossibleDuplicateWords(
          application?.invoiceNumber || linkedInvoiceNumber,
        )
      : null;
  if (possibleDuplicateOf !== null) {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'settlement.ledger.possible_duplicate',
      uid: actor.uid,
      extra: { paymentId: ref.id, settlementPaymentId: possibleDuplicateOf, kinfolkId, invoiceId: args.invoiceId },
    });
  }
  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_PAYMENT_RECORDED,
    severity: possibleDuplicateOf !== null ? 'warn' : 'info',
    actorRole: 'AUNTIE',
    actorUid: actor.uid,
    targetUid: ref.id,
    targetCollection: 'payments',
    familyId: kinfolkId || undefined,
    description:
      duplicateWords !== null
        ? duplicateWords
        : args.invoiceId
          ? // #2453: the number on the invoice as this call read it. Never the id, and never what the caller sent.
            (await import('../lib/activityWords.js')).paymentRowRecordedWords(
              application?.invoiceNumber || linkedInvoiceNumber,
            )
          : 'Standalone payment row recorded',
    payload: {
      paymentId: ref.id,
      kinfolkId,
      invoiceId: args.invoiceId,
      amount: settleBalance ? centsToDollars(amountCents) : args.amount,
      tip: settleBalance ? centsToDollars(tipCents) : args.tip,
      // #2299: the admin left Amount blank and the server applied the balance
      // it read. The figures above are the resolved ones.
      ...(settleBalance ? { applySettledBalance: true } : {}),
      // THE FEE IS IN THE AUDIT TRAIL, not only on the doc. The whole defect
      // being fixed is a fee that existed and was written down nowhere.
      fee: args.fee,
      amountCents,
      tipCents,
      feeCents,
      tipBasis: 'gross',
      appliedCents: money.appliedCents,
      unappliedCents: money.unappliedCents,
      proceedsCents: money.proceedsCents,
      autoApply: autoApplied,
      autoApplyRequested: args.autoApply,
      creditToAccountCentsRequested: args.creditToAccountCents ?? null,
      creditedToAccountCents,
      settledByInvoicePaymentId: args.settledByInvoicePaymentId ?? null,
      appliedInvoiceId: application?.invoiceId ?? null,
      appliedInvoiceState: application?.state ?? null,
      method: args.paymentMethod,
      reference: args.referenceNumber,
      testMode: actor.testMode.active,
      // WHICH SUBMISSION THIS ROW BELONGS TO. An audit trail that cannot tell a
      // second payment from a second attempt at one payment is the trail that
      // would have had to answer #825 after the fact.
      idempotencyKey: args.idempotencyKey ?? null,
      // #2300: the ledger row already recorded for this invoice's payoff, which
      // this row may repeat. Both are in `payments`.
      ...(possibleDuplicateOf !== null ? { possibleDuplicateOfPaymentId: possibleDuplicateOf } : {}),
      // #2281 review: the sweep's stand-in row this one took the place of, kept
      // here because the row itself is gone from `payments`.
      ...(replacedSweepRow !== null
        ? {
            replacedSettlementLedgerRow: {
              paymentId: replacedSweepRow.id,
              amountCents: storedCents(replacedSweepRow.data, 'amountCents'),
              date: replacedSweepRow.data['date'] ?? '',
              paymentMethod: replacedSweepRow.data['paymentMethod'] ?? '',
              referenceNumber: replacedSweepRow.data['referenceNumber'] ?? '',
              settledByInvoicePaymentId: replacedSweepRow.data['settledByInvoicePaymentId'] ?? '',
              recordedBy: replacedSweepRow.data['recordedBy'] ?? '',
              confirmationEmailSent: replacedSweepRow.data['confirmationEmailSent'] === true,
              confirmationAppOnly: replacedSweepRow.data['confirmationAppOnly'] === true,
              officeNoticeSent: replacedSweepRow.data['officeNoticeSentAt'] != null,
            },
          }
        : {}),
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'audit.write.failed',
      uid: actor.uid,
      errorMessage: (err as Error)?.message,
    });
  });

  // THE CONFIRMATION, LAST AND BEST-EFFORT. The money has landed; a mail
  // provider having a bad minute must not throw away the record of it or offer
  // a retry that would collect a second time. What actually happened comes back
  // in `confirmationEmailSent` so the operator can send it another way.
  //
  // #866: this callable is the only sender of `invoice.payment.applied` for the
  // payment it records. Ticked, the household and the office are told, full or
  // partial. Unticked, the household hears only when this payment paid the
  // invoice off (`settlesInvoice`, decided in the transaction above), on their
  // notifications list with nothing emailed (#1973), and so does the office.
  // An unticked partial tells nobody.
  //
  // #2281 review: a row that took a sweep row's place sends only the copies the
  // sweep did not get out, read off the stamps it carried over, the way a
  // same-key retry does. They go out under the sweep row's id.
  //
  // The exception is the email the admin ticks on that late call: the sweep
  // could not know about the tick and only listed the payoff, so the listed
  // copy is now sent on the household's own channels (`sendAfterSweepRow`).
  let sent: ConfirmationOutcome;
  let confirmationEmailSent: boolean;
  let confirmationAppOnly: boolean;
  if (replacedSweepRow !== null) {
    const after = await sendAfterSweepRow({
      stamps: replacedSweepRow.data,
      ticked: args.sendConfirmationEmail,
      kinfolkId,
      invoiceId: args.invoiceId,
      noticePaymentId: replacedSweepRow.id,
      uid: actor.uid,
    });
    sent = after.sent;
    confirmationEmailSent = after.confirmationEmailSent;
    confirmationAppOnly = after.confirmationAppOnly;
    // With or without a key: the row carries the sweep's stamps, and a stamp
    // that says "list only" after the email went would be untrue.
    if (after.changed) {
      await ref.update(after.stamps).catch((err) => {
        logEvent({
          severity: 'warn',
          function: 'recordPayment',
          event: 'payment.confirmation.stamp.failed',
          uid: actor.uid,
          extra: { paymentId: ref.id, err: (err as Error)?.message },
        });
      });
    }
  } else {
    sent = await sendPaymentConfirmation({
      kinfolkId,
      // The invoice the confirmation is ABOUT: the one this payment was
      // applied to, or the display link when nothing was applied. The catalog's
      // `invoice.payment.applied` template needs one.
      invoiceId: application?.invoiceId ?? args.invoiceId,
      paymentId: ref.id,
      uid: actor.uid,
      householdRequested: args.sendConfirmationEmail,
      settlesInvoice: committed.settlesInvoice,
      officeDue: true,
      // #1973: an unticked payment that pays the invoice off still puts the
      // payoff on the household's notifications list (nothing is emailed).
      householdOnPayoff: true,
    });
    // #1511: "sent" means a channel carried it. A copy that reached the household
    // in the app only is reported through `confirmationAppOnly` instead.
    confirmationEmailSent = sent.household && !sent.householdAppOnly;
    confirmationAppOnly = sent.household && sent.householdAppOnly;
    // STAMPED ON THE ROW, so a replay can report it (#825) and a same-key retry
    // knows what is left to send (#866). Outside the transaction because it is
    // not known inside one: the send is attempted only after the money has
    // landed. Best-effort like the send itself; a failed stamp must not throw
    // away a payment that is already recorded, and within
    // PAYMENT_CONFIRMATION_DEDUPE_WINDOW_MS the ledger stops a retry repeating
    // a copy that did go out.
    if (args.idempotencyKey !== undefined && (sent.household || sent.office || sent.skipped)) {
      await ref.update(noticeStamps(sent)).catch((err) => {
        logEvent({
          severity: 'warn',
          function: 'recordPayment',
          event: 'payment.confirmation.stamp.failed',
          uid: actor.uid,
          extra: { paymentId: ref.id, err: (err as Error)?.message },
        });
      });
    }
  }
  logEvent({
    severity: 'info',
    function: 'recordPayment',
    event: 'admin.payment.recorded',
    uid: actor.uid,
    extra: {
      paymentId: ref.id,
      kinfolkId,
      invoiceId: args.invoiceId,
      appliedCents: money.appliedCents,
      unappliedCents: money.unappliedCents,
      feeCents,
      appliedInvoiceId: application?.invoiceId ?? '',
      autoApply: autoApplied,
      creditedToAccountCents,
      confirmationEmailSent,
      confirmationAppOnly,
      testMode: actor.testMode.active,
    },
  });

  return validateResponse('recordPayment', Result, {
    ok: true,
    paymentId: ref.id,
    kinfolkId,
    amountCents,
    tipCents,
    feeCents,
    tipBasis: 'gross',
    appliedCents: money.appliedCents,
    unappliedCents: money.unappliedCents,
    proceedsCents: money.proceedsCents,
    // Never null on this path: the basis is stamped `'gross'` two lines up, so
    // `paymentMoneyOf` always derives a net. The `?? 0` is the type narrowing,
    // not a fallback anything can reach.
    tipNetCents: money.tipNetCents ?? 0,
    autoApply: autoApplied,
    application,
    creditedToAccountCents,
    confirmationEmailSent,
    // Present only when a household copy was written by this call, or by the
    // sweep whose row this call replaced (#1511).
    ...(confirmationEmailSent || confirmationAppOnly ? { confirmationAppOnly } : {}),
    householdNoPortalAccount: sent.noPortalAccount,
    officeNoticePending: sent.officePending,
  });
}

/**
 * #977: HOW MUCH OF THIS PAYMENT `markInvoicePaid` ALREADY PUT ON THE INVOICE,
 * for a call that carries no `apply`.
 *
 * Admin web (Mark paid) and admin Android (Record payment) settle the invoice
 * with `markInvoicePaid` first and then call this with the WHOLE transaction as
 * `amount`, the invoice as a display link, and step 1's row id as
 * `settledByInvoicePaymentId`. Treating that row as "nothing applied" made the
 * leftover `amount - tip`, so a ticked auto-apply credited the invoice money to
 * the household's account balance on top of settling the invoice with it.
 *
 * WHY THE SETTLEMENT ROW, AND NOT A REFUSAL OF `autoApply`. The row step 1 wrote
 * (`invoices/{invoiceId}/payments/{settledByInvoicePaymentId}`) records exactly
 * what was applied, in the units `paidCentsFromPayments` reads, and nothing ever
 * rewrites its amounts. With it the leftover is exact, so a genuine overpayment ($200 in
 * for a $127.50 bill and a $10 tip) still reaches the household's credit as she
 * asked. Refusing would throw that away, or throw away the ledger row with it,
 * and the ledger row is written after the money has already moved.
 *
 * Read OUTSIDE the transaction, for the reason the apply plan is: the row is
 * written once, by a `create`/`set` in `markInvoicePaid`'s own transaction, and
 * its amounts are never updated, so there is nothing a transactional read would
 * protect. (The one later write, #2296's `SETTLEMENT_LEDGER_ROW_FIELD`, is read
 * and written in the transaction below.)
 *
 * `known: false` means the call is linked to an invoice and the applied part
 * could not be read: no `settledByInvoicePaymentId` (an install from before
 * #866), or an id that names no row under that invoice. The caller then credits
 * nothing. The `markInvoicePaid:<id>` owner stamp is no substitute for the id:
 * it is written only by a payment that settles the invoice, so it cannot name a
 * partial, and nothing parses it.
 *
 * A standalone row (no `invoiceId`) applies nothing and its leftover is known.
 */
async function twoStepAppliedCents(args: {
  invoiceId: string;
  settledByInvoicePaymentId?: string | undefined;
}): Promise<{ known: boolean; appliedCents: number; reason?: 'no-settlement-id' | 'settlement-not-found' }> {
  if (args.invoiceId === '') return { known: true, appliedCents: 0 };
  if (args.settledByInvoicePaymentId === undefined) {
    return { known: false, appliedCents: 0, reason: 'no-settlement-id' };
  }
  const snap = await db()
    .collection('invoices')
    .doc(args.invoiceId)
    .collection('payments')
    .doc(args.settledByInvoicePaymentId)
    .get();
  if (!snap.exists) return { known: false, appliedCents: 0, reason: 'settlement-not-found' };
  // The same units rule the invoice's own settlement was summed with, so this
  // figure and the invoice's `paidCents` cannot disagree about one row.
  return { known: true, appliedCents: paidCentsFromPayments([(snap.data() ?? {}) as PaymentAmount]) };
}

/** The `details.code` of a payment linked to an invoice of another household. */
export const LINK_WRONG_HOUSEHOLD_CODE = 'link_wrong_household';
/** #1975: the refusal code for a processor fee larger than the payment. */
export const FEE_EXCEEDS_AMOUNT_CODE = 'fee_exceeds_amount';
/**
 * #1975: refuses a processor fee larger than the payment it came out of. A
 * keying slip (the payment typed into the fee box), refused before anything
 * is written, like a tip larger than the payment.
 */
function refuseFeeOverAmount(feeCents: number, amountCents: number): void {
  if (feeCents <= amountCents) return;
  throw new HttpsError(
    'invalid-argument',
    `A fee of ${dollars(feeCents)} is more than the ${dollars(amountCents)} payment it came out of. Check the fee.`,
    { code: FEE_EXCEEDS_AMOUNT_CODE },
  );
}
/**
 * Refuses a payment whose linked invoice belongs to a different household.
 *
 * The same test `planApply` makes for an apply: both households known and not
 * the same one. A payment with no household, and an invoice that carries none
 * (older rows), are left as they were. The sentence names the invoice by its
 * number and never by its stored id.
 */
function refuseLinkToAnotherHousehold(invoice: Record<string, unknown>, kinfolkId: string): void {
  const invoiceKin = typeof invoice['kinfolkId'] === 'string' ? invoice['kinfolkId'] : '';
  if (kinfolkId === '' || invoiceKin === '' || invoiceKin === kinfolkId) return;
  throw new HttpsError(
    'failed-precondition',
    `${invoiceLeadName(invoice['invoiceNumber'])} belongs to a different household than this payment.`,
    { code: LINK_WRONG_HOUSEHOLD_CODE },
  );
}
/** "$36.00" from integer cents, for a refusal an operator has to read. */
function dollars(cents: number): string {
  return formatUsdCents(cents);
}

/**
 * #2299: THE FIGURES OF A "PAY WHAT IS OWED" PAYMENT, from the balance the
 * transaction read. The rules are on `Args.apply.settleBalance`. Throws the
 * refusal; every one that read a balance carries it as `amountDueCents`.
 *
 * The result always satisfies `amount = applied + tip + credit`, so nothing is
 * left over that is neither tip nor credit, and the credit is exactly what the
 * admin entered.
 */
function resolveSettleBalance(input: {
  invoice: InvoiceForApply;
  kinfolkId: string;
  typedAmountCents: number;
  typedTipCents: number;
  creditCents: number;
}): { amountCents: number; tipCents: number; appliedCents: number } {
  const balance = balanceToSettle(input.invoice, input.kinfolkId);
  if (!balance.ok) {
    throw new HttpsError('failed-precondition', balance.refusal.message, {
      code: balance.refusal.code,
      ...(balance.refusal.amountDueCents !== undefined ? { amountDueCents: balance.refusal.amountDueCents } : {}),
    });
  }
  const due = balance.amountDueCents;
  const { typedAmountCents, typedTipCents, creditCents } = input;
  if (typedAmountCents === 0) {
    return { amountCents: due + typedTipCents + creditCents, tipCents: typedTipCents, appliedCents: due };
  }
  const creditNote = creditCents > 0 ? ` plus ${dollars(creditCents)} of account credit` : '';
  if (typedTipCents === 0) {
    const restCents = typedAmountCents - due - creditCents;
    if (restCents < 0) {
      throw new HttpsError(
        'failed-precondition',
        `A payment of ${dollars(typedAmountCents)} does not cover the ${dollars(due)} this invoice still owes${creditNote}. ` +
          `Raise the payment amount, or enter the part being paid under Amount collected.`,
        { code: 'settle_payment_short', amountDueCents: due },
      );
    }
    return { amountCents: typedAmountCents, tipCents: restCents, appliedCents: due };
  }
  if (due + typedTipCents + creditCents !== typedAmountCents) {
    throw new HttpsError(
      'failed-precondition',
      `This invoice still owes ${dollars(due)}. With a ${dollars(typedTipCents)} tip${creditNote} that comes to ` +
        `${dollars(due + typedTipCents + creditCents)}, not the ${dollars(typedAmountCents)} paid. ` +
        `Change the tip or the payment amount, or leave the tip blank to take the rest.`,
      { code: 'settle_split_mismatch', amountDueCents: due },
    );
  }
  return { amountCents: typedAmountCents, tipCents: typedTipCents, appliedCents: due };
}
/** A stored number, or 0. Absent reads as zero, never as a guess. */
function storedCents(stored: Record<string, unknown>, field: string): number {
  const v = stored[field];
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
}

/**
 * THE ANSWER A RETRY GETS: what the FIRST attempt did, rebuilt from the row it
 * wrote.
 *
 * Not a recomputation of where things stand now. A client that retries is
 * asking what happened to ITS submission, and between the two attempts another
 * payment can legitimately have landed on the same invoice; reporting today's
 * settlement would answer a question nobody asked, and would make the same call
 * return two different figures depending on how many times it was retried.
 *
 * Everything here comes off the stored row. The derived money figures go back
 * through `paymentMoneyOf` rather than being read field by field, so a replayed
 * answer and a first answer are produced by the same arithmetic.
 */
/**
 * How long the dispatcher ledger remembers one payment's confirmation copies,
 * for every enqueue this callable makes (the ledger's `expiresAt` follows the
 * window, so the first attempt's entry lives as long as a retry looks back).
 *
 * 7 DAYS, well past any realistic client retry of one submission. It is what
 * stops a second office copy when the household gains a portal account between
 * attempts: the retry then owes the household its copy, and the office copy
 * that rides the same enqueue is caught by the ledger, however many hours
 * later the retry lands. The identity names one payment, so a week can never
 * merge two.
 */
export const PAYMENT_CONFIRMATION_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * #866: the row fields that record which copies of `invoice.payment.applied`
 * went out for this payment. `confirmationEmailSent` is the household copy (and
 * the #825 answer field); `officeNoticeSentAt` is the office copy;
 * `officeNoticeSkippedReason` records an office-only copy that nobody exists to
 * receive, which a retry must not keep trying.
 *
 * #1511: a household copy that reached them in the app only stamps
 * `confirmationAppOnly: true` and leaves `confirmationEmailSent` false, so the
 * stored flag means what its name says. Either stamp settles the household
 * copy for a retry: the record exists, and sending again would not add a
 * channel the household has turned off.
 */
/** The stamps `noticeStamps` writes: carried onto a row that replaces the sweep's (#2281 review). */
const CARRIED_NOTICE_STAMPS = [
  'confirmationEmailSent',
  'confirmationAppOnly',
  'officeNoticeSentAt',
  'officeNoticeSkippedReason',
] as const;
/**
 * Which copies of `invoice.payment.applied` a payment's row still shows as
 * owed, for a retry (#866) or for a row taking a sweep row's place (#2281
 * review). The rules are in the note on `replayWithConfirmation`.
 */
function copiesOwed(
  stored: Record<string, unknown>,
  householdRequested: boolean,
  settlesInvoice: boolean,
): { householdTold: boolean; householdDue: boolean; listDue: boolean; officeDue: boolean } {
  const householdTold = stored['confirmationEmailSent'] === true || stored['confirmationAppOnly'] === true;
  return {
    householdTold,
    householdDue: householdRequested && !householdTold,
    // #1973: the unticked payoff's list-only copy, owed until it is on record.
    listDue: !householdRequested && settlesInvoice && !householdTold,
    officeDue:
      (settlesInvoice || householdRequested) &&
      stored['officeNoticeSentAt'] == null &&
      // Nobody existed to receive it last time; that is final, not unfinished.
      stored['officeNoticeSkippedReason'] == null,
  };
}
export function noticeStamps(sent: ConfirmationOutcome): Record<string, unknown> {
  return {
    ...(sent.household && !sent.householdAppOnly ? { confirmationEmailSent: true } : {}),
    ...(sent.household && sent.householdAppOnly ? { confirmationAppOnly: true } : {}),
    ...(sent.office ? { officeNoticeSentAt: FieldValue.serverTimestamp() } : {}),
    ...(sent.skipped ? { officeNoticeSkippedReason: 'no-recipients' } : {}),
  };
}

/**
 * THE ANSWER A RETRY GETS, plus the copies of the first attempt's notice a retry
 * may finish (#866). Since #866 this callable is the only sender of both copies
 * for the payment it records, so a first attempt that recorded the payment and
 * then crashed, or whose enqueue failed, would otherwise leave them untold for
 * good.
 *
 *   - household copy: due when this submission was ticked and the row says
 *     neither `confirmationEmailSent: true` nor `confirmationAppOnly: true`
 *     (#1511: an app-only copy is in their notifications list already).
 *   - office copy: due when the payment paid the invoice off (`settlesInvoice`,
 *     decided in the first attempt's transaction) or was ticked, and the row has
 *     no `officeNoticeSentAt`. An unticked partial is never due.
 *
 * Nothing else is redone. A first attempt that enqueued and died before its
 * stamps is caught by the ledger identity (`invoice:<id>#paymentId:<id>`) for
 * PAYMENT_CONFIRMATION_DEDUPE_WINDOW_MS.
 */
async function replayWithConfirmation(
  ref: { id: string; update: (data: Record<string, unknown>) => Promise<unknown> },
  stored: Record<string, unknown>,
  householdRequested: boolean,
  actorUid: string,
): Promise<z.infer<typeof Result>> {
  const answer = replayResult(ref.id, stored);
  // #2281 review: a row that replaced the sweep's finishes what that payment is
  // still owed the same way its first attempt did, under the sweep row's id.
  const sweepRowId = stored['noticePaymentId'];
  if (typeof sweepRowId === 'string' && sweepRowId !== '') {
    const after = await sendAfterSweepRow({
      stamps: stored,
      ticked: householdRequested,
      kinfolkId: answer.kinfolkId,
      invoiceId: typeof stored['invoiceId'] === 'string' ? stored['invoiceId'] : '',
      noticePaymentId: sweepRowId,
      uid: actorUid,
    });
    if (after.changed) {
      await ref.update(after.stamps).catch((err) => {
        logEvent({
          severity: 'warn',
          function: 'recordPayment',
          event: 'payment.confirmation.stamp.failed',
          uid: actorUid,
          extra: { paymentId: ref.id, replay: true, err: (err as Error)?.message },
        });
      });
    }
    // The row's own `confirmationAppOnly` stamp is not this answer's: it records
    // that the listed copy exists, and what the answer says about it is worked
    // out afresh above, as on the first attempt.
    const { confirmationAppOnly: _storedAppOnly, ...rest } = answer;
    void _storedAppOnly;
    return {
      ...rest,
      confirmationEmailSent: after.confirmationEmailSent,
      ...(after.confirmationEmailSent || after.confirmationAppOnly ? { confirmationAppOnly: after.confirmationAppOnly } : {}),
      householdNoPortalAccount: after.sent.noPortalAccount,
      officeNoticePending: after.sent.officePending,
    };
  }
  const settlesInvoice = stored['settlesInvoice'] === true;
  const { householdTold, householdDue, listDue, officeDue } = copiesOwed(stored, householdRequested, settlesInvoice);
  if (!householdDue && !listDue && !officeDue) return answer;
  const sent = await sendPaymentConfirmation({
    kinfolkId: answer.kinfolkId,
    invoiceId: answer.application?.invoiceId ?? (typeof stored['invoiceId'] === 'string' ? stored['invoiceId'] : ''),
    paymentId: ref.id,
    uid: actorUid,
    householdRequested: householdDue,
    settlesInvoice,
    // A ticked retry whose office copy is already stamped still owes the
    // household one; with no household uid, it must not send the office a second.
    officeDue,
    // #866: the first attempt told the household and its office copy did not go
    // out (the roster could not be read). The office is owed that copy alone,
    // settled invoice or not, because the ticked first attempt owed it one.
    officeOwedWithoutHousehold: householdRequested && householdTold,
    householdOnPayoff: listDue,
  });
  // #1511: what the household copy amounted to, first attempt or this one. The
  // stored stamps are exclusive, and a retry only sends when neither is set, so
  // at most one of these is true.
  const confirmationEmailSent = answer.confirmationEmailSent || (sent.household && !sent.householdAppOnly);
  const confirmationAppOnly = answer.confirmationAppOnly === true || (sent.household && sent.householdAppOnly);
  const householdCopy = confirmationEmailSent || confirmationAppOnly ? { confirmationAppOnly } : {};
  const reported = {
    ...answer,
    confirmationEmailSent,
    ...householdCopy,
    householdNoPortalAccount: sent.noPortalAccount,
    officeNoticePending: sent.officePending,
  };
  if (!sent.household && !sent.office && !sent.skipped) return reported;
  await ref.update(noticeStamps(sent)).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'payment.confirmation.stamp.failed',
      uid: actorUid,
      extra: { paymentId: ref.id, replay: true, err: (err as Error)?.message },
    });
  });
  logEvent({
    severity: 'warn',
    function: 'recordPayment',
    event: 'payment.confirmation.recovered',
    uid: actorUid,
    extra: { paymentId: ref.id, household: sent.household, householdAppOnly: sent.householdAppOnly, office: sent.office },
  });
  return { ...answer, confirmationEmailSent, ...householdCopy };
}

function replayResult(paymentId: string, stored: Record<string, unknown>): z.infer<typeof Result> {
  const money = paymentMoneyOf({
    amountCents: storedCents(stored, 'amountCents'),
    tipCents: storedCents(stored, 'tipCents'),
    feeCents: storedCents(stored, 'feeCents'),
    appliedCents: storedCents(stored, 'appliedCents'),
    tipBasis: 'gross',
  });
  const rawApplication = stored['application'];
  const application =
    rawApplication !== null && typeof rawApplication === 'object'
      ? (rawApplication as z.infer<typeof PaymentApplicationSchema>)
      : null;
  return validateResponse('recordPayment', Result, {
    ok: true,
    paymentId,
    kinfolkId: typeof stored['kinfolkId'] === 'string' ? stored['kinfolkId'] : '',
    amountCents: money.amountCents,
    tipCents: money.tipCents,
    feeCents: money.feeCents,
    tipBasis: 'gross',
    appliedCents: money.appliedCents,
    unappliedCents: money.unappliedCents,
    proceedsCents: money.proceedsCents,
    tipNetCents: money.tipNetCents ?? 0,
    autoApply: stored['autoApply'] === true,
    application,
    creditedToAccountCents: storedCents(stored, 'creditedToAccountCents'),
    confirmationEmailSent: stored['confirmationEmailSent'] === true,
    // #1511: present only when the row records a household copy, either way.
    ...(stored['confirmationEmailSent'] === true || stored['confirmationAppOnly'] === true
      ? { confirmationAppOnly: stored['confirmationAppOnly'] === true }
      : {}),
    // A replay answers from the row. What a retry itself sends is folded in by
    // `replayWithConfirmation`; the row alone cannot say either of these.
    householdNoPortalAccount: false,
    officeNoticePending: false,
    // #2297 review: nothing was recorded by the call this answers.
    replayed: true,
  });
}

/**
 * Sends the household their payment confirmation, through the notification
 * path this repo already has.
 *
 * `invoice.payment.applied` IS THE EXISTING CONFIRMATION and no new catalog key
 * was minted for this toggle. That key already has an email template, a push
 * template, a prefs entry and a category, and `stripeWebhook.ts` and
 * `onInvoicesWrite` fire it for the same event on other paths: money landed on
 * a bill. A second key saying the same thing would give the household two
 * independent switches for one message and let them mute one of the two.
 *
 * #866: FOR AN ADMIN-RECORDED PAYMENT THIS IS THE ONLY SENDER. The write that
 * pays the invoice (`stageApply` here, or `markInvoicePaid` in the two-step
 * flow) stamps `paymentAppliedNoticeOwner`, so `onInvoicesWrite` does not send
 * a second copy, and does not send one when the box was left unticked either.
 * A partial payment that leaves the bill open is confirmed here too, because
 * no trigger fires for it. See the ownership table in notifications/catalog.ts.
 *
 * Reports which copies went out. A household that has never installed MyTribe has
 * no uid to deliver to, which is a fact about them and not a failure here.
 *
 * #866 OPERATOR RULING, AS ON MAIN. The office copy rides every enqueue (the
 * catalog's `businessAdmins` secondary resolver), so:
 *   - ticked, household has an account: household and office are told, for a
 *     full or a partial payment. The office copy is the same "Payment received"
 *     template the household gets, not an "Invoice Paid" message, so a partial
 *     may carry it, and main sent it.
 *   - unticked, paying the invoice off (#1973): the office, and the household
 *     on their notifications list only (`listOnlyFor`, every channel off).
 *   - no household account: the office alone is told, and only when this
 *     payment paid the invoice off (`settlesInvoice`). An enqueue with no
 *     household uid writes only the office copy, the shape the Stripe webhook
 *     uses. An unticked partial, or a payment that paid nothing off, tells nobody.
 */
export interface ConfirmationOutcome {
  /**
   * The household copy was written (#1511: read off the dispatcher's outcome,
   * not assumed from the uid). A copy the ledger deduped counts, because the
   * household has it from the earlier delivery; a copy the gate or their
   * settings held back does not.
   */
  household: boolean;
  /**
   * #1511: the household copy in `household` was written with every delivery
   * channel off, so it is in their notifications list and nothing was emailed,
   * texted or pushed. Never true without `household`.
   */
  householdAppOnly: boolean;
  /**
   * #2281 review: the household copy in `household` is an earlier delivery of
   * this same payment's notice, found on the dispatcher's ledger; this call
   * wrote nothing for them. Whether that earlier copy was emailed is not known
   * from here.
   */
  householdDuplicate?: boolean;
  /**
   * #2343: the household copy was held back by the household send switch, and
   * what the switch said. 'read-failed' is a failed read, not a choice: the
   * copy is still owed and a retry may send it.
   */
  householdHeld?: HouseholdSendGateState;
  /** The office copy was enqueued: it rides every enqueue, unless its roster lookup failed. */
  office: boolean;
  /**
   * #866: nobody exists to receive it (no household uid and no office roster),
   * as the dispatcher's `NoRecipientsError` says. Final: stamped so a retry does
   * not keep trying. A failed READ is not this; it stays retryable.
   */
  skipped?: boolean;
  /** #866: the household copy was asked for and the household has no portal account. */
  noPortalAccount: boolean;
  /**
   * #866: the office copy was owed and did not go out, because a lookup or the
   * dispatch failed. Left unstamped, so a same-key retry sends it.
   */
  officePending: boolean;
}

/** No copy was attempted, because none was owed. */
const NOTHING_SENT: ConfirmationOutcome = {
  household: false,
  householdAppOnly: false,
  office: false,
  noPortalAccount: false,
  officePending: false,
};
export async function sendPaymentConfirmation(input: {
  kinfolkId: string;
  invoiceId: string;
  paymentId: string;
  uid: string;
  /** The Send Confirmation toggle (or, on a retry, a household copy still owed). */
  householdRequested: boolean;
  /** This payment paid the invoice off, so the office is told even when the household is not. */
  settlesInvoice: boolean;
  /**
   * #866: the office copy is still owed. False on a retry whose row already
   * carries `officeNoticeSentAt`. The office copy rides every enqueue, so an
   * enqueue with no household uid would be a second office copy and nothing
   * else; it is skipped.
   */
  officeDue: boolean;
  /**
   * #866: on a retry, the household copy already went out on the first attempt
   * and the office copy did not. An office-only enqueue is then owed even for a
   * payment that did not settle the invoice, because the ticked first attempt
   * owed the office a copy too.
   */
  officeOwedWithoutHousehold?: boolean;
  /**
   * #1973: when the toggle is unticked and this payment paid the invoice off,
   * the household still gets the payoff on their notifications list, with
   * every delivery channel off (`listOnlyFor`). The form has always said "the
   * household is only notified once it is paid off", and #866 had made that
   * untrue: an unticked payoff told the household nothing at all.
   */
  householdOnPayoff?: boolean;
}): Promise<ConfirmationOutcome> {
  const none: ConfirmationOutcome = {
    household: false,
    householdAppOnly: false,
    office: false,
    noPortalAccount: false,
    officePending: false,
  };
  if (input.kinfolkId === '') return none;
  let recipientUid: string | null = null;
  let noPortalAccount = false;
  const officeOnlyAllowed = input.settlesInvoice || input.officeOwedWithoutHousehold === true;
  const listOnly = !input.householdRequested && input.settlesInvoice && input.householdOnPayoff === true;
  try {
    if (input.householdRequested || listOnly) {
      recipientUid = await resolveBillingRecipientUid(input.kinfolkId);
      // Only a copy the admin asked for is reported as not reaching anyone.
      if (recipientUid === null && input.householdRequested) {
        noPortalAccount = true;
        logEvent({
          severity: 'info',
          function: 'recordPayment',
          event: 'payment.confirmation.norecipient',
          uid: input.uid,
          extra: { kinfolkId: input.kinfolkId, paymentId: input.paymentId },
        });
      }
    }
    // With no household copy to send, an enqueue is the office copy alone: only
    // when it is owed without one, and only while it is still owed.
    if (recipientUid === null && (!officeOnlyAllowed || !input.officeDue)) return { ...none, noPortalAccount };
    const outcome = await enqueueNotificationDetailed({
      key: 'invoice.payment.applied',
      recipientUid: recipientUid ?? '',
      data: {
        kinfolkId: input.kinfolkId,
        invoiceId: input.invoiceId,
        paymentId: input.paymentId,
      },
      // A retry of the same submission may land hours later (#866 replay
      // recovery below); the ledger has to remember this payment's copies that long.
      dedupeWindowMs: PAYMENT_CONFIRMATION_DEDUPE_WINDOW_MS,
      ...(listOnly && recipientUid !== null ? { listOnlyFor: [recipientUid] } : {}),
    });
    // #866: a failed lookup (the office roster read) leaves that audience out of
    // this delivery. The household copy went out; the office copy did not, and
    // stays unstamped for a retry.
    const officeUnresolved = (outcome.unresolved ?? []).length > 0;
    if (officeUnresolved) {
      logEvent({
        severity: 'error',
        function: 'recordPayment',
        event: 'payment.confirmation.office.pending',
        uid: input.uid,
        extra: { kinfolkId: input.kinfolkId, paymentId: input.paymentId, unresolved: outcome.unresolved },
      });
    }
    // #1511: the household copy exists when the dispatcher did not hold it
    // back. `written` is doc ids for both copies, so the household's is read
    // from `suppressed` instead; a `duplicate` there is the earlier delivery of
    // this same payment, which the household already has.
    const householdSuppressed = outcome.suppressed.find((s) => s.recipientUid === recipientUid);
    const household =
      recipientUid !== null && (householdSuppressed === undefined || householdSuppressed.reason === 'duplicate');
    return {
      household,
      householdDuplicate: household && householdSuppressed?.reason === 'duplicate',
      ...(recipientUid !== null && householdSuppressed?.reason === 'gate'
        ? { householdHeld: householdSuppressed.gateState ?? 'off' }
        : {}),
      // Per recipient: the office's channels are not the household's.
      // #1973: a list-only copy is app-only by construction.
      householdAppOnly: household && recipientUid !== null && (listOnly || reachedAppOnly(outcome, recipientUid)),
      office: !officeUnresolved,
      noPortalAccount,
      officePending: officeUnresolved,
    };
  } catch (err) {
    // #866: only "nobody exists to receive it" is final. Any other failure (a
    // roster read with no household copy to send, the dispatcher itself) is left
    // unstamped so a same-key retry finishes it.
    const final = isNoRecipientsError(err);
    logEvent({
      severity: final ? 'error' : 'warn',
      function: 'recordPayment',
      event: final ? 'payment.confirmation.unreachable' : 'payment.confirmation.failed',
      uid: input.uid,
      extra: {
        kinfolkId: input.kinfolkId,
        paymentId: input.paymentId,
        err: (err as Error)?.message,
      },
    });
    return final
      ? { ...none, noPortalAccount, skipped: true }
      : { ...none, noPortalAccount, officePending: recipientUid !== null || officeOnlyAllowed };
  }
}

/**
 * #2281 review: WHAT A ROW THAT TOOK THE SWEEP ROW'S PLACE STILL SENDS, on its
 * first attempt and on a same-key retry.
 *
 * `stamps` are the copies on record for this payment: the sweep row's on the
 * first attempt, the replacing row's own on a retry. Every copy goes out under
 * the sweep row's id, the identity the sweep sent under, so the dispatcher's
 * ledger drops one the sweep sent and could not stamp.
 *
 *   - Copies not on record are sent as a retry sends them (`copiesOwed`).
 *   - THE TICKED EMAIL (lead ruling, 2026-11-14). The sweep cannot know the
 *     admin ticked Send Confirmation, so it only lists the payoff (#1973).
 *     When the late call is ticked and no channel has carried the household's
 *     copy, the listed copy is sent on the household's own channels
 *     (`deliverListedCopy`): email by default. Not a second enqueue: that
 *     would be refused as a duplicate, or under a new identity would list the
 *     payoff twice and tell the office twice.
 *   - A household copy the ledger reports as a duplicate is the sweep's list
 *     entry, not an email, so it is never reported as emailed by that alone.
 *
 * A send that fails leaves the stamps as they were, and the next same-key
 * retry tries again. The answer never says both "emailed" and "list only".
 *
 * WHAT THE ANSWER SAYS WHEN THE TICKED EMAIL DID NOT GO. Every admin client
 * prints `confirmationAppOnly: true` as "reached the household in the app
 * only. Email and text are off for this household." That is true for one
 * reason only: the household's own settings have every channel off. For every
 * other reason (the operator switched this notification off, the household
 * send gate is shut, the billing member has changed since the sweep listed
 * the payoff so the listed copy is someone else's, the household has no
 * portal account now, or the send failed) the answer leaves it out, and the
 * clients say the confirmation email did not go out. The ROW keeps
 * `confirmationAppOnly: true` in each of those cases: the listed copy exists,
 * and that stamp is what lets a same-key retry try the email again.
 */
async function sendAfterSweepRow(input: {
  stamps: Record<string, unknown>;
  ticked: boolean;
  kinfolkId: string;
  invoiceId: string;
  noticePaymentId: string;
  uid: string;
}): Promise<{
  sent: ConfirmationOutcome;
  confirmationEmailSent: boolean;
  confirmationAppOnly: boolean;
  stamps: Record<string, unknown>;
  changed: boolean;
}> {
  const owed = copiesOwed(input.stamps, input.ticked, true);
  // THE STAMPS SAY NO HOUSEHOLD COPY WAS WRITTEN, AND THE BILLING MEMBER HAS
  // CHANGED SINCE THE SWEEP (lead ruling 2026-11-14). The sweep may have
  // listed the payoff for the earlier member and lost its stamp. If it did,
  // the household's copy exists and is not the new member's: nobody is sent
  // anything, and the admin is told the confirmation did not go out, as when
  // the stamp is there. `elsewhere` is that case; `unsure` is a lookup that
  // failed, which sends the household nothing this time and leaves the row
  // unstamped so a same-key retry asks again.
  let elsewhere = false;
  let unsure = false;
  const listedFor = input.stamps[SETTLEMENT_NOTICE_UID_FIELD];
  if ((owed.householdDue || owed.listDue) && typeof listedFor === 'string' && listedFor !== '') {
    try {
      const billingNow = await resolveBillingRecipientUid(input.kinfolkId);
      if (billingNow !== listedFor) {
        elsewhere = await hasDeliveredCopy({
          key: 'invoice.payment.applied',
          recipientUid: listedFor,
          data: { kinfolkId: input.kinfolkId, invoiceId: input.invoiceId, paymentId: input.noticePaymentId },
        });
      }
    } catch (err) {
      unsure = true;
      logEvent({
        severity: 'warn',
        function: 'recordPayment',
        event: 'payment.confirmation.listed-for.lookup.failed',
        uid: input.uid,
        extra: { kinfolkId: input.kinfolkId, paymentId: input.noticePaymentId, err: (err as Error)?.message },
      });
    }
  }
  if (elsewhere || unsure) {
    // The office copy alone, when it is still owed. The dispatcher's ledger
    // drops it if the sweep already sent it.
    const sent = owed.officeDue
      ? await sendPaymentConfirmation({
          kinfolkId: input.kinfolkId,
          invoiceId: input.invoiceId,
          paymentId: input.noticePaymentId,
          uid: input.uid,
          householdRequested: false,
          settlesInvoice: true,
          officeDue: true,
        })
      : NOTHING_SENT;
    return {
      sent,
      confirmationEmailSent: false,
      // Not "app only": the clients print that as the household having email
      // and text off. The admin is told the confirmation did not go out.
      confirmationAppOnly: false,
      stamps: {
        // The earlier member's listed copy is on record: the lost stamp, restored.
        ...(elsewhere ? { confirmationAppOnly: true } : {}),
        ...(sent.office ? { officeNoticeSentAt: FieldValue.serverTimestamp() } : {}),
        ...(sent.skipped ? { officeNoticeSkippedReason: 'no-recipients' } : {}),
      },
      changed: elsewhere || sent.office || sent.skipped === true,
    };
  }
  const sent =
    !owed.householdDue && !owed.listDue && !owed.officeDue
      ? NOTHING_SENT
      : await sendPaymentConfirmation({
          kinfolkId: input.kinfolkId,
          invoiceId: input.invoiceId,
          paymentId: input.noticePaymentId,
          uid: input.uid,
          householdRequested: owed.householdDue,
          settlesInvoice: true,
          officeDue: owed.officeDue,
          officeOwedWithoutHousehold: input.ticked && owed.householdTold,
          householdOnPayoff: owed.listDue,
        });
  const duplicate = sent.household && sent.householdDuplicate === true;
  const listedBefore = input.stamps['confirmationAppOnly'] === true;
  let emailed =
    input.stamps['confirmationEmailSent'] === true || (sent.household && !duplicate && !sent.householdAppOnly);
  let deliveredNow = false;
  let delivery: ListedPayoffDelivery | null = null;
  if (input.ticked && !emailed && (listedBefore || duplicate)) {
    delivery = await deliverListedPayoff(input);
    deliveredNow = delivery === 'sent' || delivery === 'already';
    emailed = deliveredNow;
  }
  const listed = listedBefore || sent.household;
  return {
    sent,
    confirmationEmailSent: emailed,
    // "App only" is said only when it is the household's own settings that kept
    // the email back, or when no email was asked for. See the note above.
    confirmationAppOnly: listed && !emailed && (delivery === null || delivery === 'no-channels'),
    stamps: {
      ...(emailed ? { confirmationEmailSent: true, confirmationAppOnly: false } : listed ? { confirmationAppOnly: true } : {}),
      ...(sent.office ? { officeNoticeSentAt: FieldValue.serverTimestamp() } : {}),
      ...(sent.skipped ? { officeNoticeSkippedReason: 'no-recipients' } : {}),
    },
    changed: deliveredNow || sent.household || sent.office || sent.skipped === true,
  };
}
/**
 * What became of the ticked email for a payoff the sweep only listed: the
 * dispatcher's own outcome, or `no-recipient` (the household has no portal
 * account now) or `failed` (the lookup or the send threw).
 */
type ListedPayoffDelivery = ListedCopyDelivery | 'no-recipient' | 'failed';
/**
 * Sends the household's listed payoff copy on their own channels. `sent` and
 * `already` mean a channel carries it. NEVER THROWS: the payment is recorded,
 * and a failure here is retried by the next same-key call.
 *
 * The copy is looked up for the household's billing member AS OF NOW. When
 * that is not the member the sweep listed it for, there is no listed copy of
 * theirs to send (`no-record`) and nothing goes out: this never writes a new
 * list entry, and never emails a member a copy that sits on another member's
 * list.
 */
async function deliverListedPayoff(input: {
  kinfolkId: string;
  invoiceId: string;
  noticePaymentId: string;
  uid: string;
}): Promise<ListedPayoffDelivery> {
  try {
    const recipientUid = await resolveBillingRecipientUid(input.kinfolkId);
    if (recipientUid === null) return 'no-recipient';
    const { outcome } = await deliverListedCopy({
      key: 'invoice.payment.applied',
      recipientUid,
      // The data the sweep's copy went out with, so the ledger entry is found.
      data: { kinfolkId: input.kinfolkId, invoiceId: input.invoiceId, paymentId: input.noticePaymentId },
    });
    logEvent({
      severity: 'info',
      function: 'recordPayment',
      event: 'payment.confirmation.listed-copy',
      uid: input.uid,
      extra: { kinfolkId: input.kinfolkId, paymentId: input.noticePaymentId, outcome },
    });
    return outcome;
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'payment.confirmation.listed-copy.failed',
      uid: input.uid,
      extra: { kinfolkId: input.kinfolkId, paymentId: input.noticePaymentId, err: (err as Error)?.message },
    });
    return 'failed';
  }
}
export const recordPayment = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped
  // test admin (ADR-0002 funnels the sandbox through this same callable).
  // resolveInvoiceWriteActor at the top of the handler is the whole gate.
  wrapCallable('recordPayment', recordPaymentHandler),
);
