import { HttpsError } from 'firebase-functions/v2/https';
import type { Transaction } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';

/** The refusal every caller of this limiter shows. Portal Android matches on it. */
export const RATE_LIMITED_MESSAGE = 'Too many attempts. Try again later.';

/**
 * Fixed-window rate limiter on a Firestore counter doc, for the public
 * (unauthenticated) callables where there is no uid to throttle on. The
 * window doc is `rate_limits/{scope}:{key}`; key is typically the caller IP
 * or the targeted resource id. Coarse by design: the goal is stopping
 * scripted probing of invite ids, not precise QoS.
 */
export async function enforceRateLimit(
  scope: string,
  key: string,
  maxPerWindow: number,
  windowSecs: number,
): Promise<void> {
  await db().runTransaction(async (tx) => {
    const limit = await readRateLimitInTx(tx, scope, key, maxPerWindow, windowSecs);
    if (!limit.allowed) throw new HttpsError('resource-exhausted', RATE_LIMITED_MESSAGE);
    limit.record();
  });
}

/**
 * The same counter, read inside a caller's own transaction (#873 final review).
 *
 * WHY. A save that counts in its own transaction first spends a save even when
 * the save is then refused or has nothing to write. Read here, the count commits
 * with the save or not at all: the caller reads this with its other reads, and
 * calls `record()` beside its writes only when it really writes. A refusal thrown
 * before that, or a no-op that writes nothing, leaves the counter as it was.
 *
 * `allowed` is false when one more save would pass `maxPerWindow`. The caller
 * decides whether that matters (a no-op is never refused for it). `record()`
 * stages the counter write on [tx], so call it only after every read.
 */
export async function readRateLimitInTx(
  tx: Transaction,
  scope: string,
  key: string,
  maxPerWindow: number,
  windowSecs: number,
): Promise<{ allowed: boolean; record: () => void }> {
  const id = `${scope}:${key}`.replace(/[/\s]/g, '_').slice(0, 1400);
  const ref = db().doc(`rate_limits/${id}`);
  const snap = await tx.get(ref);
  const now = Date.now();
  const data = snap.data() as { count?: number; windowStart?: number } | undefined;
  const windowStart = data?.windowStart ?? 0;
  if (now - windowStart > windowSecs * 1000) {
    return { allowed: true, record: () => void tx.set(ref, { count: 1, windowStart: now }) };
  }
  const count = (data?.count ?? 0) + 1;
  return { allowed: count <= maxPerWindow, record: () => void tx.set(ref, { count, windowStart }) };
}
