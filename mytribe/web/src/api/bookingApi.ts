/**
 * Typed wrappers for the booking-wizard callables the kinfolk portal calls.
 *
 * THE SHAPES FOR requestBooking, requestBookingCancellation, and
 * addBookingNote ARE NOT DEFINED HERE. They come from
 * `../contracts/bookingContracts.generated`, projected from the server zod
 * schemas under ADR-0001, same convention as api/invoicesApi.ts. What is left
 * below for those three is the part a generator cannot write: the argument
 * order a screen calls, and the prose about what each operation means.
 *
 * getServiceCatalog has no zod request/response schema on the server (same
 * situation as getMyInvoices/getMyBookings), so its ServiceDto and
 * GetServiceCatalogResult stay hand-written here, transcribed from
 * `functions/src/portal/getServiceCatalog.ts`.
 */
import { call } from '../lib/fns';
import type {
  AddBookingNoteArgs,
  AddBookingNoteResult,
  RequestBookingArgs,
  RequestBookingRescheduleArgs,
  RequestBookingRescheduleResult,
  RequestBookingCancellationArgs,
  RequestBookingCancellationResult,
  RequestBookingResult,
} from '../contracts/bookingContracts.generated';

// ── getServiceCatalog (functions/src/portal/getServiceCatalog.ts) ───────────

export interface ServiceDto {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  /** Single price (cents). When set, price is fixed. */
  priceCents: number | null;
  /** Range minimum (cents). When set, price is variable. */
  priceMinCents: number | null;
  /** Range maximum (cents). When set, price is variable. */
  priceMaxCents: number | null;
  durationMinutes: number | null;
  isOvernight: boolean;
  iconKey: string | null;
}

export interface GetServiceCatalogResult {
  services: ServiceDto[];
}

/** The business's bookable service catalog (no args beyond auth). */
export function getServiceCatalog(): Promise<GetServiceCatalogResult> {
  return call<Record<string, never>, GetServiceCatalogResult>('getServiceCatalog', {});
}

// ── getBusinessClosures (functions/src/portal/getBusinessClosures.ts) ───────
//
// C1: `business_settings` (where `companyHolidays` lives) is admin-only in
// firestore.rules, so this callable is the portal's ONLY way to learn which
// dates are closed. It resolves recurring closures into concrete dates
// server-side through the same `closureRecurrence.ts` math the
// `requestBooking` write-path guard uses, so what the month picker marks and
// what a submit will actually be refused for can never decode into two
// different calendars.

export interface BusinessClosureDto {
  /** `YYYY-MM-DD`. */
  date: string;
  name: string;
}

export interface GetBusinessClosuresRequest {
  /** `YYYY-MM-DD`, inclusive. */
  fromDate: string;
  /** `YYYY-MM-DD`, inclusive. Server caps the range at 120 days. */
  toDate: string;
}

export interface GetBusinessClosuresResult {
  closures: BusinessClosureDto[];
}

export function getBusinessClosures(req: GetBusinessClosuresRequest): Promise<GetBusinessClosuresResult> {
  return call<GetBusinessClosuresRequest, GetBusinessClosuresResult>('getBusinessClosures', req);
}

// ── getBookingPolicy (functions/src/portal/getBookingPolicy.ts) ─────────────
//
// Time-block booking (operator requirement 2026-08-24): "kinfolk book within
// time blocks, not at a specific set time." The named windows live on
// `business_settings.timeBlocks`, which is admin-only in firestore.rules, so
// this callable is the wizard's only way to learn them — the same seam and the
// same reason as getBusinessClosures above.
//
// The values are NORMALIZED server-side, and `requestBooking` validates against
// that same resolver, so the wizard is never offered a mode the write path will
// refuse. In particular `allowTimeBlockBooking` comes back FALSE when the
// business has no usable window, so "block booking on with an empty
// `timeBlocks`" is a state this type cannot arrive in.

/** How a household says WHEN. */
export type BookingMode = 'SPECIFIC_TIME' | 'TIME_BLOCK';

export interface TimeBlockDto {
  id: string;
  label: string;
  /** `HH:MM` in the business's timezone, inclusive. */
  startTime: string;
  /** `HH:MM` in the business's timezone, exclusive. */
  endTime: string;
  durationMinutes: number;
}

export interface GetBookingPolicyResult {
  allowTimeBlockBooking: boolean;
  allowSpecificTimeBooking: boolean;
  defaultBookingMode: BookingMode;
  timeBlocks: TimeBlockDto[];
}

/** What this business lets a household choose, and which windows it may pick from. */
export function getBookingPolicy(): Promise<GetBookingPolicyResult> {
  return call<Record<string, never>, GetBookingPolicyResult>('getBookingPolicy', {});
}

// ── requestBooking (functions/src/portal/requestBooking.ts, multi-visit shape) ──
//
// `RequestBookingArgs` is a SUPERSET schema covering both the multi-visit
// shape the portal sends and a legacy single-visit shape the server still
// accepts from older clients. The portal only ever builds the multi-visit
// fields (kinfolkId, kinIds, notes, pattern, weeklyDays, visits[], billing,
// communication) below; the legacy fields exist on the type for completeness
// and are never set here.

/**
 * Submits a multi-visit booking request. `visits` must be non-empty: the
 * server's zod schema (`MultiArgs.visits: z.array(VisitArgs).min(1)`) rejects
 * an empty array, so this throws client-side first with a clearer message
 * rather than round-tripping to find out.
 */
export function requestBooking(req: RequestBookingArgs): Promise<RequestBookingResult> {
  if (!req.visits || req.visits.length === 0) {
    throw new Error('No visits to book. Check the days and weeks.');
  }
  if (!req.idempotencyKey) {
    // #644: refused rather than silently sent unkeyed. This call opts into a
    // retry on `functions/internal`, and the ONLY thing that makes that safe is
    // the server deduping on this key. A caller that forgot it would get a
    // silent double booking -- and where the operator has auto-confirm on, a
    // second set of confirmed sessions. Fail here, loudly, in development.
    throw new Error('requestBooking needs an idempotencyKey. See lib/bookingIdempotency.ts.');
  }
  return call<RequestBookingArgs, RequestBookingResult>('requestBooking', req, { idempotent: true });
}

// ── requestBookingCancellation (functions/src/portal/requestBookingCancellation.ts) ──
// Vendor-parity: NOT an instant cancel. It stamps a cancelRequestedAt flag the
// business acts on; the visit's own status is untouched until they do. See the
// handler's doc comment for the full rationale.

/** Asks the business to cancel one visit. Only requested/confirmed visits qualify (server-enforced). */
export function requestBookingCancellation(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  reason?: string,
): Promise<RequestBookingCancellationResult> {
  const payload: RequestBookingCancellationArgs = {
    kinfolkId,
    batchId,
    visitId,
    ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
  };
  return call<RequestBookingCancellationArgs, RequestBookingCancellationResult>(
    'requestBookingCancellation',
    payload,
  );
}

// ── requestBookingReschedule (functions/src/portal/requestBookingReschedule.ts) ──
// Same shape of thing as the cancellation ask above, and for the same reason:
// a household PROPOSES a time, it does not move the visit. The visit keeps its
// current slot and status until the office accepts, and the answer comes back
// on the visit's own `rescheduleRequestStatus`.
/**
 * Asks the business to move one visit to a new time.
 *
 * `proposedEndTimeMs` is omitted by the screen, so the visit keeps its current
 * length: a household picking a new hour for a 30-minute drop-in means the same
 * drop-in at a different hour. The server derives the end from the visit's own
 * duration.
 */
export function requestBookingReschedule(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  proposedStartTimeMs: number,
  reason?: string,
): Promise<RequestBookingRescheduleResult> {
  const payload: RequestBookingRescheduleArgs = {
    kinfolkId,
    batchId,
    visitId,
    proposedStartTimeMs,
    ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
  };
  return call<RequestBookingRescheduleArgs, RequestBookingRescheduleResult>(
    'requestBookingReschedule',
    payload,
  );
}
// ── addBookingNote (functions/src/portal/addBookingNote.ts) ─────────────────
// `kinfolkId` is typed optional server-side but the handler throws
// invalid-argument without it (it's the authorization anchor, resolved
// BEFORE the visit lookup) — always send it, never omit.

/**
 * Leaves a note on one visit. Rejected within the 3-hour pre-visit cutoff
 * (server-enforced, see functions/src/lib/bookingNoteCutoff.ts) — the
 * rejection message is already kinfolk-facing, so it's shown as-is.
 */
export function addBookingNote(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  body: string,
): Promise<AddBookingNoteResult> {
  const payload: AddBookingNoteArgs = { kinfolkId, batchId, visitId, body };
  return call<AddBookingNoteArgs, AddBookingNoteResult>('addBookingNote', payload);
}
