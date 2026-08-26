import { normalizeBookingStatus, type BookingStatus } from './bookingTransitions';

/**
 * The IN-VISIT lifecycle state machine for `kin_care_sessions`: clocking a
 * visit on the way, in, out, and undoing an arrival.
 *
 * WHY THIS IS A SECOND MACHINE AND NOT MORE ROWS IN `bookingTransitions.ts`.
 * That module governs the four OPERATOR decisions (Approve / Reject / Cancel /
 * Mark Completed), each of which has ONE fixed target status and two of which
 * are terminal. These four are a different thing: they are the running record
 * of a visit happening, one of them (UNDO_ARRIVAL) has no fixed target at all,
 * and each of them stamps a DIFFERENT timestamp field. Folding them into
 * `TARGET`/`ALLOWED_FROM` would have meant a target lookup that sometimes
 * depends on the document, which is the shape that makes a state machine stop
 * being one. The two modules share `normalizeBookingStatus` (imported above),
 * so there is exactly one answer to "what status is this row in".
 *
 * THE ALLOWED-FROM SETS ARE ANDROID'S, TRANSCRIBED, NOT REDESIGNED. The
 * reference is `HomeScreen.kt#TodayVisitCardView`'s `LifecycleButton`
 * enablement (the `enabled = ... && status == ...` lines) plus Auntie Time's
 * "Undo Arrival" (`ui/admin/KinCareSessionsScreen.kt#ActionRow`):
 *
 *   On My Way   enabled only at SCHEDULED
 *   Arrived     enabled at SCHEDULED **or** ON_MY_WAY  <- skipping On My Way is
 *               legal on Android and stays legal here. An Auntie who is already
 *               at the door has no on-my-way to declare, and refusing her the
 *               clock-in would be a rule the field app does not have.
 *   Departed    enabled only at ARRIVED  <- this is the clock-out-before-
 *               clock-in refusal, and it is Android's, not a new one.
 *   Undo        offered only at ARRIVED / DEPARTED
 *
 * ON ANDROID THOSE ARE BUTTON ENABLEMENT, WHICH IS A COURTESY, NOT A GUARD. A
 * disabled button stops a gesture; it does not stop a stale row, a second
 * operator, or a direct invocation. This module is the enforcement, and the web
 * client gates its buttons the same way for the same courtesy reason -- exactly
 * the split `bookingsWrite.ts#transitionBookingStatus` already documents for
 * `BookingActions.tsx`'s `actionsFor` map.
 *
 * A DOUBLE CLOCK-IN IS A NO-OP, NOT A REFUSAL, AND THAT IS THE GUARD. Pressing
 * "Arrived" on a session already ARRIVED returns success having written
 * NOTHING, so the original `arrivedAt` survives. That is the protection that
 * actually matters: the failure mode of a double clock-in is not an extra
 * status write (the status is already right), it is a re-stamped arrival time
 * that quietly moves when the visit started. Refusing instead would turn a
 * double-tap into a red banner about nothing, which is the ruling
 * `bookingTransitions.ts#evaluateTransition` already made for its own actions.
 */

/** The four in-visit actions this machine governs. */
export const VISIT_LIFECYCLE_ACTIONS = [
  'ON_MY_WAY',
  'ARRIVED',
  'DEPARTED',
  'UNDO_ARRIVAL',
] as const;

export type VisitLifecycleAction = (typeof VISIT_LIFECYCLE_ACTIONS)[number];

/**
 * Which statuses each action may be applied FROM. See the header for where
 * each row comes from on Android.
 */
const ALLOWED_FROM: Readonly<Record<VisitLifecycleAction, readonly BookingStatus[]>> = {
  ON_MY_WAY: ['SCHEDULED'],
  ARRIVED: ['SCHEDULED', 'ON_MY_WAY'],
  DEPARTED: ['ARRIVED'],
  UNDO_ARRIVAL: ['ARRIVED', 'DEPARTED'],
};

/**
 * Which statuses make each action a NO-OP: the row is already past or at the
 * point the action asks for, so the honest answer is "yes, that is already
 * true" with no write.
 *
 * The three forward actions each no-op on their own target status alone.
 * UNDO_ARRIVAL is the odd one, and deliberately: it has no single target (see
 * `undoArrivalTarget`), and both statuses that mean "not arrived" -- SCHEDULED
 * and ON_MY_WAY -- satisfy an undo request equally. Undoing an arrival that is
 * not there is not a mistake worth refusing; it is a request already granted.
 */
const NOOP_AT: Readonly<Record<VisitLifecycleAction, readonly BookingStatus[]>> = {
  ON_MY_WAY: ['ON_MY_WAY'],
  ARRIVED: ['ARRIVED'],
  DEPARTED: ['DEPARTED'],
  UNDO_ARRIVAL: ['SCHEDULED', 'ON_MY_WAY'],
};

export function allowedFromForLifecycle(
  action: VisitLifecycleAction,
): readonly BookingStatus[] {
  return ALLOWED_FROM[action];
}

/**
 * Where UNDO_ARRIVAL leaves the session, which is the one target this machine
 * reads off the DOCUMENT rather than off the action.
 *
 * Ports `ui/admin/KinCareSessionsScreen.kt#ActionRow`:
 *
 *     val undoTo = if (!session.onMyWayAt.isNullOrBlank()) "ON_MY_WAY" else "SCHEDULED"
 *
 * The rule is "put the visit back where it actually was", and the only evidence
 * of where it was is whether an on-my-way was ever declared.
 */
export function undoArrivalTarget(onMyWayAt: unknown): BookingStatus {
  const stamped = typeof onMyWayAt === 'string' ? onMyWayAt.trim() : '';
  return stamped === '' ? 'SCHEDULED' : 'ON_MY_WAY';
}

/** The machine's verdict. Four enumerated variants, no fall-through. */
export type VisitLifecycleDecision =
  /** Legal: write `to`, and the timestamp the handler stamps for `action`. */
  | { kind: 'apply'; from: BookingStatus; to: BookingStatus }
  /** Already true. Report success, write nothing, keep the stamped time. */
  | { kind: 'noop'; at: BookingStatus }
  /** Recognized status, wrong one for this action. */
  | {
      kind: 'illegal';
      from: BookingStatus;
      action: VisitLifecycleAction;
      allowedFrom: readonly BookingStatus[];
    }
  /** The stored status is blank, absent, or not a value this machine knows. */
  | { kind: 'unknown-status'; raw: string };

/**
 * Decides one in-visit action.
 *
 * `onMyWayAt` is only read for UNDO_ARRIVAL and is otherwise ignored; it is
 * taken as `unknown` because it comes straight off a Firestore document that
 * nothing validates (the same "cast, not validation" caveat
 * `api/sessions.ts#SessionEntry` documents on the read side).
 *
 * The no-op check runs BEFORE the legality check, matching
 * `evaluateTransition`. DEPARTED from DEPARTED is not in `ALLOWED_FROM.DEPARTED`
 * and never will be, but it is also not a mistake worth refusing.
 */
export function evaluateVisitLifecycle(args: {
  currentStatus: unknown;
  action: VisitLifecycleAction;
  onMyWayAt?: unknown;
}): VisitLifecycleDecision {
  const current = normalizeBookingStatus(args.currentStatus);
  if (current === null) {
    return {
      kind: 'unknown-status',
      raw: typeof args.currentStatus === 'string' ? args.currentStatus : '',
    };
  }

  if (NOOP_AT[args.action].includes(current)) return { kind: 'noop', at: current };

  const allowedFrom = ALLOWED_FROM[args.action];
  if (!allowedFrom.includes(current)) {
    return { kind: 'illegal', from: current, action: args.action, allowedFrom };
  }

  const to =
    args.action === 'UNDO_ARRIVAL' ? undoArrivalTarget(args.onMyWayAt) : args.action;
  return { kind: 'apply', from: current, to };
}

/** Machine-readable refusal code, mirrored by the web client's error handling. */
export const VISIT_LIFECYCLE_ILLEGAL_CODE = 'visit_lifecycle_illegal';

/** How each action reads in an operator-facing sentence. */
const ACTION_PHRASE: Readonly<Record<VisitLifecycleAction, string>> = {
  ON_MY_WAY: 'mark this visit On my way',
  ARRIVED: 'clock in to this visit',
  DEPARTED: 'clock out of this visit',
  UNDO_ARRIVAL: 'undo the arrival on this visit',
};

/**
 * Operator-facing sentence for an illegal in-visit action. Names both ends,
 * the same shape `illegalTransitionMessage` uses, because the operator's next
 * question after "no" is always "from what, then".
 */
export function illegalLifecycleMessage(
  action: VisitLifecycleAction,
  from: BookingStatus,
  allowedFrom: readonly BookingStatus[],
): string {
  return `Cannot ${ACTION_PHRASE[action]} while it is ${from}. Allowed from: ${allowedFrom.join(', ')}.`;
}

/**
 * The household notification event each action declares, or null for one that
 * declares none.
 *
 * Mirrors `notifications/VisitNotifier.kt#Event`: Android fires exactly these
 * three from `HomeViewModel`'s `onMyWay` / `arrived` / `departed`, and fires
 * NOTHING on an undo. Undoing an arrival is an operator correcting their own
 * record; there is no second message a household should receive for it, and a
 * "never mind" push would be worse than the silence.
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
