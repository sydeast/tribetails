import { HttpsError } from 'firebase-functions/v2/https';
import { db } from './firestoreAdmin';

/**
 * Fixed-window rate limiter on a Firestore counter doc, for the public
 * (unauthenticated) callables where there is no uid to throttle on. The
 * window doc is `rate_limits/{scope}:{key}`; key is typically the caller IP
 * or the targeted resource id. Coarse by design — the goal is stopping
 * scripted probing of invite ids, not precise QoS.
 */
export async function enforceRateLimit(
  scope: string,
  key: string,
  maxPerWindow: number,
  windowSecs: number,
): Promise<void> {
  const id = `${scope}:${key}`.replace(/[/\s]/g, '_').slice(0, 1400);
  const ref = db().doc(`rate_limits/${id}`);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.data() as { count?: number; windowStart?: number } | undefined;
    const windowStart = data?.windowStart ?? 0;
    if (now - windowStart > windowSecs * 1000) {
      tx.set(ref, { count: 1, windowStart: now });
      return;
    }
    const count = (data?.count ?? 0) + 1;
    if (count > maxPerWindow) {
      throw new HttpsError('resource-exhausted', 'Too many attempts. Try again later.');
    }
    tx.set(ref, { count, windowStart });
  });
}
