import { call } from '../lib/fns';
import { callableConflictCode } from '../lib/bookingWizard';

/**
 * The WRITE half of the Schedule screen: block a window, put a one-off visit on
 * the calendar (#397 M11 and M12). `api/schedule.ts` next door is the read half
 * and stays read-only.
 *
 * BOTH CALLABLES ALREADY EXISTED AND ARE ALREADY DEPLOYED
 * (`mytribe/functions/src/index.ts` exports `createBlockedTimeSlot` and
 * `createKinCareSession`). Nothing on this web app had ever called them; the
 * desktop admin's `BlockTimeDialog.kt` / `NewVisitDialog.kt` are the reference
 * callers, and the argument maps below match theirs field for field, plus the
 * two additive arguments this task put on the server.
 *
 * NOT IN `contracts/bookingContracts.generated.ts`, and deliberately. That
 * registry generates from a callable's exported zod **Result**, and neither of
 * these has one — they return hand-written interfaces. `transitionBookingStatus`
 * and `assignAuntie` are in exactly the same position and keep local types for
 * exactly this reason (see `api/bookingsWrite.ts`'s header). Publishing a
 * contract is a decision, not a side effect of wiring a button.
 *
 * Every function throws (never swallows) on a callable failure, refusals
 * included: the caller surfaces `err.message` fail-loud, per the repo rule that
 * this layer does not decide what an operator gets to see.
 */

/**
 * The machine-readable `details.code` the visit-overlap guard refuses with
 * (`functions/src/lib/visitOverlapConflict.ts`). Branch on this, never on the
 * wording of the sentence — the same convention `BOOKING_BUSY_CONFLICT_CODE`
 * already sets in `lib/bookingWizard.ts`.
 */
export const VISIT_OVERLAP_CONFLICT_CODE = 'visit_overlap_conflict';

/**
 * Whether this refusal is one the operator is allowed to knowingly go past, and
 * has not already tried to.
 *
 * TWO REFUSALS ARE OVERRIDABLE AND ONE IS NOT, which is the whole reason this
 * reads a code instead of a message. A visit already on the books and a Google
 * Calendar busy import are both things the server cannot fully judge — the
 * calendar may be stale, and two Aunties may genuinely be working the same hour
 * (assignment lives on the envelope visit doc and is never mirrored onto the
 * flat session row, so the server cannot tell). A company closure is the
 * operator's own deliberate statement that the business is shut:
 * `guardCompanyHolidayConflict` has no override parameter at all, so its code
 * must never reach this as `true`.
 *
 * `alreadyOverridden` is false only on a first attempt. Offering the same losing
 * move twice is what Android refuses to do (`NewBookingWizard.kt` suppresses the
 * re-offer), and so does this.
 */
export function overridableScheduleRefusal(
  err: unknown,
  alreadyOverridden: boolean,
): 'visit' | 'busy' | null {
  if (alreadyOverridden) return null;
  const code = callableConflictCode(err);
  if (code === VISIT_OVERLAP_CONFLICT_CODE) return 'visit';
  if (code === 'booking_busy_conflict') return 'busy';
  return null;
}

/** What an overridable refusal offers the operator, one sentence per kind. */
export function overrideHint(kind: 'visit' | 'busy'): string {
  return kind === 'visit'
    ? 'That clash is a visit already on the books. You can book over one.'
    : 'That clash is an imported Google Calendar busy block. You can book over one.';
}

// ── M11: block time ──────────────────────────────────────────────────────────

export interface BlockTimeArgs {
  /** `YYYY-MM-DD`, the operator's local calendar day. */
  date: string;
  /** `HH:mm`, 24h, the operator's local wall clock. Stored verbatim. */
  startTime: string;
  endTime: string;
  notes: string;
  /**
   * The same window as the three fields above, as real instants.
   *
   * The stored document has no timezone field anywhere, so the server cannot
   * turn `date`+`HH:mm` into an instant without inventing a zone — which is why
   * it never checked a block against the visits underneath it. The BROWSER
   * knows the operator's zone, so it sends the window a second time as epoch ms
   * and the server does the overlap check against that. Both halves describe
   * one window; only the wall-clock half is persisted.
   */
  startTimeMs: number;
  endTimeMs: number;
  /** Set only on an explicit "Block anyway" retry after a `visit_overlap_conflict` refusal. */
  overrideVisitConflict?: boolean;
}

export interface CreateBlockedTimeSlotResult {
  ok: true;
  docId: string;
}

/**
 * createBlockedTimeSlot (admin callable): writes a private, unavailable
 * `booking_time_slots` row — `slotType: 'BLOCKED'`, `source: 'INTERNAL_MANUAL'`
 * — which the Schedule busy overlay and the kinfolk booking-availability checks
 * already read with no change on their side.
 *
 * The server refuses `startTime >= endTime` and any non-`HH:mm` clock, and (when
 * the epoch-ms twin is sent, which this app always does) any window a visit
 * already occupies.
 */
export async function createBlockedTimeSlot(
  args: BlockTimeArgs,
): Promise<CreateBlockedTimeSlotResult> {
  return call<BlockTimeArgs, CreateBlockedTimeSlotResult>('createBlockedTimeSlot', args);
}

/**
 * The `details.code` `deleteBlockedTimeSlot` refuses a Google Calendar mirror
 * with (#574).
 *
 * NOT A CONFLICT AND NOT OVERRIDABLE, which is why it is a constant here rather
 * than another arm of `overridableScheduleRefusal`: the two conflict codes say
 * "this clashes, and you may decide otherwise"; this one says the delete would
 * not last, because the next sync writes the row back. A retry button would
 * re-send the identical request and fail identically.
 */
export const IMPORTED_BUSY_SLOT_CODE = 'imported_busy_slot';

/** The `source` a row must carry (or lack) for Unblock to be offered at all. */
export const OPERATOR_BLOCK_SOURCE = 'INTERNAL_MANUAL';

/**
 * Whether this busy row is one an operator may remove.
 *
 * A row with NO `source` counts: the collection predates the field
 * (`scripts/repairBlockedTimeSlotShape.ts` exists because historical rows are
 * known to be shaped differently), and an unlabelled row in this collection is
 * a manual block. `deleteBlockedTimeSlot` makes exactly the same call, so the
 * button and the server cannot disagree about which rows are removable.
 */
export function isOperatorBlock(source: string | undefined): boolean {
  return source === undefined || source === '' || source === OPERATOR_BLOCK_SOURCE;
}

export interface DeleteBlockedTimeSlotArgs {
  slotId: string;
}

export interface DeleteBlockedTimeSlotResult {
  ok: true;
  slotId: string;
}

/**
 * deleteBlockedTimeSlot (admin callable, #574): removes ONE operator-authored
 * `booking_time_slots` row.
 *
 * THE HALF THAT HAD NO CALLABLE. `createBlockedTimeSlot` shipped in B6;
 * un-blocking had nothing, and the only unblock affordance in the product
 * (Android's) deleted the document straight from the client — which
 * `firestore.rules` denies, so it had never once worked. #574 built the
 * callable and wired it on both surfaces.
 *
 * It refuses a Google Calendar import rather than deleting it, and this app
 * does not offer the button on those rows in the first place; see
 * {@link isOperatorBlock}.
 */
export async function deleteBlockedTimeSlot(
  slotId: string,
): Promise<DeleteBlockedTimeSlotResult> {
  return call<DeleteBlockedTimeSlotArgs, DeleteBlockedTimeSlotResult>('deleteBlockedTimeSlot', {
    slotId,
  });
}

// ── M12: one-off visit ───────────────────────────────────────────────────────

export interface CreateKinCareSessionArgs {
  kinfolkId: string;
  /** Empty means the WHOLE household (operator ruling R1); the server materializes the roster. */
  kinIds: string[];
  /**
   * A `business_settings.serviceRates` KEY, never free text.
   *
   * A session document carries no price at all: `listUninvoicedSessions` prices
   * a completed visit by joining this exact string against the rate card, and a
   * value the card does not carry comes back `unpriceable` with a number to be
   * typed in by hand. So the picker offers `serviceOptionsFromRates` and nothing
   * else. Same catalog PR #569 taught the server's `resolveService` to read
   * first for the booking-request path, reached here by the other route.
   */
  serviceType: string;
  /** UTC-suffixed ISO, from `buildRescheduleTimes`, so an ad-hoc visit sorts and re-parses like every other row. */
  startTime: string;
  endTime: string;
  serviceDurationMinutes: number;
  notes?: string;
  /** Set only on an explicit retry after the matching refusal. The two are separate decisions and are audited separately. */
  overrideVisitConflict?: boolean;
  overrideBusyConflict?: boolean;
}

export interface CreateKinCareSessionResult {
  ok: true;
  sessionId: string;
}

/**
 * createKinCareSession (admin callable): puts a `SCHEDULED` visit straight on
 * the calendar.
 *
 * THIS IS NOT THE BOOKING WIZARD, and the difference matters to the operator.
 * `NewBookingDialog` (`createMultiDateBookingRequest`) mints a REQUEST envelope
 * that has to be approved before it becomes a visit; this one is the office
 * writing a visit down, which is what "add a one-off to the calendar" means and
 * what the Schedule screen needed.
 *
 * Server-side it is guarded three ways before anything is written: a company
 * closure (no override), a Google Calendar busy import (overridable), and a
 * visit already occupying the window (overridable).
 */
export async function createKinCareSession(
  args: CreateKinCareSessionArgs,
): Promise<CreateKinCareSessionResult> {
  return call<CreateKinCareSessionArgs, CreateKinCareSessionResult>('createKinCareSession', args);
}
