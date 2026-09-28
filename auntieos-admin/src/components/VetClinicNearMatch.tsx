import { type ClinicCandidate } from '../api/vetClinicsWrite';
import './VetClinicPicker.css';

interface Props {
  /** Non-empty only while `submitVetClinic` answered `needs_choice`. Nothing has been written. */
  candidates: readonly ClinicCandidate[];
  /** The name the operator typed, for the "add as different clinic" button's label. */
  clinicName: string;
  saving: boolean;
  onUseCandidate: (c: ClinicCandidate) => void;
  /** Resubmits with every candidate's id acknowledged, which authorizes the create. */
  onAddAnyway: () => void;
}

/**
 * THE CHOICE a `needs_choice` answer from `submitVetClinic` requires: the bank
 * already holds something that looks like the clinic just typed, and nothing
 * has been written. Operator ruling 2026-08-01: a near-match clinic is a
 * choice, never a substitution, so this is never skipped and the first
 * candidate is never picked silently.
 *
 * Shared by every `submitVetClinic` caller (issue #1015) rather than each one
 * growing its own version: the household vet picker's inline create
 * (`VetClinicPicker.tsx`'s `CreateClinicForm`) and the vet clinics manager's
 * "Add a clinic" card (`screens/VetClinics.tsx`'s `AddClinicCard`) now render
 * the identical choice, so an operator seeing both surfaces is not asked to
 * learn two different answers to the same server response.
 */
export function VetClinicNearMatchChoice({
  candidates,
  clinicName,
  saving,
  onUseCandidate,
  onAddAnyway,
}: Props) {
  if (candidates.length === 0) return null;

  return (
    <div className="vetpick__candidates" role="group" aria-label="Possible matches">
      <p className="vetpick__createTitle">
        A clinic like this is already in the bank. Use it, or add yours separately.
      </p>
      {candidates.map((c) => (
        <button
          key={c.id}
          type="button"
          className="vetpick__candidate"
          onClick={() => onUseCandidate(c)}
        >
          <b>{c.isEmergency ? `${c.name} · 24hr` : c.name}</b>
          <small>
            {[c.address, c.phone].filter((v) => v !== '').join(' · ')}
            {!c.verified && ' · waiting for approval'}
          </small>
        </button>
      ))}
      <button type="button" className="vetpick__ghost" disabled={saving} onClick={onAddAnyway}>
        {saving ? 'Saving…' : `No, add "${clinicName.trim()}" as a different clinic`}
      </button>
    </div>
  );
}
