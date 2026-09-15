import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { promoteQueuedNotification } from '../notifications/promoteQueued';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';
import { sweepPendingCreditNotices } from '../lib/accountCredit';

/**
 * Drains `scheduledNotifications/{auto}` docs whose `fireAtMs` has elapsed.
 *
 * Each due doc is promoted to a fresh `notifications/{id}` inbox doc plus its
 * id-matched `notificationDispatch/{id}` work order carrying
 * mode='scheduled-promoted' + status='pending', then deleted. Both documents
 * come from `promoteQueuedNotification`, which also carries forward the title,
 * description, actor and deep-link target this sweep used to drop.
 *
 * Runs every 5 minutes, 5-minute resolution is acceptable for the
 * notifications that use scheduled mode (invoice reminders, upcoming
 * KinCare reminders, newsletter sends). Tighter cadence increases cost
 * without practical benefit.
 */
const SCAN_LIMIT = 200;

export const notificationScheduledSweep = onSchedule(
  // Dispatches due notifications inside the default 60s timeout. See
  // notificationDebounceSweep.
  {
    schedule: 'every 5 minutes',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
    ...FULL_CPU_SERIAL,
  },
  wrapScheduled('notificationScheduledSweep', async () => {
    const now = Date.now();
    // #884: account credit payment notices whose delivery never went out (a
    // crash after the draw's commit, and no redelivered pass). Runs before the
    // queue drain, and its own failure never blocks it.
    try {
      const resent = await sweepPendingCreditNotices(db(), now);
      if (resent > 0) {
        logEvent({
          severity: 'info',
          function: 'notificationScheduledSweep',
          event: 'credit.notice.resent',
          extra: { resent },
        });
      }
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'notificationScheduledSweep',
        event: 'credit.notice.sweep.failed',
        extra: { error: (err as Error)?.message },
      });
    }
    const snap = await db()
      .collection('scheduledNotifications')
      .where('fireAtMs', '<=', now)
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
            mode: 'scheduled-promoted',
            origin: {
              originScheduledId: doc.id,
              scheduledFireAtMs: data.fireAtMs ?? null,
            },
          });
          tx.delete(doc.ref);
        });
        promoted += 1;
      } catch (err) {
        logEvent({
          severity: 'warn',
          function: 'notificationScheduledSweep',
          event: 'scheduled.promote.failed',
          extra: { scheduledId: doc.id, error: (err as Error)?.message },
        });
      }
    }

    logEvent({
      severity: 'info',
      function: 'notificationScheduledSweep',
      event: 'scheduled.sweep.complete',
      extra: { scanned: snap.size, promoted },
    });
  }),
);
