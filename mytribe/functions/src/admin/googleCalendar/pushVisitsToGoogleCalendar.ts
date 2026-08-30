import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../../lib/firestoreAdmin';
import { initSentry } from '../../lib/sentry';
import { logEvent } from '../../lib/logger';
import { wrapAdminCallable } from '../../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../../lib/cors';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';
import { GOOGLE_OAUTH_SECRETS, calendarClientForRefreshToken } from '../../lib/googleOAuth';
import { GOOGLE_CALENDAR_DOC_PATH, calendarPushStamp } from '../../lib/googleCalendarConnection';
import {
  SESSIONS_COLLECTION,
  applyVisitToCalendar,
  errorText,
  requireWritableConnection,
  sessionFromDoc,
  sessionSyncOkFields,
} from '../../lib/googleCalendarVisitSync';
import { readFreeBusyCalendarId } from './googleCalendarAccount';

/**
 * Writing upcoming visits onto the operator's chosen Google calendar
 * (Task 7.2). This is the half that makes the calendars EDITABLE; Task 7.1 only
 * ever read free/busy back the other way.
 *
 * ── THIS IS NO LONGER THE ONLY WAY VISITS REACH THE CALENDAR (issue #397) ──
 *
 * This file used to open with a flat refusal to build a trigger, on two
 * grounds. Both were real, and both are now answered structurally by
 * `triggers/onKinCareSessionCalendarSync.ts`, so the refusal is retired rather
 * than merely overruled:
 *
 *   - "It would start writing to a real person's calendar while the operator
 *     was still deciding which calendar to point it at." The trigger writes
 *     nothing until `writeCalendarId` is set, and that field is set by one
 *     deliberate act: the operator picking a calendar from a list in Settings.
 *     Picking the calendar IS the consent, and until it is picked the trigger
 *     returns before it ever builds a client.
 *   - "It would fire once per field change." The trigger compares
 *     CALENDAR_RELEVANT_FIELDS across the write and returns when none of them
 *     moved, so an invoice link, a clock-in stamp or a do-not-invoice flag costs
 *     one document read and no Google call.
 *
 * What that leaves this callable is the job it is genuinely better at: a bulk
 * catch-up over a window. It is the reconciliation pass for visits that changed
 * while nothing was connected, for a calendar that was swapped, and for
 * anything a failed trigger left behind. Both paths run the SAME decision table
 * (`applyVisitToCalendar` in `lib/googleCalendarVisitSync.ts`), because a bulk
 * push and a lifecycle sync disagreeing about one visit would produce a
 * calendar that is subtly wrong rather than obviously broken.
 *
 * FOUR TRAPS IN `kin_care_sessions`, all silent:
 *   - `startTime` IS AN ISO STRING, not a Timestamp. Firestore orders every
 *     timestamp after every string, so a Timestamp bound returns nothing and
 *     does not error. The window is a LEXICAL range, which works because the
 *     format is ISO.
 *   - `status` CASING IS UNENFORCED, so it is filtered in memory. A server
 *     equality would invisibly drop every visit stored in the other case.
 *   - `endTime` IS NOT ALWAYS THERE. A session with neither an end nor a
 *     duration is SKIPPED and reported, never given an invented hour.
 *   - CANCELLED VISITS ARE PUSHED AS DELETIONS, not skipped, when we have
 *     already put them on the calendar.
 *
 * THE ECHO LOOP IS REFUSED, NOT DETECTED. If the write target were the calendar
 * the free/busy sync imports FROM, every visit pushed would come back as an
 * imported BLOCKED slot over its own hour. See `lib/googleCalendarTargets.ts`.
 */

/** Frozen in `test/callableContract.test.ts`. */
export const Args = z
  .object({
    lookAheadDays: z.number().int().optional(),
  })
  .strict();

/**
 * Re-exported so the one decision table has one home while every existing
 * importer and test keeps its import path. See `lib/googleCalendarVisitSync.ts`.
 */
export {
  buildEventBody,
  isCancelled,
  googleStatus,
  resolveEndTime,
  sessionFromDoc,
  type CalendarEventBody,
  type SessionLike,
} from '../../lib/googleCalendarVisitSync';

/** Same 1..90 clamp and same 30-day default as the free/busy sync, so the two windows agree. */
export function clampLookAheadDays(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(raw)));
}

export interface PushSkip {
  sessionId: string;
  reason: string;
}

export interface PushResult {
  /** Events created or updated. */
  pushed: number;
  /** Events removed because the visit was cancelled. */
  removed: number;
  /** Sessions read before filtering. An empty result over 40 scanned rows means something. */
  scanned: number;
  skipped: PushSkip[];
  /** The stamp's timestamp, so a client renders the receipt without re-reading. */
  ranAt: string;
}

export async function pushVisitsToGoogleCalendarHandler(
  req: CallableRequest<unknown>,
): Promise<PushResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const parsed = Args.safeParse(req.data ?? {});
  if (!parsed.success) {
    throw new HttpsError('invalid-argument', 'lookAheadDays must be a whole number.');
  }
  const lookAheadDays = clampLookAheadDays(parsed.data.lookAheadDays);

  // Resolved BEFORE the try below, exactly as the free/busy sync resolves its
  // calendar id outside its own: with nothing connected there is no doc worth
  // stamping a failure onto, and the panel already says "not connected".
  const freeBusyCalendarId = await readFreeBusyCalendarId(db());
  const connection = await requireWritableConnection(db(), freeBusyCalendarId);

  try {
    return await runPush(connection.refreshToken, connection.writeCalendarId, lookAheadDays, uid);
  } catch (err) {
    // Every failure past this point is stamped before it is rethrown, so the
    // panel still says what went wrong after a reload. Best-effort: if the
    // stamp itself fails, the ORIGINAL error is the one worth surfacing.
    await stampPush(
      calendarPushStamp({ status: 'error', error: errorText(err) }, new Date().toISOString()),
      uid,
    );
    throw err;
  }
}

async function runPush(
  refreshToken: string,
  writeCalendarId: string,
  lookAheadDays: number,
  uid: string,
): Promise<PushResult> {
  const now = new Date();
  const fromIso = now.toISOString();
  const toIso = new Date(now.getTime() + lookAheadDays * 24 * 60 * 60 * 1000).toISOString();

  // LEXICAL range on an ISO string; see trap 1.
  const snap = await db()
    .collection(SESSIONS_COLLECTION)
    .where('startTime', '>=', fromIso)
    .where('startTime', '<', toIso)
    .orderBy('startTime')
    .limit(500)
    .get();

  const calendar = await calendarClientForRefreshToken(refreshToken);
  const skipped: PushSkip[] = [];
  let pushed = 0;
  let removed = 0;

  for (const doc of snap.docs) {
    const session = sessionFromDoc(doc.id, doc.data() as Record<string, unknown>);
    const nowIso = new Date().toISOString();

    // `invalid_grant` and any Google failure that is not "already gone"
    // propagate, exactly as before: one dead connection is not 500
    // individually-reported skips.
    const outcome = await applyVisitToCalendar(calendar, writeCalendarId, session, nowIso);

    if (outcome.action === 'skipped') {
      // A skip changed nothing on Google, so the stored event id must not be
      // disturbed: only the reason is reported, and only in the response.
      skipped.push({ sessionId: session.id, reason: outcome.reason });
      continue;
    }

    await doc.ref.set(
      sessionSyncOkFields(outcome.action, outcome.eventId, writeCalendarId, nowIso),
      { merge: true },
    );
    if (outcome.action === 'deleted') removed += 1;
    else pushed += 1;
  }

  const stamp = calendarPushStamp({ status: 'ok', pushed }, new Date().toISOString());
  await stampPush(stamp, uid);

  await writeAuditEntry({
    status: 'SUCCESS',
    event: AUDIT_EVENTS.INTEGRATION_CALENDAR_PUSH,
    severity: 'info',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetCollection: SESSIONS_COLLECTION,
    description: `Pushed ${pushed} visits to Google Calendar`,
    payload: { pushed, removed, skipped: skipped.length, lookAheadDays, writeCalendarId },
  });

  logEvent({
    severity: 'info',
    function: 'pushVisitsToGoogleCalendar',
    event: 'gcal.push.complete',
    uid,
    extra: { pushed, removed, scanned: snap.docs.length, skipped: skipped.length },
  });

  return { pushed, removed, scanned: snap.docs.length, skipped, ranAt: stamp.calendarPushLastRunAt };
}

async function stampPush(stamp: ReturnType<typeof calendarPushStamp>, uid: string): Promise<void> {
  try {
    await db().doc(GOOGLE_CALENDAR_DOC_PATH).set(stamp, { merge: true });
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'pushVisitsToGoogleCalendar',
      event: 'gcal.push.stamp_failed',
      uid,
      extra: { reason: errorText(err) },
    });
  }
}

export const pushVisitsToGoogleCalendar = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('pushVisitsToGoogleCalendar', pushVisitsToGoogleCalendarHandler),
);
