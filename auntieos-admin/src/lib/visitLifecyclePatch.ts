import { sessionState, type SessionState } from './sessionFormat';
import { type VisitLifecycleAction } from '../api/sessionsWrite';

/**
 * THE IN-VISIT CLOCK, DECIDED AND SPELLED AS A FIRESTORE PATCH, on the client.
 *
 * WHY THIS EXISTS AT ALL. Until now the web admin's "On my way", "Arrived" and
 * "Departed" each went through the `setVisitLifecycle` callable, and every
 * admin callable runs at minInstances 0. The measurement that started this
 * (2026-09-11) is not a suspicion:
 *
 *     setVisitLifecycle          05:26:17.698 -> 05:26:25.617   7.9 s
 *     transitionBookingStatus    02:26:16.126 -> 02:26:25.491   9.4 s
 *     listPendingBookingRequests 09-10 01:45   9.0 s start, then 669 ms of work
 *
 * The HANDLER takes about two thirds of a second. The other eight seconds are
 * Cloud Run starting a container, and `cpu: 1` is already deployed, so no
 * amount of import trimming touches it. An Auntie standing at a door tapping
 * "Arrived" waits out a cold start for a write Android has always done
 * directly.
 *
 * SO WEB NOW DOES WHAT ANDROID DOES, and the shape is Android's, transcribed
 * rather than redesigned:
 *
 *   the status patch   a direct Firestore write (`KinCareRepository` :253-271,
 *                      `KinCareSessionsScreen#undoArrivalPatch`)
 *   the audit entry    the `logActivity` callable, fired AFTER the patch and
 *                      never awaited in front of it (`AuditLog.fire`)
 *   the household push `dispatchVisitNotification`, likewise after
 *                      (`VisitNotifier`)
 *
 * COMPLETED AND CANCELLED DO NOT COME HERE AND NEVER WILL. They are terminal
 * and they decide whether a visit is billable, so they stay on
 * `transitionBookingStatus`, and `mytribe/firestore.rules`'s
 * `bookingTerminalFieldsUntouched()` refuses them to every client anyway. That
 * rule is also what makes everything below safe to write from a browser:
 *
 *     allow update: if (isAuntie() || testOwnsExisting())
 *                   && bookingTerminalFieldsUntouched();   (firestore.rules:487)
 *
 * A client may move a session between the four in-visit statuses; it may not
 * write a terminal status and it may not touch `completedAt`. No rules change
 * was needed for this, and none was made.
 *
 * WHAT THE CLIENT LOSES BY NOT CALLING THE SERVER, stated plainly so nobody
 * reads this module as a claim that the callable was pointless: the server read
 * the CURRENT document inside the same flow that wrote it, so a stale row or a
 * second operator was refused. Here the decision is made against the snapshot
 * the screen is already holding. That is Android's exposure too, and it is the
 * accepted trade for the eight seconds. The rules remain the fence that
 * matters; the state machine below is a courtesy, exactly as
 * `sessionLifecycle.ts#lifecycleActionsFor` has always been for the buttons.
 *
 * The callable is still deployed and still the only path for anything terminal.
 * See `api/sessionsWrite.ts` for what still calls it.
 */

/** The four in-visit statuses this module moves a session between. */
type LifecycleStatus = 'SCHEDULED' | 'ON_MY_WAY' | 'ARRIVED' | 'DEPARTED';

/**
 * Which statuses each action may be applied FROM. Ported from
 * `functions/src/lib/visitLifecycle.ts#ALLOWED_FROM`, which took them in turn
 * from Android's `LifecycleButton` `enabled =` gates. ARRIVED is legal from
 * SCHEDULED as well as ON_MY_WAY on purpose: an Auntie already at the door has
 * no on-my-way to declare, and neither app makes her fake one.
 */
const ALLOWED_FROM: Readonly<Record<VisitLifecycleAction, readonly LifecycleStatus[]>> = {
  ON_MY_WAY: ['SCHEDULED'],
  ARRIVED: ['SCHEDULED', 'ON_MY_WAY'],
  DEPARTED: ['ARRIVED'],
  UNDO_ARRIVAL: ['ARRIVED', 'DEPARTED'],
};

/**
 * Which statuses make each action a NO-OP rather than a refusal.
 *
 * THIS IS THE GUARD THAT ACTUALLY MATTERS ON A DOUBLE TAP, and it is the one
 * thing the server did that a client must keep doing. Pressing "Arrived" on a
 * session already ARRIVED must write NOTHING: the status is already right, so
 * the only effect of a second write would be to re-stamp `arrivedAt` and
 * quietly move when the visit started. Refusing instead would turn a double tap
 * into a red banner about nothing.
 *
 * UNDO_ARRIVAL no-ops at both statuses that mean "not arrived": undoing an
 * arrival that is not there is a request already granted.
 */
const NOOP_AT: Readonly<Record<VisitLifecycleAction, readonly LifecycleStatus[]>> = {
  ON_MY_WAY: ['ON_MY_WAY'],
  ARRIVED: ['ARRIVED'],
  DEPARTED: ['DEPARTED'],
  UNDO_ARRIVAL: ['SCHEDULED', 'ON_MY_WAY'],
};

/** `SessionState` (the screen's vocabulary) back to the stored status string. */
const STATUS_OF: Readonly<Partial<Record<SessionState, LifecycleStatus>>> = {
  scheduled: 'SCHEDULED',
  onMyWay: 'ON_MY_WAY',
  arrived: 'ARRIVED',
  departed: 'DEPARTED',
};

/** The document field each forward action stamps. */
const STAMP_FIELD: Readonly<Record<Exclude<VisitLifecycleAction, 'UNDO_ARRIVAL'>, string>> = {
  ON_MY_WAY: 'onMyWayAt',
  ARRIVED: 'arrivedAt',
  DEPARTED: 'departedAt',
};

/** How each action reads in an operator-facing sentence. Ports `ACTION_PHRASE`. */
const ACTION_PHRASE: Readonly<Record<VisitLifecycleAction, string>> = {
  ON_MY_WAY: 'mark this visit On my way',
  ARRIVED: 'clock in to this visit',
  DEPARTED: 'clock out of this visit',
  UNDO_ARRIVAL: 'undo the arrival on this visit',
};

/**
 * The fields of a session this module reads. A structural subset of
 * `api/sessions.ts#SessionEntry`, so a screen hands its `entry` straight in.
 *
 * EVERY FIELD IS OPTIONAL BECAUSE THE DOCUMENT IS A CAST, not validated data:
 * the same caveat `SessionEntry` carries on every one of its own fields.
 */
export interface VisitLifecycleSession {
  _id: string;
  status?: string | undefined;
  /** Decides where an undone arrival goes BACK to. Never cleared by an undo. */
  onMyWayAt?: string | undefined;
  /** The household. Absent means there is nobody to notify. */
  kinfolkId?: string | undefined;
  kinCareBatchId?: string | undefined;
  kinCareVisitId?: string | undefined;
  sourceBookingId?: string | undefined;
}

/** The verdict on one tap. Four variants, no fall-through. */
export type VisitLifecycleDecision =
  /** Legal: write `patch`, and tell the operator `from` became `to`. */
  | { kind: 'apply'; from: LifecycleStatus; to: LifecycleStatus }
  /** Already true. Report success, write nothing, keep the stamped time. */
  | { kind: 'noop'; at: LifecycleStatus }
  /** A status this machine knows, but the wrong one for this action. */
  | { kind: 'illegal'; from: LifecycleStatus; allowedFrom: readonly LifecycleStatus[] }
  /** Blank, absent, terminal, or a status nothing recognizes. */
  | { kind: 'unreachable'; raw: string };

/**
 * Where UNDO_ARRIVAL leaves the session, the one target read off the DOCUMENT
 * rather than off the action.
 *
 * Ports `KinCareSessionsScreen.kt#ActionRow`:
 *
 *     val undoTo = if (!session.onMyWayAt.isNullOrBlank()) "ON_MY_WAY" else "SCHEDULED"
 *
 * The rule is "put the visit back where it actually was", and the only evidence
 * of where it was is whether an on-my-way was ever declared.
 */
export function undoArrivalTarget(onMyWayAt: unknown): LifecycleStatus {
  const stamped = typeof onMyWayAt === 'string' ? onMyWayAt.trim() : '';
  return stamped === '' ? 'SCHEDULED' : 'ON_MY_WAY';
}

/**
 * Decides one in-visit action against the snapshot the screen is holding.
 *
 * The no-op check runs BEFORE the legality check, matching the server's
 * `evaluateVisitLifecycle`. DEPARTED from DEPARTED is not in
 * `ALLOWED_FROM.DEPARTED` and never will be, but it is also not a mistake worth
 * refusing.
 *
 * COMPLETED and CANCELLED land in `unreachable`, not `illegal`, and the
 * distinction is deliberate: they are not a wrong step in this machine, they
 * are outside it. `transitionBookingStatus` owns them and the rules refuse them
 * to every client.
 */
export function evaluateVisitLifecycle(args: {
  status: string | undefined;
  action: VisitLifecycleAction;
  onMyWayAt?: string | undefined;
}): VisitLifecycleDecision {
  const raw = args.status ?? '';
  const current = STATUS_OF[sessionState(raw)];
  if (current === undefined) return { kind: 'unreachable', raw: raw.trim() };

  if (NOOP_AT[args.action].includes(current)) return { kind: 'noop', at: current };

  const allowedFrom = ALLOWED_FROM[args.action];
  if (!allowedFrom.includes(current)) return { kind: 'illegal', from: current, allowedFrom };

  const to =
    args.action === 'UNDO_ARRIVAL' ? undoArrivalTarget(args.onMyWayAt) : (args.action as LifecycleStatus);
  return { kind: 'apply', from: current, to };
}

/**
 * The exact field map one action writes. THE ANDROID FIELD SET, FIELD FOR
 * FIELD; the comparison to make when reviewing this is against
 * `KinCareRepository` :253-271 and `KinCareSessionsScreen#undoArrivalPatch`,
 * not against the callable's patch.
 *
 * `updatedAt` IS AN ISO STRING, NOT `serverTimestamp()`. The callable wrote a
 * server timestamp; Android's `patchSession` writes `Instant.now().toString()`,
 * and a browser that queued a write offline has no server clock to ask anyway.
 * Nothing reads this field, so matching Android costs nothing and keeps one
 * collection from carrying two types on one key.
 *
 * `updatedBy` is NOT written, also matching Android. Who did it lives in the
 * audit entry, which is signed with the server's own view of the actor
 * (`logActivity` trusts `req.auth.uid`, never a client-supplied id). A
 * client-written `updatedBy` would be the weaker of the two records, not a
 * second one.
 *
 * ON_MY_WAY omits `etaMinutesAway` unless an ETA was actually declared. The web
 * clock has no ETA input and Android's Auntie Time card sends none either;
 * writing a 0 would put "arriving in 0 minutes" on the document and into the
 * household's notification.
 */
export function lifecyclePatchFor(args: {
  action: VisitLifecycleAction;
  to: LifecycleStatus;
  nowIso: string;
  etaMinutes?: number | undefined;
}): Record<string, string | number> {
  const patch: Record<string, string | number> = {
    status: args.to,
    updatedAt: args.nowIso,
  };

  if (args.action === 'UNDO_ARRIVAL') {
    // `arrivedAt` is cleared to `""` rather than deleted, which is this
    // collection's own spelling for "cleared". The server reads a non-numeric
    // value on these fields as "no evidence" (`readArrivalEvidence`), and every
    // reader that does `.slice(0, 10)` or `.trim()` on a timestamp keeps
    // working.
    patch.arrivedAt = '';
    // ISSUE #608: `departedAt` goes with it. Undo is offered from DEPARTED as
    // well as ARRIVED, so leaving it behind produced a session whose status said
    // it had not started and whose document still carried the moment it ended.
    // `missingVisitSteps` (`functions/src/lib/arrivalVerification.ts`) reads the
    // two together to gate a COMPLETE, so the stale half let a later re-arrival
    // complete against a departure the operator had explicitly undone.
    patch.departedAt = '';
    // ISSUE #582: the arrival-location evidence belongs to the arrival being
    // undone. Left behind, the NEXT arrival (quite possibly at a different
    // door, quite possibly offline and so with no measurement of its own)
    // inherits it, and wrong evidence can refuse a COMPLETE that should pass as
    // easily as pass one that should be refused.
    patch.arrivalDistanceMeters = '';
    patch.arrivalAccuracyMeters = '';
    patch.arrivalLocationCheckedAt = '';
    // NOT cleared, deliberately: `onMyWayAt`, which is the leg being rewound TO
    // and so is what chose `to` above; `completedAt`, unreachable because undo
    // is only offered from ARRIVED and DEPARTED and fenced by the rules
    // regardless; and `etaMinutesAway`, left alone to match Android.
    return patch;
  }

  patch[STAMP_FIELD[args.action]] = args.nowIso;
  if (args.action === 'ARRIVED') {
    // Android sends `visitRouteId = ""` on arrival and lets the GPS service
    // fill it in once tracking starts (`HomeViewModel#arrived`). The browser
    // tracker (`lib/visitTracking.ts`) writes breadcrumbs, never this field, so
    // on web the empty string is simply the honest "no route yet".
    patch.visitRouteId = '';
  }
  if (args.action === 'ON_MY_WAY' && args.etaMinutes !== undefined) {
    patch.etaMinutesAway = args.etaMinutes;
  }
  return patch;
}

/**
 * Operator-facing sentence for an action this session cannot take. Names both
 * ends, the shape `illegalLifecycleMessage` uses on the server, because the
 * operator's next question after "no" is always "from what, then".
 */
export function illegalLifecycleMessage(
  action: VisitLifecycleAction,
  from: LifecycleStatus,
  allowedFrom: readonly LifecycleStatus[],
): string {
  return `Cannot ${ACTION_PHRASE[action]} while it is ${from}. Allowed from: ${allowedFrom.join(', ')}.`;
}

/** Operator-facing sentence for a status outside the in-visit machine entirely. */
export function unreachableLifecycleMessage(
  action: VisitLifecycleAction,
  raw: string,
): string {
  const named = raw === '' ? 'has no status on file' : `is ${raw}`;
  return `Cannot ${ACTION_PHRASE[action]}: this visit ${named}.`;
}

/**
 * The household notification event each action declares, or null for one that
 * declares none.
 *
 * Mirrors `VisitNotifier.kt#Event`: Android fires exactly these three and fires
 * NOTHING on an undo. Undoing an arrival is an operator correcting their own
 * record; a "never mind" push would be worse than the silence.
 */
export function notificationEventFor(
  action: VisitLifecycleAction,
): 'on_my_way' | 'arrived' | 'departed' | null {
  switch (action) {
    case 'ON_MY_WAY':
      return 'on_my_way';
    case 'ARRIVED':
      return 'arrived';
    case 'DEPARTED':
      return 'departed';
    case 'UNDO_ARRIVAL':
      return null;
  }
}

/**
 * The audit `actionType` each action emits, SCREAMING_SNAKE because
 * `logActivity` rejects anything else at its zod boundary.
 *
 * The three forward ones are Android's own strings (`HomeViewModel`'s
 * `VISIT_ON_MY_WAY` / `VISIT_ARRIVED` / `VISIT_DEPARTED`), so one activity feed
 * reads the same whichever app the Auntie had in her hand.
 *
 * `VISIT_UNDO_ARRIVAL` has no Android counterpart: Android's undo goes through
 * `AdminDataViewModel#patchKinCareSession`, which audits nothing. It is kept
 * here rather than dropped to match Android, because the callable this replaces
 * DID audit an undo, and an undo is the one action in this set that erases
 * stamped times, and losing its trail would be a regression dressed as parity.
 * Android should follow; filed as the gap it is, not silently mirrored.
 */
export function auditActionTypeFor(action: VisitLifecycleAction): string {
  return `VISIT_${action}`;
}
