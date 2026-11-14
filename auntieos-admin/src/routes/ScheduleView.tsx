import { useRouteContext } from '@tanstack/react-router';
import { Schedule } from '../screens/Schedule';
import { isAuntieAccess } from '../lib/access';

/**
 * The Schedule at `/schedule`.
 *
 * #2199, operator ruling 2026-11-14 ("the button is disabled but visible"): it
 * tells the screen whether an Auntie is signed in, from the access the admin
 * layout already resolved, so Mark Completed in a visit's sheet is held from
 * the first paint. `BookingsView` and `SessionsView` do the same.
 */
export function ScheduleView() {
  const { access } = useRouteContext({ from: '/admin' });
  return <Schedule isAuntie={isAuntieAccess(access)} />;
}
