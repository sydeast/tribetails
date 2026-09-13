import { onCall, CallableRequest, HttpsError } from 'firebase-functions/v2/https';
import { FieldValue } from 'firebase-admin/firestore';
import { z, ZodError } from 'zod';
import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { initSentry } from '../lib/sentry';
import { wrapAdminCallable } from '../lib/wrapAdminCallable';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS } from '../lib/auditEvents';
import { clearedArrivalEvidence } from '../lib/arrivalVerification';
import { TRIBETAILS_CORS } from '../lib/cors';
import { validateResponse } from '../lib/callableResponse';
import { BOOKING_STATUS_UNKNOWN_CODE, unknownStatusMessage } from '../lib/bookingTransitions';
import {
  VISIT_LIFECYCLE_ACTIONS,
  VISIT_LIFECYCLE_ILLEGAL_CODE,
  evaluateVisitLifecycle,
  illegalLifecycleMessage,
  notificationEventFor,
  type VisitLifecycleAction,
} from '../lib/visitLifecycle';
import { dispatchVisitNotificationCore } from './dispatchVisitNotification';

/**
 * #397 L19: server-bound On-my-way / Clock in / Clock out / Undo arrival on ONE
 * `kin_care_sessions` document.
 *
 * THE WEB ADMIN NO LONGER CALLS THIS ON A FIELD TAP (2026-09-12), and the three
 * reasons below are kept verbatim because two of them are still true and the
 * third is what changed. What replaced it is
 * `auntieos-admin/src/api/sessionsWrite.ts#patchVisitLifecycle`: a direct
 * Firestore write, with `logActivity` and `dispatchVisitNotification` fired
 * behind it, which is Android's shape exactly.
 *
 * WHY, IN ONE MEASUREMENT. Every admin callable runs at minInstances 0, and on
 * 2026-09-11 this one took 05:26:17.698 -> 05:26:25.617 to answer: 7.9 seconds
 * of Cloud Run building a container in front of roughly 0.67 s of handler.
 * `cpu: 1` is already deployed, so import trimming does not touch it. An Auntie
 * standing at a door waited that out to say she had arrived.
 *
 * THIS CALLABLE IS NOT DEAD AND MUST NOT BE DELETED. It is still exported, still
 * deployed, and still the only path that reads the session server-side before
 * deciding -- which is the one thing the client path gives up (a stale row or a
 * second operator). It remains correct for any caller that is not a field tap,
 * and it is the escape hatch if the direct write turns out to be wrong. Reason
 * 1 below is the one that was overtaken: the operator has since ruled that
 * MOBILE WEB IS THE FIELD FALLBACK, so the browser is on a phone in a dead
 * zone after all, and `auntieos-admin/src/lib/firebase.ts` now runs Firestore
 * with a persistent offline queue for exactly that.
 *
 * WHAT THIS IS FOR. The web admin had no write path onto a visit's lifecycle at
 * all: `screens/Sessions.tsx` said so in its own header ("Still NOT built here:
 * the WRITE flows, clock-in/out, GPS tracking"), and `SessionDetail.tsx`
 * rendered clocked-in / clocked-out as read-only `Fact`s. Android ships all of
 * it. This callable was the web half, and it is a CALLABLE rather than the
 * direct `updateDoc` Android uses for three reasons the field app did not
 * share:
 *
 *   1. ANDROID'S DIRECT PATCH IS AN OFFLINE CONCESSION, and it says so:
 *      `KinCareRepository#markSessionComplete`'s KDoc explains the three
 *      forward transitions stay direct writes because they are "IN-VISIT
 *      telemetry from a phone that is regularly offline between houses, and
 *      Firestore's offline write queue is what makes them land at all". A
 *      browser at the office desk has no such problem, so it buys nothing and
 *      gives up the two things below.
 *   2. THE AUDIT IS BOUND TO THE MUTATION. Android fires `AuditLog` from the
 *      client after the write, which is the CWE-345 shape `triageOrphanReport`
 *      and `transitionBookingStatus` both moved off. Here the audit is written
 *      by the same server flow that writes the document, on every path,
 *      refusals included.
 *   3. THE HOUSEHOLD ACTUALLY GETS TOLD. On Android the message is a SECOND
 *      client call (`VisitNotifier` -> `dispatchVisitNotification`), and
 *      nothing triggers on a `kin_care_sessions` write, so any other writer
 *      notifies nobody. Doing it here means the web cannot ship a clock-in
 *      whose "kinfolk notified" is a lie. See the notification block below.
 *
 * WHAT IT IS NOT FOR, and each has an owner already:
 *   - COMPLETED / CANCELLED: `transitionBookingStatus`. Those are terminal,
 *     they decide whether a visit is billable, and `firestore.rules` refuses
 *     them to every client. This callable never writes either.
 *   - startTime / endTime: `rescheduleBooking`, which carries the busy,
 *     closure and visit-overlap guards. Moving a visit's window through here
 *     would route around all three.
 *
 * SHAPE is deliberately `transitionBookingStatus.ts`'s, line for line where it
 * can be: `wrapAdminCallable` for the admin claim, zod at the boundary,
 * read-before-write so the audit records the real before/after, a pure state
 * machine (`lib/visitLifecycle.ts`) that owns the legality question so this
 * handler cannot answer it a second, slightly different way.
 */
export const Args = z.object({
  sessionId: z.string().min(1).max(120),
  action: z.enum(VISIT_LIFECYCLE_ACTIONS),
  /**
   * The CALLER's "now" for the timestamp this action stamps, kept for exactly
   * the reason `transitionBookingStatus.Args.completedAt` keeps it: every
   * reader of this collection already parses a client-stamped ISO string
   * (`lib/sessionFormat.ts`, `DashboardInsights.kt`), and a server-stamped
   * value would be a second, differently-skewed kind of instant on one field.
   * Omitted, the server stamps its own, so the field is never absent.
   *
   * Ignored for UNDO_ARRIVAL, which clears timestamps rather than writing one.
   */
  atIso: z.string().min(1).max(40).optional(),
  /**
   * Only meaningful for ON_MY_WAY: the ETA the operator declared, in minutes.
   * Stored on `etaMinutesAway` and forwarded to the household notification,
   * matching `KinCareRepository#markSessionOnMyWay` and
   * `VisitNotifier.notify(..., etaMinutes)`. Android's Auntie Time card sends
   * none and its Home card sends one, so this is optional here too.
   */
  etaMinutes: z.number().int().min(0).max(24 * 60).optional(),
});

export const Result = z
  .object({
    ok: z.literal(true),
    sessionId: z.string(),
    action: z.enum(VISIT_LIFECYCLE_ACTIONS),
    /** The status the row held before this call. Equal to `status` on a no-op. */
    from: z.string(),
    /** The status the row holds now. */
    status: z.string(),
    /** False when the action was already true and nothing was written. */
    changed: z.boolean(),
    /**
     * Whether the household was told. `false` covers three different, honest
     * outcomes -- an action that declares no event (undo), a session with no
     * routing ids, and a dispatch that failed -- so `notifySkipped` names which.
     */
    notified: z.boolean(),
    /** Why no notification went out, or null when one did. */
    notifySkipped: z.string().nullable(),
  })
  .strict();

export type SetVisitLifecycleResult = z.infer<typeof Result>;

/** The document field each forward action stamps. */
const STAMP_FIELD: Readonly<Record<Exclude<VisitLifecycleAction, 'UNDO_ARRIVAL'>, string>> = {
  ON_MY_WAY: 'onMyWayAt',
  ARRIVED: 'arrivedAt',
  DEPARTED: 'departedAt',
};

/** Audit a refusal, then let the caller throw. Never swallows the throw. */
async function auditRefusal(args: {
  uid: string;
  sessionId: string;
  action: VisitLifecycleAction;
  code: string;
  from: string;
  description: string;
}): Promise<void> {
  await writeAuditEntry({
    event: AUDIT_EVENTS.VISIT_LIFECYCLE_REFUSED,
    severity: 'warn',
    status: 'FAILURE',
    actorRole: 'AUNTIE',
    actorUid: args.uid,
    targetUid: args.sessionId,
    targetCollection: 'kin_care_sessions',
    description: args.description,
    payload: {
      sessionId: args.sessionId,
      action: args.action,
      refusalCode: args.code,
      from: args.from,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'setVisitLifecycle',
      event: 'audit.write.failed',
      uid: args.uid,
      errorMessage: (err as Error)?.message,
    });
  });
}

interface SessionDoc {
  status?: unknown;
  kinfolkId?: unknown;
  onMyWayAt?: unknown;
  kinCareBatchId?: unknown;
  kinCareVisitId?: unknown;
  sourceBookingId?: unknown;
}

function nonBlank(v: unknown): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : '';
}

/**
 * Tell the household, best-effort.
 *
 * BEST-EFFORT IS THE ANDROID CONTRACT, not a shortcut. `VisitNotifier.notify`
 * returns a `Result` and `HomeViewModel` only ever reads its success branch --
 * a failed dispatch logs and the visit stays clocked in. Making the clock-in
 * fail because a push could not be enqueued would lose the operational fact
 * (the Auntie IS at the door) over a message. What web adds is that the
 * outcome is REPORTED rather than silently dropped, so the screen can say
 * "clocked in, but the household was not notified" instead of implying both.
 *
 * The routing ids are `VisitNotifier`'s, transcribed: prefer the envelope pair
 * (`kinCareBatchId` + `kinCareVisitId`), fall back to the legacy flat
 * `sourceBookingId`, and when a session carries neither there is nothing to
 * route to -- an AuntieOS-native visit that predates the kinCare envelope.
 * Android `error()`s there and swallows it in `runCatching`; here it is a named
 * skip reason rather than a swallowed throw.
 */
async function notifyHousehold(args: {
  action: VisitLifecycleAction;
  session: SessionDoc;
  uid: string;
  actorName: string | undefined;
  etaMinutes: number | undefined;
}): Promise<{ notified: boolean; notifySkipped: string | null }> {
  const event = notificationEventFor(args.action);
  if (event === null) return { notified: false, notifySkipped: 'no_event_for_action' };

  const familyId = nonBlank(args.session.kinfolkId);
  if (familyId === '') return { notified: false, notifySkipped: 'session_has_no_kinfolk' };

  const batchId = nonBlank(args.session.kinCareBatchId);
  const visitId = nonBlank(args.session.kinCareVisitId);
  const bookingId = nonBlank(args.session.sourceBookingId);
  const useEnvelope = batchId !== '' && visitId !== '';
  if (!useEnvelope && bookingId === '') {
    return { notified: false, notifySkipped: 'session_has_no_routing_ids' };
  }

  try {
    const outcome = await dispatchVisitNotificationCore(
      {
        familyId,
        ...(useEnvelope ? { batchId, visitId } : { bookingId }),
        event,
        ...(args.etaMinutes !== undefined ? { etaMinutes: args.etaMinutes } : {}),
      },
      args.uid,
      args.actorName,
    );
    return outcome.suppressed
      ? { notified: false, notifySkipped: 'household_prefs_suppressed' }
      : { notified: true, notifySkipped: null };
  } catch (err) {
    logEvent({
      severity: 'warn',
      function: 'setVisitLifecycle',
      event: 'visit.notification.failed',
      uid: args.uid,
      errorMessage: (err as Error)?.message,
    });
    return { notified: false, notifySkipped: 'dispatch_failed' };
  }
}

export async function setVisitLifecycleHandler(
  req: CallableRequest<unknown>,
): Promise<SetVisitLifecycleResult> {
  initSentry();
  const uid = req.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required.');

  let args: z.infer<typeof Args>;
  try {
    args = Args.parse(req.data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpsError('invalid-argument', 'setVisitLifecycle validation failed', {
        validationErrors: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw err;
  }

  const ref = db().doc(`kin_care_sessions/${args.sessionId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    await auditRefusal({
      uid,
      sessionId: args.sessionId,
      action: args.action,
      code: 'not_found',
      from: '',
      description: `${args.action} refused: session '${args.sessionId}' not found`,
    });
    throw new HttpsError('not-found', `Session '${args.sessionId}' not found.`);
  }

  const prev = (snap.data() ?? {}) as SessionDoc;
  const decision = evaluateVisitLifecycle({
    currentStatus: prev.status,
    action: args.action,
    onMyWayAt: prev.onMyWayAt,
  });

  if (decision.kind === 'unknown-status') {
    await auditRefusal({
      uid,
      sessionId: args.sessionId,
      action: args.action,
      code: BOOKING_STATUS_UNKNOWN_CODE,
      from: decision.raw,
      description: `${args.action} refused: unreadable status on session '${args.sessionId}'`,
    });
    throw new HttpsError('failed-precondition', unknownStatusMessage(decision.raw), {
      code: BOOKING_STATUS_UNKNOWN_CODE,
      sessionId: args.sessionId,
    });
  }

  if (decision.kind === 'illegal') {
    await auditRefusal({
      uid,
      sessionId: args.sessionId,
      action: args.action,
      code: VISIT_LIFECYCLE_ILLEGAL_CODE,
      from: decision.from,
      description: `${args.action} refused: illegal from ${decision.from}`,
    });
    throw new HttpsError(
      'failed-precondition',
      illegalLifecycleMessage(args.action, decision.from, decision.allowedFrom),
      {
        code: VISIT_LIFECYCLE_ILLEGAL_CODE,
        sessionId: args.sessionId,
        from: decision.from,
        allowedFrom: decision.allowedFrom,
      },
    );
  }

  if (decision.kind === 'noop') {
    // Already true. NOTHING IS WRITTEN, and that is the point: re-stamping
    // `arrivedAt` on a second clock-in would quietly move when the visit
    // started. Audited anyway (at 'info', changed:false) so the trail shows
    // the operator pressed the button. No notification either -- the household
    // was told the first time, and a duplicate push is worse than none.
    await writeAuditEntry({
      event: AUDIT_EVENTS.VISIT_LIFECYCLE_SET,
      severity: 'info',
      status: 'SUCCESS',
      actorRole: 'AUNTIE',
      actorUid: uid,
      targetUid: args.sessionId,
      targetCollection: 'kin_care_sessions',
      description: `${args.action} on session ${args.sessionId}: already ${decision.at}, no write`,
      payload: {
        sessionId: args.sessionId,
        action: args.action,
        from: decision.at,
        to: decision.at,
        changed: false,
      },
    }).catch((err) => {
      logEvent({
        severity: 'warn',
        function: 'setVisitLifecycle',
        event: 'audit.write.failed',
        uid,
        errorMessage: (err as Error)?.message,
      });
    });

    return validateResponse('setVisitLifecycle', Result, {
      ok: true as const,
      sessionId: args.sessionId,
      action: args.action,
      from: decision.at,
      status: decision.at,
      changed: false,
      notified: false,
      notifySkipped: 'already_in_this_state',
    });
  }

  const stampedAt = args.atIso ?? new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: decision.to,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: uid,
  };

  if (args.action === 'UNDO_ARRIVAL') {
    // Ports `KinCareSessionsScreen.kt`'s undo patch, which clears `arrivedAt`
    // by writing the empty string (this collection's own "cleared" spelling --
    // `KinCareRepository#patchKinCareSession` documents "Pass empty-string to
    // clear a field (e.g. Undo Arrived)"), not a field delete, so every reader
    // that does `.take(10)` or `.trim()` on it keeps working.
    patch.arrivedAt = '';
    // Undoing from DEPARTED must not leave a `departedAt` behind: that is a
    // record saying the visit both ended and has not started.
    // `missingVisitSteps` (lib/arrivalVerification.ts) reads exactly these two
    // fields to decide whether a visit may be completed, so the stale value is
    // not cosmetic -- it would let a re-arrival complete while claiming a
    // departure that was undone.
    //
    // This was a disclosed divergence from Android when #606 shipped it here
    // first. Android closed it in #608 (`KinCareSessionsScreen.kt`'s
    // `undoArrivalPatch`), so the two paths now clear the same field set.
    patch.departedAt = '';
    // ISSUE #582, same reasoning one field further on. `verifyVisitArrival`
    // stamps how far from the household THIS arrival was recorded, and
    // `transitionBookingStatus` refuses a COMPLETE on a measurement outside the
    // operator's radius. An undone arrival's measurement is evidence about an
    // arrival that no longer exists: leave it and the NEXT arrival, quite
    // possibly at a different door and quite possibly offline so with no
    // measurement of its own, inherits it. That can refuse a COMPLETE that
    // should pass as easily as pass one that should be refused. The Android and
    // desktop Auntie Time cards clear the same three fields on their own direct
    // undo patch; the field list is shared so the two paths cannot drift.
    Object.assign(patch, clearedArrivalEvidence());
  } else {
    patch[STAMP_FIELD[args.action]] = stampedAt;
    if (args.action === 'ON_MY_WAY' && args.etaMinutes !== undefined) {
      patch.etaMinutesAway = args.etaMinutes;
    }
  }

  await ref.set(patch, { merge: true });

  const { notified, notifySkipped } = await notifyHousehold({
    action: args.action,
    session: prev,
    uid,
    actorName: req.auth?.token?.name,
    etaMinutes: args.etaMinutes,
  });

  await writeAuditEntry({
    event: AUDIT_EVENTS.VISIT_LIFECYCLE_SET,
    severity: 'info',
    status: 'SUCCESS',
    actorRole: 'AUNTIE',
    actorUid: uid,
    targetUid: args.sessionId,
    targetCollection: 'kin_care_sessions',
    description: `${args.action} on session ${args.sessionId}: ${decision.from} -> ${decision.to}`,
    payload: {
      sessionId: args.sessionId,
      action: args.action,
      from: decision.from,
      to: decision.to,
      changed: true,
      notified,
      notifySkipped,
    },
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'setVisitLifecycle',
      event: 'audit.write.failed',
      uid,
      errorMessage: (err as Error)?.message,
    });
  });

  logEvent({
    severity: 'info',
    function: 'setVisitLifecycle',
    event: 'admin.visit.lifecycleSet',
    uid,
    extra: {
      sessionId: args.sessionId,
      action: args.action,
      from: decision.from,
      to: decision.to,
      notified,
    },
  });

  return validateResponse('setVisitLifecycle', Result, {
    ok: true as const,
    sessionId: args.sessionId,
    action: args.action,
    from: decision.from,
    status: decision.to,
    changed: true,
    notified,
    notifySkipped,
  });
}

export const setVisitLifecycle = onCall(
  { region: 'us-central1', cors: TRIBETAILS_CORS, secrets: ['SENTRY_DSN'] },
  wrapAdminCallable('setVisitLifecycle', setVisitLifecycleHandler),
);
