/**
 * #814: mints the id the SERVER used to mint for an outbound send, so a second
 * attempt at one send names the send the first attempt made.
 *
 * This is `bookingIdempotency.ts` applied to the two callables that put mail in
 * front of households. The reasoning is identical and is worth restating here,
 * because the consequence is worse: `functions/internal` is what the SDK
 * reports for ANY transport failure, so the client cannot tell "the request
 * never arrived" from "the fan-out committed and the reply was lost". Retrying
 * repairs the first and double-sends the second, and a marketing email that
 * reaches a household twice cannot be recalled.
 *
 * ONE KEY PER SUBMISSION, NOT PER CLICK. That is the discipline these functions
 * exist to support. A caller holds the key across the automatic retry inside
 * `call(..., { idempotent: true })` AND across an operator who presses the
 * button again after seeing an error, and mints a new one only when the send
 * being submitted has actually changed. A fresh key per click brings the
 * duplicate straight back, in the exact case the operator is most likely to
 * produce it.
 *
 * Deliberately not `crypto.randomUUID()`: the value becomes a Firestore
 * document id that readers downstream already see (a blast's id rides on every
 * scheduled copy as `data.blastId`, which is what cancel queries on), and the
 * server's zod guard refuses anything that is not this shape. See
 * `mytribe/functions/src/lib/sendIdempotency.ts` for the server half.
 */
function mintKey(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

/** The id of the `marketingBlasts/{id}` row `scheduleMarketingBlast` will create. */
export function mintBlastIdempotencyKey(): string {
  return mintKey('blast');
}

/** The id of the `broadcasts/{id}` row `broadcastMessage` will claim before it sends. */
export function mintBroadcastIdempotencyKey(): string {
  return mintKey('bcast');
}
