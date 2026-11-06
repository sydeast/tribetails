import { useMemo } from 'react';
import { VET_CLINICS_QUERY, sortVetClinics, type VetClinic } from '../api/vetClinics';
import type { Async } from './async';
import { useCollection } from './firestore';
/** The vet clinic bank, A to Z, including any clinic saved without a name (#1565). */
export function useVetClinics(): Async<VetClinic[]> {
  const state = useCollection<VetClinic>(VET_CLINICS_QUERY);
  return useMemo(
    () => (state.status === 'ready' ? { ...state, data: sortVetClinics(state.data) } : state),
    [state],
  );
}
