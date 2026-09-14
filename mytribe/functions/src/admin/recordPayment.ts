import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
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
  planApply,
  readInvoiceForApply,
  stageApply,
  type ApplyOutcome,
  type ApplyStep,
} from '../lib/paymentApply';
import { creditAccount } from '../lib/accountCredit';
import { PaymentIdempotencyKeyArg, assertSameCaller } from '../lib/moneyIdempotency';
import { resolveKinfolkUid } from '../lib/resolveKinfolkUid';
import { enqueueNotification } from '../notifications/dispatcher';
import { PAYMENT_APPLIED_CLAIM_FIELD, claimableMarkInvoicePaidOwner } from '../lib/paymentAppliedOwner';

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
 *   `autoApply`              put the leftover into the household's EXISTING
 *                            account credit, for a FUTURE invoice.
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
      /** DOLLARS applied to that invoice. */
      amount: z.number().min(0).max(10_000_000),
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
   */
  autoApply: z.boolean().default(false),
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
    /** Whether the leftover was moved into the household's account credit. */
    autoApply: z.boolean(),
    /** What the apply did, or null when no invoice balance was touched. */
    application: PaymentApplicationSchema.nullable(),
    /**
     * The unapplied remainder actually moved into
     * `families/{kinfolkId}.accountBalanceCents`, the EXISTING credit ledger
     * `redeemCredit` fills and the portal already shows, not a new one.
     *
     * Zero when auto-apply was off, when there was no remainder, or when the
     * payment belongs to no household. It is reported separately from
     * `unappliedCents` because those are two different facts: what is left over,
     * and what was done with it.
     */
    creditedToAccountCents: CentsSchema,
    /**
     * Whether the household confirmation actually went out.
     *
     * FALSE IS A REAL ANSWER, not an error. The operator may not have asked for
     * one, and a household with no portal account has no uid to send to. Either
     * way the payment is recorded; saying "sent" when nothing was is the class
     * of lie this whole surface is being cleaned of.
     */
    confirmationEmailSent: z.boolean(),
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

  // EVERY FIGURE IN INTEGER CENTS, ONCE, HERE. The dollar floats the request
  // carries are the collection's legacy shape and are still stored verbatim
  // below; nothing downstream re-derives cents from them, so no two readers can
  // round the same dollar differently.
  const amountCents = dollarsToCents(args.amount);
  const tipCents = dollarsToCents(args.tip);
  const feeCents = dollarsToCents(args.fee);
  const appliedCents = args.apply ? dollarsToCents(args.apply.amount) : 0;
  const money = paymentMoneyOf({
    amountCents,
    tipCents,
    feeCents,
    appliedCents,
    // Stamped, not inferred: this server writes gross tips and says so, which
    // is the whole point of the field.
    tipBasis: 'gross',
  });
  // A TIP LARGER THAN THE PAYMENT is refused up front rather than stored as a
  // negative unapplied balance. It is a keying slip (the tip typed into the
  // amount box, or dollars mistaken for cents), and every later reader of the
  // row would have to decide what a payment that is more tip than money means.
  if (tipCents > amountCents) {
    throw new HttpsError(
      'invalid-argument',
      `A tip of ${dollars(tipCents)} does not fit inside a payment of ${dollars(amountCents)}. ` +
        `The tip is part of what the client paid, not an addition to it.`,
      { code: 'tip_exceeds_amount' },
    );
  }
  const paidAtIso = new Date().toISOString();
  // THE APPLY, PLANNED BEFORE ANYTHING IS WRITTEN. Refusing here means no
  // payment row either: an operator who mis-keyed the Apply box gets the whole
  // form back to correct, not a stored payment whose apply silently did not
  // happen.
  //
  // The plan is still read and refused OUTSIDE the transaction (#825). These
  // are reads of an invoice this call does not own, the refusal they produce is
  // about the request rather than about the stored state, and pulling them in
  // would make every transaction retry re-read the whole subcollection.
  let plannedStep: ApplyStep | null = null;
  if (args.apply) {
    const plan = planApply({
      invoice: await readInvoiceForApply(db(), args.apply.invoiceId),
      appliedCents,
      kinfolkId,
      // What the payment has to give: everything except the gross tip. The tip
      // is the operator's, never the household's bill.
      spendableCents: amountCents - tipCents,
    });
    if (!plan.ok) {
      throw new HttpsError('failed-precondition', plan.refusal.message, {
        code: plan.refusal.code,
      });
    }
    plannedStep = plan.step;
  }
  // THE LEFTOVER BECOMES ACCOUNT CREDIT, in the ledger this repo already has.
  // Her label says "apply any Unapplied amount to FUTURE invoices", so the
  // remainder is HELD rather than spread across today's bills, and
  // `triggers/onInvoiceAutoApply.ts` spends it on the next invoice that becomes
  // collectable.
  const creditedToAccountCents =
    args.autoApply && money.unappliedCents > 0 && kinfolkId !== '' ? money.unappliedCents : 0;

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
  const committed = await db().runTransaction(async (tx) => {
    // FIRESTORE REQUIRES EVERY READ BEFORE EVERY WRITE, which happens to be the
    // order the guard needs anyway.
    if (args.idempotencyKey !== undefined) {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const stored = (snap.data() ?? {}) as Record<string, unknown>;
        assertSameCaller(stored, actor.uid, 'recordedBy');
        return { replayed: stored, application: null as ApplyOutcome | null, settlesInvoice: false };
      }
    }
    // #866: DID THE `markInvoicePaid` STEP BEFORE THIS ONE PAY THE INVOICE OFF?
    // Both admin clients settle with `markInvoicePaid` and then call this with
    // the invoice as a display link. The office is told only for a payment that
    // paid the bill off, so this call claims that settlement's owner stamp, in
    // the same transaction, and only one call can ever claim it.
    const linkedInvoiceRef =
      !plannedStep && args.invoiceId !== '' ? db().collection('invoices').doc(args.invoiceId) : null;
    const linkedInvoiceSnap = linkedInvoiceRef ? await tx.get(linkedInvoiceRef) : null;
    const claimedOwner = linkedInvoiceSnap?.exists
      ? claimableMarkInvoicePaidOwner((linkedInvoiceSnap.data() ?? {}) as Record<string, unknown>, kinfolkId)
      : null;
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
      amount: args.amount,
      tip: args.tip,
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
      autoApply: args.autoApply,
      // What of the leftover actually reached the household's account credit.
      creditedToAccountCents,
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
    };
    // #866: WHETHER THIS PAYMENT PAID THE INVOICE OFF, decided in this
    // transaction and stored, so a same-key retry that finishes a lost office
    // copy reads the same answer instead of re-deriving it from a later state.
    // Either this call's own apply settled it, or it claimed the settlement
    // `markInvoicePaid` stamped just before it.
    const settlesInvoice = staged
      ? staged.state === 'settled' || staged.state === 'overpaid'
      : claimedOwner !== null;
    row['settlesInvoice'] = settlesInvoice;
    if (linkedInvoiceRef && claimedOwner !== null) {
      tx.set(linkedInvoiceRef, { [PAYMENT_APPLIED_CLAIM_FIELD]: claimedOwner }, { merge: true });
    }
    // `create` WHEN THERE IS A KEY, so two attempts that somehow reach the
    // write together are refereed by the server rather than by the read above.
    // A keyless call keeps `set`: its id is server-minted and cannot collide.
    if (args.idempotencyKey !== undefined) tx.create(ref, row);
    else tx.set(ref, row);
    return { replayed: null, application: staged, settlesInvoice };
  });

  if (committed.replayed !== null) {
    logEvent({
      severity: 'info',
      function: 'recordPayment',
      event: 'admin.payment.recorded.replay',
      uid: actor.uid,
      extra: { paymentId: ref.id, kinfolkId, idempotencyKey: args.idempotencyKey, raced: true },
    });
    return replayWithConfirmation(ref, committed.replayed, args.sendConfirmationEmail, actor.uid);
  }
  const application = committed.application;

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.BILLING_PAYMENT_RECORDED,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: actor.uid,
    targetUid: ref.id,
    targetCollection: 'payments',
    familyId: kinfolkId || undefined,
    description: args.invoiceId
      ? `Payment row recorded against invoice ${args.invoiceNumber || args.invoiceId}`
      : 'Standalone payment row recorded',
    payload: {
      paymentId: ref.id,
      kinfolkId,
      invoiceId: args.invoiceId,
      amount: args.amount,
      tip: args.tip,
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
      autoApply: args.autoApply,
      creditedToAccountCents,
      appliedInvoiceId: application?.invoiceId ?? null,
      appliedInvoiceState: application?.state ?? null,
      method: args.paymentMethod,
      reference: args.referenceNumber,
      testMode: actor.testMode.active,
      // WHICH SUBMISSION THIS ROW BELONGS TO. An audit trail that cannot tell a
      // second payment from a second attempt at one payment is the trail that
      // would have had to answer #825 after the fact.
      idempotencyKey: args.idempotencyKey ?? null,
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
  // partial. Unticked (or no portal account), the household gets nothing from
  // any path, and the office is told only when this payment paid the invoice
  // off (`settlesInvoice`, decided in the transaction above), as on main.
  const sent = await sendPaymentConfirmation({
    kinfolkId,
    // The invoice the confirmation is ABOUT: the one this payment was
    // applied to, or the display link when nothing was applied. The catalog's
    // `invoice.payment.applied` template needs one.
    invoiceId: application?.invoiceId ?? args.invoiceId,
    paymentId: ref.id,
    uid: actor.uid,
    householdRequested: args.sendConfirmationEmail,
    settlesInvoice: committed.settlesInvoice,
  });
  const confirmationEmailSent = sent.household;
  {
    // STAMPED ON THE ROW, so a replay can report it (#825) and a same-key retry
    // knows what is left to send (#866). Outside the transaction because it is
    // not known inside one: the send is attempted only after the money has
    // landed. Best-effort like the send itself; a failed stamp must not throw
    // away a payment that is already recorded, and within
    // PAYMENT_CONFIRMATION_DEDUPE_WINDOW_MS the ledger stops a retry repeating
    // a copy that did go out.
    if (args.idempotencyKey !== undefined && (sent.household || sent.office)) {
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
      autoApply: args.autoApply,
      creditedToAccountCents,
      confirmationEmailSent,
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
    autoApply: args.autoApply,
    application,
    creditedToAccountCents,
    confirmationEmailSent,
  });
}

/** "$36.00" from integer cents, for a refusal an operator has to read. */
function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
 * How long the dispatcher ledger remembers one payment's confirmation copies.
 * A same-key retry that finishes a lost confirmation (below) can land hours
 * after the first attempt; the identity names one payment, so a day can never
 * merge two.
 */
export const PAYMENT_CONFIRMATION_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * #866: the row fields that record which copies of `invoice.payment.applied`
 * went out for this payment. `confirmationEmailSent` is the household copy (and
 * the #825 answer field); `officeNoticeSentAt` is the office copy.
 */
function noticeStamps(sent: ConfirmationOutcome): Record<string, unknown> {
  return {
    ...(sent.household ? { confirmationEmailSent: true } : {}),
    ...(sent.office ? { officeNoticeSentAt: FieldValue.serverTimestamp() } : {}),
  };
}

/**
 * THE ANSWER A RETRY GETS, plus the copies of the first attempt's notice a retry
 * may finish (#866). Since #866 this callable is the only sender of both copies
 * for the payment it records, so a first attempt that recorded the payment and
 * then crashed, or whose enqueue failed, would otherwise leave them untold for
 * good.
 *
 *   - household copy: due when this submission was ticked and the row does not
 *     say `confirmationEmailSent: true`.
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
  const settlesInvoice = stored['settlesInvoice'] === true;
  const householdDue = householdRequested && stored['confirmationEmailSent'] !== true;
  const officeDue = (settlesInvoice || householdRequested) && stored['officeNoticeSentAt'] == null;
  if (!householdDue && !officeDue) return answer;
  const sent = await sendPaymentConfirmation({
    kinfolkId: answer.kinfolkId,
    invoiceId: answer.application?.invoiceId ?? (typeof stored['invoiceId'] === 'string' ? stored['invoiceId'] : ''),
    paymentId: ref.id,
    uid: actorUid,
    householdRequested: householdDue,
    settlesInvoice,
  });
  if (!sent.household && !sent.office) return answer;
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
    extra: { paymentId: ref.id, household: sent.household, office: sent.office },
  });
  return { ...answer, confirmationEmailSent: answer.confirmationEmailSent || sent.household };
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
 *   - unticked, or no household account: the office alone is told, and only
 *     when this payment paid the invoice off (`settlesInvoice`). An enqueue with
 *     no household uid writes only the office copy, the shape the Stripe webhook
 *     uses. A partial, or a payment that paid nothing off, tells nobody.
 */
interface ConfirmationOutcome {
  /** The household copy was enqueued. */
  household: boolean;
  /** The office copy was enqueued (it rides every enqueue). */
  office: boolean;
}

async function sendPaymentConfirmation(input: {
  kinfolkId: string;
  invoiceId: string;
  paymentId: string;
  uid: string;
  /** The Send Confirmation toggle. Off means the household is not told. */
  householdRequested: boolean;
  /** This payment paid the invoice off, so the office is told even when the household is not. */
  settlesInvoice: boolean;
}): Promise<ConfirmationOutcome> {
  const none: ConfirmationOutcome = { household: false, office: false };
  if (input.kinfolkId === '') return none;
  try {
    let recipientUid: string | null = null;
    if (input.householdRequested) {
      recipientUid = await resolveKinfolkUid(input.kinfolkId);
      if (recipientUid === null) {
        logEvent({
          severity: 'info',
          function: 'recordPayment',
          event: 'payment.confirmation.norecipient',
          uid: input.uid,
          extra: { kinfolkId: input.kinfolkId, paymentId: input.paymentId },
        });
      }
    }
    if (recipientUid === null && !input.settlesInvoice) return none;
    await enqueueNotification({
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
    });
    return { household: recipientUid !== null, office: true };
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'recordPayment',
      event: 'payment.confirmation.failed',
      uid: input.uid,
      extra: {
        kinfolkId: input.kinfolkId,
        paymentId: input.paymentId,
        err: (err as Error)?.message,
      },
    });
    return none;
  }
}

export const recordPayment = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  // wrapCallable, NOT wrapAdminCallable: the gate must also admit a scoped
  // test admin (ADR-0002 funnels the sandbox through this same callable).
  // resolveInvoiceWriteActor at the top of the handler is the whole gate.
  wrapCallable('recordPayment', recordPaymentHandler),
);
