import type { VetClinicDto, VetClinicSummaryDto } from '../api/tribeApi';
import { formatPhone } from '../lib/phone';
import { vetLine } from '../lib/kinVet';
import { VetClinicPicker } from './VetClinicPicker';

/**
 * #1908 kin-vet (owner ruling 2026-11-12) on the Kin edit and add forms. The
 * Kin's vet is the household's, read only, unless "Different vet for this Kin"
 * (unticked by default) is ticked; then the area vet list picks one for this
 * Kin alone. Unticking puts the Kin back on the household's vet.
 */
export function KinVetField({
  idPrefix,
  householdVet,
  householdVetLoading,
  clinics,
  clinicsLoading,
  clinicsFailed,
  differentVet,
  ownVetClinicId,
  onDifferentChange,
  onPick,
  error,
}: {
  idPrefix: string;
  householdVet: VetClinicSummaryDto | null | undefined;
  householdVetLoading: boolean;
  clinics: readonly VetClinicDto[];
  clinicsLoading: boolean;
  clinicsFailed: boolean;
  differentVet: boolean;
  ownVetClinicId: string;
  onDifferentChange: (next: boolean) => void;
  onPick: (clinicId: string) => void;
  error?: string | undefined;
}) {
  const own = ownVetClinicId.trim() === '' ? undefined : clinics.find((c) => c.id === ownVetClinicId.trim());
  return (
    <div className="field full">
      <label id={`${idPrefix}-vet-label`}>Vet</label>
      <p className="sub" data-testid={`${idPrefix}-household-vet`}>
        {householdVetLoading
          ? 'Loading your Tribe Profile vet…'
          : householdVet
            ? `From your Tribe Profile: ${vetLine(householdVet, formatPhone)}`
            : 'No vet on your Tribe Profile yet.'}
      </p>
      <label className="checkline" htmlFor={`${idPrefix}-differentVet`} style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <input
          id={`${idPrefix}-differentVet`}
          type="checkbox"
          checked={differentVet}
          onChange={(e) => onDifferentChange(e.target.checked)}
        />
        Different vet for this Kin
      </label>
      {differentVet && (
        <>
          {own ? (
            <p className="sub" data-testid={`${idPrefix}-own-vet`}>
              <b>{vetLine(own, formatPhone)}</b>
            </p>
          ) : ownVetClinicId.trim() !== '' && !clinicsLoading ? (
            <p className="hint" style={{ color: 'var(--coral)' }}>This Kin&rsquo;s vet is no longer on the list. Choose another.</p>
          ) : null}
          <VetClinicPicker
            id={`${idPrefix}-ownVet`}
            label={own ? 'Change this Kin’s vet' : 'Choose this Kin’s vet'}
            clinics={clinics}
            loading={clinicsLoading}
            failed={clinicsFailed}
            onPick={(c) => onPick(c.id)}
          />
        </>
      )}
      {error && (
        <span className="hint" style={{ color: 'var(--coral)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
