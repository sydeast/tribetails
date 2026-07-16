import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapCallable } from '../lib/wrapCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { TRIBETAILS_CORS } from '../lib/cors';
import { isStaff } from '../lib/staffGate';

/**
 * Archive notification(s) out of the active inbox.
 *
 * Notifications live in the flat top-level `notifications` collection keyed by
 * doc id with a `recipientUid` field. The dispatcher writes NO `archivedAt`
 * field, these callables add it (server timestamp) so the client can split the
 * inbox into active vs archived without deleting anything.
 *
 * Security mirrors markNotificationRead / bulkMarkNotificationsRead exactly:
 * a caller may only archive notifications whose `recipientUid` is the caller;
 * admins (admin claim or role) may archive any. Missing ids, docs with no
 * `recipientUid`, and other-recipient docs are skipped (not counted, no write),
 * so a partially-stale client list still archives everything it legitimately
 * can.
 */

function isAdminReq(req: CallableRequest<unknown>, functionName: string): boolean {
  const claim = req.auth?.token?.admin === true || req.auth?.token?.role === 'admin';
  return isStaff(req.auth?.uid, claim, functionName);
}

// ───────────────────────────── single ─────────────────────────────
const ArchiveArgs = z.object({
  id: z.string().min(1).max(200),
});

export async function archiveNotificationHandler(
  req: CallableRequest<unknown>,
): Promise<{ archived: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isAdminReq(req, 'archiveNotification');

  let args: z.infer<typeof ArchiveArgs>;
  try {
    args = ArchiveArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'archiveNotification validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  let archived = 0;
  const ref = db().collection('notifications').doc(args.id);
  const snap = await ref.get();
  const data = snap.exists ? (snap.data() as { recipientUid?: string; key?: string } | undefined) : undefined;
  if (data?.recipientUid && (isAdmin || data.recipientUid === uid)) {
    await ref.set({ archivedAt: FieldValue.serverTimestamp(), archivedByUid: uid }, { merge: true });
    archived = 1;
  }

  await writeAuditEntry({
    event: AUDIT_EVENTS.NOTIFICATIONS_ARCHIVE,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetUid: args.id,
    targetCollection: 'notifications',
    description: `Notification ${data?.key ?? args.id} archived`,
    payload: { notificationId: args.id, key: data?.key, archived, archivedBy: uid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'archiveNotification',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'archiveNotification',
    event: 'notifications.archived',
    uid,
    extra: { notificationId: args.id, archived },
  });

  return { archived };
}

export const archiveNotification = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('archiveNotification', archiveNotificationHandler),
);

// ───────────────────────────── bulk ─────────────────────────────
const BulkArchiveArgs = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(200),
});

export async function bulkArchiveNotificationsHandler(
  req: CallableRequest<unknown>,
): Promise<{ archived: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isAdminReq(req, 'bulkArchiveNotifications');

  let args: z.infer<typeof BulkArchiveArgs>;
  try {
    args = BulkArchiveArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'bulkArchiveNotifications validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const requestedIds = Array.from(new Set(args.ids));
  let archived = 0;

  for (const id of requestedIds) {
    const ref = db().collection('notifications').doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() as { recipientUid?: string } | undefined;
    if (!data?.recipientUid) continue;
    if (!isAdmin && data.recipientUid !== uid) continue;

    await ref.set({ archivedAt: FieldValue.serverTimestamp(), archivedByUid: uid }, { merge: true });
    archived += 1;
  }

  await writeAuditEntry({
    event: AUDIT_EVENTS.NOTIFICATIONS_ARCHIVE,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetCollection: 'notifications',
    description: `Bulk archived ${archived} of ${requestedIds.length} notification(s)`,
    payload: { requested: requestedIds.length, archived, archivedBy: uid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'bulkArchiveNotifications',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'bulkArchiveNotifications',
    event: 'notifications.bulk.archived',
    uid,
    extra: { requested: requestedIds.length, archived },
  });

  return { archived };
}

export const bulkArchiveNotifications = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('bulkArchiveNotifications', bulkArchiveNotificationsHandler),
);
