/**
 * The booking status state machine for `kin_care_sessions`.
 *
 * WHY THIS EXISTS. Until now the four operator transitions on a session
 * (Approve / Reject / Cancel / Mark Completed) were a bare client patch:
 * `auntieos-admin/src/api/bookingsWrite.ts` did
 * `updateDoc(doc(db, 'kin_care_sessions', id), { status })`, gated only by
 * `firestore.rules`'s `isAuntie()`. Any status string could be written from any
 * status, and nothing recorded who did it or what it moved from. Reschedule on
 * the same document has been server-bound and audited since 1E §A.9
 * (`rescheduleBooking.ts`); the status transitions were the gap.
 *
 * The machine is a PURE module so the legality question has its own tests and
 * so the handler cannot answer it a second, slightly different way. Every
 * decision it returns is an enumerated variant: nothing is reached by
 * elimination, and an unrecognized stored status gets its own named outcome
 * rather than being absorbed into whichever branch happens to be last. That is
 * the same discipline `auntieos-admin/src/lib/bookingFormat.ts#bookingState`
 * follows on the read side.
 */

/**
 * Every status this machine recognizes on a `kin_care_sessions` doc.
 *
 *  - DRAFT / PENDING       the two pre-approval outcomes a booking request
 *                          lands in (BookingScreen.kt "Save draft" / "Submit
 *                          request").
 *  - SCHEDULED             an approved, not yet started visit. Written by
 *                          `createKinCareSession.ts` and
 *                          `approveBookingSeriesCore.ts`.
 *  - ON_MY_WAY / ARRIVED / DEPARTED
 *                          the in-visit lifecycle the field app drives
 *                          (`KinCareRepository.markSessionOnMyWay` and
 *                          siblings). Not operator transitions, but a visit
 *                          reaches Complete and Cancel FROM them, so they are
 *                          legal sources here.
 *  - COMPLETED / CANCELLED terminal.
 */
export const BOOKING_STATUSES = [
  'DRAFT',
  'PENDING',
  'SCHEDULED',
  'ON_MY_WAY',
  'ARRIVED',
  'DEPARTED',
  'COMPLETED',
  'CANCELLED',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** The four operator transitions this machine governs. */
export const BOOKING_ACTIONS = ['APPROVE', 'REJECT', 'CANCEL', 'COMPLETE'] as const;

export type BookingAction = (typeof BOOKING_ACTIONS)[number];

/**
 * Stored spellings that mean CANCELLED but are not it.
 *
 * `CANCELED` is the American spelling some older rows carry, and `REJECTED` is
 * a MyTribe-side value that never had a distinct meaning on this collection.
 * `BookingScreen.kt`'s `CANCELLED_STATUSES` and the admin's `bookingFormat.ts`
 * both already fold these three into one bucket on READ; folding them here too
 * is what stops "cancel an already-cancelled visit" from reading as an illegal
 * transition purely because of how the row was spelled years ago.
 *
 * They are read aliases ONLY. Every write this machine authorizes emits the
 * canonical `CANCELLED`.
 */
const STATUS_ALIASES: Readonly<Record<string, BookingStatus>> = {
  CANCELED: 'CANCELLED',
  REJECTED: 'CANCELLED',
};

const KNOWN: ReadonlySet<string> = new Set<string>(BOOKING_STATUSES);

/**
 * Canonicalizes a stored status string, or returns null when the row holds
 * something this machine does not recognize (including a blank or absent
 * status). Null is a REFUSAL signal, never a default: a session whose status
 * cannot be read is not a session whose status may be guessed at.
 */
export function normalizeBookingStatus(raw: unknown): BookingStatus | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === '') return null;
  const aliased = STATUS_ALIASES[upper];
  if (aliased !== undefined) return aliased;
  return KNOWN.has(upper) ? (upper as BookingStatus) : null;
}

/** Where each action leaves the session. */
const TARGET: Readonly<Record<BookingAction, BookingStatus>> = {
  APPROVE: 'SCHEDULED',
  REJECT: 'CANCELLED',
  CANCEL: 'CANCELLED',
  COMPLETE: 'COMPLETED',
};

/**
 * Which statuses each action may be applied FROM.
 *
 * REJECT AND CANCEL LAND ON THE SAME STATUS AND ARE STILL DIFFERENT ACTIONS,
 * and the difference is the source set, which is the whole point of writing
 * this down:
 *
 *   REJECT turns down a request that was never approved (DRAFT / PENDING). No
 *   visit was ever promised to the household, nothing was put on a calendar,
 *   and nothing is billable.
 *
 *   CANCEL calls off a visit that HAD been approved (SCHEDULED, or already in
 *   flight at ON_MY_WAY / ARRIVED / DEPARTED). The household was told it was
 *   happening, and a partially-performed visit may still be billable.
 *
 * The stored status collapses both to `CANCELLED` because this collection has
 * no distinct "rejected" value and inventing one would break every existing
 * reader. The audit trail is where the distinction survives: the entry records
 * the action the operator chose AND the status it came from, so "declined a
 * request" and "called off a promised visit" are still two different events
 * after the fact. `batchUpdateBookings.ts` keeps the same distinction on the
 * sibling envelope model for the same reason.
 */
const ALLOWED_FROM: Readonly<Record<BookingAction, readonly BookingStatus[]>> = {
  APPROVE: ['DRAFT', 'PENDING'],
  REJECT: ['DRAFT', 'PENDING'],
  CANCEL: ['SCHEDULED', 'ON_MY_WAY', 'ARRIVED', 'DEPARTED'],
  COMPLETE: ['SCHEDULED', 'ON_MY_WAY', 'ARRIVED', 'DEPARTED'],
};

export function targetStatusFor(action: BookingAction): BookingStatus {
  return TARGET[action];
}

export function allowedFromFor(action: BookingAction): readonly BookingStatus[] {
  return ALLOWED_FROM[action];
}

/** The machine's verdict. Four enumerated variants, no fall-through. */
export type TransitionDecision =
  /** Legal: write `to`. */
  | { kind: 'apply'; from: BookingStatus; to: BookingStatus }
  /** Already there. Report success, write nothing. */
  | { kind: 'noop'; at: BookingStatus }
  /** Recognized status, wrong one for this action. */
  | { kind: 'illegal'; from: BookingStatus; to: BookingStatus; allowedFrom: readonly BookingStatus[] }
  /** The stored status is blank, absent, or not a value this machine knows. */
  | { kind: 'unknown-status'; raw: string };

/**
 * Decides one transition.
 *
 * IDEMPOTENCE IS SUCCESS, NOT AN ERROR. A session already in the action's
 * target status returns `noop`: the operator asked for a state the row is
 * already in, and the two clients that reach this both retry on failure, so
 * refusing would turn a double-tap into a red banner about nothing.
 * `batchUpdateBookings.ts` already treats an already-target visit as updated
 * with no write; this matches it rather than inventing a second convention.
 *
 * The noop check runs BEFORE the legality check on purpose. CANCEL from
 * CANCELLED is not in `ALLOWED_FROM.CANCEL` and never will be, but it is also
 * not a mistake worth refusing.
 */
export function evaluateTransition(args: {
  currentStatus: unknown;
  action: BookingAction;
}): TransitionDecision {
  const current = normalizeBookingStatus(args.currentStatus);
  if (current === null) {
    return {
      kind: 'unknown-status',
      raw: typeof args.currentStatus === 'string' ? args.currentStatus : '',
    };
  }

  const to = targetStatusFor(args.action);
  if (current === to) return { kind: 'noop', at: current };

  const allowedFrom = allowedFromFor(args.action);
  if (!allowedFrom.includes(current)) {
    return { kind: 'illegal', from: current, to, allowedFrom };
  }
  return { kind: 'apply', from: current, to };
}

/** Machine-readable refusal codes, mirrored by both clients' error handling. */
export const BOOKING_TRANSITION_ILLEGAL_CODE = 'booking_transition_illegal';
export const BOOKING_STATUS_UNKNOWN_CODE = 'booking_status_unknown';

/** Operator-facing sentence for an illegal transition. Names both ends. */
export function illegalTransitionMessage(
  action: BookingAction,
  from: BookingStatus,
  allowedFrom: readonly BookingStatus[],
): string {
  return `Cannot ${action} a booking in status ${from}. Allowed from: ${allowedFrom.join(', ')}.`;
}

/** Operator-facing sentence for a status this machine cannot read. */
export function unknownStatusMessage(raw: string): string {
  const shown = raw.trim() === '' ? '(blank)' : raw.trim();
  return `Booking status '${shown}' is not a status this app recognizes, so no transition can be applied to it.`;
}

/**
 * Appends the operator's cancellation reason to a session's existing notes.
 *
 * Ports the format `EnhancedSchedulingViewModel#bridgeCancellationToSession`
 * used on Android, so a cancellation reason reads the same however it was
 * entered. ONE DELIBERATE DIFFERENCE, disclosed rather than silent: that code
 * appended to the ENVELOPE booking's `notes` and wrote the result onto the
 * session, which overwrote whatever the session itself had recorded. Here the
 * append is onto the SESSION's own notes, because the session is the document
 * being written.
 */
export function appendCancellationNote(existingNotes: unknown, reason: string): string {
  const trimmedReason = reason.trim();
  if (trimmedReason === '') return typeof existingNotes === 'string' ? existingNotes : '';
  const existing = typeof existingNotes === 'string' ? existingNotes.trim() : '';
  const line = `[Booking cancelled] ${trimmedReason}`;
  return existing === '' ? line : `${existing}\n${line}`;
}
