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
 * Stage 2 tail: mark MANY notifications read at once. The companion to the
 * single markNotificationRead callable; reuses the exact same read-field
 * semantics it writes (`readAt` + `viewedAt` server timestamps + `viewedByUid`)
 * and the same recipient guard: a caller may only mark notifications whose
 * `recipientUid` is the caller (admins may mark any, matching markNotificationRead).
 *
 * Notifications live in the flat top-level `notifications` collection keyed by
 * doc id with a `recipientUid` field.
 *
 * Per-id outcomes are not aborted on a single bad id: ids that are missing or
 * belong to another recipient are simply skipped (not counted in `marked`), so
 * a partially-stale client list still marks everything it legitimately can.
 */
const Args = z.object({
  ids: z.array(z.string().min(1).max(200)).min(1).max(200),
});

export async function bulkMarkNotificationsReadHandler(
  req: CallableRequest<unknown>,
): Promise<{ ok: true; marked: number }> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const isAdmin = isStaff(uid, req.auth?.token?.admin === true || req.auth?.token?.role === 'admin', 'bulkMarkNotificationsRead');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'bulkMarkNotificationsRead validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const requestedIds = Array.from(new Set(args.ids));
  let marked = 0;

  for (const id of requestedIds) {
    const ref = db().collection('notifications').doc(id);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const data = snap.data() as { recipientUid?: string } | undefined;
    if (!data?.recipientUid) continue;
    if (!isAdmin && data.recipientUid !== uid) continue;

    await ref.set(
      {
        readAt: FieldValue.serverTimestamp(),
        viewedAt: FieldValue.serverTimestamp(),
        viewedByUid: uid,
      },
      { merge: true },
    );
    marked += 1;
  }

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.NOTIFICATIONS_BULK_READ,
    severity: 'info',
    actorRole: isAdmin ? 'AUNTIE' : 'PRIMARY',
    actorUid: uid,
    targetCollection: 'notifications',
    description: `Bulk marked ${marked} of ${requestedIds.length} notification(s) read`,
    payload: { requested: requestedIds.length, marked, viewedBy: uid },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'bulkMarkNotificationsRead',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'bulkMarkNotificationsRead',
    event: 'notifications.bulk.marked.read',
    uid,
    extra: { requested: requestedIds.length, marked },
  });

  return { ok: true, marked };
}

export const bulkMarkNotificationsRead = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'] },
  wrapCallable('bulkMarkNotificationsRead', bulkMarkNotificationsReadHandler),
);
