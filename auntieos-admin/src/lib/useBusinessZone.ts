import { useEffect, useState } from 'react';
import { getBusinessSettings } from '../api/settings';
import { DEFAULT_BUSINESS_TIME_ZONE, resolveBusinessTimeZone } from './businessOperations';
import { sharedLoad } from './useSharedOneShot';

/**
 * The `sharedLoad` key `useBookingCatalog` reads `business_settings` under
 * (`BOOKING_CATALOG_KEY`). Joining it means a screen that already names its
 * services from the catalog learns the zone from the same request.
 */
export const BUSINESS_SETTINGS_SHARED_KEY = 'bookingCatalog';

/**
 * `business_settings.timeZone`, the clock the business's days are counted on
 * (#2036: the Auntie Time Archive's FROM and TO). The server's own default,
 * America/Chicago, until the read lands and if it fails or the stored zone is
 * unusable (#1109), never the device's.
 */
export function useBusinessZone(): string {
  const [zone, setZone] = useState<string>(DEFAULT_BUSINESS_TIME_ZONE);
  useEffect(() => {
    let live = true;
    sharedLoad(BUSINESS_SETTINGS_SHARED_KEY, getBusinessSettings)
      .then((settings) => {
        if (live) setZone(resolveBusinessTimeZone(settings.timeZone));
      })
      .catch(() => {
        // The default zone stands; see the doc above.
      });
    return () => {
      live = false;
    };
  }, []);
  return zone;
}
