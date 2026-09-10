import { useCallback, useState } from 'react';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { GhostButton, PrimaryButton } from './Buttons';
import { VetClinicPicker, EMPTY_VET_CLINIC, type VetClinicSelection } from './VetClinicPicker';
import { type Async } from '../lib/async';
import { selectableClinics, type VetClinic } from '../api/vetClinics';
import { resolveHouseholdVet, type ResolvedVet } from '../lib/householdVet';
import { legacyVetKeysForSlot, type HouseholdFields, type HouseholdSectionSpec } from '../lib/householdDataSchema';
import { saveHouseholdSection, type HouseholdRecord } from '../api/householdData';
import './HouseholdSectionDialog.css';

interface Props {
  section: HouseholdSectionSpec;
  kinfolkName: string;
  record: HouseholdRecord;
  /** The shared catalog, as the screen read it. Not re-read here: one listener, one truth. */
  clinics: Async<VetClinic[]>;
  onClose: () => void;
  onSaved: (next: HouseholdRecord) => void;
}

/**
 * Choosing a household's vet: the write half of the veterinary section.
 *
 * The generic `HouseholdSectionDialog` cannot do this job and now refuses to
 * try. What the record stores is two `vet_clinics` document ids, and an id is
 * not something an operator can type: a wrong character points a household at
 * another practice, or at nothing, on the one screen a sitter reads a vet's
 * number off in an emergency. So the vet is SEARCHED, through the same
 * `VetClinicPicker` the rest of the product uses, and the value is always a row
 * that already exists in the bank.
 *
 * THE PATCH IS THE TWO CLINIC IDS, PLUS A CLEAR FOR ANY SLOT THAT IS LINKED.
 * `primaryVetClinicId` and `emergencyVetClinicId` are the only fields this
 * dialog ever fills in with real text. The seven free-text `primaryVet*` /
 * `emergencyVet*` fields the section also lists are the retired copy: read for
 * a household that predates the catalog, shown when they linger, never
 * authored again.
 *
 * BUT A LINKED SLOT CLEARS ITS OWN LEGACY FIELDS IN THE SAME WRITE
 * (`legacyVetKeysForSlot`, issue #677). Before this, choosing a clinic here left
 * the old typed text sitting on the record forever, since nothing in the admin
 * ever touched it. From the operator's chair that reads as "cannot update vet":
 * the clinic picker shows the new practice, the read view shows the new
 * practice, and the same record still carries a name nobody chose. Clearing the
 * matching slot's legacy text the moment it is superseded is what makes this
 * dialog the one place a stale copy can actually be retired, rather than a
 * banner that can only report it.
 *
 * WHY HERE AND NOT ON THE PROFILE, which is where android sends you ("Edit on
 * the profile", `ui/directory/HouseholdDataScreen.kt`). React went the other
 * way on purpose: `KinfolkEdit` deleted its vet panel so the kinfolk doc would
 * stop being a second writable copy, and both `HouseholdVetPanels` and
 * `KinfolkProfile` now tell the operator to re-pick the vet on Household Data.
 * Porting android's button would leave the React admin with nowhere at all to
 * set a household's vet.
 */
export function VetSectionDialog({
  section,
  kinfolkName,
  record,
  clinics,
  onClose,
  onSaved,
}: Props) {
  const catalog = clinics.status === 'ready' ? clinics.data : [];
  const vet = resolveHouseholdVet(record, catalog);

  const [primary, setPrimary] = useState<VetClinicSelection>(() =>
    seed(record.primaryVetClinicId, vet.primary),
  );
  const [emergency, setEmergency] = useState<VetClinicSelection>(() =>
    seed(record.emergencyVetClinicId, vet.emergency),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Same memoized close as HouseholdSectionDialog, for the same reason: Dialog's
  // focus effect keys off this identity, and a fresh arrow each render steals
  // the caret out of the search box after its first character.
  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  // The catalog is what resolves a stored id into a clinic. Without it the
  // pickers have nothing to search and nothing to show, and a save from that
  // state would write two blank ids over a real vet. Refused rather than
  // rendered hopefully.
  const ready = clinics.status === 'ready';
  const pickable = selectableClinics(catalog);
  const dangling = vet.primary.dangling || vet.emergency.dangling;

  async function handleSave() {
    if (!ready || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const patch: Partial<HouseholdFields> = {
        primaryVetClinicId: primary.clinicId,
        emergencyVetClinicId: emergency.clinicId,
      };
      // A linked slot's legacy text is retired the moment the link is saved:
      // it is superseded by the clinic and nothing else in the admin will ever
      // clear it. An unlinked slot keeps its legacy text, since that text is
      // the vet actually shown for it.
      if (primary.clinicId.trim() !== '') {
        for (const key of legacyVetKeysForSlot('primary')) patch[key] = '';
      }
      if (emergency.clinicId.trim() !== '') {
        for (const key of legacyVetKeysForSlot('emergency')) patch[key] = '';
      }
      const next = await saveHouseholdSection(record, patch);
      setSaving(false);
      onSaved(next);
    } catch (err) {
      setSaving(false);
      setSaveError(err instanceof Error ? err.message : 'The save did not go through.');
    }
  }

  return (
    <Dialog
      title={`${section.title} · ${kinfolkName}`}
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Saving…' : 'Save vet'}
            onClick={() => void handleSave()}
            disabled={saving || !ready}
            busy={saving}
          />
        </>
      }
    >
      <p className="hsection__blurb">{section.blurb}</p>

      {clinics.status === 'loading' && <p className="hsection__blurb">Reading the shared clinic catalog…</p>}
      {clinics.status === 'error' && (
        <Banner tone="warning" title="The shared clinic catalog didn't load">
          <p>
            {clinics.message} There is nothing to search and nothing to save against, so this
            household&rsquo;s vet is left exactly as it is.
          </p>
        </Banner>
      )}

      {ready && (
        <>
          {dangling && (
            <Banner tone="warning" title="The clinic on file no longer exists">
              <p>
                This household points at a clinic that has been removed from the catalog, so there
                is nothing left to show for it. Pick the vet again below.
              </p>
            </Banner>
          )}

          <fieldset className="hsection__fields" disabled={saving}>
            <legend className="hsection__legend">{section.title}</legend>

            <VetClinicPicker
              name="primaryVet"
              label="Primary vet"
              clinics={pickable}
              value={primary}
              onChange={setPrimary}
              disabled={saving}
              wide
            />

            <VetClinicPicker
              name="emergencyVet"
              label="Emergency vet"
              clinics={pickable.filter((c) => c.isEmergency === true)}
              value={emergency}
              onChange={setEmergency}
              disabled={saving}
              createAsEmergency
              wide
            />
          </fieldset>

          {/* The 24 hour list is a filter on one flag, so a clinic missing from
              it is a clinic nobody has marked yet, not a clinic that cannot be
              used. Saying where the flag lives beats leaving the operator to
              conclude the bank is short. */}
          <p className="hsection__blurb">
            The emergency list is the clinics flagged as 24 hour in the vet clinics manager. If the
            one you want is missing, flag it there and it appears here.
          </p>
        </>
      )}

      {saveError !== null && (
        <Banner tone="error" title="That vet did not save">
          <p>
            Firestore rejected the write to household_data: {saveError}. Nothing changed, and your
            choice is still here.
          </p>
        </Banner>
      )}
    </Dialog>
  );
}

/**
 * What the picker opens on: the clinic this household is already linked to,
 * or the legacy free text when there is no link.
 *
 * `resolveHouseholdVet` has already decided which of those two applies, so this
 * reuses that answer rather than re-deriving it, and the picker's own unlinked
 * chip then says out loud what an id-less household is.
 *
 * A DANGLING id opens blank on purpose. Carrying an id that resolves to nothing
 * would render a chip with no name, which reads as a vet on file; the banner
 * above says what actually happened instead.
 */
function seed(clinicId: string, resolved: ResolvedVet): VetClinicSelection {
  if (resolved.dangling) return { ...EMPTY_VET_CLINIC };
  return {
    clinicId: clinicId.trim(),
    name: resolved.name,
    phone: resolved.phone,
    address: resolved.address,
  };
}
