import { useEffect, useState } from 'react';
import { getBusinessSettings } from '../api/settings';
import { EMPTY_BOOKING_CATALOG, type BookingCatalog } from './bookingFormat';
import { sharedLoad } from './useSharedOneShot';

/** The `sharedLoad` key every caller of {@link useBookingCatalog} joins. */
export const BOOKING_CATALOG_KEY = 'bookingCatalog';

/**
 * The operator's KinCare catalog, for a screen that only needs it to NAME a
 * visit's service (#1592: KinTales rows printed `visit_60`). A read of
 * `business_settings` through `getBusinessSettings`, the same read Bookings
 * and Schedule use for their own copies.
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
    sharedLoad(BOOKING_CATALOG_KEY, getBusinessSettings)
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
