import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db } from '../lib/firestoreAdmin';
import { wrapScheduled } from '../lib/wrapScheduled';

export const rotateOldFcmTokens = onSchedule(
  { schedule: 'every monday 04:00', timeZone: 'America/New_York', secrets: ['SENTRY_DSN'] },
  wrapScheduled('rotateOldFcmTokens', async () => {
    const cutoff = new Date(Date.now() - 60 * 86400 * 1000);
    const snap = await db().collection('fcmTokens').where('updatedAt', '<', cutoff).limit(500).get();
    for (const d of snap.docs) await d.ref.delete();
  }),
);
