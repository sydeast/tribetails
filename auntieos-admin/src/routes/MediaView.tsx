import { useParams, useRouteContext } from '@tanstack/react-router';
import { Media } from '../screens/Media';
import { type MediaTargetType } from '../lib/mediaScopeFormat';
import { isAuntieAccess } from '../lib/access';

/**
 * Adapts the `media/$type/$id` route params to Media's typed props.
 *
 * #2438: it also tells the screen whether an Auntie is signed in, from the
 * access the admin layout already resolved, so a photo's Delete is never drawn
 * for her. Deleting a file is the owner's.
 */
export function MediaView() {
  const { type, id } = useParams({ from: '/admin/media/$type/$id' });
  const { access } = useRouteContext({ from: '/admin' });
  const targetType: MediaTargetType = type === 'household' ? 'household' : 'kin';
  return <Media targetType={targetType} targetId={id} isAuntie={isAuntieAccess(access)} />;
}
