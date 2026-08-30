import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../../lib/firestoreAdmin';
import { initSentry } from '../../lib/sentry';
import { logEvent } from '../../lib/logger';
import { wrapAdminCallable } from '../../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../../lib/cors';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';
import { GOOGLE_OAUTH_SECRETS } from '../../lib/googleOAuth';
import {
  SESSIONS_COLLECTION,
  VisitSyncAction,
  requireWritableConnection,
  syncVisitBySessionId,
} from '../../lib/googleCalendarVisitSync';
import { readFreeBusyCalendarId } from './googleCalendarAccount';

/**
 * One visit, brought into line with the operator's Google calendar (issue
 * #397). The RETRY path, and the manual one.
 *
 * ONE CALLABLE, NOT THREE. There is no `createCalendarEvent`,
 * `updateCalendarEvent`, `deleteCalendarEvent` triple, and their absence is the
 * design rather than a cut. Create, update and delete are all reachable here —
 * this callable performs whichever of them the visit's stored state calls for —
 * but a client is never the one that decides which. A caller who could say
 * "delete" could delete the event for a visit that is still happening, and a
 * caller who could say "create" could put a second copy of an existing visit on
 * the calendar. The session row already knows whether the visit is cancelled
 * and whether we have written it before; that is the whole decision, and it
 * belongs on the server where the row is.
 *
 * That also makes the callable IDEMPOTENT, which is what a retry button needs.
 * Pressing it twice on the same visit produces one event and two updates, never
 * two events.
 *
 * WHY IT EXISTS WHEN THE TRIGGER IS AUTOMATIC. A trigger's failure has no
 * caller to report to, so its recovery has to be somebody's deliberate act.
 * This is that act: the operator sees a visit stamped with a sync error, and
 * presses the thing that tries it again. Without it, the only recovery would be
 * to edit the visit into re-triggering itself, which is asking an operator to
 * fake a change to a real booking to work around our plumbing.
 */

/**
 * Frozen in `test/callableContract.test.ts`.
 *
 * ONE KEY, AND IT MUST STAY ONE. No calendar id (the operator's chosen target
 * is resolved server-side, so a client cannot aim a household's visit at a
 * calendar the operator never picked) and no action (see above). `min(1)`
 * rejects the empty string, which would otherwise resolve to a document path of
 * `kin_care_sessions/` and throw a Firestore argument error instead of a
 * readable one; `max(1500)` is Firestore's own document-id ceiling.
 */
export const Args = z
  .object({
    sessionId: z.string().trim().min(1).max(1500),
  })
  .strict();

export interface SyncVisitResult {
  sessionId: string;
  /** What was actually done at Google. */
  action: VisitSyncAction;
  /** The event id after the action. Empty after a delete, and after a skip that never wrote. */
  eventId: string;
  /** Why nothing was written. Empty unless `action` is `skipped`. */
  reason: string;
  syncedAt: string;
}

export async function syncVisitToGoogleCalendarHandler(
  req: CallableRequest<unknown>,
): Promise<SyncVisitResult> {
  initSentry();
  const uid = req.auth?.uid;
  // defense-in-depth; wrapAdminCallable already enforces admin.
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = Args.safeParse(req.data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'sessionId is required and must be a visit id.');
  }
  const { sessionId } = parsed.data;

  // Refuses a dead connection and the echo-loop calendar BEFORE any Google
  // call, with the same `details.code`s the panels already branch on.
  const freeBusyCalendarId = await readFreeBusyCalendarId(db());
  const connection = await requireWritableConnection(db(), freeBusyCalendarId);

  const outcome = await syncVisitBySessionId(
    db(),
    connection,
    sessionId,
    new Date().toISOString(),
  );

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.INTEGRATION_CALENDAR_PUSH,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SESSIONS_COLLECTION,
    description: `Synced visit ${sessionId} to Google Calendar (${outcome.action})`,
    payload: {
      sessionId,
      action: outcome.action,
      writeCalendarId: connection.writeCalendarId,
      reason: outcome.reason,
    },
  });

  logEvent({
    severity: 'info',
    function: 'syncVisitToGoogleCalendar',
    event: 'gcal.visit.sync',
    uid,
    extra: { sessionId, action: outcome.action },
  });

  return {
    sessionId: outcome.sessionId,
    action: outcome.action,
    eventId: outcome.eventId,
    reason: outcome.reason,
    syncedAt: outcome.syncedAt,
  };
}

export const syncVisitToGoogleCalendar = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('syncVisitToGoogleCalendar', syncVisitToGoogleCalendarHandler),
);
