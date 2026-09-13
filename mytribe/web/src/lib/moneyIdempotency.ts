/**
 * #825: the key that stops one tap on Pay becoming two live Checkout Sessions.
 *
 * `bookingIdempotency.ts` beside this file does the same job for booking
 * creation (#644), and the reasoning transfers, but the mechanism on the other
 * end is different and the difference is the whole point.
 *
 * A booking key is checked by OUR server against a Firestore document. There is
 * no document to check here: `payInvoice` asks STRIPE to create a Checkout
 * Session, and a replay creates a SECOND session in Stripe's database. Both
 * stay payable. Nothing our server writes can stop that second session being
 * created. Only Stripe can, so the key is passed through to Stripe as a request
 * option, and Stripe answers a retry with the session the first attempt made.
 *
 * #826 ALREADY STOPS THE SECOND CHARGE PAYING THE BILL TWICE: the webhook
 * recognises it and routes the money to the household's account balance instead
 * of applying it again. That net holds. What it cannot do is un-charge the
 * card, because there are no refunds here and it acts after the money has
 * moved. A household debited twice and handed a credit has still been debited
 * twice, which is why it is worth not opening the second session at all.
 *
 * IT ALSO COVERS A TAP #826's SESSION REUSE CANNOT SEE. That reuse hands back
 * the session stored on the invoice, so it needs the previous call to have
 * finished and written one. This covers the call that did NOT finish: Stripe
 * made the session and the reply was lost coming back, so nothing was stored
 * and the retry has nothing to be handed.
 *
 * ONE KEY PER SUBMISSION, NOT PER TAP. Stripe holds a key for 24 hours, and
 * REFUSES one reused with a different request body. That is a real constraint
 * on how long a key may be held: the amount `payInvoice` sends is the invoice's
 * REMAINING balance, so if that balance moves between two taps, the second tap
 * must carry a new key. The screen therefore mints one per mount and drops it
 * the moment a checkout is handed back, rather than keeping one for the life of
 * an invoice.
 *
 * The server closes the rest of that gap rather than leaving it to this rule.
 * It derives the key it actually hands Stripe from this value PLUS the
 * invoice's settlement round and its current balance, which are the two facts
 * #826 treats as making an open session unusable. So a balance that moved
 * between two taps mints a fresh session rather than earning a Stripe error,
 * and the two rules cannot disagree. Dropping the key here is the belt to that
 * braces.
 *
 * See `mytribe/functions/src/lib/moneyIdempotency.ts` for the server half.
 */
export function mintCheckoutIdempotencyKey(): string {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}
