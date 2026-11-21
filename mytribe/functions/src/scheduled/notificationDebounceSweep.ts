import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { promoteQueuedNotification } from '../notifications/promoteQueued';
import { FULL_CPU_SERIAL, SCHEDULE_RETRY_FREQUENT } from '../lib/runtimeOptions';
import { countHeldNotice, withHeldNoticeBatch } from '../notifications/heldNoticeBatch';
// #2478: loaded only when a run has rows to drain, so the cold-start graph stays at its bound.
import type * as QueuedCopyHold from '../notifications/queuedCopyHold';

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

/** #2478: the job whose line counts the household copies held at their send time. */
export const DEBOUNCE_HELD_JOB = 'notificationDebounceSweep';

/**
 * Drains the due rows of `pendingNotifications` at `now`. Exported for the
 * tests; the cron below is its only caller.
 *
 * #2478: a household copy is asked about "Send notices to households" again
 * here, at its send time (`notifications/queuedCopyHold.ts`). Off, it comes off
 * the queue and is never sent later, and the run writes one line with the
 * count. Unreadable, it stays queued for the next tick. Today every debounced
 * key (`pets.updated`, `profile.updated`) goes to the office only, so this
 * holds nothing yet; it is here so the next household key cannot slip past.
 */
export async function drainPendingNotifications(
  now: number,
): Promise<{ promoted: number; held: number; skipped: number }> {
  const snap = await db()
    .collection('pendingNotifications')
    .where('fireAfterMs', '<=', now)
    .limit(SCAN_LIMIT)
    .get();
  if (snap.empty) return { promoted: 0, held: 0, skipped: 0 };

  let promoted = 0;
  let held = 0;
  let skipped = 0;
  const { queuedCopyVerdict, startQueuedCopyGate }: typeof QueuedCopyHold = await import(
    '../notifications/queuedCopyHold.js'
  );
  const gate = startQueuedCopyGate();
  await withHeldNoticeBatch(DEBOUNCE_HELD_JOB, { atMs: now, final: true }, async (heldBatch) => {
    for (const doc of snap.docs) {
      const data = doc.data() as Record<string, unknown>;
      const key = typeof data.key === 'string' ? data.key : '';
      const verdict = key === '' ? 'send' : await queuedCopyVerdict(key, data.stream, gate);
      if (verdict === 'skip') {
        skipped += 1;
        continue;
      }
      try {
        const done = await db().runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return false;
          if (verdict === 'send') {
            promoteQueuedNotification(tx, data, {
              mode: 'debounced-promoted',
              origin: { originPendingId: doc.id },
            });
          }
          tx.delete(doc.ref);
          return true;
        });
        if (!done) continue;
        if (verdict === 'hold') {
          held += 1;
          countHeldNotice(heldBatch, key, 'off', [key, `pending:${doc.id}`].join('\u0000'));
        } else {
          promoted += 1;
        }
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'notificationDebounceSweep',
          event: verdict === 'hold' ? 'debounce.hold.failed' : 'debounce.promote.failed',
          extra: { pendingId: doc.id, error: (err as Error)?.message },
        });
      }
    }
  });

  logEvent({
    severity: 'info',
    function: 'notificationDebounceSweep',
    event: 'debounce.sweep.complete',
    extra: { scanned: snap.size, promoted, held, skipped },
  });
  return { promoted, held, skipped };
}

export const notificationDebounceSweep = onSchedule(
  // Runs every minute and dispatches. The default 60s timeout leaves no room
  // to run 4x slower on a quarter vCPU, and a run can overlap the next tick.
  {
    schedule: 'every 1 minutes',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
    ...SCHEDULE_RETRY_FREQUENT,
  },
  wrapScheduled('notificationDebounceSweep', async () => {
    await drainPendingNotifications(Date.now());
  }),
);
