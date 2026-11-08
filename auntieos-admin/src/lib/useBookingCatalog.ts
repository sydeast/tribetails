import { useEffect, useState } from 'react';
import { getBusinessSettings } from '../api/settings';
import { EMPTY_BOOKING_CATALOG, type BookingCatalog } from './bookingFormat';

/**
 * The operator's KinCare catalog, for a screen that only needs it to NAME a
 * visit's service (#1592: KinTales rows printed `visit_60`). One-shot read of
 * `business_settings`, the same `getBusinessSettings` + `live` guard Bookings
 * and Schedule use for their own copies.
 *
 * Fails quiet to the empty catalog, which `bookingServiceName` reads as "no
 * match" and answers with the stored text: the row says what it always said,
 * never a made-up name.
 */
export function useBookingCatalog(): BookingCatalog {
  const [catalog, setCatalog] = useState<BookingCatalog>(EMPTY_BOOKING_CATALOG);
  useEffect(() => {
    let live = true;
    getBusinessSettings()
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
