import { onDocumentWritten, FirestoreEvent, Change, DocumentSnapshot } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';

import { db } from '../lib/firestoreAdmin';
import { logEvent } from '../lib/logger';
import { wrapTrigger } from '../lib/wrapTrigger';
import { writeAuditEntry } from '../lib/writeAuditEntry';
import { AUDIT_EVENTS, type AuditEvent } from '../lib/auditEvents';
import {
  ARRIVAL_RADIUS_CODE,
  ARRIVAL_VERIFICATION_CODE,
  COMPLETED_OUTSIDE_RANGE_FIELD,
  arrivalCheckedByOwner,
  missingVisitSteps,
  readArrivalEvidence,
  readArrivalSettings,
} from '../lib/arrivalVerification';
import { classifyArrivalDistance } from '../lib/geo';
import {
  HOUSEHOLD_STATUS_BEFORE_COMPLETION_FIELD,
  UNDO_DEPARTED_UNTIL_FIELD,
  UNDO_DEPARTED_WINDOW_MS,
} from '../lib/visitLifecycle';

/**
 * #2123 (operator ruling 2026-11-12): "Completed." A visit is Completed as
 * soon as the Auntie has departed, for everyone. Sending a KinTale never
 * decides it, and "since the admin can work as an auntie, KinTales cannot be
 * required to complete their visits."
 *
 * WHAT THIS REPLACES. #1793, #1799 (PRs #1800, #1806) completed a DEPARTED
 * visit from the client once its KinTale was sent (`autoCompleteEligible`), and
 * a visit with no KinTale stayed Departed. That coupling is gone on every
 * client; this trigger is the one place a departure becomes a completion.
 *
 * WHY A TRIGGER, against #1800's "Why not the server". That PR kept completion
 * on the clients for two reasons, and both are answered here:
 *
 *   1. "A Firestore trigger has no actor." Departure is a direct client patch
 *      (Android's offline queue, the web's `patchVisitLifecycle`, the console),
 *      and `transitionBookingStatus` is not on the Auntie allowlist
 *      (`lib/auntieAccess.ts`). A client-driven COMPLETE would fail for the
 *      Auntie who departed, and for a departure replayed from a phone's
 *      offline queue there is no client around to send it at all. The audit
 *      entry says what happened instead: `actorRole: 'SYSTEM'`, the departure
 *      as the cause (`payload.trigger`), and the session as the target, so the
 *      Activity Log line reads "Completed the visit: departed to completed".
 *   2. "No one to tell" a refusal. The operator's arrival rule
 *      (`requireArrivalDepartureVerification`, #519 / #582) still applies,
 *      checked the way `transitionBookingStatus` checks it. A refused visit
 *      stays DEPARTED, the refusal is audited at `warn` in the same words the
 *      callable uses, and every admin card for a DEPARTED visit keeps its
 *      Complete button, which re-asks through `transitionBookingStatus` and
 *      shows the reason.
 *
 * WHAT IT WRITES, in one transaction that re-reads the session: `status:
 * COMPLETED`, `completedAt` (the departure stamp, so the visit's finish is when
 * the Auntie left, not when this ran), `updatedAt`, `kinTaleDue: true` when
 * "KinTale required" is on and nothing has been sent (`lib/kinTaleRequirement`),
 * and the household's copy moved to `completed` (#1627's mirror, same rules:
 * never created, never over a cancelled or completed copy).
 *
 * LOOP-SAFE AND IDEMPOTENT. It acts only on the write that MOVES a session to
 * DEPARTED (`departedNow`), so its own COMPLETED write, and any later edit to a
 * Departed visit, fire nothing. Inside the transaction it re-reads the session
 * and does nothing unless it is still DEPARTED, so an undone arrival, a manual
 * Complete that got there first, or a retry writes nothing twice.
 *
 * NO NEW HOUSEHOLD NOTICE. The household already hears "Your Auntie has left"
 * from the departure tap (`dispatchVisitNotification`), and nothing sends on a
 * session or `kinCares` move to completed.
 *
 * #2250: IT ALSO OPENS "UNDO DEPARTED". Whether it completes the visit or the
 * arrival rule refuses it, the same transaction stamps `undoDepartedUntil`:
 * this server's clock plus `UNDO_DEPARTED_WINDOW_MS`. Every admin client shows
 * "Undo departed" until that moment and `lib/undoDeparted.ts` refuses after
 * it. A completion also keeps what the household's copy read before
 * (`householdStatusBeforeCompletion`) so the undo can put it back.
 */

type SessionData = Record<string, unknown>;

function statusOf(data: SessionData | undefined): string {
  const raw = data?.['status'];
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

function nonBlank(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/** The write that moves a session to DEPARTED, and only that write. */
export function departedNow(before: SessionData | undefined, after: SessionData | undefined): boolean {
  if (after === undefined) return false;
  return statusOf(after) === 'DEPARTED' && statusOf(before) !== 'DEPARTED';
}

export type DepartureCompletion =
  | {
      kind: 'completed';
      kinTaleDue: boolean;
      /** #2279: the owner's arrival was measured outside the range. Allowed, and recorded. */
      outsideRange?: { distanceMeters: number; radiusMeters: number };
    }
  | { kind: 'skipped'; status: string }
  | { kind: 'refused'; code: string; description: string };

/**
 * Completes one DEPARTED session, or says why not. Exported for the tests and
 * for any later caller that needs the same answer; the trigger is the only one.
 */
export async function completeDepartedSession(
  sessionId: string,
  nowIso: string = new Date().toISOString(),
): Promise<DepartureCompletion> {
  const firestore = db();
  // Loaded here, not at file scope, as `transitionBookingStatus` loads them:
  // see coldStartImportGraph.test.ts.
  const [
    { kinTaleDueAtCompletion, kinTaleRequiredFrom },
    { visitMissingStepsWords, visitOutsideRadiusWords, visitTransitionWords, visitCompletedOutsideRangeWords },
  ] = await Promise.all([import('../lib/kinTaleRequirement.js'), import('../lib/activityWords.js')]);
  const arrival = await readArrivalSettings(firestore);
  const sessionRef = firestore.doc(`kin_care_sessions/${sessionId}`);

  // #2250: when "Undo departed" closes for this departure, by this clock.
  const seenMs = Date.parse(nowIso);
  const undoStamp = {
    [UNDO_DEPARTED_UNTIL_FIELD]: new Date(
      (Number.isFinite(seenMs) ? seenMs : Date.now()) + UNDO_DEPARTED_WINDOW_MS,
    ).toISOString(),
  };

  let mirrored: 'completed' | null = null;
  let arrivalLocationVerdict: 'within' | 'outside' | 'unverified' | 'not_checked' = 'not_checked';

  const outcome = await firestore.runTransaction(async (tx): Promise<DepartureCompletion> => {
    const snap = await tx.get(sessionRef);
    const session = (snap.exists ? snap.data() : undefined) as SessionData | undefined;
    const status = statusOf(session);
    if (session === undefined || status !== 'DEPARTED') return { kind: 'skipped', status };
    // #2123: "KinTale required" is read INSIDE the transaction, so the owner
    // switching it off cannot interleave with this completion: either this
    // commits first and the switch-off clears its stamp
    // (`triggers/onBusinessSettingsWrite.ts`), or it reads the switch as off.
    const settingsSnap = await tx.get(firestore.doc('business_settings/business_settings'));
    const kinTaleRequired = kinTaleRequiredFrom(settingsSnap.data() as Record<string, unknown> | undefined);
    let outsideRange: { distanceMeters: number; radiusMeters: number } | undefined;

    if (arrival.required) {
      const missing = missingVisitSteps(session);
      if (missing.length > 0) {
        tx.set(sessionRef, undoStamp, { merge: true });
        return { kind: 'refused', code: ARRIVAL_VERIFICATION_CODE, description: visitMissingStepsWords(missing) };
      }
      const evidence = readArrivalEvidence(session);
      arrivalLocationVerdict = classifyArrivalDistance({
        distanceMeters: evidence.distanceMeters,
        accuracyMeters: evidence.accuracyMeters,
        radiusMeters: arrival.radiusMeters,
      });
      // #2279, operator ruling 2026-11-14: the owner may start and complete a
      // visit outside the range, and it is recorded. Nobody calls this
      // trigger, so who measured the arrival is read off the session
      // (`ARRIVAL_CHECKED_BY_OWNER_FIELD`, server-written only). An Auntie can
      // no longer start outside the range at all, so any other outside
      // arrival is an old one or a stray: it stays Departed, as before, for
      // the owner to complete from the card.
      if (arrivalLocationVerdict === 'outside' && arrivalCheckedByOwner(session)) {
        outsideRange = {
          distanceMeters: Math.round(evidence.distanceMeters ?? 0),
          radiusMeters: arrival.radiusMeters,
        };
      } else if (arrivalLocationVerdict === 'outside') {
        tx.set(sessionRef, undoStamp, { merge: true });
        return {
          kind: 'refused',
          code: ARRIVAL_RADIUS_CODE,
          description: visitOutsideRadiusWords(Math.round(evidence.distanceMeters ?? 0), arrival.radiusMeters),
        };
      }
    }

    // #1627's mirror, read before any write as a transaction requires.
    const kinfolkId = nonBlank(session['kinfolkId']);
    const batchId = nonBlank(session['kinCareBatchId']);
    const visitId = nonBlank(session['kinCareVisitId']);
    let visitRef: FirebaseFirestore.DocumentReference | null = null;
    let householdStatusBefore = '';
    if (kinfolkId !== '' && batchId !== '' && visitId !== '') {
      const ref = firestore.doc(`families/${kinfolkId}/bookings/${batchId}/kinCares/${visitId}`);
      const visit = await tx.get(ref);
      const current = (visit.data() as { status?: unknown } | undefined)?.status;
      if (visit.exists && current !== 'cancelled' && current !== 'completed') {
        visitRef = ref;
        householdStatusBefore = nonBlank(current);
      }
    }

    const due = kinTaleDueAtCompletion(session, kinTaleRequired);
    const departedAt = nonBlank(session['departedAt']);
    tx.set(
      sessionRef,
      {
        status: 'COMPLETED',
        completedAt: departedAt !== '' ? departedAt : nowIso,
        updatedAt: FieldValue.serverTimestamp(),
        ...(due ? { kinTaleDue: true } : {}),
        ...(outsideRange !== undefined ? { [COMPLETED_OUTSIDE_RANGE_FIELD]: true } : {}),
        ...undoStamp,
        ...(householdStatusBefore !== ''
          ? { [HOUSEHOLD_STATUS_BEFORE_COMPLETION_FIELD]: householdStatusBefore }
          : {}),
      },
      { merge: true },
    );
    if (visitRef !== null) {
      tx.set(visitRef, { status: 'completed', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      mirrored = 'completed';
    }
    return { kind: 'completed', kinTaleDue: due, ...(outsideRange !== undefined ? { outsideRange } : {}) };
  });

  if (outcome.kind === 'refused') {
    await audit({
      event: AUDIT_EVENTS.BOOKING_TRANSITION_REFUSED,
      severity: 'warn',
      status: 'FAILURE',
      sessionId,
      description: outcome.description,
      payload: {
        sessionId,
        action: 'COMPLETE',
        refusalCode: outcome.code,
        from: 'DEPARTED',
        attempted: 'COMPLETED',
        trigger: 'departure',
      },
    });
  } else if (outcome.kind === 'completed') {
    await audit({
      event: AUDIT_EVENTS.BOOKING_STATUS_TRANSITION,
      severity: outcome.outsideRange !== undefined ? 'warn' : 'info',
      status: 'SUCCESS',
      sessionId,
      description:
        outcome.outsideRange !== undefined
          ? visitCompletedOutsideRangeWords(
              'DEPARTED',
              outcome.outsideRange.distanceMeters,
              outcome.outsideRange.radiusMeters,
            )
          : visitTransitionWords('COMPLETE', 'DEPARTED', 'COMPLETED'),
      payload: {
        sessionId,
        action: 'COMPLETE',
        from: 'DEPARTED',
        to: 'COMPLETED',
        changed: true,
        trigger: 'departure',
        visitMirrored: mirrored,
        kinTaleDue: outcome.kinTaleDue,
        arrivalLocationVerdict,
        ...(outcome.outsideRange !== undefined ? { completedOutsideRange: true, ...outcome.outsideRange } : {}),
      },
    });
  }

  logEvent({
    severity: 'info',
    function: 'onKinCareSessionDeparted',
    event: `visit.departure.${outcome.kind}`,
    extra: { sessionId, ...(outcome.kind === 'refused' ? { code: outcome.code } : {}) },
  });
  return outcome;
}

/** Best-effort, as every audit beside a committed write is (`transitionBookingStatus`). */
async function audit(args: {
  event: AuditEvent;
  severity: 'info' | 'warn';
  status: 'SUCCESS' | 'FAILURE';
  sessionId: string;
  description: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await writeAuditEntry({
    event: args.event,
    severity: args.severity,
    status: args.status,
    actorRole: 'SYSTEM',
    targetUid: args.sessionId,
    targetCollection: 'kin_care_sessions',
    description: args.description,
    payload: args.payload,
  }).catch((err) => {
    logEvent({
      severity: 'warn',
      function: 'onKinCareSessionDeparted',
      event: 'audit.write.failed',
      errorMessage: (err as Error)?.message,
    });
  });
}

export async function onKinCareSessionDepartedHandler(
  event: FirestoreEvent<Change<DocumentSnapshot> | undefined, { sessionId: string }>,
): Promise<void> {
  const before = event.data?.before?.data() as SessionData | undefined;
  const after = event.data?.after?.data() as SessionData | undefined;
  if (!departedNow(before, after)) return;
  await completeDepartedSession(event.params.sessionId);
}

/**
 * A THIRD trigger on `kin_care_sessions`, beside `onKinCareRollup` and
 * `onKinCareSessionCalendarSync`, because it answers a different question: is
 * this visit done. No secrets beyond Sentry; it talks to nobody outside Firestore.
 */
export const onKinCareSessionDeparted = onDocumentWritten(
  {
    document: 'kin_care_sessions/{sessionId}',
    region: 'us-central1',
    secrets: ['SENTRY_DSN'],
  },
  wrapTrigger('onKinCareSessionDeparted', onKinCareSessionDepartedHandler),
);
