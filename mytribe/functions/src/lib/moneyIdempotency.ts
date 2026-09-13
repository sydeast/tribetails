import type {
  DocumentReference,
  DocumentData,
  SetOptions,
  Transaction,
  WriteBatch,
} from 'firebase-admin/firestore';

import { idempotencyKeyArg, sendIdempotencyKeyRe, assertSameCaller } from './sendIdempotency';

/**
 * #825: the caller-supplied key that makes an INVOICE or PAYMENT callable safe
 * to retry.
 *
 * ── WHY THIS IS THE THIRD FILE AND NOT THE THIRD MECHANISM ────────────────
 *
 * `bookingIdempotency.ts` (#644) and `sendIdempotency.ts` (#814) already said
 * the hard part, and neither is restated here:
 *
 *   the key shape       built by `sendIdempotencyKeyRe` / `idempotencyKeyArg`,
 *                       imported from `sendIdempotency.ts`. A second copy of a
 *                       regex builder is how two key shapes drift apart.
 *   the cross-caller    `assertSameCaller`, imported from the same place. An id
 *   refusal             that belongs to somebody else is a guessed or replayed
 *                       id, and handing back their row is a disclosure.
 *   the anchor row      the document the callable was going to write anyway IS
 *                       the idempotency record. There is no second collection
 *                       to keep in step, which is #644's rule and the reason
 *                       this repo has never needed an `idempotencyKeys`
 *                       collection.
 *
 * What is genuinely new here is only the GUARD, and it is new because of what
 * these callables move.
 *
 * ── WHY A TRANSACTION, AND NOT #814's `create()` CLAIM ────────────────────
 *
 * #814 used a bare `create()` because a send has one row and no second write
 * to keep in step with it: the claim IS the whole decision. That is not true of
 * any callable in this file.
 *
 *   `recordPayment`     writes `payments/{key}` AND increments
 *                       `families/{id}.accountBalanceCents` AND may write an
 *                       invoice and its payment subcollection.
 *   `markInvoicePaid`   writes `invoices/{id}/payments/{key}` AND re-derives
 *                       the invoice's settlement onto the invoice doc.
 *   `createInvoice`     writes `invoices/{key}` AND consumes a value from the
 *   `createQuote`       shared `counters/invoiceNumber` sequence.
 *
 * A `WriteBatch` is already atomic, and a `batch.create()` that lost its race
 * would abort the balance increment with it, so "batch versus transaction" is
 * NOT an argument about whether the writes land together. They already do.
 * Three things only a transaction gives:
 *
 *   1. THE READ AND THE DECISION SHARE ONE SNAPSHOT. "Has this key already
 *      recorded a payment?" and "do not increment the balance again" are
 *      settled by the same commit, rather than by a check made before it.
 *   2. TWO SIMULTANEOUS ATTEMPTS ARE SERIALISED by the lock the read takes on
 *      the anchor document, so the loser sees the winner's row instead of
 *      racing a check-then-write. A nine-second cold start is long enough for
 *      an operator to press again while the first attempt is still running, so
 *      this is the ordinary case here, not the exotic one.
 *   3. THE REPLAY IS ANSWERED FROM THAT SAME SNAPSHOT, rather than from a
 *      second, unrefereed read taken after catching `ALREADY_EXISTS`.
 *
 * On `createInvoice` and `createQuote` the transaction buys one thing more: the
 * invoice number is drawn from the counter INSIDE it
 * (`mintInvoiceNumberInTransaction`), so a replay that loses the race does not
 * leave a minted number with no invoice on it. That is the "burns a fresh
 * invoice number each time" half of #825, and a claim cannot close it, because
 * by the time a claim fails the number is already spent.
 *
 * ── THE FAST PATH IS NOT AN OPTIMISATION ─────────────────────────────────
 *
 * Every callable here reads the anchor row BEFORE it re-runs its guards, and
 * returns the stored answer if it is there. #644's `lookupIdempotentEnvelope`
 * explains why in general; here the specific hazard is exact and reachable:
 * attempt 1 of `recordPayment` settles an invoice, attempt 2 re-plans the same
 * apply, and `alreadySettledRefusal` refuses it — reporting
 * `failed-precondition` for a payment that is already stored and perfectly
 * fine. A retry must not be able to turn a success into an error message.
 *
 * ── THE KEY IS OPTIONAL, EVERYWHERE ──────────────────────────────────────
 *
 * A payload without one behaves exactly as it did before: server-minted id, no
 * dedupe. That is what keeps the frozen contract shapes valid and lets the
 * three admin clients adopt this one at a time.
 */

/**
 * `.optional()`, never `.nullable().optional()`. `readModel.ts` refuses that
 * combination because Kotlin's one `T?` cannot distinguish "key omitted" from
 * "key sent null"; the ADR-0003 note in `createMultiDateBookingRequest.ts` has
 * the full reasoning.
 *
 * One prefix per callable, deliberately. All four values become Firestore
 * document ids, two of them in the SAME `invoices` collection, and a distinct
 * prefix is what stops a key minted for a quote from being replayed at
 * `createInvoice` — where it would answer with somebody else's document.
 */
export const PAYMENT_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('pay');
export const INVOICE_PAYMENT_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('ipay');
export const INVOICE_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('inv');
export const QUOTE_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('quot');

/** The id of the `payments/{key}` row `recordPayment` will create. */
export const PaymentIdempotencyKeyArg = idempotencyKeyArg(
  PAYMENT_IDEMPOTENCY_KEY_RE,
  'pay_<millis>_<suffix>',
);
/** The id of the `invoices/{invoiceId}/payments/{key}` row `markInvoicePaid` will create. */
export const InvoicePaymentIdempotencyKeyArg = idempotencyKeyArg(
  INVOICE_PAYMENT_IDEMPOTENCY_KEY_RE,
  'ipay_<millis>_<suffix>',
);
/** The id of the `invoices/{key}` document `createInvoice` will create. */
export const InvoiceIdempotencyKeyArg = idempotencyKeyArg(
  INVOICE_IDEMPOTENCY_KEY_RE,
  'inv_<millis>_<suffix>',
);
/** The id of the `invoices/{key}` document `createQuote` will create. */
export const QuoteIdempotencyKeyArg = idempotencyKeyArg(
  QUOTE_IDEMPOTENCY_KEY_RE,
  'quot_<millis>_<suffix>',
);

/**
 * Stripe's own idempotency key, for `payInvoice`.
 *
 * A DIFFERENT MECHANISM ON PURPOSE, because the duplicate is not in Firestore.
 * A replayed `payInvoice` creates a second Checkout Session at Stripe, and both
 * sessions stay payable. The second object is created in Stripe's database, so
 * nothing this server writes can stop it being created; the key is handed to
 * Stripe as a request option and Stripe returns the FIRST session instead.
 *
 * WHAT #826 ALREADY DOES, AND WHY THIS IS STILL WORTH HAVING. Since that issue
 * a second completed session no longer pays the bill twice: `stripeWebhook`
 * recognises it and routes the money to the household's account balance
 * (`lib/invoiceCheckoutDedupe.ts`). The money is not lost. But THE CARD IS
 * STILL CHARGED. Reconciliation is what you do after money has moved, and by
 * standing ruling there is no refund to undo it with, so a household debited
 * twice and handed a credit has still been debited twice. Preventing the second
 * session is the only thing that stops the charge happening at all.
 *
 * IT ALSO COVERS A CALL #826's SESSION REUSE CANNOT SEE. That reuse hands back
 * the session stored on the invoice in `pendingCheckoutSessionId`, which is
 * written AFTER Stripe returns, so it needs the previous call to have finished.
 * A call that created the session and then lost its reply stored nothing: the
 * retry finds nothing to reuse and mints a second session. That is this key's
 * case, and it is the ordinary shape of a #825 replay.
 *
 * The shape matches the rest of this file so all five keys are minted by one
 * client helper; Stripe accepts any string up to 255 characters.
 */
export const CHECKOUT_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('chk');
export const CheckoutIdempotencyKeyArg = idempotencyKeyArg(
  CHECKOUT_IDEMPOTENCY_KEY_RE,
  'chk_<millis>_<suffix>',
);

/**
 * Re-exported so a money callable imports its guard and its key from one
 * module. The definition stays in `sendIdempotency.ts`, where #814 wrote down
 * why a cross-caller collision is refused rather than deduped.
 */
export { assertSameCaller };

/**
 * What `stageApply` and `creditAccount` actually need: something that can stage
 * a `set`.
 *
 * STRUCTURAL, NOT `WriteBatch | Transaction`. Both classes carry overloaded,
 * generic `set` signatures, and TypeScript refuses to call a method through a
 * union of two overload sets ("none of those signatures are compatible"). One
 * structural member is compatible with both and says exactly what is required
 * of the writer, which is also the honest description: those helpers stage one
 * write and have no opinion about what commits it.
 */
export interface StagedWriter {
  set(
    ref: DocumentReference<DocumentData>,
    data: Record<string, unknown>,
    options?: SetOptions,
  ): unknown;
}

/** Compile-time proof that both of Firestore's writers satisfy the type above. */
export type StagedWriterIsSatisfiedByBatch = WriteBatch extends StagedWriter ? true : never;
export type StagedWriterIsSatisfiedByTransaction = Transaction extends StagedWriter ? true : never;
