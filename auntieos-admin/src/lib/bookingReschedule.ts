import { type BookingEntry } from '../api/bookings';
import {
  buildRescheduleTimes,
  localDateInput,
  localTimeInput,
  visitDurationMinutes,
  type RescheduleTimes,
} from './bookingDetailFormat';
import { bulkTargetName, type BulkFailure, type BulkSkip } from './bookingBulk';
import { bookingState, type BookingState } from './bookingFormat';
import { str } from './coerce';

/**
 * The decision logic behind the Bookings list's bulk RESCHEDULE (#397 M16),
 * kept out of the screen for the same reason `bookingBulk.ts` next door is: the
 * screen owns the awaits, this file owns who is eligible, what is written, and
 * what the operator is told afterwards.
 *
 * IT IS A PER-VISIT REVIEW SHEET, NOT ONE DELTA APPLIED TO MANY ROWS, and that
 * is the whole design. `BulkBar`'s own comment used to say a bulk Reschedule
 * could not be built because "rescheduling many visits at once means picking a
 * new time PER visit (they do not share one)". That sentence was right about
 * the mechanism and wrong about the conclusion: the operator's ruling is that
 * the sheet SUPPLIES the per-visit time. Every selected visit arrives with its
 * own field, prefilled with the window it holds now, and the operator adjusts
 * the ones that need adjusting and confirms once. `rescheduleBooking` is still
 * called once per visit, with that visit's own window.
 *
 * ONE CALLABLE, NOT TWO. Unlike the APPROVE / REJECT / CANCEL bulk beside it,
 * this needs no second leg onto the household's copy of the visit: since PR
 * #650 `rescheduleBooking` moves both the `kin_care_sessions` row this list
 * renders AND the `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`
 * envelope doc the household reads. Adding a `batchUpdateBookings` leg here
 * would be a second writer racing the server's own.
 *
 * The shapes are `bookingBulk.ts`'s (`BulkSkip`, `BulkFailure`) so one result
 * banner can report either kind of bulk press: a skip was never attempted, a
 * failure was attempted and refused, and neither is ever folded into a count.
 */

/**
 * Which refusals the operator may knowingly go past, mirroring what
 * `api/scheduleWrite.ts#overridableScheduleRefusal` returns.
 *
 * A COMPANY CLOSURE IS ABSENT FROM THIS UNION ON PURPOSE, and must stay absent.
 * `guardCompanyHolidayConflict` has no override parameter on the server, so an
 * override offer for it would be a button that cannot work.
 */
export type RescheduleOverride = 'visit' | 'busy';

/** One selected visit, with everything the sheet needs to draw a row for it. */
export interface RescheduleTarget {
  /** The `kin_care_sessions` doc id, and the row's identity in this list. */
  id: string;
  /** Household name for the sheet and the result copy. Never an id. */
  name: string;
  /** LOCAL `YYYY-MM-DD` prefill, `''` when the stored start does not parse. */
  date: string;
  /** LOCAL `HH:mm` prefill, `''` when the stored start does not parse. */
  time: string;
  /**
   * Minutes the visit runs, which is what the new end is computed from. A move
   * is not a resize: the operator picks where the visit STARTS and it keeps its
   * length, the same rule the detail sheet's Reschedule panel and the Schedule
   * grid's drag already follow.
   */
  durationMinutes: number;
  /** The window it holds now, so the sheet can show what is being moved. */
  currentStart: string;
}

/** What the operator typed into one row of the sheet. */
export interface RescheduleDraft {
  date: string;
  time: string;
}

/** One visit that will be written, with the window resolved from its draft. */
export interface RescheduleWrite {
  target: RescheduleTarget;
  times: RescheduleTimes;
}

/** A visit the server refused, plus whether the operator may go past it. */
export interface RescheduleFailure extends BulkFailure {
  /**
   * The override this refusal offers, or null. Null covers three different
   * facts and the sheet treats them identically: the refusal has no override
   * (a company closure), the call failed for some other reason, or the
   * operator has ALREADY overridden once and the same losing move is not
   * offered twice.
   */
  override: RescheduleOverride | null;
}

/** One visit that landed, and where it landed. */
export interface RescheduleApplied {
  id: string;
  name: string;
  /** The new start, as written. */
  startTime: string;
}

export interface BulkRescheduleOutcome {
  applied: RescheduleApplied[];
  failures: RescheduleFailure[];
  skipped: BulkSkip[];
}

/**
 * Whether a visit in this state can be moved at all.
 *
 * A POSITIVE test against the enumerated `BookingState`, never a negation, the
 * same discipline `bulkActionApplies` keeps next door. Only `scheduled` says
 * yes, and that is exactly the rule the per-row surfaces already apply
 * (`BookingActions.tsx`'s `canReschedule`, and `ReschedulePanel`'s
 * `status === '' || status === 'SCHEDULED'`). A pending request has no window
 * on the books to move, and a completed or cancelled visit is history.
 */
export function rescheduleApplies(state: BookingState): boolean {
  switch (state) {
    case 'scheduled':
      return true;
    case 'draft':
    case 'pending':
    case 'completed':
    case 'cancelled':
    case 'unknown':
      return false;
  }
}

/** Why a visit cannot be moved, in the operator's words rather than a state name. */
function rescheduleSkipReason(state: BookingState): string {
  switch (state) {
    case 'draft':
    case 'pending':
      return 'It is still awaiting a reply, so it has no visit on the books to move. Approve it first.';
    case 'completed':
      return 'It has already been completed.';
    case 'cancelled':
      return 'It has already been cancelled.';
    case 'unknown':
      return 'Its status is not one this app recognizes, so it is left where it is.';
    case 'scheduled':
      return '';
  }
}

/**
 * Split the selection into the visits the sheet will offer and the ones it
 * will not.
 *
 * Selection is held as ids, so a row that left the stream between the click and
 * the press is simply not in `rows` any more. It lands in `skipped` with a
 * reason rather than being silently dropped from the count, which is the same
 * treatment `planBulkAction` gives it.
 */
export function planBulkReschedule(
  rows: readonly BookingEntry[],
  selectedIds: ReadonlySet<string>,
): { eligible: RescheduleTarget[]; skipped: BulkSkip[] } {
  const eligible: RescheduleTarget[] = [];
  const skipped: BulkSkip[] = [];
  const byId = new Map(rows.map((r) => [r._id, r]));

  for (const id of selectedIds) {
    const row = byId.get(id);
    if (!row) {
      skipped.push({ id, name: id, reason: 'It is no longer in the list, so nothing was written.' });
      continue;
    }
    const name = bulkTargetName(row);
    const state = bookingState({ status: row.status });
    if (!rescheduleApplies(state)) {
      skipped.push({ id, name, reason: rescheduleSkipReason(state) });
      continue;
    }
    const startTime = str(row.startTime);
    eligible.push({
      id,
      name,
      date: localDateInput(startTime),
      time: localTimeInput(startTime),
      durationMinutes: visitDurationMinutes(row),
      currentStart: startTime,
    });
  }

  return { eligible, skipped };
}

/**
 * Turn what the operator left in the sheet into the writes to make.
 *
 * THREE ROWS NEVER REACH THE SERVER, and each says so by name:
 *
 *   - a row left exactly where it was. Confirming a sheet of six after
 *     adjusting two must move two visits, not six: the other four would fire a
 *     callable, stamp a RESCHEDULE audit entry and notify a household about a
 *     move nobody made. `isNoOpDrop` refuses the same thing for a drag that
 *     jitters two pixels.
 *   - a row left blank, including one whose stored start never parsed and so
 *     had nothing to prefill. Blank is not a time.
 *   - a row whose date and time cannot be turned into a real instant
 *     (2026-02-30, 25:00). `buildRescheduleTimes` returns null and the visit is
 *     left alone rather than handed a garbage window.
 */
export function planRescheduleWrites(
  targets: readonly RescheduleTarget[],
  drafts: ReadonlyMap<string, RescheduleDraft>,
): { writes: RescheduleWrite[]; skipped: BulkSkip[] } {
  const writes: RescheduleWrite[] = [];
  const skipped: BulkSkip[] = [];

  for (const target of targets) {
    const draft = drafts.get(target.id) ?? { date: target.date, time: target.time };
    const date = draft.date.trim();
    const time = draft.time.trim();

    if (date === '' || time === '') {
      skipped.push({
        id: target.id,
        name: target.name,
        reason: 'No new date and time were entered, so this visit was left where it is.',
      });
      continue;
    }
    if (date === target.date && time === target.time) {
      skipped.push({
        id: target.id,
        name: target.name,
        reason: 'Its time is unchanged, so nothing was written.',
      });
      continue;
    }
    const times = buildRescheduleTimes(date, time, target.durationMinutes);
    if (times === null) {
      skipped.push({
        id: target.id,
        name: target.name,
        reason: `${date} ${time} is not a real date and time, so this visit was left where it is.`,
      });
      continue;
    }
    writes.push({ target, times });
  }

  return { writes, skipped };
}

/**
 * Fold the per-visit results into one outcome.
 *
 * `failures` is keyed by session id, which is the id the operator's row carries,
 * so every entry can be reported against the household name they picked. A
 * visit that is in neither `failures` nor a later refusal landed.
 */
export function mergeRescheduleResults(
  writes: readonly RescheduleWrite[],
  failures: ReadonlyMap<string, { reason: string; override: RescheduleOverride | null }>,
  skipped: readonly BulkSkip[],
): BulkRescheduleOutcome {
  const applied: RescheduleApplied[] = [];
  const failed: RescheduleFailure[] = [];

  for (const write of writes) {
    const failure = failures.get(write.target.id);
    if (failure !== undefined) {
      failed.push({
        id: write.target.id,
        name: write.target.name,
        reason: failure.reason,
        override: failure.override,
      });
      continue;
    }
    applied.push({
      id: write.target.id,
      name: write.target.name,
      startTime: write.times.startTime,
    });
  }

  return { applied, failures: failed, skipped: [...skipped] };
}

/**
 * The headline of the result banner. It always names both numbers, because
 * "Moved 4 visits" next to a selection of six is the sentence an operator reads
 * as done.
 */
export function bulkRescheduleSummary(outcome: BulkRescheduleOutcome): string {
  const total = outcome.applied.length + outcome.failures.length + outcome.skipped.length;
  const noun = total === 1 ? 'visit' : 'visits';
  return `Moved ${outcome.applied.length} of ${total} selected ${noun}.`;
}

/** What an override offer says, per kind. Mirrors `api/scheduleWrite.ts#overrideHint`. */
export function rescheduleOverrideLabel(kind: RescheduleOverride): string {
  return kind === 'visit' ? 'Move over the booked visit' : 'Move over the busy block';
}
