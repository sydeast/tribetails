/**
 * #644: mints the booking id the SERVER used to mint, so a retry can be safe.
 *
 * #630 established that Cloud Run can drop a request before it reaches the
 * container, and that the SDK reports that as `functions/internal` — the same
 * code it reports when the write committed and only the reply was lost. Moving
 * the id to the client is what lets the server tell those two apart: the second
 * attempt names the booking the first one made, so the server can hand back
 * that booking instead of creating another. See
 * `mytribe/functions/src/lib/bookingIdempotency.ts` for the server half and for
 * why the format is `req_<millis>_<suffix>` rather than a uuid.
 *
 * ONE KEY PER SUBMISSION, NOT PER CLICK. That is the whole discipline this
 * function is here to support: a caller holds the key across the automatic
 * retry inside `call()` AND across an operator who clicks Create again after
 * seeing an error, and mints a new one only when the booking being submitted
 * has actually changed. A fresh key per click brings the double-booking
 * straight back, in the exact case the operator is most likely to produce it.
 *
 * Deliberately not `crypto.randomUUID()`: this value becomes a Firestore
 * document id that every reader downstream already sees, and the server's zod
 * guard refuses anything that is not the shape it has always minted.
 *
 * The portal carries its own copy at `mytribe/web/src/lib/bookingIdempotency.ts`,
 * the same way `fns.ts` is deliberately duplicated across the two apps.
 */
export function mintBookingIdempotencyKey(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}
