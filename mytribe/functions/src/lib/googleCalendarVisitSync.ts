import type { calendar_v3 } from '@googleapis/calendar';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  calendarClientForRefreshToken,
  isInvalidGrant,
  revokedError,
} from './googleOAuth';
import {
  CalendarAutoSyncStamp,
  GOOGLE_CALENDAR_DOC_PATH,
  GoogleCalendarConnectionDoc,
  requireConnectedDoc,
} from './googleCalendarConnection';
import { WRITE_CALENDAR_INVALID_CODE, writeCalendarProblem } from './googleCalendarTargets';

/**
 * ONE visit, one calendar event — the per-session half of Task 7.2 that the
 * bulk push was always the outer loop of (issue #397).
 *
 * WHY THIS LIB EXISTS AT ALL. `pushVisitsToGoogleCalendar` already knew how to
 * turn a `kin_care_sessions` row into an event and how to decide between
 * insert, update and delete. That knowledge was inlined in its loop body, so
 * the only way to reach it was to sweep the next 30 days. A visit that was
 * confirmed, moved or cancelled therefore reached the operator's calendar when,
 * and only when, somebody remembered to press Push. The decision table is now
 * here, the loop is still there, and both call the same code: a divergence
 * between "what the button writes" and "what the trigger writes" is the one bug
 * this feature cannot afford, because its symptom is a calendar that is subtly
 * wrong rather than one that is obviously broken.
 *
 * WHAT IS DELIBERATELY NOT HERE. No scheduling policy, no notion of which
 * lifecycle transition happened. This lib is told a session id and reads the
 * stored row; it does not accept a caller's claim about what the visit now
 * says. Six different callables mirror onto `kin_care_sessions`
 * (`manageBookingSeries`, `batchUpdateBookings`, `rescheduleBooking`,
 * `rescheduleRequests`, `transitionBookingStatus`, `createKinCareSession`) and
 * a per-caller argument would be six chances to describe the same row six
 * different ways.
 */

/** The collection every lifecycle path mirrors a visit onto. */
export const SESSIONS_COLLECTION = 'kin_care_sessions';

/**
 * The fields of a visit that an event on a calendar is made out of.
 *
 * This list IS the trigger's relevance filter. `onKinCareSessionCalendarSync`
 * fires on every write to a visit row — an invoice link, a do-not-invoice flag,
 * a clock-in stamp, an internal note — and calling Google on each of those
 * would spend quota to send Google a body it already has.
 */
export const CALENDAR_RELEVANT_FIELDS = [
  'startTime',
  'endTime',
  'serviceDurationMinutes',
  'status',
  'serviceType',
  'notes',
  'kinfolkId',
] as const;

/**
 * The fields the sync itself writes back onto the visit row.
 *
 * THIS IS THE LOOP GUARD, and it is the half of the design that bites if it is
 * got wrong. Every one of these is written by `syncVisitBySessionId` onto the
 * very document whose writes trigger it. None of them appears in
 * CALENDAR_RELEVANT_FIELDS, so the write-back produces a second invocation that
 * finds no relevant change and stops. Listed explicitly (rather than left
 * implicit in "not in the relevant list") because a future field added to the
 * write-back and forgotten here is not a bug that shows up in a test — it is an
 * infinite trigger loop billed per invocation, discovered on the invoice.
 */
export const SESSION_SYNC_FIELDS = [
  'googleEventId',
  'googleCalendarId',
  'googleCalendarSyncedAt',
  'googleCalendarSource',
  'googleCalendarSyncStatus',
  'googleCalendarSyncError',
  'googleCalendarSyncFailedAt',
] as const;

/** Statuses that mean the visit is off. Compared case-insensitively; casing is unenforced. */
const CANCELLED_STATUSES = ['CANCELLED', 'CANCELED', 'DECLINED'];

export function isCancelled(status: unknown): boolean {
  return typeof status === 'string' && CANCELLED_STATUSES.includes(status.trim().toUpperCase());
}

export interface SessionLike {
  id: string;
  kinfolkId: string;
  serviceType: string;
  /** ISO-8601 STRING, never a Timestamp. */
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
      typeof data['serviceDurationMinutes'] === 'number'
        ? (data['serviceDurationMinutes'] as number)
        : 0,
    status: s('status'),
    notes: s('notes'),
    googleEventId: s('googleEventId'),
  };
}

/**
 * The event's end, or null when the session says nothing usable. Null is a SKIP,
 * never a default length: an event claiming an hour nobody entered blocks out
 * time the operator never agreed to.
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
 * the world to share by accident.
 */
export function buildEventBody(session: SessionLike, endTime: string): CalendarEventBody {
  const service = session.serviceType.trim() === '' ? 'Visit' : session.serviceType.trim();
  const summary =
    session.kinfolkId.trim() === '' ? service : `${service} for ${session.kinfolkId.trim()}`;
  const noteLine = session.notes.trim() === '' ? '' : `${session.notes.trim()}\n\n`;
  return {
    summary,
    description: `${noteLine}Booked in AuntieOS. Visit ${session.id}.`,
    start: { dateTime: session.startTime },
    end: { dateTime: endTime },
    extendedProperties: { private: { tribetailsSessionId: session.id } },
  };
}

/** Best-effort HTTP status extraction across Google API client error shapes. */
export function googleStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  if (typeof e.code === 'number') return e.code;
  if (typeof e.status === 'number') return e.status;
  if (e.response && typeof e.response.status === 'number') return e.response.status;
  return undefined;
}

/**
 * True when Google is telling us the event is already gone: the operator
 * deleted it by hand, or a previous delete of ours landed and its response was
 * lost. Both mean the state we wanted has been reached by another route.
 */
export function isAlreadyGone(err: unknown): boolean {
  const status = googleStatus(err);
  return status === 404 || status === 410;
}

/**
 * Did this write change anything an event is made of?
 *
 * Compared by JSON value rather than by identity so a number written back as
 * the same number, or a string re-set to itself, is not a change. A field
 * absent on one side and empty on the other IS reported as a change, which errs
 * toward one wasted Google call rather than toward a stale event.
 */
export function calendarFieldsChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): boolean {
  if (before === undefined || after === undefined) return true;
  return CALENDAR_RELEVANT_FIELDS.some(
    (field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null),
  );
}

export type VisitSyncAction = 'created' | 'updated' | 'deleted' | 'skipped';

export interface VisitSyncOutcome {
  sessionId: string;
  action: VisitSyncAction;
  /** The Google event id after the action. Empty after a delete, or after a skip. */
  eventId: string;
  /** Why nothing was written. Empty unless `action` is `skipped`. */
  reason: string;
  syncedAt: string;
}

/** The receipt a successful sync leaves on the visit row itself. */
export function sessionSyncOkFields(
  action: VisitSyncAction,
  eventId: string,
  writeCalendarId: string,
  nowIso: string,
): Record<string, unknown> {
  return {
    googleEventId: eventId,
    googleCalendarId: eventId === '' ? '' : writeCalendarId,
    googleCalendarSyncedAt: nowIso,
    googleCalendarSource: 'AUNTIEOS_PUSH',
    googleCalendarSyncStatus: action === 'skipped' ? 'skipped' : 'ok',
    googleCalendarSyncError: '',
    googleCalendarSyncFailedAt: '',
  };
}

/**
 * The receipt a FAILED sync leaves on the visit row.
 *
 * `googleEventId` is deliberately absent: a failure must not disturb the id,
 * because the id is what the retry uses to decide update-versus-insert. A
 * cleared id after a transient network error would create a duplicate event on
 * the next attempt.
 */
export function sessionSyncErrorFields(error: string, nowIso: string): Record<string, unknown> {
  return {
    googleCalendarSyncStatus: 'error',
    googleCalendarSyncError: error,
    googleCalendarSyncFailedAt: nowIso,
  };
}

export function errorText(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  return typeof err === 'string' && err.trim() !== ''
    ? err
    : 'The write to Google Calendar failed.';
}

/**
 * Insert, update or delete the one event for one session, against an already
 * built client. The decision table, and nothing else:
 *
 *   cancelled + no stored id  → nothing was ever written, nothing to remove
 *   cancelled + stored id     → DELETE, and forget the id
 *   live + no usable end      → SKIP, with the reason the operator must act on
 *   live + no stored id       → INSERT, and remember the id
 *   live + stored id          → UPDATE, and if Google has forgotten the event,
 *                               INSERT a replacement rather than failing forever
 *                               on an id that no longer exists
 *
 * `invalid_grant` is rethrown as `revokedError()` from every branch. It is the
 * one Google failure that retrying never fixes.
 */
export async function applyVisitToCalendar(
  calendar: calendar_v3.Calendar,
  writeCalendarId: string,
  session: SessionLike,
  nowIso: string,
): Promise<VisitSyncOutcome> {
  const base = { sessionId: session.id, syncedAt: nowIso };

  if (isCancelled(session.status)) {
    if (session.googleEventId === '') {
      return { ...base, action: 'skipped', eventId: '', reason: 'This visit was never on the calendar.' };
    }
    try {
      await calendar.events.delete({
        calendarId: writeCalendarId,
        eventId: session.googleEventId,
      });
    } catch (err) {
      if (isInvalidGrant(err)) throw revokedError();
      // Already gone is the state we were trying to reach.
      if (!isAlreadyGone(err)) throw err;
    }
    return { ...base, action: 'deleted', eventId: '', reason: '' };
  }

  const endTime = resolveEndTime(session);
  if (endTime === null) {
    return {
      ...base,
      action: 'skipped',
      eventId: session.googleEventId,
      reason:
        'This visit has no end time and no duration, so there is no length to put on the ' +
        'calendar. Add one and sync again.',
    };
  }

  const body = buildEventBody(session, endTime);

  if (session.googleEventId !== '') {
    try {
      await calendar.events.update({
        calendarId: writeCalendarId,
        eventId: session.googleEventId,
        requestBody: body,
      });
      return { ...base, action: 'updated', eventId: session.googleEventId, reason: '' };
    } catch (err) {
      if (isInvalidGrant(err)) throw revokedError();
      if (!isAlreadyGone(err)) throw err;
      // Fall through to a fresh insert. The bulk push clears the id and waits
      // for the next run; a lifecycle sync has no next run to wait for, so it
      // recreates the event now and the operator's calendar stays correct.
    }
  }

  try {
    const created = await calendar.events.insert({ calendarId: writeCalendarId, requestBody: body });
    const eventId = typeof created.data.id === 'string' ? created.data.id : '';
    return { ...base, action: 'created', eventId, reason: '' };
  } catch (err) {
    if (isInvalidGrant(err)) throw revokedError();
    throw err;
  }
}

export interface ConnectionForSync {
  refreshToken: string;
  writeCalendarId: string;
  googleAccountEmail: string;
}

/**
 * Rejects unless the connection can actually be written to: connected, and
 * pointed at a calendar that is not the one the free/busy sync imports FROM.
 * The echo loop is refused up front because `freebusy.query` returns start and
 * end and nothing else, so no marker on the event could survive the round trip
 * to be filtered out on the way back.
 */
export async function requireWritableConnection(
  database: FirebaseFirestore.Firestore,
  freeBusyCalendarId: string,
): Promise<GoogleCalendarConnectionDoc> {
  const connection = await requireConnectedDoc(database);
  const problem = writeCalendarProblem(
    connection.writeCalendarId,
    freeBusyCalendarId,
    connection.googleAccountEmail,
  );
  if (problem !== null) {
    throw new HttpsError('failed-precondition', problem, { code: WRITE_CALENDAR_INVALID_CODE });
  }
  return connection;
}

/**
 * The whole per-visit operation: read the row, act on Google, write the receipt
 * back onto the row.
 *
 * A MISSING ROW IS NOT AN ERROR. The trigger's delete path calls
 * `deleteVisitEvent` directly with the id it read off the deleted snapshot; a
 * caller who names a session that no longer exists gets a `skipped` outcome and
 * no exception, because "the visit is gone" and "the visit's event should be
 * gone" are the same request.
 */
export async function syncVisitBySessionId(
  database: FirebaseFirestore.Firestore,
  connection: ConnectionForSync,
  sessionId: string,
  nowIso: string,
): Promise<VisitSyncOutcome> {
  const ref = database.collection(SESSIONS_COLLECTION).doc(sessionId);
  const snap = await ref.get();
  if (!snap.exists) {
    return {
      sessionId,
      action: 'skipped',
      eventId: '',
      reason: 'That visit no longer exists.',
      syncedAt: nowIso,
    };
  }

  const session = sessionFromDoc(sessionId, (snap.data() ?? {}) as Record<string, unknown>);
  const calendar = await calendarClientForRefreshToken(connection.refreshToken);

  let outcome: VisitSyncOutcome;
  try {
    outcome = await applyVisitToCalendar(calendar, connection.writeCalendarId, session, nowIso);
  } catch (err) {
    // Stamped onto the visit BEFORE the rethrow, so the failure outlives the
    // request that caused it. A trigger has no caller to show an error to.
    await ref.set(sessionSyncErrorFields(errorText(err), nowIso), { merge: true }).catch(() => {});
    throw err;
  }

  if (outcome.action === 'skipped' && outcome.eventId === session.googleEventId) {
    // Nothing was written to Google, so nothing but the reason is worth
    // recording. Writing the ok-fields here would clear a real earlier error.
    await ref.set(
      {
        googleCalendarSyncStatus: 'skipped',
        googleCalendarSyncError: outcome.reason,
        googleCalendarSyncFailedAt: '',
      },
      { merge: true },
    );
    return outcome;
  }

  await ref.set(
    sessionSyncOkFields(outcome.action, outcome.eventId, connection.writeCalendarId, nowIso),
    { merge: true },
  );
  return outcome;
}

/**
 * Removes the event for a visit row that no longer exists.
 *
 * The hard-delete path. `syncVisitBySessionId` cannot serve it: there is no
 * document left to read the event id off, and no document left to stamp. The
 * id comes from the deleted snapshot the trigger was handed.
 */
export async function deleteVisitEvent(
  connection: ConnectionForSync,
  sessionId: string,
  eventId: string,
  nowIso: string,
): Promise<VisitSyncOutcome> {
  if (eventId.trim() === '') {
    return {
      sessionId,
      action: 'skipped',
      eventId: '',
      reason: 'This visit was never on the calendar.',
      syncedAt: nowIso,
    };
  }
  const calendar = await calendarClientForRefreshToken(connection.refreshToken);
  try {
    await calendar.events.delete({ calendarId: connection.writeCalendarId, eventId: eventId.trim() });
  } catch (err) {
    if (isInvalidGrant(err)) throw revokedError();
    if (!isAlreadyGone(err)) throw err;
  }
  return { sessionId, action: 'deleted', eventId: '', reason: '', syncedAt: nowIso };
}

/** Writes the auto-sync receipt. Best effort: a lost receipt must not mask the real failure. */
export async function stampAutoSync(
  database: FirebaseFirestore.Firestore,
  stamp: CalendarAutoSyncStamp,
): Promise<void> {
  try {
    await database.doc(GOOGLE_CALENDAR_DOC_PATH).set(stamp, { merge: true });
  } catch {
    /* reported by the caller's own log line */
  }
}
