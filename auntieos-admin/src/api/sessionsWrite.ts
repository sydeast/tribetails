import { doc } from 'firebase/firestore';
import { updateDoc } from '../lib/firestoreWrite';
import { db } from '../lib/firebase';
import { call } from '../lib/fns';
import {
  auditActionTypeFor,
  evaluateVisitLifecycle,
  illegalLifecycleMessage,
  lifecyclePatchFor,
  notificationEventFor,
  unreachableLifecycleMessage,
  type VisitLifecycleSession,
} from '../lib/visitLifecyclePatch';

/**
 * The WRITE half of the Auntie Time surface (#397 L19), which `api/sessions.ts`
 * only ever read and `screens/Sessions.tsx` said in its own header was "Still
 * NOT built here".
 *
 * ── THE IN-VISIT CLOCK IS A DIRECT FIRESTORE WRITE NOW ─────────────────────
 *
 * THIS HEADER USED TO SAY THE OPPOSITE, and the sentence it led with is worth
 * quoting because it is the part that turned out to be wrong: "A browser has no
 * offline queue to protect." Two facts overtook it.
 *
 *   1. THE OPERATOR RULED THAT MOBILE WEB IS THE FIELD FALLBACK. An Auntie
 *      opens this admin on a phone, at a door, in whatever coverage the street
 *      has. The browser is not at the office desk the old comment imagined, and
 *      `lib/firebase.ts` now turns Firestore's offline queue ON for exactly
 *      that reason -- read its header for what that does and does not survive.
 *   2. THE COLD START IS MEASURED, NOT SUSPECTED (2026-09-11). Every admin
 *      callable runs at minInstances 0:
 *
 *          setVisitLifecycle         05:26:17.698 -> 05:26:25.617   7.9 s
 *          transitionBookingStatus   02:26:16.126 -> 02:26:25.491   9.4 s
 *          listPendingBookingRequests  9.0 s to start, then 669 ms of work
 *
 *      The handler is two thirds of a second. The rest is Cloud Run building a
 *      container, `cpu: 1` is already deployed, and no import trimming touches
 *      it. A field tap on "Arrived" waited out that cold start for a write
 *      Android has always done directly.
 *
 * SO THE SPLIT IS ANDROID'S NOW, TRANSCRIBED: the status patch goes straight to
 * the document, and the two things the callable also did follow it, AFTER the
 * write and never in front of it --
 *
 *   the audit entry     the `logActivity` callable (`AuditLog.fire`)
 *   the household push  `dispatchVisitNotification` (`VisitNotifier`)
 *
 * NEITHER CAN FAIL THE TAP. Android wraps both in `runCatching` for the same
 * reason: losing the operational fact (the Auntie IS at the door) because a
 * push could not be enqueued is the worse outcome. What web adds is that the
 * notification's outcome is REPORTED rather than silently dropped, so the
 * screen can say "clocked in, but the household was not notified" instead of
 * implying both.
 *
 * THE AUDIT IS STILL CHAINED. `logActivity` is what Android has routed through
 * since 2026-05-26 precisely so a client-origin entry still lands inside
 * `writeAuditEntry`'s SHA-256 hash chain, and it trusts `req.auth.uid` over any
 * client-supplied actor.
 *
 * WHAT IS GIVEN UP, in full, so the next reader is not left to discover it:
 *
 *   THE ENTRY IS NO LONGER WRITTEN BY THE FLOW THAT WRITES THE DOCUMENT, so a
 *   tab closed in between loses it. That is Android's exposure, now shared, and
 *   it is the price of the eight seconds.
 *   REFUSALS ARE NO LONGER AUDITED. The callable's `auditRefusal` wrote a
 *   `VISIT_LIFECYCLE_REFUSED` row on every illegal action, unreadable status
 *   and missing session. A client that refuses before writing has nothing to
 *   tell the server about, so nothing is recorded -- which is exactly Android's
 *   behaviour, where an illegal action is a disabled button and no more. The
 *   trail now records what HAPPENED rather than also what was attempted. Any
 *   attempt that gets past this module still meets `firestore.rules`, and a
 *   rules refusal is logged by Firestore itself.
 *   THE DECISION IS MADE FROM A SNAPSHOT, not from the document read inside the
 *   write. See `patchVisitLifecycle`'s own header.
 *
 * WHAT LIVES WHERE, so a reader does not go looking for a verb in the wrong
 * module:
 *
 *   this module   `patchVisitLifecycle`     the in-visit clock, DIRECT WRITE
 *                 `setVisitLifecycle`       the same four actions through the
 *                                           server. Off the tap path now; see
 *                                           its own header.
 *                 `updateKinCareSession`    the descriptive fields
 *   bookingsWrite `transitionBookingStatus` approve / reject / cancel /
 *                                           complete (terminal, billable)
 *                 `rescheduleBooking`       startTime / endTime, with the
 *                                           busy, closure and overlap guards
 *
 * COMPLETE AND CANCEL DID NOT MOVE AND WILL NOT. They are terminal, they decide
 * whether a visit is billable, and `mytribe/firestore.rules:487` refuses them
 * to every client:
 *
 *     allow update: if (isAuntie() || testOwnsExisting())
 *                   && bookingTerminalFieldsUntouched();
 *
 * That same line is what makes the in-visit patch legal from a browser with no
 * rules change at all: an admin may move a session between the four in-visit
 * statuses, and may not write a terminal status or touch `completedAt`.
 *
 * Every function here THROWS (never swallows) on a failed WRITE, refusals
 * included, per the fail-loud policy: the caller surfaces `err.message` rather
 * than this module deciding what the operator gets to see. The audit and the
 * notification are the two deliberate exceptions, and they are exceptions
 * because neither of them is the write.
 *
 * Types are local rather than generated. `contracts/registry.ts` is a
 * hand-written scope list and adding a line to it is a decision to publish the
 * contract; the two callables on this exact collection that these sit beside,
 * `transitionBookingStatus` and `createKinCareSession`, are both absent from
 * it, so these follow the established local-type pattern rather than
 * introducing a third convention on one collection.
 */

/**
 * The four in-visit actions `setVisitLifecycle` accepts. Mirrors the server's
 * `VISIT_LIFECYCLE_ACTIONS` (`functions/src/lib/visitLifecycle.ts`).
 */
export type VisitLifecycleAction = 'ON_MY_WAY' | 'ARRIVED' | 'DEPARTED' | 'UNDO_ARRIVAL';

export interface SetVisitLifecycleResult {
  ok: true;
  sessionId: string;
  action: VisitLifecycleAction;
  /** The status the row held before the call. Equal to `status` on a no-op. */
  from: string;
  /** The status the row holds now. */
  status: string;
  /** False when the action was already true and nothing was written. */
  changed: boolean;
  /** Whether the household was told. */
  notified: boolean;
  /** Why no notification went out, or null when one did. */
  notifySkipped: string | null;
}

interface SetVisitLifecycleArgs {
  sessionId: string;
  action: VisitLifecycleAction;
  atIso?: string;
  etaMinutes?: number;
}

/**
 * The machine-readable refusal code `setVisitLifecycle` throws with when the
 * action is illegal from the row's current status. Mirrors the server's
 * `VISIT_LIFECYCLE_ILLEGAL_CODE`; a caller matching on it must match the
 * string, not the message, which is written for the operator and will change.
 */
export const VISIT_LIFECYCLE_ILLEGAL_CODE = 'visit_lifecycle_illegal';

/** What a household push did, once it settles. Never a reason to fail a tap. */
export interface VisitNotifyOutcome {
  /** Whether the household was actually told. */
  notified: boolean;
  /** Why nobody was told, or null when somebody was. */
  notifySkipped: string | null;
}

/** What one direct in-visit write did. Mirrors {@link SetVisitLifecycleResult}. */
export interface PatchVisitLifecycleResult {
  sessionId: string;
  action: VisitLifecycleAction;
  /** The status the row held before the write. Equal to `status` on a no-op. */
  from: string;
  /** The status the row holds now. */
  status: string;
  /** False when the action was already true and NOTHING was written. */
  changed: boolean;
  /**
   * The household push, still in flight when this resolves. NEVER REJECTS, and
   * never awaited before the write returns: that ordering is the whole point of
   * the change, and awaiting it here would hand the tap back a callable's cold
   * start through the side door.
   *
   * A caller that tells the operator anything about the household must wait for
   * THIS, not for the write. Saying "notified" on the strength of the patch
   * alone is the exact lie this codebase keeps warning about.
   */
  notification: Promise<VisitNotifyOutcome>;
}

const SESSIONS_COLLECTION = 'kin_care_sessions';

/**
 * Tell the household, best-effort, through the callable Android calls.
 *
 * ROUTING IS `VisitNotifier`'s, TRANSCRIBED (and it is the same list the server
 * handler's `notifyHousehold` used): prefer the envelope pair
 * (`kinCareBatchId` + `kinCareVisitId`), fall back to the legacy flat
 * `sourceBookingId`, and when a session carries neither there is nothing to
 * route to at all -- an AuntieOS-native visit predating the kinCare envelope.
 * Android `error()`s there and swallows it in `runCatching`; here every dead end
 * is a NAMED skip reason, because a screen that cannot say why nobody was told
 * will imply somebody was.
 */
async function notifyHousehold(args: {
  action: VisitLifecycleAction;
  session: VisitLifecycleSession;
  etaMinutes: number | undefined;
}): Promise<VisitNotifyOutcome> {
  const event = notificationEventFor(args.action);
  if (event === null) return { notified: false, notifySkipped: 'no_event_for_action' };

  const familyId = (args.session.kinfolkId ?? '').trim();
  if (familyId === '') return { notified: false, notifySkipped: 'session_has_no_kinfolk' };

  const batchId = (args.session.kinCareBatchId ?? '').trim();
  const visitId = (args.session.kinCareVisitId ?? '').trim();
  const bookingId = (args.session.sourceBookingId ?? '').trim();
  const useEnvelope = batchId !== '' && visitId !== '';
  if (!useEnvelope && bookingId === '') {
    return { notified: false, notifySkipped: 'session_has_no_routing_ids' };
  }

  try {
    const res = await call<Record<string, unknown>, { dispatchIds?: string[]; suppressed?: boolean }>(
      'dispatchVisitNotification',
      {
        familyId,
        ...(useEnvelope ? { batchId, visitId } : { bookingId }),
        event,
        ...(args.etaMinutes !== undefined ? { etaMinutes: args.etaMinutes } : {}),
      },
    );
    const suppressed = res.suppressed ?? (res.dispatchIds ?? []).length === 0;
    return suppressed
      ? { notified: false, notifySkipped: 'household_prefs_suppressed' }
      : { notified: true, notifySkipped: null };
  } catch (err) {
    // Logged, not thrown, and not surfaced as an error state: the visit is
    // already clocked. The operator learns the household was not told from
    // `notifySkipped`, which is the honest half of the sentence.
    console.warn('[visitLifecycle] household notification failed', err);
    return { notified: false, notifySkipped: 'dispatch_failed' };
  }
}

/**
 * Write the audit entry for one in-visit action, through the same `logActivity`
 * callable Android uses, and swallow every failure.
 *
 * SWALLOWING IS THE CONTRACT, not a shortcut, and `AuditLog.fire`'s own KDoc is
 * the precedent: "Failures are swallowed at the call site - callers must not
 * block their UI on the audit write". The console warning is the dev-log
 * equivalent of Android's `AuntieLog.e`, so a dropped audit is never silent to
 * a developer even though it is invisible to the operator.
 */
async function fireLifecycleAudit(args: {
  action: VisitLifecycleAction;
  sessionId: string;
  from: string;
  to: string;
}): Promise<void> {
  try {
    await call('logActivity', {
      actionType: auditActionTypeFor(args.action),
      description: `${args.action} on session ${args.sessionId}: ${args.from} -> ${args.to}`,
      status: 'SUCCESS',
      targetId: args.sessionId,
      targetCollection: SESSIONS_COLLECTION,
    });
  } catch (err) {
    console.warn('[visitLifecycle] audit entry failed', err);
  }
}

/**
 * THE FIELD TAP: On my way / Arrived / Departed / Undo arrival, written STRAIGHT
 * TO FIRESTORE, then audited and announced behind it.
 *
 * WHY THIS REPLACED THE CALLABLE ON THE TAP PATH is the module header. What
 * matters when reading the code: the four transitions this writes are exactly
 * the ones `firestore.rules` lets an admin write, the field set is
 * `lib/visitLifecyclePatch.ts`'s and is Android's field for field, and the two
 * things behind the `await` cannot reach back and fail it.
 *
 * IT DECIDES AGAINST THE SNAPSHOT THE SCREEN IS HOLDING, which is the one thing
 * given up. The server read the document inside the same flow that wrote it, so
 * a stale row or a second operator was refused; here a screen looking at a
 * fifteen-second-old row can write from it. That is Android's exposure — it
 * decides from `runOnSession`'s card — and it is the accepted trade. Three
 * things bound it: `firestore.rules` still refuses anything terminal, the
 * no-op check below still refuses to re-stamp a time that is already there, and
 * `SessionDetail`'s snapshot is a LIVE subscription rather than a fetch.
 *
 * A DELETED SESSION FAILS LOUD. `updateDoc` (not `setDoc`) rejects on a missing
 * document rather than resurrecting it with three fields, which is the same
 * choice `api/inboxChannelsWrite.ts` documents for the same reason.
 *
 * THROWS, with the operator's sentence already in `err.message`, when the
 * action is illegal from where the visit is or when the visit is somewhere this
 * machine does not reach at all (COMPLETED / CANCELLED / unreadable). The
 * caller surfaces the message; it does not compose one.
 *
 * @param session the row the screen is showing. Needs `_id` and `status` at
 *                minimum; `onMyWayAt` decides where an undo rewinds to, and the
 *                routing ids decide whether anyone can be notified.
 * @param nowIso  the caller's "now", which is also what lands on the stamped
 *                field. Passed in rather than taken here so the format stays
 *                `lib/sessionLifecycle.ts#lifecycleNowIso`'s and is testable
 *                without freezing a clock.
 */
export async function patchVisitLifecycle(
  session: VisitLifecycleSession,
  action: VisitLifecycleAction,
  options: { nowIso: string; etaMinutes?: number | undefined },
): Promise<PatchVisitLifecycleResult> {
  const decision = evaluateVisitLifecycle({
    status: session.status,
    action,
    onMyWayAt: session.onMyWayAt,
  });

  if (decision.kind === 'unreachable') {
    throw new Error(unreachableLifecycleMessage(action, decision.raw));
  }
  if (decision.kind === 'illegal') {
    throw Object.assign(
      new Error(illegalLifecycleMessage(action, decision.from, decision.allowedFrom)),
      { details: { code: VISIT_LIFECYCLE_ILLEGAL_CODE } },
    );
  }
  if (decision.kind === 'noop') {
    // Already true, so NOTHING is written and nobody is told a second time.
    // This is the branch that stops a double tap from moving `arrivedAt`.
    return {
      sessionId: session._id,
      action,
      from: decision.at,
      status: decision.at,
      changed: false,
      notification: Promise.resolve({ notified: false, notifySkipped: 'already_in_this_state' }),
    };
  }

  await updateDoc(
    doc(db, SESSIONS_COLLECTION, session._id),
    lifecyclePatchFor({
      action,
      to: decision.to,
      nowIso: options.nowIso,
      etaMinutes: options.etaMinutes,
    }),
  );

  // BOTH OF THESE START AFTER THE WRITE HAS ACKED AND NEITHER IS AWAITED HERE.
  // `void` on the audit is not carelessness: it is the same fire-and-forget
  // `AuditLog.fire` launches into `viewModelScope`, and `fireLifecycleAudit`
  // already swallows its own failure, so there is no rejection to leak.
  void fireLifecycleAudit({
    action,
    sessionId: session._id,
    from: decision.from,
    to: decision.to,
  });

  return {
    sessionId: session._id,
    action,
    from: decision.from,
    status: decision.to,
    changed: true,
    notification: notifyHousehold({ action, session, etaMinutes: options.etaMinutes }),
  };
}

/**
 * `setVisitLifecycle` (admin callable): On my way / Arrived / Departed / Undo
 * arrival on one `kin_care_sessions` row.
 *
 * NO LONGER ON THE FIELD-TAP PATH. `patchVisitLifecycle` above is what the
 * clock buttons call now, because this one paid a 7.9 s Cloud Run cold start
 * for 0.67 s of work (the module header has the measurements). This wrapper and
 * the callable behind it are BOTH kept, deployed and working: the callable is
 * still the only path that reads the document server-side before deciding, it
 * still audits inside the same flow that writes, and it is what any non-browser
 * caller should use. Deleting either would remove the escape hatch if the
 * direct write turns out to be wrong, and this tree's standing rule is that
 * unreachable code gets fixed, not deleted.
 *
 * THE STATE MACHINE IS SERVER-SIDE AND THIS FUNCTION DOES NOT SECOND-GUESS IT,
 * the same split `transitionBookingStatus` documents. `lib/sessionLifecycle.ts`
 * decides which buttons the screen OFFERS, which is a courtesy so the operator
 * is not shown a control that will fail -- exactly what Android's
 * `LifecycleButton` `enabled =` gates are. A stale row, a second operator or a
 * direct invocation all reach the server, which refuses with
 * `failed-precondition` and a `details.code` of `visit_lifecycle_illegal` (or
 * `booking_status_unknown` for a row whose status it cannot read) and audits
 * the attempt either way.
 *
 * A DOUBLE CLOCK-IN RESOLVES, IT DOES NOT REJECT: the server returns
 * `changed: false` having written nothing, so the original `arrivedAt` is
 * preserved rather than moved. Callers should read `changed` before telling the
 * operator anything happened.
 *
 * `atIso` is the CALLER's "now", kept because every reader of this collection
 * already parses a client-stamped ISO string (`lib/sessionFormat.ts`,
 * Android's `DashboardInsights.kt`). Omitted, the server stamps its own.
 */
export async function setVisitLifecycle(
  sessionId: string,
  action: VisitLifecycleAction,
  options: { atIso?: string; etaMinutes?: number } = {},
): Promise<SetVisitLifecycleResult> {
  return call<SetVisitLifecycleArgs, SetVisitLifecycleResult>('setVisitLifecycle', {
    sessionId,
    action,
    ...(options.atIso !== undefined ? { atIso: options.atIso } : {}),
    ...(options.etaMinutes !== undefined ? { etaMinutes: options.etaMinutes } : {}),
  });
}

/**
 * The fields `updateKinCareSession` will change. Every one is OPTIONAL and the
 * server writes only the keys that are stated, which is the point: this
 * collection carries fields no edit form will ever show (`gpsSummary`,
 * `visitRouteId`, `reportIds`, `invoiceId`, and the `_backfilledFrom` /
 * `_backfilledAt` / `_reason` provenance on the migration stub sessions), and a
 * rebuild-from-form-state save would wipe every one of them.
 */
export interface KinCareSessionEdit {
  /** A `serviceRates` key, not free text: pricing is by this exact name. */
  serviceType?: string;
  /** Admin-internal notes, replaced wholesale. */
  notes?: string;
  serviceDurationMinutes?: number;
  /**
   * R1: which Kin this visit covers. An EMPTY array means the WHOLE HOUSEHOLD,
   * not "no Kin" -- the server expands it through `materializeKinRoster` and
   * re-resolves `kinNames` in the same write, so the two cannot drift.
   */
  kinIds?: string[];
}

export interface UpdateKinCareSessionResult {
  ok: true;
  sessionId: string;
  /** The field names actually written. */
  updated: string[];
}

/**
 * `updateKinCareSession` (admin callable): edit the descriptive fields of one
 * visit.
 *
 * DELIBERATELY CANNOT TOUCH: `status` / `completedAt` (terminal and billable --
 * `transitionBookingStatus`), the lifecycle stamps (`setVisitLifecycle`),
 * `startTime` / `endTime` (`rescheduleBooking`, which runs the busy-calendar,
 * company-closure and visit-overlap guards a plain field edit would route
 * around), or `kinfolkId` (re-homing a visit is not an edit). The server
 * rejects those keys by simply not having them in its schema.
 *
 * Throws on `not-found` (the session is gone), `invalid-argument` (an
 * out-of-bounds value, or a patch that states no field at all) and auth
 * errors; the caller surfaces the message fail-loud.
 */
export async function updateKinCareSession(
  sessionId: string,
  edit: KinCareSessionEdit,
): Promise<UpdateKinCareSessionResult> {
  return call<{ sessionId: string } & KinCareSessionEdit, UpdateKinCareSessionResult>(
    'updateKinCareSession',
    { sessionId, ...edit },
  );
}
