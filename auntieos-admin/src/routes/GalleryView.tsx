import { useRouteContext } from '@tanstack/react-router';
import { Gallery } from '../screens/Gallery';
import { isAuntieAccess } from '../lib/access';

/**
 * The Gallery at `/gallery`.
 *
 * #2438: it tells the screen whether an Auntie is signed in, from the access
 * the admin layout already resolved, so a photo's Delete is never drawn for
 * her, first paint included. Deleting a file is the owner's.
 */
export function GalleryView() {
  const { access } = useRouteContext({ from: '/admin' });
  return <Gallery isAuntie={isAuntieAccess(access)} />;
}
