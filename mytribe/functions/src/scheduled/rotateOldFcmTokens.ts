import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { DocumentReference } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { wrapScheduled } from '../lib/wrapScheduled';
import { paginateQuery } from '../lib/paginateCollectionGroup';

const STALE_AFTER_DAYS = 60;
const DELETE_BATCH_LIMIT = 500; // Firestore hard cap on writes per WriteBatch.

type FcmTokenDoc = { updatedAt?: { toMillis?: () => number } | null };

/**
 * Deletes every `fcm_tokens` doc whose `updatedAt` is older than 60 days,
 * draining the collection page by page (WARNING-25) instead of stopping at a
 * single `.limit(500)`.
 *
 * The collection name was corrected from the phantom `fcmTokens` (camel) in
 * 84c6607; this collection has therefore never actually been pruned, so the
 * standing backlog can easily exceed one page, and a single-page sweep would
 * take weeks to drain it 500 at a time with nothing logged in between.
 *
 * The cutoff filter runs IN-MEMORY inside the page callback rather than as a
 * Firestore `.where()`, for the same reason kincareReminderCron and
 * scheduleDigestCron do it: `paginateQuery` orders every page by
 * `documentId()`, and Firestore rejects a query whose inequality filter field
 * (`updatedAt`) differs from its first sort order. Passing the unfiltered
 * collection keeps the scan on the automatic single-field index with no
 * composite index to deploy.
 *
 * Deletes are batched at the 500 cap rather than issued as one await per doc.
 * The final partial batch is flushed after the drain. Without that flush the
 * tail of the last page would be staged and never committed, the same
 * silent-drop class of bug WARNING-25 exists to prevent.
 *
 * A doc with no `updatedAt` at all is left alone: the original `.where()` query
 * excluded missing fields, and nothing should be inferred about a token whose
 * freshness was never stamped.
 *
 * Exported for testing. Returns the number of tokens actually committed.
 */
export async function runFcmTokenPruneScan(now: number = Date.now()): Promise<number> {
  const cutoffMs = now - STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  let staged: DocumentReference[] = [];
  let deleted = 0;

  async function flush(): Promise<void> {
    if (staged.length === 0) return;
    // Hand the refs off and clear BEFORE awaiting, so a rejected commit can
    // never leave the same refs staged for a second commit on a later flush.
    const chunk = staged;
    staged = [];
    const batch = db().batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
    deleted += chunk.length;
  }

  await paginateQuery(
    db().collection('fcm_tokens'),
    async (docSnap) => {
      const data = docSnap.data() as FcmTokenDoc;
      const updatedMs = data.updatedAt?.toMillis?.();
      if (typeof updatedMs !== 'number') return;
      if (updatedMs >= cutoffMs) return;
      staged.push(docSnap.ref);
      if (staged.length >= DELETE_BATCH_LIMIT) await flush();
    },
    { functionName: 'rotateOldFcmTokens' },
  );

  await flush();
  return deleted;
}

/**
 * Runs Mondays 04:00 ET. Prunes device tokens untouched for 60 days.
 *
 * A stale token is not merely clutter: pushChannel and broadcastMessage
 * multicast to every token owned by a uid, so dead tokens mean sends attempted
 * against devices that no longer exist.
 */
export const rotateOldFcmTokens = onSchedule(
  { schedule: 'every monday 04:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'] },
  wrapScheduled('rotateOldFcmTokens', async () => {
    await runFcmTokenPruneScan();
  }),
);
