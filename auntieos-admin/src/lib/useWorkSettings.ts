import { useCallback, useEffect, useState } from 'react';
import { getWorkSettings, getWorkSettingsFor, type WorkSettings } from '../api/workSettings';
import type { Async } from './async';
import { currentSessionSeat, seatKey } from './sessionSeat';
import { invalidateSharedLoad, sharedLoad, SHARED_ONE_SHOT_TTL_MS } from './useSharedOneShot';

/**
 * #2164: ONE work-settings read shared by every card and hook on a board
 * (`useBookingCatalog`, `useBusinessZone`, `useArrivalRule` and the screens'
 * own notices), keyed by who is signed in so one session's answer is never
 * served to the next.
 */
export const WORK_SETTINGS_KEY = 'bookingCatalog';

export async function loadSharedWorkSettings(ttlMs: number = SHARED_ONE_SHOT_TTL_MS): Promise<WorkSettings> {
  const seat = await currentSessionSeat();
  return sharedLoad(seatKey(WORK_SETTINGS_KEY, seat), () => getWorkSettingsFor(seat), ttlMs);
}

/**
 * This screen's OWN read as a load state, one per mount, never shared: for a
 * screen whose values must be the document as it stands when the screen opens
 * (Schedule, Bookings, visit detail, KinTale templates), as their direct reads
 * always were. Retry reads again.
 */
export function useWorkSettingsRead(): Async<WorkSettings> {
  const [state, setState] = useState<Async<WorkSettings>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', retry });
    getWorkSettings()
      .then((data) => {
        if (live) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : 'Load failed', retry });
      });
    return () => {
      live = false;
    };
  }, [attempt, retry]);
  return state;
}

/**
 * The shared read as a load state, for a screen that has to SAY it is waiting
 * or that the read failed (`components/WorkSettingsNotice.tsx`). Retry drops the
 * held entry so it really reads again.
 */
export function useWorkSettings(): Async<WorkSettings> {
  const [state, setState] = useState<Async<WorkSettings>>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    void currentSessionSeat().then((seat) => {
      invalidateSharedLoad(seatKey(WORK_SETTINGS_KEY, seat));
      setAttempt((n) => n + 1);
    });
  }, []);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading', retry });
    loadSharedWorkSettings()
      .then((data) => {
        if (live) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (live) setState({ status: 'error', message: err instanceof Error ? err.message : 'Load failed', retry });
      });
    return () => {
      live = false;
    };
  }, [attempt, retry]);
  return state;
}
