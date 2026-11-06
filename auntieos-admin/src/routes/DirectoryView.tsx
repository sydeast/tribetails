import { useSearch } from '@tanstack/react-router';
import { Directory } from '../screens/Directory';
/**
 * The `/directory` route. A thin reader for the two entry params Home's "Kin in
 * care" card sends (#1601): `?tab=kin` opens the Kin tab and `?inCare=1` narrows
 * it to the pets that card counts. Initial state only, so the operator can
 * switch tab or widen the filter afterwards without the URL fighting back.
 */
export function DirectoryView() {
  const { tab, inCare } = useSearch({ from: '/admin/directory' });
  return <Directory initialTab={tab === 'kin' ? 'kin' : 'kinfolk'} initialKinInCare={inCare === '1'} />;
}
