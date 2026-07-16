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
