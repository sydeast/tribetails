import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { db } from '../../lib/firestoreAdmin';
import { initSentry } from '../../lib/sentry';
import { logEvent } from '../../lib/logger';
import { wrapAdminCallable } from '../../lib/wrapAdminCallable';
import { TRIBETAILS_CORS } from '../../lib/cors';
import { writeAuditEntry } from '../../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../../lib/auditEvents';
import {
  GOOGLE_OAUTH_SECRETS,
  calendarClientForRefreshToken,
  isInvalidGrant,
  revokedError,
} from '../../lib/googleOAuth';
import {
  GOOGLE_CALENDAR_DOC_PATH,
  calendarPushStamp,
  requireConnectedDoc,
} from '../../lib/googleCalendarConnection';
import {
  WRITE_CALENDAR_INVALID_CODE,
  writeCalendarProblem,
} from '../../lib/googleCalendarTargets';
import { readFreeBusyCalendarId } from './googleCalendarAccount';

/**
 * Writing upcoming visits onto the operator's chosen Google calendar
 * (Task 7.2). This is the half that makes the calendars EDITABLE; Task 7.1 only
 * ever read free/busy back the other way.
 *
 * ONE OPERATOR-INITIATED ACTION, NOT A TRIGGER, following 7.1's precedent
 * exactly: no Firestore trigger, no schedule, admin-callable only. A trigger on
 * `kin_care_sessions` would start writing to a real person's calendar on the
 * next edit of any visit, including edits made while the operator was still
 * deciding which calendar to point it at, and it would fire once per field
 * change. The plan sketched a per-session callable plus a trigger; a per-session
 * callable with no surface to press would be gate-dark, so what ships is the
 * bulk action the panel actually exposes, with the per-session upsert as its
 * inner step.
 *
 * FOUR TRAPS IN `kin_care_sessions`, all silent, all the same ones
 * `listUninvoicedSessions` documents:
 *   - `startTime` IS AN ISO STRING, not a Timestamp. Firestore orders every
 *     timestamp after every string, so a Timestamp bound returns nothing and
 *     does not error. The window is a LEXICAL range, which works because the
 *     format is ISO.
 *   - `status` CASING IS UNENFORCED, so it is filtered in memory. A server
 *     equality would invisibly drop every visit stored in the other case.
 *   - `endTime` IS NOT ALWAYS THERE. A session with neither an end nor a
 *     duration is SKIPPED and reported, never given an invented hour: an event
 *     that claims a length nobody entered would block out time the operator
 *     never agreed to.
 *   - CANCELLED VISITS ARE PUSHED AS DELETIONS, not skipped, when we have
 *     already put them on the calendar. Leaving a cancelled visit on a calendar
 *     the operator plans their day from is worse than never having written it.
 *
 * THE ECHO LOOP IS REFUSED, NOT DETECTED. If the write target were the calendar
 * the free/busy sync imports FROM, every visit pushed would come back as an
 * imported BLOCKED slot over its own hour. `freebusy.query` returns start and
 * end and nothing else, so no marker on the event could survive the round trip
 * to be filtered out on the way back. Refusing the overlap up front is the only
 * guard that works; see `lib/googleCalendarTargets.ts`.
 */

/** Frozen in `test/callableContract.test.ts`. */
export const Args = z
  .object({
    lookAheadDays: z.number().int().optional(),
  })
  .strict();

const SESSIONS_COLLECTION = 'kin_care_sessions';

/** Same 1..90 clamp and same 30-day default as the free/busy sync, so the two windows agree. */
export function clampLookAheadDays(raw: number | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return 30;
  return Math.max(1, Math.min(90, Math.trunc(raw)));
}

/** Statuses that mean the visit is off. Compared case-insensitively; see trap 2. */
const CANCELLED_STATUSES = ['CANCELLED', 'CANCELED', 'DECLINED'];

export function isCancelled(status: unknown): boolean {
  return typeof status === 'string' && CANCELLED_STATUSES.includes(status.trim().toUpperCase());
}

export interface SessionLike {
  id: string;
  kinfolkId: string;
  serviceType: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  status: string;
  notes: string;
  googleEventId: string;
}

export function sessionFromDoc(id: string, data: Record<string, unknown>): SessionLike {
  const s = (k: string): string => (typeof data[k] === 'string' ? (data[k] as string) : '');
  return {
    id,
    kinfolkId: s('kinfolkId'),
    serviceType: s('serviceType'),
    startTime: s('startTime'),
    endTime: s('endTime'),
    durationMinutes:
      typeof data['serviceDurationMinutes'] === 'number' ? (data['serviceDurationMinutes'] as number) : 0,
    status: s('status'),
    notes: s('notes'),
    googleEventId: s('googleEventId'),
  };
}

/**
 * The event's end, or null when the session says nothing usable. Null is a SKIP,
 * never a default length: see trap 3.
 */
export function resolveEndTime(session: SessionLike): string | null {
  const startMs = Date.parse(session.startTime);
  if (!Number.isFinite(startMs)) return null;
  const endMs = Date.parse(session.endTime);
  if (Number.isFinite(endMs) && endMs > startMs) return new Date(endMs).toISOString();
  if (session.durationMinutes > 0) {
    return new Date(startMs + session.durationMinutes * 60_000).toISOString();
  }
  return null;
}

export interface CalendarEventBody {
  summary: string;
  description: string;
  start: { dateTime: string };
  end: { dateTime: string };
  extendedProperties: { private: { tribetailsSessionId: string } };
}

/**
 * The event as Google receives it.
 *
 * DELIBERATELY THIN. The summary names the service and the household reference,
 * and the description carries the visit note and the session id. No address, no
 * phone number, no kin medical detail: this calendar belongs to a Google account
 * whose sharing we do not control, and a calendar entry is the easiest thing in
 * the world to share by accident. The operator has the full record in AuntieOS,
 * one tap from the session id printed here.
 *
 * `extendedProperties.private.tribetailsSessionId` is the belt to the stored
 * `googleEventId`'s braces: if the stored id is ever lost, the event can still
 * be recognised as ours rather than duplicated.
 */
export function buildEventBody(session: SessionLike, endTime: string): CalendarEventBody {
  const service = session.serviceType.trim() === '' ? 'Visit' : session.serviceType.trim();
  const summary = session.kinfolkId.trim() === '' ? service : `${service} for ${session.kinfolkId.trim()}`;
  const noteLine = session.notes.trim() === '' ? '' : `${session.notes.trim()}\n\n`;
  return {
    summary,
    description: `${noteLine}Booked in AuntieOS. Visit ${session.id}.`,
    start: { dateTime: session.startTime },
    end: { dateTime: endTime },
    extendedProperties: { private: { tribetailsSessionId: session.id } },
  };
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
  const connection = await requireConnectedDoc(db());

  try {
    return await runPush(connection.refreshToken, connection.googleAccountEmail, connection.writeCalendarId, lookAheadDays, uid);
  } catch (err) {
    // Every failure past this point is stamped before it is rethrown, so the
    // panel still says what went wrong after a reload. Best-effort: if the
    // stamp itself fails, the ORIGINAL error is the one worth surfacing.
    await stampPush(calendarPushStamp({ status: 'error', error: errorText(err) }, new Date().toISOString()), uid);
    throw err;
  }
}

async function runPush(
  refreshToken: string,
  googleAccountEmail: string,
  writeCalendarId: string,
  lookAheadDays: number,
  uid: string,
): Promise<PushResult> {
  const freeBusyCalendarId = await readFreeBusyCalendarId(db());
  const problem = writeCalendarProblem(writeCalendarId, freeBusyCalendarId, googleAccountEmail);
  if (problem !== null) {
    throw new HttpsError('failed-precondition', problem, { code: WRITE_CALENDAR_INVALID_CODE });
  }

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

  const calendar = calendarClientForRefreshToken(refreshToken);
  const skipped: PushSkip[] = [];
  let pushed = 0;
  let removed = 0;

  for (const doc of snap.docs) {
    const session = sessionFromDoc(doc.id, doc.data() as Record<string, unknown>);

    if (isCancelled(session.status)) {
      if (session.googleEventId === '') continue;
      try {
        await calendar.events.delete({ calendarId: writeCalendarId, eventId: session.googleEventId });
      } catch (err) {
        if (isInvalidGrant(err)) throw revokedError();
        // A 404 or 410 means the operator already removed it by hand, which is
        // the state we were trying to reach. Anything else is a real failure.
        const status = googleStatus(err);
        if (status !== 404 && status !== 410) throw err;
      }
      await doc.ref.set(
        { googleEventId: '', googleCalendarSyncedAt: new Date().toISOString(), googleCalendarSource: 'AUNTIEOS_PUSH' },
        { merge: true },
      );
      removed += 1;
      continue;
    }

    const endTime = resolveEndTime(session);
    if (endTime === null) {
      skipped.push({
        sessionId: session.id,
        reason:
          'This visit has no end time and no duration, so there is no length to put on the ' +
          'calendar. Add one and push again.',
      });
      continue;
    }

    const body = buildEventBody(session, endTime);
    try {
      if (session.googleEventId === '') {
        const created = await calendar.events.insert({ calendarId: writeCalendarId, requestBody: body });
        const eventId = typeof created.data.id === 'string' ? created.data.id : '';
        await doc.ref.set(
          {
            googleEventId: eventId,
            googleCalendarId: writeCalendarId,
            googleCalendarSyncedAt: new Date().toISOString(),
            googleCalendarSource: 'AUNTIEOS_PUSH',
          },
          { merge: true },
        );
      } else {
        await calendar.events.update({
          calendarId: writeCalendarId,
          eventId: session.googleEventId,
          requestBody: body,
        });
        await doc.ref.set(
          {
            googleCalendarId: writeCalendarId,
            googleCalendarSyncedAt: new Date().toISOString(),
            googleCalendarSource: 'AUNTIEOS_PUSH',
          },
          { merge: true },
        );
      }
      pushed += 1;
    } catch (err) {
      if (isInvalidGrant(err)) throw revokedError();
      const status = googleStatus(err);
      // An event the operator deleted by hand comes back as 404 or 410 on
      // update. Clearing our stale id lets the NEXT run recreate it, instead of
      // failing forever on an id Google has forgotten.
      if ((status === 404 || status === 410) && session.googleEventId !== '') {
        await doc.ref.set({ googleEventId: '' }, { merge: true });
        skipped.push({
          sessionId: session.id,
          reason: 'The event had been deleted in Google. It will be recreated on the next push.',
        });
        continue;
      }
      throw err;
    }
  }

  const stamp = calendarPushStamp({ status: 'ok', pushed }, new Date().toISOString());
  await stampPush(stamp, uid);

  await writeAuditEntry({
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

async function stampPush(
  stamp: ReturnType<typeof calendarPushStamp>,
  uid: string,
): Promise<void> {
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

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'The push to Google Calendar failed.';
}

/** Best-effort HTTP status extraction across googleapis error shapes. */
export function googleStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  return undefined;
}

export const pushVisitsToGoogleCalendar = onCall(
  {
    region: 'us-central1',
    cors: TRIBETAILS_CORS,
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN', 'AUNTIE_OPERATOR_UIDS'],
  },
  wrapAdminCallable('pushVisitsToGoogleCalendar', pushVisitsToGoogleCalendarHandler),
);
