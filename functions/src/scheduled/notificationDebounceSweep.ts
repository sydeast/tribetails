import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';

/**
 * Drains `pendingNotifications/{uid}_{key}` docs whose fireAfterMs has elapsed.
 *
 * Each pending doc is promoted to a fresh `notifications/{id}` doc with
 * mode='debounced-promoted' + status='pending'. The trigger fan-out
 * (onNotificationCreate) then dispatches to channel subdocs as usual.
 *
 * Debounce semantics:
 *   - 'snapshot' strategy: the pending doc's `data` field is the latest
 *     enqueue's payload (dispatcher writes with merge:true, last writer wins).
 *   - 'collapse' strategy: same as snapshot at this layer; richer rollup
 *     would require the dispatcher to append items into an array, not
 *     wired today. TODO when needed.
 *
 * Runs every minute. Idempotent within a run via per-doc fence: delete the
 * pending doc as part of the same transaction so a partial failure doesn't
 * cause double dispatch.
 */
const SCAN_LIMIT = 100;

export const notificationDebounceSweep = onSchedule(
  { schedule: 'every 1 minutes', region: 'us-central1', secrets: ['SENTRY_DSN'] },
  wrapScheduled('notificationDebounceSweep', async () => {
    const now = Date.now();
    const snap = await db()
      .collection('pendingNotifications')
      .where('fireAfterMs', '<=', now)
      .limit(SCAN_LIMIT)
      .get();
    if (snap.empty) return;

    let promoted = 0;
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      try {
        await db().runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return;
          const newRef = db().collection('notifications').doc();
          tx.set(newRef, {
            key: data.key,
            category: data.category,
            recipientUid: data.recipientUid,
            actorUid: data.actorUid ?? null,
            data: data.data ?? {},
            channels: data.channels ?? [],
            status: 'pending',
            mode: 'debounced-promoted',
            originPendingId: doc.id,
            createdAt: FieldValue.serverTimestamp(),
          });
          tx.delete(doc.ref);
        });
        promoted += 1;
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'notificationDebounceSweep',
          event: 'debounce.promote.failed',
          extra: { pendingId: doc.id, error: (err as Error)?.message },
        });
      }
    }

    logEvent({
      severity: 'info',
      function: 'notificationDebounceSweep',
      event: 'debounce.sweep.complete',
      extra: { scanned: snap.size, promoted },
    });
  }),
);
