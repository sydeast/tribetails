import { useNavigate, useRouteContext, useSearch } from '@tanstack/react-router';
import { Communicate } from '../screens/Communicate';
import { isAuntieAccess } from '../lib/access';

/**
 * The `/communicate` route. Reads `?draftId=` (#1563), the stored KinTale draft
 * KinTales > Drafts or Home's "KinTales pending" sent the operator here to
 * review, and hands it to the screen. The screen itself stays router-free so
 * its tests render it bare.
 *
 * #2444: it also tells the screen whether an Auntie is signed in, from the
 * access the admin layout already resolved, so the owner's sends are never
 * drawn for her, and gives her empty state its way to the KinTales list.
 */
export function CommunicateView() {
  const { draftId } = useSearch({ from: '/admin/communicate' });
  const { access } = useRouteContext({ from: '/admin' });
  const navigate = useNavigate();
  return (
    <Communicate
      draftId={draftId}
      isAuntie={isAuntieAccess(access)}
      onOpenKinTale={(reportId) => void navigate({ to: '/kintales', search: { kinTaleId: reportId } })}
      onOpenKinTales={() => void navigate({ to: '/kintales', search: { range: 'all' } })}
    />
  );
}
