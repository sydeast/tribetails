import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../lib/firestoreAdmin';
import { wrapTrigger } from '../../lib/wrapTrigger';
import type { Channel } from '../types';

/**
 * Fans out a freshly-written `notifications/{id}` doc into per-channel subdocs
 * `notifications/{id}/channels/{channel}` with status='pending'. Each channel
 * subdoc is then processed independently by onNotificationChannelCreate, so a
 * failure in one channel does not block the others.
 */
export const onNotificationCreate = onDocumentCreated(
  { document: 'notifications/{id}', secrets: ['SENTRY_DSN'] },
  wrapTrigger('onNotificationCreate', async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() as { channels?: Channel[]; status?: string } | undefined;
    if (!data) return;
    if (data.status !== 'pending') return;
    const channels = data.channels ?? [];
    if (channels.length === 0) {
      await snap.ref.set({ status: 'no-channels', completedAt: FieldValue.serverTimestamp() }, { merge: true });
      return;
    }

    const batch = db().batch();
    for (const ch of channels) {
      const ref = snap.ref.collection('channels').doc(ch);
      batch.set(ref, {
        channel: ch,
        status: 'pending',
        attempts: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    batch.update(snap.ref, { status: 'dispatched', dispatchedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }),
);
