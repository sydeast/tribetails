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
 * stay payable. Two sessions become two PaymentIntents, and `stripeWebhook`
 * claims on the PaymentIntent id, so both settle and the household is charged
 * twice for one bill — with no refund available to put it back, by standing
 * ruling. Nothing our server writes can prevent that. Only Stripe can, so the
 * key is passed through to Stripe as a request option, and Stripe answers a
 * retry with the session the first attempt created.
 *
 * ONE KEY PER SUBMISSION, NOT PER TAP. Stripe holds a key for 24 hours, and
 * REFUSES one reused with a different request body. That is a real constraint
 * on how long a key may be held: the amount `payInvoice` sends is the invoice's
 * REMAINING balance, so if that balance moves between two taps, the second tap
 * must carry a new key. The screen therefore mints one per mount and drops it
 * the moment a checkout is handed back, rather than keeping one for the life of
 * an invoice. Where the two rules disagree, Stripe errors rather than charging
 * twice, which is the safe direction to be wrong in.
 *
 * See `mytribe/functions/src/lib/moneyIdempotency.ts` for the server half.
 */
export function mintCheckoutIdempotencyKey(): string {
  return `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}
