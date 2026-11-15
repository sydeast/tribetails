import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firestoreAdmin';
import { logEvent } from './logger';
import { writeAuditEntry } from './writeAuditEntry';
import { AUDIT_EVENTS, type AuditEvent } from './auditEvents';
import { normalizeBookingStatus } from './bookingTransitions';
import { notificationEventFor, type VisitLifecycleAction } from './visitLifecycle';

/**
 * #2037: THE HOUSEHOLD NOTICE AND THE ACTIVITY LOG LINE FOR ONE CLOCK STEP
 * (On my way, Arrived, Departed, Undo arrival), sent by the server from the
 * committed write.
 *
 * WHAT WAS WRONG. Every admin client wrote the step straight to
 * `kin_care_sessions` and then, from the browser or the phone, called
 * `logActivity` and `dispatchVisitNotification`. A reload in the second
 * between the two lost both: the visit read ARRIVED, the household was never
 * told, and the Activity Log had no "Visit arrived" line. An Android write that
 * sat in the offline queue had the same hole, and the desktop and Android
 * Auntie Time cards never wrote the line at all.
 *
 * WHAT IT IS NOW. `triggers/onKinCareSessionLifecycle.ts` reads every write to
 * a session, and `visitStepOf` names the step a status move is. This module
 * then writes the line and hands the notice to `dispatchVisitNotificationCore`,
 * which keeps the household send gate and the household's own preferences in
 * force. `setVisitLifecycle` calls the same function inline for its answer.
 *
 * EXACTLY ONCE, by construction rather than by a claim:
 *   - the line has a fixed id (`visitStepAuditId`), so a second writer for the
 *     same step (a redelivered trigger, `setVisitLifecycle` and the trigger its
 *     own write fires) writes nothing;
 *   - the notice carries the dedupe key old installed clients already send
 *     (`visitDedupeKey`: the visit, the step and its stamped time), so a
 *     client from before this change that still dispatches after its write is
 *     the duplicate, not a second notice;
 *   - the outcome is recorded at `visit_step_notices/{id}`, which the clients
 *     read for the sentence on the card. A writer that only found the notice
 *     already sent never overwrites the first writer's outcome.
 */

export const VISIT_STEP_NOTICES_COLLECTION = 'visit_step_notices';
/** How long a clock step's notice is remembered against a redelivered event. */
export const VISIT_STEP_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

type SessionData = Record<string, unknown>;

/** One clock step a write made, or what the trigger needs to say nothing. */
export interface VisitStep {
  action: VisitLifecycleAction;
  from: string;
  to: string;
  /**
   * When the step happened (ms epoch), read off the field the step stamps
   * (`onMyWayAt`, `arrivedAt`, `departedAt`). For an undo, the arrival it
   * undid. Null when the field is missing or unreadable.
   */
  atMs: number | null;
  /** The ETA an on-my-way declared in this write, when it declared one. */
  etaMinutes?: number;
}

function statusOf(data: SessionData | undefined): string | null {
  return normalizeBookingStatus(data?.['status']);
}

function nonBlank(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** A date-time with no offset, the shape the desktop console's `nowIso()` stamps. */
const ZONELESS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * The stamped ISO time as ms. The clients name a notice by `Date.parse` (web)
 * or `Instant.parse(..).toEpochMilli()` (Android) of the very string they
 * wrote, and both drop the digits after the millisecond, as this does.
 *
 * The desktop console stamps the business's wall clock with no offset
 * (`2026-11-10T16:00:00`). `Date.parse` would read that in the server's own
 * zone, which is UTC in production and the machine's zone in a test, so it is
 * read as UTC here, explicitly, and the console names its record the same way
 * (`visitNoticeAtMs`). The value only names the notice; nothing shows it.
 */
export function stampMs(raw: unknown): number | null {
  const iso = nonBlank(raw);
  if (iso === '') return null;
  const ms = Date.parse(ZONELESS_DATE_TIME.test(iso) ? `${iso}Z` : iso);
  return Number.isFinite(ms) ? ms : null;
}

const STAMP_FIELD: Readonly<Record<Exclude<VisitLifecycleAction, 'UNDO_ARRIVAL' | 'UNDO_DEPARTED'>, string>> = {
  ON_MY_WAY: 'onMyWayAt',
  ARRIVED: 'arrivedAt',
  DEPARTED: 'departedAt',
};

/**
 * PURE. The clock step this write made, or null when it made none.
 *
 * Only a MOVE between two readable statuses counts, and only along the four
 * edges the clock buttons draw (`lib/visitLifecycle.ts`):
 *   SCHEDULED to ON_MY_WAY                 On my way
 *   SCHEDULED or ON_MY_WAY to ARRIVED      Arrived
 *   ARRIVED to DEPARTED                    Departed
 *   ARRIVED or DEPARTED to SCHEDULED or ON_MY_WAY   Undo arrival
 *   DEPARTED or COMPLETED to ARRIVED       Undo departed (#2250)
 * A created session (no `before`), a deleted one, an edit that leaves the
 * status alone, and the move to COMPLETED or CANCELLED (the departure trigger
 * and `transitionBookingStatus`, which log their own) are not steps.
 */
export function visitStepOf(before: SessionData | undefined, after: SessionData | undefined): VisitStep | null {
  if (before === undefined || after === undefined) return null;
  const from = statusOf(before);
  const to = statusOf(after);
  if (from === null || to === null || from === to) return null;

  let action: VisitLifecycleAction | null = null;
  if (to === 'ON_MY_WAY' && from === 'SCHEDULED') action = 'ON_MY_WAY';
  else if (to === 'ARRIVED' && (from === 'SCHEDULED' || from === 'ON_MY_WAY')) action = 'ARRIVED';
  else if (to === 'DEPARTED' && from === 'ARRIVED') action = 'DEPARTED';
  else if ((to === 'SCHEDULED' || to === 'ON_MY_WAY') && (from === 'ARRIVED' || from === 'DEPARTED')) {
    action = 'UNDO_ARRIVAL';
  }
  // #2250: a departure taken back. Only `setVisitLifecycle` makes this move
  // (the rules refuse it to every client), and it writes this line itself; the
  // trigger names the same step so whichever is second writes nothing.
  else if (to === 'ARRIVED' && (from === 'DEPARTED' || from === 'COMPLETED')) action = 'UNDO_DEPARTED';
  if (action === null) return null;

  if (action === 'UNDO_ARRIVAL') {
    // Named by the arrival it undid: each arrival can be undone once.
    return { action, from, to, atMs: stampMs(before['arrivedAt']) };
  }
  if (action === 'UNDO_DEPARTED') {
    // Named by the departure it undid, for the same reason.
    return { action, from, to, atMs: stampMs(before['departedAt']) };
  }
  const step: VisitStep = { action, from, to, atMs: stampMs(after[STAMP_FIELD[action]]) };
  if (action === 'ON_MY_WAY') {
    // Only an ETA this write declared. Android writes `etaMinutesAway` with the
    // step and sends it when it is above zero; the web writes and sends it only
    // when one was entered. An older value left on the row is not this step's.
    const eta = after['etaMinutesAway'];
    if (typeof eta === 'number' && Number.isInteger(eta) && eta > 0 && eta !== before['etaMinutesAway']) {
      step.etaMinutes = eta;
    }
  }
  return step;
}

/** The household notice a step sends, by the dispatcher's name for it, or null (undo). */
export function visitStepEvent(action: VisitLifecycleAction): 'on_my_way' | 'arrived' | 'departed' | null {
  return notificationEventFor(action);
}

/**
 * The id of a step's outcome at `visit_step_notices/{id}`. Every client builds
 * the same string from the session id, the notice (`on_my_way`, `arrived`,
 * `departed`) and the time it stamped, so it can find the outcome without
 * asking a callable. Mirrored in web `api/sessionsWrite.ts#visitStepNoticeId`,
 * Android `VisitNotifier.stepNoticeId` and the desktop `FirestoreClient`.
 */
export function visitStepNoticeId(sessionId: string, event: string, atMs: number): string {
  return `${sessionId}__${event}__${atMs}`;
}

/** The fixed `activity_log` id for a step's line, so a second writer writes nothing. */
export function visitStepAuditId(sessionId: string, step: Pick<VisitStep, 'action' | 'atMs'>, fallback: string): string {
  return `visitstep__${sessionId}__${step.action}__${step.atMs ?? fallback}`;
}

const STEP_EVENT: Readonly<Record<VisitLifecycleAction, AuditEvent>> = {
  ON_MY_WAY: AUDIT_EVENTS.VISIT_ON_MY_WAY,
  ARRIVED: AUDIT_EVENTS.VISIT_ARRIVED,
  DEPARTED: AUDIT_EVENTS.VISIT_DEPARTED,
  UNDO_ARRIVAL: AUDIT_EVENTS.VISIT_UNDO_ARRIVAL,
  UNDO_DEPARTED: AUDIT_EVENTS.VISIT_UNDO_DEPARTED,
};

/** What the household was told, the shape every client already reads. */
export interface VisitStepOutcome {
  notified: boolean;
  /** Why nobody was told, or null when somebody was. */
  notifySkipped: string | null;
}

/**
 * Why a session cannot be routed to a household, read off the row, or the
 * routing ids when it can. The same order every client checks
 * (`visitRoutingSkip`).
 */
function routingOf(session: SessionData):
  | { skip: 'session_has_no_kinfolk' | 'session_has_no_routing_ids' }
  | { skip: null; familyId: string; batchId?: string; visitId?: string; bookingId?: string } {
  const familyId = nonBlank(session['kinfolkId']);
  if (familyId === '') return { skip: 'session_has_no_kinfolk' };
  const batchId = nonBlank(session['kinCareBatchId']);
  const visitId = nonBlank(session['kinCareVisitId']);
  const bookingId = nonBlank(session['sourceBookingId']);
  if (batchId !== '' && visitId !== '') return { skip: null, familyId, batchId, visitId };
  if (bookingId !== '') return { skip: null, familyId, bookingId };
  return { skip: 'session_has_no_routing_ids' };
}

/**
 * Who the line names. `logActivity` worked this out from the caller's token
 * (#1820) and stamped `admin` / `staffRole` on the line, which the Activity
 * Log reads to print the owner or an Auntie. A trigger has no token, so the
 * writer's claims are read from Auth and handed to the same resolver. A writer
 * whose claims cannot be read for a passing reason is still named, in the
 * business band with no stamp; no writer at all is the system's.
 *
 * An id Auth has no user for is not a person. The event's `authId` is not
 * promised to be a uid for every principal (a Firebase console edit has been
 * seen to carry an email), so such an id is dropped and the line reads as the
 * system's rather than filed under a string nobody signs in as.
 */
const NOT_A_USER = new Set(['auth/user-not-found', 'auth/invalid-uid', 'auth/argument-error']);

async function stepActor(
  actorUid: string | null,
  familyId: string,
): Promise<{ uid: string | null; actorRole: 'AUNTIE' | 'SYSTEM' | 'PRIMARY' | 'SECONDARY'; stamp: Record<string, unknown> }> {
  if (!actorUid) return { uid: null, actorRole: 'SYSTEM', stamp: {} };
  try {
    const [{ auth }, { resolveAuditActor, auditActorPayload }] = await Promise.all([
      import('./firestoreAdmin.js'),
      import('./auditActor.js'),
    ]);
    const user = await auth().getUser(actorUid);
    const actor = await resolveAuditActor(
      { uid: actorUid, token: (user.customClaims ?? {}) as never },
      'onKinCareSessionLifecycle',
      familyId === '' ? undefined : familyId,
    );
    return { uid: actorUid, actorRole: actor.actorRole, stamp: auditActorPayload(actor) };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && NOT_A_USER.has(code)) return { uid: null, actorRole: 'SYSTEM', stamp: {} };
    return { uid: actorUid, actorRole: 'AUNTIE', stamp: {} };
  }
}

/**
 * Write the step's Activity Log line and, for a forward step, tell the
 * household. Safe to call more than once for the same step, from any server
 * path. Never throws: a failed dispatch is the outcome `dispatch_failed`,
 * recorded for the card, and a failed line write is logged at `error` (and so
 * reaches Sentry) without holding the notice back. The two are independent,
 * as they were on the clients.
 *
 * @param session  the session as the write left it (`after`).
 * @param actorUid who made the write, when known. Null for a write the server
 *                 cannot attribute; the line then reads as the system's.
 * @param fallbackKey names the line when the step carries no stamped time
 *                 (the trigger's event id), so it is still written once.
 */
export async function announceVisitStep(input: {
  sessionId: string;
  session: SessionData;
  step: VisitStep;
  actorUid: string | null;
  actorName?: string | undefined;
  source: 'trigger' | 'setVisitLifecycle';
  fallbackKey: string;
}): Promise<VisitStepOutcome> {
  const { sessionId, session, step } = input;
  const { visitTransitionWords } = await import('./activityWords.js');
  const familyId = nonBlank(session['kinfolkId']);

  const actor = await stepActor(input.actorUid, familyId);
  try {
    await writeAuditEntry({
      event: STEP_EVENT[step.action],
      severity: 'info',
      status: 'SUCCESS',
      actorRole: actor.actorRole,
      ...(actor.uid ? { actorUid: actor.uid } : {}),
      targetUid: sessionId,
      targetCollection: 'kin_care_sessions',
      ...(familyId !== '' ? { familyId } : {}),
      description: visitTransitionWords(step.action, step.from, step.to),
      payload: {
        visitId: sessionId,
        action: step.action,
        from: step.from,
        to: step.to,
        source: input.source,
        // The same owner or Auntie stamp `logActivity` put on these lines (#1820).
        ...actor.stamp,
      },
      docId: visitStepAuditId(sessionId, step, input.fallbackKey),
    });
  } catch (err) {
    logEvent({
      severity: 'error',
      function: 'announceVisitStep',
      event: 'audit.write.failed',
      extra: { sessionId, action: step.action, source: input.source },
      errorMessage: (err as Error)?.message,
    });
  }

  const line = { actorRole: actor.actorRole, actorUid: actor.uid, stamp: actor.stamp };
  // #2038: an undone arrival's notice comes off the household's notifications
  // list. Nothing is sent about it. Here, and not in `setVisitLifecycle`,
  // because the session trigger brings every undo through this function, a
  // client's own write included. #2348: the "has left" of a departure that
  // ended that arrival goes with it. #2357: what came off is recorded for the
  // sentence the admin clients show.
  if (step.action === 'UNDO_ARRIVAL') {
    const { withdrawUndoneArrivalNotices } = await import('./arrivalNoticeWithdrawal.js');
    await withdrawUndoneArrivalNotices({
      sessionId,
      session,
      atMs: step.atMs,
      source: input.source,
      settled: 'ask',
      line,
    });
  }

  const event = visitStepEvent(step.action);
  if (event === null) return { notified: false, notifySkipped: 'no_event_for_action' };

  // #2038: a wrong Arrived tap taken back within a second or two can reach the
  // trigger after its own undo. That arrival is gone, so nothing is sent for it
  // and nothing is recorded. The callable has just written the arrival itself
  // and does not ask.
  if (step.action === 'ARRIVED' && step.atMs !== null && input.source === 'trigger') {
    if (!(await arrivalOnFile(sessionId, step.atMs))) {
      // #2357: the undo ran first and left its record to this handler, which
      // is the one that knows the arrival was never announced.
      const { withdrawUndoneArrivalNotices } = await import('./arrivalNoticeWithdrawal.js');
      await withdrawUndoneArrivalNotices({ sessionId, session, atMs: step.atMs, source: input.source, settled: true, line });
      return { notified: false, notifySkipped: 'no_event_for_action' };
    }
  }
  // #2357: the same for a Departed tap taken back (Undo departed, or Undo
  // arrival) before its notice was sent. That departure is gone, so the
  // household is not told she left.
  if (step.action === 'DEPARTED' && step.atMs !== null && input.source === 'trigger') {
    if (!(await departureOnFile(sessionId, step.atMs))) {
      return { notified: false, notifySkipped: 'no_event_for_action' };
    }
  }

  const routing = routingOf(session);
  let outcome: VisitStepOutcome;
  let dispatchIds: string[] = [];
  // #2038, lead ruling on review: a real arrival after an undone one is not
  // announced twice. When the earlier arrival reached the household, its entry
  // goes back on their notifications list for this arrival and nothing is
  // sent. Recorded below with the row's id, so an undo of THIS arrival finds it.
  // #2250, #2348: the same for a real Departed after an undone one, whichever
  // undo took it back.
  // #2357: only on the same business day. A step that lands on a later day
  // than the undone one is a later visit, not a quick mistake, and is
  // announced below like any other (`quietRepeatOf`).
  const repeat =
    (step.action === 'ARRIVED' || step.action === 'DEPARTED') && step.atMs !== null
      ? await (await import('./arrivalNoticeWithdrawal.js')).settleRepeat(
          step.action === 'ARRIVED' ? 'arrived' : 'departed',
          { sessionId, session, atMs: step.atMs, source: input.source, line },
        )
      : null;
  const toldRowId = repeat?.quietId ?? null;
  if (toldRowId !== null) {
    outcome = { notified: false, notifySkipped: 'already_notified' };
    dispatchIds = [toldRowId];
  } else if (routing.skip !== null) {
    outcome = { notified: false, notifySkipped: routing.skip };
  } else {
    try {
      const { dispatchVisitNotificationCore } = await import('../admin/dispatchVisitNotification.js');
      const res = await dispatchVisitNotificationCore(
        {
          familyId: routing.familyId,
          ...(routing.batchId && routing.visitId
            ? { batchId: routing.batchId, visitId: routing.visitId }
            : { bookingId: routing.bookingId }),
          event,
          ...(step.etaMinutes !== undefined ? { etaMinutes: step.etaMinutes } : {}),
          ...(step.atMs !== null ? { eventAtMs: step.atMs } : {}),
        },
        actor.uid ?? '',
        input.actorName,
        {
          auditDocId: `visitnotice__${visitStepAuditId(sessionId, step, input.fallbackKey)}`,
          // A redelivery hours later is still this step: its key names the stamp.
          ...(step.atMs !== null ? { dedupeWindowMs: VISIT_STEP_DEDUPE_WINDOW_MS } : {}),
        },
      );
      dispatchIds = res.dispatchIds;
      outcome = res.suppressed
        ? { notified: false, notifySkipped: res.reason ?? 'household_prefs_suppressed' }
        : { notified: true, notifySkipped: null };
    } catch (err) {
      logEvent({
        severity: 'warn',
        function: 'announceVisitStep',
        event: 'visit.notification.failed',
        extra: { sessionId, action: step.action, source: input.source },
        errorMessage: (err as Error)?.message,
      });
      outcome = { notified: false, notifySkipped: 'dispatch_failed' };
    }
  }

  if (step.atMs === null) return outcome;
  const arrivalAtMs = step.action === 'DEPARTED' ? stampMs(session['arrivedAt']) : null;
  const recorded = await recordOutcome(visitStepNoticeId(sessionId, event, step.atMs), {
    sessionId,
    action: step.action,
    event,
    atMs: step.atMs,
    outcome,
    dispatchIds,
    source: input.source,
    // #2348: the arrival a departure ended, so an undo of that arrival finds it.
    ...(step.action === 'DEPARTED' && arrivalAtMs !== null ? { arrivalAtMs } : {}),
  });
  // #2357, lead ruling: a step announced on a later business day replaces the
  // earlier day's entry, which "Undo departed" alone left listed. Only once
  // this step's own entry exists, whoever sent it (this run, or an installed
  // client's dispatch this run was the duplicate of). After the record above,
  // which is one of the two places the withdrawal reads that entry's id.
  if (repeat !== null && repeat.replacedId !== null && (step.action === 'ARRIVED' || step.action === 'DEPARTED')) {
    const { withdrawReplacedNotice } = await import('./arrivalNoticeWithdrawal.js');
    await withdrawReplacedNotice(step.action === 'ARRIVED' ? 'arrived' : 'departed', {
      sessionId,
      session,
      atMs: step.atMs,
      replacedId: repeat.replacedId,
      source: input.source,
      line,
    });
  }
  // #2038: the undo ran while this notice was being sent, found no row and
  // withdrew nothing. The row exists now, so it is withdrawn here. After the
  // record above, which is where the withdrawal reads the row's id. #2357: and
  // the undo left its own record to this run, so it is written here whether
  // or not there was a row to take off.
  if (step.action === 'ARRIVED' && !(await arrivalOnFile(sessionId, step.atMs))) {
    const { withdrawUndoneArrivalNotices } = await import('./arrivalNoticeWithdrawal.js');
    await withdrawUndoneArrivalNotices({ sessionId, session, atMs: step.atMs, source: input.source, settled: true, line });
  }
  // #2348: the same for "has left" when the arrival it ended has been undone
  // in the meantime. An "Undo departed" alone leaves the entry listed (#2250).
  if (
    step.action === 'DEPARTED' &&
    arrivalAtMs !== null &&
    (recorded.notified || recorded.notifySkipped === 'already_notified') &&
    !(await arrivalOnFile(sessionId, arrivalAtMs))
  ) {
    const { withdrawUndoneArrivalNotices } = await import('./arrivalNoticeWithdrawal.js');
    await withdrawUndoneArrivalNotices({ sessionId, session, atMs: arrivalAtMs, source: input.source, settled: true, line });
  }
  return recorded;
}

/**
 * #2038: is the arrival stamped `atMs` still the visit's arrival, on the
 * session as it reads now? A session that cannot be read counts as standing:
 * a passing error never withholds or withdraws a true notice.
 */
async function arrivalOnFile(sessionId: string, atMs: number): Promise<boolean> {
  try {
    const snap = await db().doc(`kin_care_sessions/${sessionId}`).get();
    if (!snap.exists) return true;
    const { arrivalStillStands } = await import('./arrivalNoticeWithdrawal.js');
    return arrivalStillStands(snap.data() as SessionData, atMs, stampMs);
  } catch {
    return true;
  }
}
/** #2357: the same question of the departure stamped `atMs`, with the same benefit of the doubt. */
async function departureOnFile(sessionId: string, atMs: number): Promise<boolean> {
  try {
    const snap = await db().doc(`kin_care_sessions/${sessionId}`).get();
    if (!snap.exists) return true;
    const { departureStillStands } = await import('./arrivalNoticeWithdrawal.js');
    return departureStillStands(snap.data() as SessionData, atMs, stampMs);
  } catch {
    return true;
  }
}

/**
 * Record the outcome for the card, and answer with the one on record. A writer
 * that only found the notice already sent (`already_notified`) is the second
 * writer for this step: it never overwrites the first writer's outcome, and
 * answers with it when there is one.
 */
async function recordOutcome(
  id: string,
  rec: {
    sessionId: string;
    action: VisitLifecycleAction;
    event: string;
    atMs: number;
    outcome: VisitStepOutcome;
    dispatchIds: string[];
    source: string;
    arrivalAtMs?: number;
  },
): Promise<VisitStepOutcome> {
  const ref = db().collection(VISIT_STEP_NOTICES_COLLECTION).doc(id);
  const doc = {
    sessionId: rec.sessionId,
    action: rec.action,
    event: rec.event,
    atMs: rec.atMs,
    notified: rec.outcome.notified,
    reason: rec.outcome.notifySkipped,
    dispatchIds: rec.dispatchIds,
    source: rec.source,
    ...(rec.arrivalAtMs !== undefined ? { arrivalAtMs: rec.arrivalAtMs } : {}),
    recordedAt: FieldValue.serverTimestamp(),
    // #2357: the server's clock as a plain number, which the day rule reads
    // (`arrivalNoticeWithdrawal.ts#quietRepeatOf`).
    recordedAtMs: Date.now(),
  };
  try {
    if (rec.outcome.notified) {
      await ref.set(doc);
      return rec.outcome;
    }
    if (rec.outcome.notifySkipped === 'dispatch_failed') {
      // #2037 review: a second writer whose dispatch failed (a passing error)
      // never overwrites a first writer that did tell the household.
      const prior = await ref.get();
      if (prior.exists && (prior.data() as { notified?: unknown }).notified === true) return { notified: true, notifySkipped: null };
      await ref.set(doc);
      return rec.outcome;
    }
    if (rec.outcome.notifySkipped !== 'already_notified') {
      await ref.set(doc);
      return rec.outcome;
    }
    const snap = await ref.get();
    if (snap.exists) {
      const stored = snap.data() as { notified?: unknown; reason?: unknown };
      return {
        notified: stored.notified === true,
        notifySkipped: typeof stored.reason === 'string' ? stored.reason : null,
      };
    }
    await ref.create(doc).catch(() => undefined);
  } catch (err) {
    // The card falls back to its waiting sentence; the notice itself is out.
    logEvent({
      severity: 'warn',
      function: 'announceVisitStep',
      event: 'visit.notice.record.failed',
      extra: { id },
      errorMessage: (err as Error)?.message,
    });
  }
  return rec.outcome;
}
