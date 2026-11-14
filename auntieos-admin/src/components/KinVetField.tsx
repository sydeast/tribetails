import { useId } from 'react';
import { getHouseholdData, type HouseholdRecord } from '../api/householdData';
import { clinicDetail, clinicName, selectableClinics, type VetClinic } from '../api/vetClinics';
import { type Async } from '../lib/async';
import { useOneShot } from '../lib/useOneShot';
import { useVetClinics } from '../lib/useVetClinics';
import { resolveKinVet, showsVet, vetLine } from '../lib/kinVet';
import { BLANK_VET } from '../lib/householdVet';
import { LoadingRow } from './LoadingRow';
import { Banner } from './Banner';

/** The household's vet record, read once; a Kin with no household reads as none. */
export function useHouseholdVetRecord(kinfolkId: string): Async<HouseholdRecord | null> {
  return useOneShot(
    () => (kinfolkId.trim() === '' ? Promise.resolve(null) : getHouseholdData(kinfolkId)),
    'getHouseholdData',
  );
}

interface KinVetFieldProps {
  kinfolkId: string;
  /** The Kin's own vet, '' for the household's. */
  value: string;
  /** "Different vet for this Kin" is ticked. */
  different: boolean;
  onDifferentChange: (next: boolean) => void;
  onChange: (clinicId: string) => void;
  disabled?: boolean;
}

/**
 * #1908 kin-vet, the edit form's Vet row. The household's vet is shown read
 * only. "Different vet for this Kin" (unticked unless the Kin already has its
 * own) opens the area vet list; unticking sends the Kin back to the household's
 * vet when the form is saved.
 */
export function KinVetField({ kinfolkId, value, different, onDifferentChange, onChange, disabled }: KinVetFieldProps) {
  const household = useHouseholdVetRecord(kinfolkId);
  const clinics = useVetClinics();
  const checkId = useId();
  const selectId = useId();

  const all: readonly VetClinic[] = clinics.status === 'ready' ? clinics.data : [];
  const householdVet =
    household.status === 'ready' && clinics.status === 'ready'
      ? resolveKinVet('', household.data, all).vet
      : BLANK_VET;
  // The current pick stays in the list even when it has since been retired, so
  // the select shows what is on file rather than silently reading "Choose".
  const options = selectableClinics(all);
  const current = all.find((c) => c._id === value);
  const listed = current !== undefined && !options.some((c) => c._id === current._id) ? [current, ...options] : options;

  return (
    <div className="kedit__field kedit__field--wide">
      <span className="kedit__label">Vet</span>
      {household.status === 'loading' || clinics.status === 'loading' ? (
        <LoadingRow label="Loading the vet list…" className="kedit__hint" />
      ) : household.status === 'error' || clinics.status === 'error' ? (
        <Banner tone="warning" title="The vet list did not load">
          {household.status === 'error' ? household.message : clinics.status === 'error' ? clinics.message : ''}
        </Banner>
      ) : (
        <p className="kedit__readonly" data-testid="kin-vet-household">
          {showsVet(householdVet) ? `${vetLine(householdVet)} (the household's vet)` : 'No vet on the household yet.'}
        </p>
      )}
      <label className="kedit__check" htmlFor={checkId}>
        <input
          id={checkId}
          type="checkbox"
          checked={different}
          disabled={disabled}
          onChange={(e) => onDifferentChange(e.target.checked)}
        />
        <span>Different vet for this Kin</span>
      </label>
      {different && clinics.status === 'ready' && (
        <select
          id={selectId}
          className="kedit__input"
          aria-label="Vet for this Kin"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose a vet</option>
          {listed.map((c) => (
            <option key={c._id} value={c._id}>
              {[clinicName(c) || 'Unnamed clinic', clinicDetail(c)].filter((s) => s !== '').join(' · ')}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
