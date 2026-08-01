/**
 * Wire types + typed wrappers for the booking-wizard callables. Self-contained
 * (mirrors api/invoicesApi.ts's `call` pattern) so it doesn't touch
 * api/types.ts or api/portal.ts while other work happens in parallel.
 *
 * Every DTO below is transcribed from its backend handler; each block cites
 * its source file. Field names/types/defaults MUST stay in sync with those
 * files.
 */
import { call } from '../lib/fns';

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

// ── requestBooking (functions/src/portal/requestBooking.ts, multi-visit shape) ──

export type BookingPattern = 'individual' | 'weekly';

export interface BookingVisitInput {
  /** Epoch ms; the server rejects a start time in the past. */
  startTimeMs: number;
  endTimeMs?: number | null;
  serviceId: string;
  /**
   * Display-fallback label only: the server resolves the canonical name from
   * `serviceId` server-side and ignores this when the id resolves.
   */
  serviceName: string;
  /** Display-fallback only: the server resolves the canonical price server-side and ignores this when `serviceId` resolves. */
  priceCents?: number | null;
}

export interface RequestBookingRequest {
  kinfolkId?: string;
  kinIds?: string[];
  notes?: string;
  pattern?: BookingPattern;
  /** 0=Sun..6=Sat; only meaningful when pattern === 'weekly'. */
  weeklyDays?: number[];
  visits: BookingVisitInput[];
}

export interface RequestBookingResult {
  /** The envelope id (parent `bookings/{batchId}` doc). */
  batchId: string;
  /** Legacy multi-id alias; in the envelope model this is `[batchId]`. */
  bookingIds: string[];
  /** Legacy single-id alias. */
  bookingId?: string;
}

/**
 * Submits a multi-visit booking request. `visits` must be non-empty: the
 * server's zod schema (`MultiArgs.visits: z.array(VisitArgs).min(1)`) rejects
 * an empty array, so this throws client-side first with a clearer message
 * rather than round-tripping to find out.
 */
export function requestBooking(req: RequestBookingRequest): Promise<RequestBookingResult> {
  if (req.visits.length === 0) {
    throw new Error('No visits to book. Check the days and weeks.');
  }
  return call<RequestBookingRequest, RequestBookingResult>('requestBooking', req);
}

// ── requestBookingCancellation (functions/src/portal/requestBookingCancellation.ts) ──
// Vendor-parity: NOT an instant cancel. It stamps a cancelRequestedAt flag the
// business acts on; the visit's own status is untouched until they do. See the
// handler's doc comment for the full rationale.

export interface RequestBookingCancellationRequest {
  kinfolkId?: string;
  batchId: string;
  visitId: string;
  reason?: string;
}

export interface RequestBookingCancellationResult {
  ok: true;
  visitId: string;
  /** True when a request was already pending (this call was a no-op). */
  alreadyPending: boolean;
}

/** Asks the business to cancel one visit. Only requested/confirmed visits qualify (server-enforced). */
export function requestBookingCancellation(
  kinfolkId: string,
  batchId: string,
  visitId: string,
  reason?: string,
): Promise<RequestBookingCancellationResult> {
  const payload: RequestBookingCancellationRequest = {
    kinfolkId,
    batchId,
    visitId,
    ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
  };
  return call<RequestBookingCancellationRequest, RequestBookingCancellationResult>(
    'requestBookingCancellation',
    payload,
  );
}

// ── addBookingNote (functions/src/portal/addBookingNote.ts) ─────────────────
// `kinfolkId` is typed optional server-side but the handler throws
// invalid-argument without it (it's the authorization anchor, resolved
// BEFORE the visit lookup) — always send it, never omit.

export interface AddBookingNoteRequest {
  kinfolkId: string;
  batchId: string;
  visitId: string;
  body: string;
}

export interface AddBookingNoteResult {
  noteId: string;
}

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
  const payload: AddBookingNoteRequest = { kinfolkId, batchId, visitId, body };
  return call<AddBookingNoteRequest, AddBookingNoteResult>('addBookingNote', payload);
}
