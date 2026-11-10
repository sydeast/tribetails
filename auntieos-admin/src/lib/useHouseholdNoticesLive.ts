import { useEffect, useState } from 'react';
import { getBusinessSettings } from '../api/settings';
import { sharedLoad } from './useSharedOneShot';

/**
 * The `sharedLoad` key {@link useBookingCatalog} reads `business_settings`
 * under. Repeated here, not imported, because the screen tests mock that module
 * whole; `useHouseholdNoticesLive.test.ts` pins the two equal.
 */
export const BUSINESS_SETTINGS_SHARED_KEY = 'bookingCatalog';

/**
 * #1794: whether the household-notices switch
 * (`business_settings.householdNotificationsLive`, Settings > Notifications)
 * is on, for a confirm deciding whether it may promise a notice.
 *
 * NO NEW READ. Auntie Time and the visit sheet already read the settings
 * document through `useBookingCatalog`, and this joins the same `sharedLoad`
 * request, so the board still fetches it once.
 *
 * `null` while the read is in flight and when it fails. The confirm then says
 * nothing about the household rather than guess either way.
 */
export function useHouseholdNoticesLive(): boolean | null {
  const [live, setLive] = useState<boolean | null>(null);
  useEffect(() => {
    let mounted = true;
    sharedLoad(BUSINESS_SETTINGS_SHARED_KEY, getBusinessSettings)
      .then((settings) => {
        if (mounted) setLive(settings.householdNotificationsLive === true);
      })
      .catch(() => {
        // Unknown, not off: see the doc above.
      });
    return () => {
      mounted = false;
    };
  }, []);
  return live;
}
