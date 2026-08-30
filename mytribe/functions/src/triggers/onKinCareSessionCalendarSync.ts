import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { GOOGLE_OAUTH_SECRETS } from '../lib/googleOAuth';
import { calendarAutoSyncStamp, readConnection } from '../lib/googleCalendarConnection';
import { writeCalendarProblem } from '../lib/googleCalendarTargets';
import {
  VisitSyncOutcome,
  calendarFieldsChanged,
  deleteVisitEvent,
  errorText,
  stampAutoSync,
  syncVisitBySessionId,
} from '../lib/googleCalendarVisitSync';
import { readFreeBusyCalendarId } from '../admin/googleCalendar/googleCalendarAccount';

/**
 * A confirmed visit appears on the operator's Google calendar. A rescheduled
 * one moves. A cancelled one comes off. Automatically (issue #397).
 *
 * ── WHY A TRIGGER, AFTER THIS FEATURE SPENT A YEAR REFUSING TO BE ONE ─────
 *
 * `pushVisitsToGoogleCalendar` shipped with a written refusal to build this,
 * and the refusal named two real hazards. Neither is waved away here; each is
 * answered by something in this file:
 *
 *   1. "It would write to a real person's calendar while the operator was still
 *      deciding which calendar to point it at." Answered by the `writeCalendarId`
 *      gate below. That field is empty until the operator picks a calendar from
 *      a list in Settings, and picking it is the consent. Before that, this
 *      function returns without building a client, without a Google call, and
 *      without so much as a log line worth reading.
 *   2. "It would fire once per field change." Answered by `calendarFieldsChanged`.
 *      A visit row is written by a dozen things that have nothing to do with a
 *      calendar entry — an invoice link, a do-not-invoice flag, a clock-in
 *      stamp, an internal note. Only the seven fields an event is MADE of are
 *      compared, so everything else costs one document read.
 *
 * ── WHY THIS COLLECTION AND NOT THE SIX CALLABLES THAT WRITE TO IT ────────
 *
 * `manageBookingSeries`, `batchUpdateBookings`, `rescheduleBooking`,
 * `rescheduleRequests`, `transitionBookingStatus` and `createKinCareSession`
 * all mirror onto `kin_care_sessions`. Hooking each of them would be six call
 * sites to keep in step, six places to forget, and — the practical half —
 * six files being edited by other work at the same time. Watching the row they
 * all agree on catches every lifecycle path, including any added later, and
 * touches none of their files.
 *
 * ── THE LOOP GUARD ────────────────────────────────────────────────────────
 *
 * This function writes back onto the collection it watches: the event id and
 * the sync receipt. None of those fields is in CALENDAR_RELEVANT_FIELDS, so the
 * write-back produces one more invocation that finds nothing moved and returns.
 * `SESSION_SYNC_FIELDS` in the sync lib lists them, and exists so that a field
 * added to the write-back and forgotten is caught by a test rather than by a
 * bill.
 *
 * ── FAILURE IS STAMPED, NOT THROWN ────────────────────────────────────────
 *
 * A rethrow makes Firestore retry, and retrying a calendar write whose first
 * attempt may already have created an event is how one visit becomes four. So
 * every failure is written down in two places instead — the visit row, and the
 * connection document all three admin panels already poll — and the operator's
 * recovery is `syncVisitToGoogleCalendar` on that one visit, or the bulk Push
 * for all of them. Same reasoning, and the same shape, as `onInvoiceAutoApply`.
 */

type SessionData = Record<string, unknown>;

/** The event id we last wrote for this visit, off whichever snapshot still exists. */
function storedEventId(data: SessionData | undefined): string {
  const raw = data?.['googleEventId'];
  return typeof raw === 'string' ? raw.trim() : '';
}

export async function onKinCareSessionCalendarSyncHandler(
  event: FirestoreEvent<Change<DocumentSnapshot> | undefined, { sessionId: string }>,
): Promise<void> {
  const sessionId = event.params.sessionId;
  const before = event.data?.before?.data() as SessionData | undefined;
  const after = event.data?.after?.data() as SessionData | undefined;

  // A write with neither side is not a state this trigger can act on.
  if (before === undefined && after === undefined) return;

  const deleted = after === undefined;

  // GATE ONE: is anything connected, and has the operator chosen a target?
  // Cheapest check first, and the answer to hazard 1 above.
  const connection = await readConnection(db());
  if (!connection.connected || connection.writeCalendarId.trim() === '') return;

  // GATE TWO: did anything an event is made of actually change? A hard delete
  // always passes: there is no "after" to compare, and the event must come off.
  if (!deleted && !calendarFieldsChanged(before, after)) return;

  // GATE THREE: the echo loop. Checked here as well as in the two callables
  // because the operator can point the free/busy sync at the write calendar
  // AFTER connecting, and this path has no human in it to notice.
  const freeBusyCalendarId = await readFreeBusyCalendarId(db());
  const problem = writeCalendarProblem(
    connection.writeCalendarId,
    freeBusyCalendarId,
    connection.googleAccountEmail,
  );
  if (problem !== null) {
    await report(sessionId, { failed: problem });
    return;
  }

  const nowIso = new Date().toISOString();
  try {
    const outcome = deleted
      ? await deleteVisitEvent(connection, sessionId, storedEventId(before), nowIso)
      : await syncVisitBySessionId(db(), connection, sessionId, nowIso);
    await report(sessionId, { ok: outcome });
  } catch (err) {
    // FAIL LOUD, DO NOT THROW. See the header: a retry here duplicates events.
    await report(sessionId, { failed: errorText(err) });
  }
}

/**
 * Writes the outcome down where somebody will find it, and says so in the log.
 *
 * Both halves matter and neither replaces the other: the log is where an
 * engineer looks after the fact, and the connection stamp is what the operator
 * sees on a panel they were going to open anyway.
 */
async function report(
  sessionId: string,
  outcome: { ok: VisitSyncOutcome } | { failed: string },
): Promise<void> {
  const nowIso = new Date().toISOString();
  if ('failed' in outcome) {
    await stampAutoSync(
      db(),
      calendarAutoSyncStamp({ status: 'error', sessionId, error: outcome.failed }, nowIso),
    );
    logEvent({
      severity: 'error',
      function: 'onKinCareSessionCalendarSync',
      event: 'gcal.autosync.failed',
      extra: { sessionId, reason: outcome.failed },
    });
    return;
  }

  await stampAutoSync(
    db(),
    calendarAutoSyncStamp(
      { status: 'ok', sessionId, action: outcome.ok.action },
      outcome.ok.syncedAt,
    ),
  );
  logEvent({
    severity: 'info',
    function: 'onKinCareSessionCalendarSync',
    event: 'gcal.autosync.done',
    extra: { sessionId, action: outcome.ok.action, reason: outcome.ok.reason },
  });
}

export const onKinCareSessionCalendarSync = onDocumentWritten(
  {
    document: 'kin_care_sessions/{sessionId}',
    region: 'us-central1',
    // A v2 trigger mounts ONLY the secrets it declares. Without these two the
    // OAuth client cannot be built and every sync would fail with
    // `google_oauth_not_configured` against secrets that are, in fact, set.
    secrets: [...GOOGLE_OAUTH_SECRETS, 'SENTRY_DSN'],
  },
  wrapTrigger('onKinCareSessionCalendarSync', onKinCareSessionCalendarSyncHandler),
);
