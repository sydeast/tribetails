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

/**
 * The stamped ISO time as ms. The clients name a notice by `Date.parse` (web,
 * desktop) or `Instant.parse(..).toEpochMilli()` (Android) of the very string
 * they wrote, and both drop the digits after the millisecond, as this does.
 */
export function stampMs(raw: unknown): number | null {
  const iso = nonBlank(raw);
  if (iso === '') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const STAMP_FIELD: Readonly<Record<Exclude<VisitLifecycleAction, 'UNDO_ARRIVAL'>, string>> = {
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
  if (action === null) return null;

  if (action === 'UNDO_ARRIVAL') {
    // Named by the arrival it undid: each arrival can be undone once.
    return { action, from, to, atMs: stampMs(before['arrivedAt']) };
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
 * whose claims cannot be read is still named, in the business band with no
 * stamp; no writer at all is the system's.
 */
async function stepActor(
  actorUid: string | null,
  familyId: string,
): Promise<{ actorRole: 'AUNTIE' | 'SYSTEM' | 'PRIMARY' | 'SECONDARY'; stamp: Record<string, unknown> }> {
  if (!actorUid) return { actorRole: 'SYSTEM', stamp: {} };
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
    return { actorRole: actor.actorRole, stamp: auditActorPayload(actor) };
  } catch {
    return { actorRole: 'AUNTIE', stamp: {} };
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
      ...(input.actorUid ? { actorUid: input.actorUid } : {}),
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

  const event = visitStepEvent(step.action);
  if (event === null) return { notified: false, notifySkipped: 'no_event_for_action' };

  const routing = routingOf(session);
  let outcome: VisitStepOutcome;
  let dispatchIds: string[] = [];
  if (routing.skip !== null) {
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
        input.actorUid ?? '',
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
  return recordOutcome(visitStepNoticeId(sessionId, event, step.atMs), {
    sessionId,
    action: step.action,
    event,
    atMs: step.atMs,
    outcome,
    dispatchIds,
    source: input.source,
  });
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
    recordedAt: FieldValue.serverTimestamp(),
  };
  try {
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
