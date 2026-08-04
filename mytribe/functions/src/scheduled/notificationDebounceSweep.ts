import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { promoteQueuedNotification } from '../notifications/promoteQueued';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';

/**
 * Drains `pendingNotifications/{uid}_{key}` docs whose fireAfterMs has elapsed.
 *
 * Each pending doc is promoted to a fresh `notifications/{id}` inbox doc plus its
 * id-matched `notificationDispatch/{id}` work order carrying
 * mode='debounced-promoted' + status='pending'. The fan-out trigger
 * (onNotificationCreate, now watching the work order) then dispatches to channel
 * subdocs as usual. Both documents are built by `promoteQueuedNotification`,
 * which is also why the promoted card now keeps its title, description, actor and
 * deep-link target; this sweep used to drop all four.
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
  // Runs every minute and dispatches. The default 60s timeout leaves no room
  // to run 4x slower on a quarter vCPU, and a run can overlap the next tick.
  {
    schedule: 'every 1 minutes',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
  },
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
          promoteQueuedNotification(tx, data, {
            mode: 'debounced-promoted',
            origin: { originPendingId: doc.id },
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
