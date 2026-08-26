import { call } from '../lib/fns';

/**
 * The WRITE half of the Auntie Time surface (#397 L19), which `api/sessions.ts`
 * only ever read and `screens/Sessions.tsx` said in its own header was "Still
 * NOT built here".
 *
 * EVERY WRITE BELOW IS A CALLABLE, and there is deliberately no direct
 * `updateDoc` anywhere in this module. Android drives the same lifecycle by
 * patching `kin_care_sessions` straight from the phone, and that is a
 * concession its own repository documents -- "IN-VISIT telemetry from a phone
 * that is regularly offline between houses, and Firestore's offline write queue
 * is what makes them land at all" (`KinCareRepository#markSessionComplete`). A
 * browser has no offline queue to protect and would give up the two things the
 * callable buys: an audit entry bound to the mutation rather than fired from
 * the client afterwards, and the household notification, which on Android is a
 * SECOND client call (`VisitNotifier`) that any other writer simply skips.
 *
 * WHAT LIVES WHERE, so a reader does not go looking for a verb in the wrong
 * module. Four callables own the four kinds of write to one session document:
 *
 *   this module   `setVisitLifecycle`      the in-visit clock
 *                 `updateKinCareSession`   the descriptive fields
 *   bookingsWrite `transitionBookingStatus` approve / reject / cancel /
 *                                           complete (terminal, billable)
 *                 `rescheduleBooking`       startTime / endTime, with the
 *                                           busy, closure and overlap guards
 *
 * Both functions here THROW (never swallow) on any callable failure, refusals
 * included, per the fail-loud policy: the caller surfaces `err.message` rather
 * than this module deciding what the operator gets to see.
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

/**
 * `setVisitLifecycle` (admin callable): On my way / Arrived / Departed / Undo
 * arrival on one `kin_care_sessions` row.
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
