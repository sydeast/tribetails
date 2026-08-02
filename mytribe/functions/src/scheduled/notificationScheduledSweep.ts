import { onSchedule } from 'firebase-functions/v2/scheduler';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapScheduled } from '../lib/wrapScheduled';
import { FULL_CPU_SERIAL } from '../lib/runtimeOptions';

/**
 * Drains `scheduledNotifications/{auto}` docs whose `fireAtMs` has elapsed.
 *
 * Each due doc is promoted to a fresh `notifications/{id}` doc with
 * mode='scheduled-promoted' + status='pending', then deleted.
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
          const newRef = db().collection('notifications').doc();
          tx.set(newRef, {
            key: data.key,
            category: data.category,
            recipientUid: data.recipientUid,
            actorUid: data.actorUid ?? null,
            data: data.data ?? {},
            channels: data.channels ?? [],
            status: 'pending',
            mode: 'scheduled-promoted',
            originScheduledId: doc.id,
            scheduledFireAtMs: data.fireAtMs ?? null,
            createdAt: FieldValue.serverTimestamp(),
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
