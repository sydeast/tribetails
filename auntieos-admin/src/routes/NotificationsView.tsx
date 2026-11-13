import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { Notifications } from '../screens/Notifications';
import { isAuntieAccess } from '../lib/access';
import { type NotificationRoute } from '../lib/notificationActions';

/**
 * Performs the navigations the Notifications feed asks for.
 *
 * The feed hands up a `NotificationRoute` from its own tested routing table
 * (`lib/notificationActions.ts`) rather than calling the router itself, so the
 * table stays unit-testable and the screen stays renderable without a router.
 * The cast is the price of a runtime-computed destination: TanStack types
 * `navigate()` against the literal route tree, which cannot express "one of
 * four routes, decided from Firestore data". Every `to` the table can produce
 * is a route registered in `router.tsx`, and `notificationActions.test.ts` pins
 * all four.
 *
 * #2200 / #2201: it also tells the feed whether the signed-in account is an
 * Auntie, from the access the admin layout already resolved, so her rows offer
 * no Open or Create quote into Invoices, a screen that sends her Home.
 */
export function NotificationsView() {
  const navigate = useNavigate();
  const { access } = useRouteContext({ from: '/admin' });
  const go = (route: NotificationRoute) => {
    void navigate(route as unknown as Parameters<typeof navigate>[0]);
  };
  return <Notifications onNavigate={go} isAuntie={isAuntieAccess(access)} />;
}
