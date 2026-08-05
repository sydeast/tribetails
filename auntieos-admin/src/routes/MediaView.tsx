import { useParams } from '@tanstack/react-router';
import { Media } from '../screens/Media';
import { type MediaTargetType } from '../lib/mediaScopeFormat';

/** Adapts the `media/$type/$id` route params to Media's typed props. */
export function MediaView() {
  const { type, id } = useParams({ from: '/admin/media/$type/$id' });
  const targetType: MediaTargetType = type === 'household' ? 'household' : 'kin';
  return <Media targetType={targetType} targetId={id} />;
}
