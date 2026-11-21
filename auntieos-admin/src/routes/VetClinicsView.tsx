import { useRouteContext } from '@tanstack/react-router';
import { VetClinics } from '../screens/VetClinics';
import { isAuntieAccess } from '../lib/access';

/**
 * The vet bank at `/vet-clinics`.
 *
 * It tells the screen whether an Auntie is signed in, from the access the
 * admin layout already resolved, so a clinic card carries no curating control
 * for her. She may add a clinic; editing and retiring one are the owner's.
 */
export function VetClinicsView() {
  const { access } = useRouteContext({ from: '/admin' });
  return <VetClinics isAuntie={isAuntieAccess(access)} />;
}
