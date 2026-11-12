import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getMyBookings } from '../api/portal';
import type { GetMyBookingsResult } from '../contracts/bookingContracts.generated';
import { bookingsQueryKey } from './bookingsCache';
import { bookingsPollMs } from './portalFormat';

/**
 * The household's schedule, as Home, Schedule and the booking page all read it.
 *
 * #1823 / #1832: one hook so the three screens share one rule for keeping it
 * current. While a visit is under way, or a confirmed one is about due, the
 * list is re-read every `BOOKINGS_POLL_MS` (`bookingsPollMs` decides), so
 * On the way, Arrived and Departed reach an open screen without a reload and
 * the live card clears when the Auntie leaves. The rest of the time it is read
 * once per mount, as before.
 *
 * A re-read keeps the data on screen while it runs, so nothing flickers; the
 * first read of each screen has its own loading line. React Query pauses the
 * interval while the tab is hidden, and coming back to the tab re-reads at
 * once (`refetchOnWindowFocus`, on for this query only), which is when a
 * household checking on a visit most needs the current answer.
 *
 * ONE FAILED RE-READ MUST NOT TAKE THE SCREEN AWAY. Every screen answers
 * `isError` with the full-page "we hit a snag", which is right for a schedule
 * that never loaded and wrong for a household watching a visit whose thirtieth
 * re-read dropped. So while the list is being kept current, a re-read that
 * fails hands back the answer already on screen and the next turn tries again.
 * A read with nothing to fall back on still fails out loud.
 */
export function useMyBookings(kinfolkId: string | undefined) {
  const queryClient = useQueryClient();
  const queryKey = bookingsQueryKey(kinfolkId);
  return useQuery({
    queryKey,
    queryFn: async () => {
      try {
        return await getMyBookings(kinfolkId);
      } catch (err) {
        const last = queryClient.getQueryData<GetMyBookingsResult>(queryKey);
        if (last !== undefined && bookingsPollMs(last) !== false) return last;
        throw err;
      }
    },
    refetchInterval: (query) => bookingsPollMs(query.state.data),
    refetchOnWindowFocus: (query) => bookingsPollMs(query.state.data) !== false,
  });
}
