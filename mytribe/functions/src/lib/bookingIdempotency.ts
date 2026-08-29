import { z } from 'zod';
import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';

/**
 * #644 (follow-up to #630): the caller-supplied key that makes a booking-create
 * retry safe.
 *
 * #630 established that a request can be dropped by Cloud Run before it ever
 * reaches the container, and that the SDK reports that as `functions/internal` —
 * the same code it reports when the write committed and only the REPLY was
 * lost. The client cannot tell those apart. That is the whole problem: retrying
 * fixes the first case and double-books the second, because both booking-create
 * callables minted `batchId = req_${Date.now()}_${random}` server-side on every
 * call, so two attempts with identical arguments wrote two envelopes and two
 * full sets of visits, with nothing comparing them.
 *
 * The key moves that id to the CLIENT, minted once per logical submission and
 * reused by every attempt at it. The envelope document at
 * `families/{kinfolkId}/bookings/{batchId}` then IS the idempotency record —
 * there is no second collection to keep in step, and the dedupe is enforced by
 * the same transaction that does the write (see `writeEnvelope`), so two
 * attempts racing each other cannot both pass a check-then-write.
 *
 * The key is OPTIONAL on both callables. A payload without one behaves exactly
 * as it did before: server-minted id, no dedupe. That is what keeps the frozen
 * legacy payloads valid and what lets the four clients adopt this one at a time.
 */

/**
 * Deliberately the SHAPE THE SERVER ALREADY MINTS — `req_<millis>_<suffix>` —
 * rather than a bare uuid.
 *
 * This value becomes a Firestore document id and is read back by everything
 * downstream (`getMyBookings`, `enrichTemplateData`, the envelope triggers), so
 * a new id format would be a data-shape change smuggled in as a reliability fix.
 * Nothing downstream currently parses the prefix — checked — but keeping the
 * shape means nothing has to.
 *
 * The suffix bound is 1..16 because `Math.random().toString(36).slice(2, 8)`
 * can return fewer than 6 characters (a random ending in zeros), so the
 * server's own historical ids have to remain expressible here.
 */
export const BOOKING_IDEMPOTENCY_KEY_RE = /^req_[0-9]{10,16}_[a-z0-9]{1,16}$/;

/**
 * `.optional()`, never `.nullable().optional()`. `readModel.ts` refuses that
 * combination outright, because Kotlin's one `T?` cannot distinguish "key
 * omitted" from "key sent null" — see the ADR-0003 note in
 * `createMultiDateBookingRequest.ts` for the full reasoning.
 */
export const IdempotencyKeyArg = z
  .string()
  .regex(
    BOOKING_IDEMPOTENCY_KEY_RE,
    'idempotencyKey must look like req_<millis>_<suffix>, the id shape the server mints.',
  )
  .optional();

/** What a booking-create callable needs back to answer a deduped retry. */
export interface StoredEnvelope {
  batchId: string;
  visitIds: string[];
  visitCount: number;
}

/**
 * Reads the visit ids of an envelope that already exists.
 *
 * `writeEnvelope` denormalizes `visitIds` onto the envelope precisely so this
 * is one read. The subcollection scan is the fallback for envelopes written
 * before that field existed: a client would have to send a key equal to an old
 * `batchId` to reach it, which is close enough to impossible that the fallback
 * is here for correctness rather than for traffic.
 */
export async function readEnvelopeVisitIds(
  kinfolkId: string,
  batchId: string,
  stored: Record<string, unknown> | undefined,
): Promise<string[]> {
  const denormalized = stored?.['visitIds'];
  if (Array.isArray(denormalized)) {
    return denormalized.filter((v): v is string => typeof v === 'string' && v.length > 0);
  }
  const snap = await db()
    .collection(`families/${kinfolkId}/bookings/${batchId}/kinCares`)
    .get();
  return snap.docs.map((d) => d.id);
}

/**
 * The FAST PATH: an attempt whose key already has an envelope returns that
 * envelope without re-running any of the create-time validation.
 *
 * This is not the safety mechanism — `writeEnvelope`'s in-transaction guard is,
 * and it is what makes two simultaneous attempts safe. This is what makes a
 * retry DETERMINISTIC. Without it, a retry re-runs the guards, and a guard can
 * legitimately have changed its mind between attempts: the operator's own retry
 * a minute after a visible error can trip "every visit startTime must be in the
 * future" for a visit that has since slipped inside the 60-second grace, and
 * report `invalid-argument` for a booking that is already stored and fine.
 *
 * Returns null when the key is absent or unused, which is the ordinary path.
 * Throws `already-exists` when the id belongs to a DIFFERENT caller: the
 * document path is already scoped by household, so a cross-caller collision
 * means a guessed or replayed id, and handing back somebody else's envelope
 * would be a disclosure, not a dedupe.
 */
export async function lookupIdempotentEnvelope(opts: {
  kinfolkId: string;
  key: string | undefined;
  uid: string;
}): Promise<StoredEnvelope | null> {
  const { kinfolkId, key, uid } = opts;
  if (!key) return null;
  const snap = await db().doc(`families/${kinfolkId}/bookings/${key}`).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  assertSameCaller(data, uid);
  const visitIds = await readEnvelopeVisitIds(kinfolkId, key, data);
  return { batchId: key, visitIds, visitCount: visitIds.length };
}

/** Shared by the fast path and the transaction guard, so both refuse alike. */
export function assertSameCaller(stored: Record<string, unknown>, uid: string): void {
  if (stored['requestedByUid'] !== uid) {
    throw new HttpsError(
      'already-exists',
      'That booking id is already in use. Start the request again.',
    );
  }
}
