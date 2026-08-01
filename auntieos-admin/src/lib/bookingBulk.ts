import { type BookingEntry } from '../api/bookings';
import { type BatchBookingAction } from '../api/bookingsWrite';
import { type BatchUpdateBookingsResult } from '../contracts/bookingContracts.generated';
import { bookingState, type BookingState } from './bookingFormat';
import { str } from './coerce';

/**
 * The decision logic behind the Bookings list's bulk bar, kept out of the
 * screen so every branch has direct vitest coverage (the bookingFormat.ts /
 * invoiceFormat.ts convention). The screen owns the awaits; this file owns what
 * to write, to which model, and what to tell the operator afterwards.
 *
 * THE ONE THING TO UNDERSTAND BEFORE CHANGING ANY OF IT: a bulk action on this
 * list touches TWO collections, and it has to, because the two halves of a
 * booking live in two places.
 *
 *   `kin_care_sessions/{id}`   the flat visit row this list streams and this
 *                              list renders. Only a write HERE changes what the
 *                              operator sees. Written directly from the client
 *                              (firestore.rules grants isAuntie() create/update
 *                              /delete), the same transport, and the same three
 *                              named wrappers, the per-row action in
 *                              BookingActions.tsx already uses.
 *
 *   `families/{kinfolkId}/bookings/{batchId}/kinCares/{visitId}`
 *                              the envelope visit doc. It is what the HOUSEHOLD
 *                              reads (portal `getMyBookings` runs a
 *                              collectionGroup over `kinCares`), and it is the
 *                              ONLY model `batchUpdateBookings` can act on: that
 *                              handler resolves every id through
 *                              `collectionGroup('kinCares')` and reports an
 *                              unresolvable one as `{ id, error: 'not-found' }`.
 *
 * So calling `batchUpdateBookings` with the ids this list holds, on its own,
 * would be a guaranteed no-op wearing a success banner: `kin_care_sessions` doc
 * ids are not `kinCares` doc ids, every one would come back not-found, and even
 * a resolved one would leave the row on screen unchanged. And writing only the
 * flat row would cancel a visit in the admin while the household's portal still
 * showed it confirmed.
 *
 * `manageBookingSeries.ts` settled this asymmetry the same way server-side: its
 * cancel writes `kinCares/{id}` AND mirrors onto `kin_care_sessions/vis_{id}`.
 * This is that pairing, from the client, for a hand-picked set of rows.
 *
 * `approveBookingSeriesCore.ts` stamps `kinCareVisitId` onto every session it
 * creates from an approved request, which is how a row here names its envelope
 * counterpart. A row without one (a legacy/ad-hoc session) simply has no
 * envelope doc to keep in step, and is written to the flat collection alone.
 */

/** One selected row, reduced to what the bulk machinery needs from it. */
export interface BulkTarget {
  /** The `kin_care_sessions` doc id, and the row's identity in this list. */
  id: string;
  /** Household name for the result copy. Never an id: the operator picked rows by name. */
  name: string;
  /**
   * `kinCareVisitId` when this session came from an approved booking request,
   * `null` when it did not. Only the non-null ones can be sent to
   * `batchUpdateBookings`.
   */
  envelopeVisitId: string | null;
}

/** A row that was selected but will not be written, with the reason. */
export interface BulkSkip {
  id: string;
  name: string;
  reason: string;
}

export interface BulkPlan {
  eligible: BulkTarget[];
  skipped: BulkSkip[];
}

/**
 * Which of the three bulk transitions a row in a given state can legally take.
 *
 * A POSITIVE per-state map, deliberately the same shape (and the same
 * lifecycle) as `actionsFor` in BookingActions.tsx, never derived by
 * elimination: `draft`/`pending` are the pre-visit states an APPROVE or a
 * REJECT applies to; `scheduled` is the one live state a CANCEL applies to;
 * `completed`/`cancelled`/`unknown` take nothing at all.
 *
 * This is what stops a bulk press from doing something the per-row surface
 * would never offer. Select a cancelled row alongside four pending ones, press
 * Approve, and without this the cancelled visit would be quietly resurrected to
 * SCHEDULED. It is reported as skipped instead, by name.
 */
export function bulkActionApplies(state: BookingState, action: BatchBookingAction): boolean {
  switch (state) {
    case 'draft':
    case 'pending':
      return action === 'APPROVE' || action === 'REJECT';
    case 'scheduled':
      return action === 'CANCEL';
    case 'completed':
    case 'cancelled':
    case 'unknown':
      return false;
  }
}

/** Why a row cannot take this action, in the operator's words rather than a state name. */
function skipReason(state: BookingState, action: BatchBookingAction): string {
  const verb = action === 'APPROVE' ? 'approved' : action === 'REJECT' ? 'rejected' : 'cancelled';
  switch (state) {
    case 'draft':
    case 'pending':
      return `Still awaiting a reply, so it cannot be ${verb}. Approve or reject it instead.`;
    case 'scheduled':
      return `Already on the books, so it cannot be ${verb}. Cancel it instead.`;
    case 'completed':
      return 'Already completed.';
    case 'cancelled':
      return 'Already cancelled.';
    case 'unknown':
      return 'Its status is not one this app recognizes, so no action is applied to it.';
  }
}

/** The household name this list shows for a row, blank name included. */
export function bulkTargetName(row: BookingEntry): string {
  const name = str(row.kinfolkName).trim();
  return name !== '' ? name : 'Unnamed Kinfolk';
}

/**
 * Split the selection into what will be written and what will not.
 *
 * Selection is held as ids, not rows, so a row that left the stream between
 * the click and the press is simply not in `rows` any more; it lands in
 * `skipped` with a reason rather than being written blind or silently dropped
 * from the count.
 */
export function planBulkAction(
  rows: readonly BookingEntry[],
  selectedIds: ReadonlySet<string>,
  action: BatchBookingAction,
): BulkPlan {
  const eligible: BulkTarget[] = [];
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
    if (!bulkActionApplies(state, action)) {
      skipped.push({ id, name, reason: skipReason(state, action) });
      continue;
    }
    const visitId = str(row.kinCareVisitId).trim();
    eligible.push({ id, name, envelopeVisitId: visitId !== '' ? visitId : null });
  }

  return { eligible, skipped };
}

/**
 * `batchUpdateBookings`'s zod contract caps `ids` at 100 per call, so a
 * selection larger than that is chunked rather than sent whole and rejected
 * with `invalid-argument` after the flat writes have already landed. The list
 * itself is capped at 200 rows, so this is at most two calls today; it is
 * written as a loop because the cap on either side can move.
 */
export const ENVELOPE_BATCH_LIMIT = 100;

export function chunkEnvelopeIds(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ENVELOPE_BATCH_LIMIT) {
    out.push(ids.slice(i, i + ENVELOPE_BATCH_LIMIT));
  }
  return out;
}

/** One booking that did not fully land, named, with the reason it did not. */
export interface BulkFailure {
  id: string;
  name: string;
  reason: string;
}

export interface BulkOutcome {
  action: BatchBookingAction;
  /** Rows where every write that applied to them succeeded. */
  applied: BulkTarget[];
  /** Rows that were written nowhere, or only half-written. */
  failures: BulkFailure[];
  /** Rows never attempted, with why. Distinct from a failure, and shown as such. */
  skipped: BulkSkip[];
}

/**
 * Fold the two legs' results into one per-booking verdict.
 *
 * `sessionFailures` are the flat writes that threw, keyed by session id.
 * `envelopeResults` are whatever `batchUpdateBookings` resolved with, one per
 * chunk. Its `failed[]` entries are keyed by ENVELOPE VISIT id, so they are
 * mapped back onto the row that named them; an id the operator never sees is an
 * id they cannot act on.
 *
 * A row whose flat write landed but whose envelope leg failed is a FAILURE, not
 * a success with a footnote: the admin list and the household's portal now
 * disagree about that visit, and the operator is the only one who can notice.
 */
export function mergeBulkResults(
  action: BatchBookingAction,
  plan: BulkPlan,
  sessionFailures: ReadonlyMap<string, string>,
  envelopeResults: readonly BatchUpdateBookingsResult[],
): BulkOutcome {
  const envelopeFailure = new Map<string, string>();
  for (const result of envelopeResults) {
    for (const f of result.failed) envelopeFailure.set(f.id, f.error);
  }

  const applied: BulkTarget[] = [];
  const failures: BulkFailure[] = [];

  for (const target of plan.eligible) {
    const sessionError = sessionFailures.get(target.id);
    if (sessionError !== undefined) {
      failures.push({ id: target.id, name: target.name, reason: sessionError });
      continue;
    }
    const envelopeError =
      target.envelopeVisitId === null ? undefined : envelopeFailure.get(target.envelopeVisitId);
    if (envelopeError !== undefined) {
      failures.push({
        id: target.id,
        name: target.name,
        reason: `The visit was updated here, but the household's copy of it was not (${envelopeError}). The two now disagree.`,
      });
      continue;
    }
    applied.push(target);
  }

  return { action, applied, failures, skipped: plan.skipped };
}

/** Past-tense verb for the result copy. */
export function bulkActionVerb(action: BatchBookingAction): string {
  return action === 'APPROVE' ? 'Approved' : action === 'REJECT' ? 'Rejected' : 'Cancelled';
}

/**
 * The headline of the result banner. It always names both numbers, because
 * "Approved 4 bookings" next to a selection of six is the sentence an operator
 * reads as done.
 */
export function bulkOutcomeSummary(outcome: BulkOutcome): string {
  const attempted = outcome.applied.length + outcome.failures.length;
  const total = attempted + outcome.skipped.length;
  const noun = total === 1 ? 'booking' : 'bookings';
  return `${bulkActionVerb(outcome.action)} ${outcome.applied.length} of ${total} selected ${noun}.`;
}
