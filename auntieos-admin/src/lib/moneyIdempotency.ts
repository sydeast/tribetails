/**
 * #825: mints the id the SERVER used to mint for an invoice or a payment, so a
 * second attempt at one submission names the row the first attempt made.
 *
 * This is `sendIdempotency.ts` beside it (#814) pointed at money. The reasoning
 * is the same and the consequence is worse: `functions/internal` is what the
 * SDK reports for ANY transport failure, so the client cannot tell "the request
 * never arrived" from "the write committed and the reply was lost". Retrying
 * repairs the first and, on `recordPayment`, records a second payment AND a
 * second account credit — and account balance is the only destination this
 * business has for money owed back, so that credit is spendable money made from
 * nothing, in a direction nothing can claw back.
 *
 * ONE KEY PER SUBMISSION, NOT PER CLICK. That is the discipline these functions
 * exist to support, and the discipline lives in the screens, not here. A caller
 * holds its key across the automatic retry inside `call(..., { idempotent: true })`
 * AND across an operator who presses the button again after seeing an error,
 * and mints a new one only when what is being submitted has actually changed.
 * A fresh key per click brings the duplicate straight back, in the exact case
 * the operator is most likely to produce one.
 *
 * ONE PREFIX PER CALLABLE. All four values become Firestore document ids, and
 * two of them land in the SAME `invoices` collection, so a distinct prefix is
 * what stops a key minted for a quote from answering at `createInvoice` — where
 * it would hand back a document that is not the one being asked about. The
 * server's zod guards refuse anything else; see
 * `mytribe/functions/src/lib/moneyIdempotency.ts` for the server half and for
 * why a transaction rather than a bare claim.
 */
function mintKey(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

/** The id of the `payments/{key}` row `recordPayment` will create. */
export function mintPaymentIdempotencyKey(): string {
  return mintKey('pay');
}

/** The id of the `invoices/{id}/payments/{key}` row `markInvoicePaid` will create. */
export function mintInvoicePaymentIdempotencyKey(): string {
  return mintKey('ipay');
}

/** The id of the `invoices/{key}` document `createInvoice` will create. */
export function mintInvoiceIdempotencyKey(): string {
  return mintKey('inv');
}

/** The id of the `invoices/{key}` document `createQuote` will create. */
export function mintQuoteIdempotencyKey(): string {
  return mintKey('quot');
}
