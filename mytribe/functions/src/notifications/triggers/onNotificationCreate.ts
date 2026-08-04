import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../../lib/firestoreAdmin';
import { wrapTrigger } from '../../lib/wrapTrigger';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';
import type { Channel } from '../types';

/**
 * Fans out a freshly-written `notificationDispatch/{id}` WORK ORDER into
 * per-channel subdocs `notificationDispatch/{id}/channels/{channel}` with
 * status='pending'. Each channel subdoc is then processed independently by
 * onNotificationChannelCreate, so a failure in one channel does not block the
 * others.
 *
 * IT USED TO WATCH `notifications/{id}` AND STAMP THAT DOCUMENT (operator ruling
 * R5, 2026-08-03). The fan-out wrote `status: 'dispatched'` + `dispatchedAt`
 * onto the notification and hung a `channels` subcollection off it, which is how
 * pipeline state ended up rendered as card content in both admin clients. The
 * notification is mail; this is the postman's route sheet. They are now two
 * documents (see `DISPATCH_COLLECTION` in dispatcher.ts) and only this one
 * carries workflow.
 *
 * THE EXPORT NAME IS DELIBERATELY UNCHANGED even though the path moved, and that
 * is a deployment decision, not an oversight. A v2 Firestore trigger is
 * identified to Firebase by its export name; renaming it to
 * `onNotificationDispatchCreate` would deploy a NEW function and leave the old
 * `onNotificationCreate` live on `notifications/{id}` until a separate delete
 * ran, so for that window every dispatch would be fanned out twice and the old
 * code would keep stamping `status`/`dispatchedAt` back onto the very documents
 * this change cleans. Keeping the name repoints the existing trigger in place,
 * atomically, with no such window.
 *
 * WHAT THE PIPELINE DID IS NOT LOST, IT MOVED TO THE RIGHT PLACE. This writes
 * NOTIFICATION_DISPATCHED into the hash-chained `activity_log` naming the key,
 * the mode and the channels chosen. That is the operator's own instruction:
 * "Channels, trigger, and dispatched are activity log not notification."
 */

/**
 * The fan-out body, exported separately from the CloudFunction wrapper so it is
 * unit-testable without a real Firestore CloudEvent (the `...Handler` convention
 * onNotificationChannelCreate already uses).
 */
export async function onNotificationDispatchCreateHandler(event: any): Promise<void> {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() as
      | {
          notificationId?: string;
          key?: string;
          recipientUid?: string;
          channels?: Channel[];
          mode?: string;
          status?: string;
        }
      | undefined;
    if (!data) return;
    if (data.status !== 'pending') return;

    const notificationId = data.notificationId ?? snap.ref.id;
    const channels = data.channels ?? [];
    if (channels.length === 0) {
      await snap.ref.set(
        { status: 'no-channels', completedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
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

    // The workflow record, in the Activity Log where it belongs. Targeted at the
    // NOTIFICATION (not the work order) so the audit trail's Target column keeps
    // pointing at the thing an operator can actually go and look at, matching
    // the NOTIFICATION_RECEIVED entry the channel trigger writes moments later.
    await writeAuditEntry({
      status: 'SUCCESS',
      event: AUDIT_EVENTS.NOTIFICATION_DISPATCHED,
      severity: 'info',
      actorRole: 'SYSTEM',
      targetUid: notificationId,
      targetCollection: 'notifications',
      description: `Notification ${data.key ?? '(unknown key)'} dispatched to ${channels.join(', ')}`,
      payload: {
        notificationId,
        key: data.key ?? '',
        mode: data.mode ?? '',
        channels,
        recipientUid: data.recipientUid ?? '',
      },
    }).catch(() => {
      // Non-fatal: the fan-out already committed and the channel subdocs are
      // live. wrapTrigger's Sentry hook records the audit exception separately;
      // throwing here would retry a fan-out that has already happened.
    });
}

export const onNotificationCreate = onDocumentCreated(
  { document: 'notificationDispatch/{id}', secrets: ['SENTRY_DSN'] },
  wrapTrigger('onNotificationCreate', onNotificationDispatchCreateHandler),
);
