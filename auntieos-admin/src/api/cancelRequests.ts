import { call } from '../lib/fns';
import type {
  CancelRequestDto,
  ListCancelRequestsArgs,
  ListCancelRequestsResult,
  ResolveBookingCancellationRequestArgs,
  ResolveBookingCancellationRequestResult,
} from '../contracts/bookingContracts.generated';

/**
 * The office's end of the kinfolk cancellation ask (issue #438).
 *
 * The ask itself has been written to the visit since 2026-07-02 and no admin
 * screen ever read it back, so a household could be told their request was sent
 * while the office saw nothing and an Auntie turned up. These two calls are the
 * read and the ruling.
 *
 * Same reason as `rescheduleRequests.ts` for arriving through a callable rather
 * than `useCollection`: the requests live in the per-household `kinCares`
 * subcollection, this app's Bookings screen streams the flat
 * `kin_care_sessions` collection, and `CollectionSpec` has no collection-group
 * variant. `VisitRequestsSection` renders both queues as one list.
 */
export type { CancelRequestDto };

/** Every visit with a cancellation ask still waiting on a decision, oldest first. */
export function listCancelRequests(limit?: number): Promise<ListCancelRequestsResult> {
  const payload: ListCancelRequestsArgs = limit !== undefined ? { limit } : {};
  return call<ListCancelRequestsArgs, ListCancelRequestsResult>('listCancelRequests', payload);
}

/**
 * Accepts or declines one request.
 *
 * ACCEPTING CANCELS THE VISIT: the server writes the household's kinCares doc
 * and the flat `kin_care_sessions` row together, so this screen and the portal
 * cannot end up disagreeing about whether a visit is still happening.
 * Declining changes nothing about the visit and records the optional note,
 * which the household reads on its own booking screen and is emailed.
 *
 * #700: the note is optional on a decline too. The office does not owe the
 * household a reason; `note` is only the extra, custom text an operator can
 * choose to add on top of the decline. An empty note is withheld from the call
 * entirely rather than sent as `''`.
 */
export function resolveBookingCancellationRequest(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  decision: 'accept' | 'decline',
  note?: string,
): Promise<ResolveBookingCancellationRequestResult> {
  const payload: ResolveBookingCancellationRequestArgs = {
    kinfolkId,
    batchId,
    visitId,
    decision,
    ...(note && note.trim() ? { note: note.trim() } : {}),
  };
  return call<ResolveBookingCancellationRequestArgs, ResolveBookingCancellationRequestResult>(
    'resolveBookingCancellationRequest',
    payload,
  );
}
