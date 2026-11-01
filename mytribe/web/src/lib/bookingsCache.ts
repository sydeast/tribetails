/**
 * #1281: putting a booking write's answer into the `['myBookings', kinfolkId]`
 * cache, so a household sees what it just saved the moment the call resolves.
 *
 * THE DEFECT. Every booking write used to end in `invalidateQueries` and move
 * on. On /schedule/book nothing observes `['myBookings']`, so that call does
 * nothing; the wizard navigated to Schedule, Schedule drew the cached list
 * from before the booking ("No upcoming bookings"), and the new booking
 * appeared only when Schedule's own refetch came back about five seconds
 * later. Reschedule and cancel had the same gap on BookingDetail.
 *
 * THE FIX. The write callables now return the record they wrote, read back in
 * exactly the `getMyBookings` shape (`functions/src/lib/portalBookingDto.ts`).
 * It goes into the cache here. Nothing is built client-side from what the
 * household typed: a visit's times, statuses and labels are only ever the
 * server's, so the business-day calendar in Chicago time cannot drift.
 *
 * When there is no record to write (an older server, a failed read-back) or no
 * list in the cache to write it into, the caller WAITS for a fresh list
 * instead, so the action stays pending until the data is real. A list seeded
 * from one envelope would hide every other booking the household has.
 */
import type { QueryClient } from '@tanstack/react-query';
import { getMyBookings } from '../api/portal';
import type {
  GetMyBookingsResult,
  GetMyBookingsResultEnvelope,
  GetMyBookingsResultLiveVisit,
} from '../contracts/bookingContracts.generated';

type Visit = GetMyBookingsResultLiveVisit;
type Envelope = GetMyBookingsResultEnvelope;

export function bookingsQueryKey(kinfolkId: string | undefined) {
  return ['myBookings', kinfolkId] as const;
}

/** Same ordering `getMyBookings` uses (`visitSortMs` on the server). */
function sortMs(v: Visit): number {
  if (v.startTimeMs != null) return v.startTimeMs;
  if (v.requestedDate) {
    const ms = Date.parse(`${v.requestedDate}T23:59:59.999Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

function envelopeSortMs(e: Envelope): number {
  if (e.firstStartTimeMs != null) return e.firstStartTimeMs;
  const keys = e.kinCares.map(sortMs).filter((ms) => ms > 0);
  return keys.length > 0 ? Math.min(...keys) : 0;
}

const isLive = (v: Visit) => v.status === 'active' || v.status === 'enRoute';
const isOpen = (v: Visit) => v.status === 'requested' || v.status === 'confirmed';
const isDone = (v: Visit) => v.status === 'completed' || v.status === 'cancelled';

/**
 * Adds (or replaces) one envelope and its visits in a bookings list. Visits
 * land in the bucket `getMyBookings` would put them in, by their status; the
 * server has just validated that a new booking is in the future, so no clock
 * is consulted here.
 */
export function mergeEnvelope(old: GetMyBookingsResult, envelope: Envelope): GetMyBookingsResult {
  const ids = new Set(envelope.kinCares.map((v) => v.id));
  const keep = (v: Visit) => !ids.has(v.id);
  const upcoming = [...old.upcoming.filter(keep), ...envelope.kinCares.filter(isOpen)].sort((a, b) => sortMs(a) - sortMs(b));
  const recent = [...envelope.kinCares.filter(isDone), ...old.recent.filter(keep)];
  const liveVisit = old.liveVisit && !ids.has(old.liveVisit.id) ? old.liveVisit : (envelope.kinCares.find(isLive) ?? old.liveVisit);
  const envelopes = [...old.envelopes.filter((e) => e.batchId !== envelope.batchId), envelope].sort(
    (a, b) => envelopeSortMs(a) - envelopeSortMs(b),
  );
  return { liveVisit, upcoming, recent, envelopes };
}

/** Replaces one visit, wherever the list holds it, with the copy the server returned. */
export function patchVisit(old: GetMyBookingsResult, visit: Visit): GetMyBookingsResult {
  const swap = (v: Visit) => (v.id === visit.id ? visit : v);
  return {
    liveVisit: old.liveVisit ? swap(old.liveVisit) : null,
    upcoming: old.upcoming.map(swap),
    recent: old.recent.map(swap),
    envelopes: old.envelopes.map((e) => (e.kinCares.some((v) => v.id === visit.id) ? { ...e, kinCares: e.kinCares.map(swap) } : e)),
  };
}

/** True when the visit is already in the list, so a patch would show it. */
function holdsVisit(list: GetMyBookingsResult, visitId: string): boolean {
  return (
    list.liveVisit?.id === visitId ||
    list.upcoming.some((v) => v.id === visitId) ||
    list.recent.some((v) => v.id === visitId) ||
    list.envelopes.some((e) => e.kinCares.some((v) => v.id === visitId))
  );
}

/** Fetches the list now and waits for it. Used whenever there is nothing safe to write. */
async function refreshNow(queryClient: QueryClient, kinfolkId: string | undefined): Promise<void> {
  await queryClient.fetchQuery({
    queryKey: bookingsQueryKey(kinfolkId),
    queryFn: () => getMyBookings(kinfolkId),
    staleTime: 0,
  });
}

/**
 * Puts a written booking into the cache, or waits for a fresh list when it
 * cannot. Resolves only once the cache shows the booking, which is what lets a
 * caller keep its button pending until then.
 *
 * A failed refresh is swallowed: the write itself succeeded, and a household
 * must not be told a booking failed because the list behind it did not load.
 */
export async function applyBookingWrite(
  queryClient: QueryClient,
  kinfolkId: string | undefined,
  written: { envelope?: Envelope | null; visit?: Visit | null },
): Promise<void> {
  const key = bookingsQueryKey(kinfolkId);
  const old = queryClient.getQueryData<GetMyBookingsResult>(key);
  let next: GetMyBookingsResult | null = null;
  if (old && written.envelope) next = mergeEnvelope(old, written.envelope);
  else if (old && written.visit && holdsVisit(old, written.visit.id)) next = patchVisit(old, written.visit);

  try {
    if (next) {
      queryClient.setQueryData(key, next);
      // Reconcile in the background. The record above is the server's own
      // read-back, so this changes nothing a household can see; it catches
      // counts and anything else the write touched beside this one record.
      void queryClient.invalidateQueries({ queryKey: key });
    } else {
      await refreshNow(queryClient, kinfolkId);
    }
  } catch {
    /* the write succeeded; the list catches up on its next read */
  }
}
