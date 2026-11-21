import { useRouteContext } from '@tanstack/react-router';
import { Inbox } from '../screens/Inbox';
import { isAuntieAccess } from '../lib/access';

/**
 * The Inbox at `/inbox`.
 *
 * It tells the screen whether an Auntie is signed in, from the access the
 * admin layout already resolved, so the business line's Channels panel is
 * never mounted for her. The rules give her none of its four reads.
 */
export function InboxView() {
  const { access } = useRouteContext({ from: '/admin' });
  return <Inbox isAuntie={isAuntieAccess(access)} />;
}
