import { useNavigate, useRouteContext, useSearch } from '@tanstack/react-router';
import { Directory } from '../screens/Directory';
import { isAuntieAccess } from '../lib/access';
import { useKinRoute } from './useKinRoute';

/**
 * The `/directory` route. A thin reader for the two entry params Home's "Kin in
 * care" card sends (#1601): `?tab=kin` opens the Kin tab and `?inCare=1` narrows
 * it to the pets that card counts. Initial state only, so the operator can
 * switch tab or widen the filter afterwards without the URL fighting back.
 *
 * It also tells the screen whether an Auntie is signed in, from the access the
 * admin layout already resolved, so Add kinfolk is never drawn for her.
 */
export function DirectoryView() {
  const { tab, inCare, kin, kinView } = useSearch({ from: '/admin/directory' });
  const navigate = useNavigate();
  // #1893: a Kin opened from the Kin tab has its own address too.
  const { routedKin, onKinRouteChange } = useKinRoute(kin, kinView, (search, replace) => {
    void navigate({
      to: '/directory',
      search: { ...(tab !== undefined ? { tab } : {}), ...(inCare !== undefined ? { inCare } : {}), ...search },
      replace,
    });
  });
  const { access } = useRouteContext({ from: '/admin' });
  return (
    <Directory
      isAuntie={isAuntieAccess(access)}
      initialTab={tab === 'kin' || kin !== undefined ? 'kin' : 'kinfolk'}
      initialKinInCare={inCare === '1'}
      routedKin={routedKin}
      onKinRouteChange={onKinRouteChange}
    />
  );
}
