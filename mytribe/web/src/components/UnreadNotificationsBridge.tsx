import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthState, useAuth } from '../lib/auth';
import { reportError } from '../lib/sentry';
import { resetUnreadBadge, setLiveRows, setUnreadFeedFailed } from '../lib/unreadBadge';
import { subscribeUnreadRows } from '../lib/unreadNotificationsListener';

/**
 * #1833: owns the one listener behind the bell's count, for the whole app.
 *
 * Mounted once beside the router (main.tsx), not inside PortalNav: every
 * screen renders its own PortalNav, so a listener there would close and reopen
 * on each navigation and the badge would blink. Keyed on the signed-in uid;
 * signing out closes it and forgets what it held.
 *
 * Each snapshot after the first that changes a row also refreshes the
 * notifications list when it is open, so the rows and the count change
 * together. A snapshot the store does not take (#2329: the cache's, before the
 * server has answered) does neither.
 *
 * A FAILED LISTENER IS QUIET IN THE HEADER AND LOUD IN THE LOGS, the same
 * ruling as the admin rail's count (auntieos-admin/src/lib/useUnreadInbox.ts):
 * the bell draws no badge instead of an old number, there is no banner, and
 * the failure goes to the console and to Sentry so a bell that never shows a
 * badge can be diagnosed. The notifications list stays the place that reports
 * its own failed load, with a retry. A denial that arrives because the session
 * just ended is expected and is not reported.
 */
export function UnreadNotificationsBridge(): null {
  const auth = useAuth();
  const uid = auth.status === 'signedIn' ? auth.user.uid : null;
  const queryClient = useQueryClient();

  useEffect(() => {
    if (uid === null) return;
    let first = true;
    const stop = subscribeUnreadRows(
      uid,
      ({ rows, fromCache, rowsChanged }) => {
        if (!setLiveRows(rows, { fromCache })) return;
        if (!first && rowsChanged) void queryClient.invalidateQueries({ queryKey: ['myNotifications'] });
        first = false;
      },
      (err) => {
        if (getAuthState().status !== 'signedIn') return;
        setUnreadFeedFailed();
        console.warn('Bell unread count unavailable:', err);
        reportError(err, 'bellUnreadCount');
      },
    );
    return () => {
      stop();
      resetUnreadBadge();
    };
  }, [uid, queryClient]);

  return null;
}
