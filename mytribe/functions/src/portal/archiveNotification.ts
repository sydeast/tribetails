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
    status: 'SUCCESS',
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
    status: 'SUCCESS',
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

// ─────────────────────────── restore (the way back) ───────────────────────────

/**
 * THE INVERSE, AND WHY IT HAD TO EXIST.
 *
 * Until now `archivedAt` could only ever be stamped. No callable cleared it, no
 * client listed archived rows, and the admin's feed hides them outright, so
 * "Archive" was a one-way door: an operator who filed the wrong row away had no
 * way back to it from any surface. That is the same failure the Invoices screen
 * refuses by construction (`unarchiveInvoice`, plus a three-state archive facet
 * so an archived invoice can still be found), and there is no reason a
 * notification should be the harder thing to undo.
 *
 * WRITES `archivedAt: null` RATHER THAN DELETING THE FIELD, matching
 * `unarchiveInvoice` for a reason that is about queries, not tidiness:
 * Firestore's `== null` matches only documents that HAVE the field, so a
 * restored doc that carries an explicit null is the shape a future server-side
 * "active only" predicate could actually use, while a deleted field is
 * unreachable by any predicate. It diverges from `markNotificationUnread`
 * next door, which DOES delete `readAt`; that field has no such predicate in
 * its future and is documented as absent-on-the-wire.
 *
 * BOTH CLIENTS ALREADY READ NULL AS "NOT ARCHIVED". Android's
 * `NotificationEntry.archivedAt` is a `String?` filtered with `isNullOrBlank()`,
 * and the React admin reads it through one `isNotificationArchived` predicate
 * that treats absent and null alike. Neither needed a change to make a restored
 * row reappear, which is what makes the null safe rather than merely tidy.
 *
 * `archivedByUid` is deliberately left ON the document. It records who filed the
 * row away, which stays true after a restore, and clearing it would erase the
 * only trace on the doc itself that an archive ever happened.
 *
 * Gate, skip rule and counting are identical to the archive pair above, so a
 * partially-stale client selection restores everything it legitimately can and
 * reports the real number.
 */
const UnarchiveArgs = z.object({
  id: z.string().min(1).max(200),
});

export async function unarchiveNotificationHandler(
  req: CallableRequest<unknown>,
): Promise<{ unarchived: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isAdminReq(req, 'unarchiveNotification');

  let args: z.infer<typeof UnarchiveArgs>;
  try {
    args = UnarchiveArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'unarchiveNotification validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  let unarchived = 0;
  const ref = db().collection('notifications').doc(args.id);
  const snap = await ref.get();
  const data = snap.exists
    ? (snap.data() as { recipientUid?: string; key?: string } | undefined)
    : undefined;
  if (data?.recipientUid && (isAdmin || data.recipientUid === uid)) {
    await ref.set({ archivedAt: null }, { merge: true });
    unarchived = 1;
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATIONS_UNARCHIVE,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetUid: args.id,
    targetCollection: 'notifications',
    description: `Notification ${data?.key ?? args.id} restored to the active inbox`,
    payload: { notificationId: args.id, key: data?.key, unarchived, restoredBy: uid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'unarchiveNotification',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'unarchiveNotification',
    event: 'notifications.unarchived',
    uid,
    extra: { notificationId: args.id, unarchived },
  });

  return { unarchived };
}

export const unarchiveNotification = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('unarchiveNotification', unarchiveNotificationHandler),
);

const BulkUnarchiveArgs = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(200),
});

export async function bulkUnarchiveNotificationsHandler(
  req: CallableRequest<unknown>,
): Promise<{ unarchived: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isAdminReq(req, 'bulkUnarchiveNotifications');

  let args: z.infer<typeof BulkUnarchiveArgs>;
  try {
    args = BulkUnarchiveArgs.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'bulkUnarchiveNotifications validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const requestedIds = Array.from(new Set(args.ids));
  let unarchived = 0;

  for (const id of requestedIds) {
    const ref = db().collection('notifications').doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() as { recipientUid?: string } | undefined;
    if (!data?.recipientUid) continue;
    if (!isAdmin && data.recipientUid !== uid) continue;

    await ref.set({ archivedAt: null }, { merge: true });
    unarchived += 1;
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATIONS_UNARCHIVE,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetCollection: 'notifications',
    description: `Bulk restored ${unarchived} of ${requestedIds.length} notification(s)`,
    payload: { requested: requestedIds.length, unarchived, restoredBy: uid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'bulkUnarchiveNotifications',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'bulkUnarchiveNotifications',
    event: 'notifications.bulk.unarchived',
    uid,
    extra: { requested: requestedIds.length, unarchived },
  });

  return { unarchived };
}

export const bulkUnarchiveNotifications = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('bulkUnarchiveNotifications', bulkUnarchiveNotificationsHandler),
);
