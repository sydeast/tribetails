import { useEffect, useState } from 'react';
import { EMPTY_BOOKING_CATALOG, type BookingCatalog } from './bookingFormat';
import { loadSharedWorkSettings, WORK_SETTINGS_KEY } from './useWorkSettings';

/**
 * The `sharedLoad` key prefix every caller of {@link useBookingCatalog} joins.
 * #2164: the full key also names the signed-in session (`lib/sessionSeat.ts`).
 */
export const BOOKING_CATALOG_KEY = WORK_SETTINGS_KEY;

/**
 * The operator's KinCare catalog, for a screen that only needs it to NAME a
 * visit's service (#1592: KinTales rows printed `visit_60`). The shared work
 * settings read (`lib/useWorkSettings.ts`): the owner's own `business_settings`
 * read, or for an Auntie the narrow staff read, which names KinCares and never
 * carries a rate (#2164).
 *
 * SHARED, NOT PER CARD. Home mounts the Overdue, Safebox and Today's pack
 * cards at once and each names its service, so a per-hook read was three
 * fetches of one document per visit to /home. The read goes through
 * `sharedLoad`, the cache the Home weather cards already use: every caller
 * mounted together joins one request, and a later mount reuses it until it
 * goes stale, so a rename in Settings shows within that window.
 *
 * Fails quiet to the empty catalog, which `bookingServiceName` reads as "no
 * match" and answers with the stored text: the row says what it always said,
 * never a made-up name. A failed read is never cached, so the next mount
 * tries again.
 */
export function useBookingCatalog(): BookingCatalog {
  const [catalog, setCatalog] = useState<BookingCatalog>(EMPTY_BOOKING_CATALOG);
  useEffect(() => {
    let live = true;
    loadSharedWorkSettings()
      .then((settings) => {
        if (!live) return;
        setCatalog({
          serviceRates: settings.serviceRates,
          serviceDurations: settings.serviceDurations,
          timeBlocks: settings.timeBlocks,
        });
      })
      .catch(() => {
        // The empty catalog is the fallback; see the doc above.
      });
    return () => {
      live = false;
    };
  }, []);
  return catalog;
}
