import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isOwner, staffBypass } from '../lib/staffGate';

/**
 * Marks a notification as viewed by its recipient. Writes `readAt` +
 * `viewedAt` server timestamps to `notifications/{id}` and emits a
 * NOTIFICATION_VIEWED audit entry so admins can see exactly which catalog
 * messages have been read.
 *
 * Security: only the recipient (or an admin) may mark a notification read.
 * The caller's uid must match `recipientUid` on the parent doc.
 */
const Args = z.object({
  notificationId: z.string().min(1).max(200),
});

export async function markNotificationReadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  // #944: allowlisted - her own inbox.
  const isAdmin = staffBypass(req.auth, 'markNotificationRead');
  const args = Args.parse(req.data);

  const ref = db().collection('notifications').doc(args.notificationId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Notification not found.');
  }
  const data = snap.data() as { recipientUid?: string; key?: string } | undefined;
  if (!data?.recipientUid) {
    throw new HttpsError('failed-precondition', 'Notification has no recipientUid.');
  }
  if (!isAdmin && data.recipientUid !== uid) {
    throw new HttpsError('permission-denied', 'Not your notification.');
  }

  await ref.set(
    {
      readAt: FieldValue.serverTimestamp(),
      viewedAt: FieldValue.serverTimestamp(),
      viewedByUid: uid,
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'markNotificationRead',
    event: 'notifications.marked.read',
    uid,
    extra: { notificationId: args.notificationId, key: data.key },
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATION_VIEWED,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    // Audit target is the notification doc; recipientUid moved into payload
    // so the canonical Activity Log "Target" column points to the notification.
    targetUid: args.notificationId,
    targetCollection: 'notifications',
    description: `Notification ${data.key ?? args.notificationId} viewed`,
    payload: { notificationId: args.notificationId, key: data.key, viewedBy: uid, recipientUid: data.recipientUid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'markNotificationRead',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true };
}

export const markNotificationRead = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('markNotificationRead', markNotificationReadHandler),
);

/**
 * Inverse of markNotificationRead: clears the read markers so the notification
 * shows as unread again. Same recipient-or-admin guard. Backs the read/unread
 * toggle quick-action.
 */
export async function markNotificationUnreadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isOwner(uid, req.auth?.token?.admin === true || req.auth?.token?.role === 'admin', 'markNotificationUnread');
  const args = Args.parse(req.data);

  const ref = db().collection('notifications').doc(args.notificationId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Notification not found.');
  }
  const data = snap.data() as { recipientUid?: string; key?: string } | undefined;
  if (!data?.recipientUid) {
    throw new HttpsError('failed-precondition', 'Notification has no recipientUid.');
  }
  if (!isAdmin && data.recipientUid !== uid) {
    throw new HttpsError('permission-denied', 'Not your notification.');
  }

  await ref.set(
    {
      readAt: FieldValue.delete(),
      viewedAt: FieldValue.delete(),
      viewedByUid: FieldValue.delete(),
    },
    { merge: true },
  );

  logEvent({
    severity: 'info',
    function: 'markNotificationUnread',
    event: 'notifications.marked.unread',
    uid,
    extra: { notificationId: args.notificationId, key: data.key },
  });

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATION_VIEWED,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetUid: args.notificationId,
    targetCollection: 'notifications',
    description: `Notification ${data.key ?? args.notificationId} marked unread`,
    payload: { notificationId: args.notificationId, key: data.key, unreadBy: uid, recipientUid: data.recipientUid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'markNotificationUnread',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  return { ok: true };
}

export const markNotificationUnread = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('markNotificationUnread', markNotificationUnreadHandler),
);
