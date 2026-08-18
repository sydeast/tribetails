import { call } from '../lib/fns';
import type {
  ListRescheduleRequestsArgs,
  ListRescheduleRequestsResult,
  RescheduleRequestDto,
  ResolveBookingRescheduleRequestArgs,
  ResolveBookingRescheduleRequestResult,
} from '../contracts/bookingContracts.generated';

/**
 * The office's end of the kinfolk reschedule ask (issue #399, item 2).
 *
 * These requests live one per household under
 * `families/{kinfolkId}/bookings/{batchId}/kinCares`, while this app's Bookings
 * screen streams the FLAT `kin_care_sessions` collection. Two different id
 * spaces, which is why the queue arrives through a callable doing a
 * collection-group query rather than through `useCollection`: `CollectionSpec`
 * wraps a single `collection(db, path)` and has no collection-group variant.
 * `api/bookings.ts` flagged that gap and reserved a dedicated "incoming
 * requests" surface for exactly this; the queue below is it.
 *
 * The shapes come from `../contracts/bookingContracts.generated`, projected
 * from the server zod schemas. What is left here is the argument order a screen
 * calls and what each operation means.
 */
export type { RescheduleRequestDto };

/** Every visit with a proposed new time still waiting on a decision, oldest first. */
export function listRescheduleRequests(limit?: number): Promise<ListRescheduleRequestsResult> {
  const payload: ListRescheduleRequestsArgs = limit !== undefined ? { limit } : {};
  return call<ListRescheduleRequestsArgs, ListRescheduleRequestsResult>('listRescheduleRequests', payload);
}

/**
 * Accepts or declines one request.
 *
 * ACCEPTING MOVES THE VISIT: the server writes the household's kinCares doc and
 * the flat `kin_care_sessions` row together, so this screen and the portal stop
 * disagreeing about when the visit is. Declining moves nothing and records the
 * note, which the household reads on its own booking screen.
 *
 * A decline needs a note. The server refuses one without it, and the dialog
 * enforces it too, so the operator finds out before the round trip.
 */
export function resolveBookingRescheduleRequest(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  decision: 'accept' | 'decline',
  note?: string,
): Promise<ResolveBookingRescheduleRequestResult> {
  const payload: ResolveBookingRescheduleRequestArgs = {
    kinfolkId,
    batchId,
    visitId,
    decision,
    ...(note && note.trim() ? { note: note.trim() } : {}),
  };
  return call<ResolveBookingRescheduleRequestArgs, ResolveBookingRescheduleRequestResult>(
    'resolveBookingRescheduleRequest',
    payload,
  );
}
