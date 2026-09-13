import { z } from 'zod';
import { HttpsError } from 'firebase-functions/v2/https';
import type { DocumentReference } from 'firebase-admin/firestore';

/**
 * #814: the caller-supplied key that makes an outbound SEND safe to retry.
 *
 * This is the same mechanism #644 gave booking creation, applied to the two
 * callables that fan mail out to households. The reasoning transfers exactly:
 * the SDK reports a dropped request and a lost reply as the same
 * `functions/internal`, so the client cannot tell "never arrived" from
 * "committed, reply lost". Retrying repairs the first and DOUBLE-SENDS the
 * second, and here the second is marketing email to real households, which
 * cannot be recalled.
 *
 * What is different from bookings is where the anchor row comes from:
 *
 *   scheduleMarketingBlast  already writes `marketingBlasts/{id}` BEFORE the
 *                           fan-out (#813 did that so a queued copy could be
 *                           cancelled), so the row is already the natural
 *                           idempotency record. The key simply becomes its id.
 *   broadcastMessage        wrote `broadcasts/{id}` AFTER the send, so there was
 *                           nothing to collide with while the send was running.
 *                           It now writes the row first too, for the same reason
 *                           the blast does.
 *
 * THE CLAIM IS `create()`, NOT A READ-THEN-WRITE. Two attempts at one send can
 * be in flight at once (the client's 20s budget expires while the server is
 * still fanning out, and the operator clicks again), so a check-then-write lets
 * both see "absent". `create()` is refereed by the server: exactly one of the
 * two gets the document and the loser is told `ALREADY_EXISTS`. #644 used a
 * transaction because `writeEnvelope` already ran one and the guard could ride
 * inside it; there is no transaction here to ride, and a `create()` is the same
 * atomicity with less machinery.
 *
 * The key is OPTIONAL on both callables. A payload without one behaves exactly
 * as it did before, server-minted id, no dedupe, which is what keeps the
 * frozen contract shapes valid and lets each client adopt it on its own.
 */

/**
 * Deliberately a SHAPED key rather than a bare uuid, for the reason
 * `bookingIdempotency.ts` gives: the value becomes a Firestore document id that
 * operators and downstream readers see (`data.blastId` rides on every scheduled
 * copy and is what `cancelMarketingBlast` queries on), so an id that says what
 * it is beats an opaque one.
 *
 * The suffix bound is 1..16 rather than exactly 6 because a client minting from
 * `Math.random().toString(36)` can produce fewer than 6 characters when the
 * random ends in zeros.
 */
export function sendIdempotencyKeyRe(prefix: string): RegExp {
  return new RegExp(`^${prefix}_[0-9]{10,16}_[a-z0-9]{1,16}$`);
}

export const BLAST_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('blast');
export const BROADCAST_IDEMPOTENCY_KEY_RE = sendIdempotencyKeyRe('bcast');

/**
 * `.optional()`, never `.nullable().optional()`. `readModel.ts` refuses that
 * combination because Kotlin's one `T?` cannot distinguish "key omitted" from
 * "key sent null". the ADR-0003 note in `createMultiDateBookingRequest.ts` has
 * the full reasoning.
 */
export function idempotencyKeyArg(re: RegExp, shape: string) {
  return z.string().regex(re, `idempotencyKey must look like ${shape}`).optional();
}

export const BlastIdempotencyKeyArg = idempotencyKeyArg(
  BLAST_IDEMPOTENCY_KEY_RE,
  'blast_<millis>_<suffix>',
);
export const BroadcastIdempotencyKeyArg = idempotencyKeyArg(
  BROADCAST_IDEMPOTENCY_KEY_RE,
  'bcast_<millis>_<suffix>',
);

/** The fan-out's own state, stored on the anchor row. */
export type FanoutState = 'running' | 'complete' | 'failed';

/**
 * A row this attempt did not create, handed back so the handler can answer the
 * retry from what is already stored.
 */
export interface ClaimResult {
  /** True when THIS attempt created the row, and so owns the fan-out. */
  claimed: boolean;
  /** The stored row, when a previous attempt owns it. */
  stored: Record<string, unknown>;
}

/**
 * Refuses a key that belongs to somebody else.
 *
 * The blast and broadcast collections are not scoped by household the way a
 * booking envelope is, so a collision across callers means a guessed or
 * replayed id. Handing back another operator's send would be a disclosure
 * (audience description, subject, counts), not a dedupe.
 */
export function assertSameCaller(
  stored: Record<string, unknown>,
  actorUid: string,
  actorField: string,
): void {
  if (stored[actorField] !== actorUid) {
    throw new HttpsError(
      'already-exists',
      'That send id is already in use. Start this send again.',
    );
  }
}

/** Firestore's ALREADY_EXISTS (gRPC status 6), however the SDK surfaced it. */
export function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  if (e?.code === 6) return true;
  return typeof e?.message === 'string' && e.message.includes('ALREADY_EXISTS');
}

/**
 * Claims `ref` for this attempt, or reports who already holds it.
 *
 * `create()` is the whole guard: it is the one write whose outcome depends on
 * what is already stored, so two simultaneous attempts cannot both win it.
 */
export async function claimIdempotentRow(opts: {
  ref: DocumentReference;
  row: Record<string, unknown>;
  actorUid: string;
  actorField: string;
}): Promise<ClaimResult> {
  const { ref, row, actorUid, actorField } = opts;
  try {
    await ref.create(row);
    return { claimed: true, stored: row };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  const snap = await ref.get();
  const stored = (snap.data() ?? {}) as Record<string, unknown>;
  assertSameCaller(stored, actorUid, actorField);
  return { claimed: false, stored };
}

/** A stored count, read back for a replayed reply. Absent reads as 0, never as a guess. */
export function storedCount(stored: Record<string, unknown>, field: string): number {
  const v = stored[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
