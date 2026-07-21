import { useCallback, useEffect, useState } from 'react';
import { getKin, type KinDetail } from '../api/kinView';
import { updateKin, setKinArchived, type KinEditPatch } from '../api/directoryWrite';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import './KinEdit.css';

interface KinEditProps {
  kinId: string;
  kinName: string;
  /** Called after a successful save/archive so the caller reloads the detail view. */
  onDone: () => void;
  onCancel: () => void;
}

/** The editable string fields (booleans handled separately). */
const TEXT_FIELDS = [
  ['name', 'Name'],
  ['species', 'Species'],
  ['breed', 'Breed'],
  ['age', 'Age'],
  ['sex', 'Sex'],
  ['weight', 'Weight'],
  ['colorMarkings', 'Color / markings'],
] as const;
const CARE_FIELDS = [
  ['staysAs', 'Stays as'],
  ['routine', 'Routine'],
  ['trainingCommands', 'Training / commands'],
  ['feedingBrand', 'Food / brand'],
] as const;
/**
 * NO `vetInfo` ENTRY HERE, and this is a rule, not an oversight. Fix-backlog
 * item 5.4 (AuntieOS_Fix_Backlog_2026-06-02.md:90): "Remove vet info box from
 * the pet (Kin). Vets attach to the Kinfolk (owner), not the Kin. Stop adding
 * an add/edit vet info box to the pet profile. It may be shown READ-ONLY on the
 * Kin, but never as an entry box there."
 *
 * The canonical household vet is `kinfolk.vetClinicName` / `vetClinicPhone` /
 * `vetClinicAddress`, edited and displayed on the household
 * (`screens/KinfolkProfile.tsx`). Android already complies, see the matching
 * note at `DirectoryViewModel.kt:1067` ("vetInfo has no setter: vet is read-only
 * on the Kin (single-source on Kinfolk, 1D)"); React was the last surface still
 * offering a second, per-pet place to type a vet, which is how a household ends
 * up with two disagreeing vets and no rule about which one is true.
 *
 * The stored `kin.vetInfo` field is deliberately NOT deleted: `KinView.tsx:182`
 * renders it read-only and legacy docs still carry real data (HANDOFF_2026-05-28
 * :152). Dropping it from the write path is safe for that data because
 * `directoryWrite.ts#updateKin` sends its patch through `updateDoc`, a
 * field-level MERGE, so a key the patch omits is left untouched rather than
 * cleared. The whole-object hazard the 2026-07-20 audit describes is real but
 * belongs to the Kotlin trees (`.set(kin)` / `platformUpdateKin`), and both
 * carry `vetInfo` on their Kin model, so it round-trips there too.
 */
const HEALTH_FIELDS = [
  ['vaccinations', 'Vaccinations'],
  ['medicationHealthNotes', 'Medication / health notes'],
] as const;
const OWNER_FIELDS = [
  ['ownerEmail', 'Owner email'],
  ['ownerPhone', 'Owner phone'],
] as const;

type FormState = Pick<
  KinDetail,
  | 'name' | 'species' | 'breed' | 'age' | 'sex' | 'weight' | 'colorMarkings'
  | 'spayedNeutered' | 'reactive' | 'staysAs' | 'routine' | 'trainingCommands'
  | 'feedingBrand' | 'vaccinations' | 'medicationHealthNotes'
  | 'officeNotes' | 'ownerEmail' | 'ownerPhone' | 'status'
>;

/**
 * `vetInfo` is dropped alongside the never-edited identity fields so it cannot
 * reach the form state at all, which is what makes the HEALTH_FIELDS rule above
 * enforceable by the compiler rather than by memory: there is no `form.vetInfo`
 * for a future field row or patch key to reference.
 */
function toForm(k: KinDetail): FormState {
  const { _id, kinfolkId, profilePictureUrl, vetInfo, ...rest } = k;
  void _id;
  void kinfolkId;
  void profilePictureUrl;
  void vetInfo;
  return rest;
}

/**
 * Kin (pet) editor: the WRITE surface KinView's Edit action opens. Loads the
 * flat `kin/{id}` doc (getKin), edits the rich flat fields, and saves via
 * `updateKin` (a direct rules-backed merge on the flat collection, NOT the
 * portal `updateKin` callable, which edits a different model; see
 * api/directoryWrite.ts). Archive/restore is the separate status control
 * (`setKinArchived`), matching the wasm KinEditScreen. Fail-loud, disabled
 * while a write is in flight.
 */
export function KinEdit({ kinId, kinName, onDone, onCancel }: KinEditProps) {
  const [loaded, setLoaded] = useState<Async<KinDetail>>({ status: 'loading' });
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    setLoaded({ status: 'loading' });
    void (async () => {
      try {
        const data = await getKin(kinId);
        if (live) {
          setLoaded({ status: 'ready', data });
          setForm(toForm(data));
        }
      } catch (err) {
        if (live) {
          setLoaded({
            status: 'error',
            message: `getKin failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [kinId]);

  useEffect(() => load(), [load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function handleSave() {
    if (!form || saving) return;
    if (form.name.trim() === '') {
      setError('A kin name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Send every editable field (updateDoc is a merge; status stays owned by archive).
      const patch: KinEditPatch = {
        name: form.name.trim(),
        species: form.species,
        breed: form.breed,
        age: form.age,
        sex: form.sex,
        weight: form.weight,
        colorMarkings: form.colorMarkings,
        spayedNeutered: form.spayedNeutered,
        reactive: form.reactive,
        staysAs: form.staysAs,
        routine: form.routine,
        trainingCommands: form.trainingCommands,
        feedingBrand: form.feedingBrand,
        vaccinations: form.vaccinations,
        medicationHealthNotes: form.medicationHealthNotes,
        // No `vetInfo`: see the HEALTH_FIELDS note. `updateKin` patches through
        // `updateDoc`, a merge, so omitting the key preserves the stored value
        // for KinView's read-only row instead of blanking it.
        officeNotes: form.officeNotes,
        ownerEmail: form.ownerEmail,
        ownerPhone: form.ownerPhone,
      };
      await updateKin(kinId, patch);
      setSaving(false);
      onDone();
    } catch (err) {
      setSaving(false);
      setError(`updateKin failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    }
  }

  async function handleArchiveToggle() {
    if (!form || archiving) return;
    const archived = form.status !== 'archived';
    setArchiving(true);
    setError(null);
    try {
      await setKinArchived(kinId, archived);
      setArchiving(false);
      onDone();
    } catch (err) {
      setArchiving(false);
      setError(`setKinArchived failed: ${err instanceof Error ? err.message : 'Update failed'}`);
    }
  }

  const busy = saving || archiving;

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title={`Edit ${kinName || kinId}`}
        subtitle="Kin profile editor."
        trailing={<GhostButton label="Cancel" onClick={onCancel} disabled={busy} />}
      />

      {error !== null && (
        <Banner tone="error" title="Save failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <AsyncRegion
        state={loaded}
        what="kin"
        isEmpty={() => false}
        loading={<p className="kedit__hint">Loading kin…</p>}
        empty={<p className="kedit__hint">Nothing to edit.</p>}
      >
        {() =>
          form === null ? (
            <p className="kedit__hint">Loading kin…</p>
          ) : (
            <>
              <DenPanel title="Basics">
                <fieldset className="kedit__grid" disabled={busy}>
                  {TEXT_FIELDS.map(([key, label]) => (
                    <label key={key} className="kedit__field">
                      <span className="kedit__label">{label}</span>
                      <input
                        className="kedit__input"
                        value={form[key]}
                        onChange={(e) => set(key, e.target.value)}
                      />
                    </label>
                  ))}
                  <label className="kedit__check">
                    <input
                      type="checkbox"
                      checked={form.spayedNeutered}
                      onChange={(e) => set('spayedNeutered', e.target.checked)}
                    />
                    <span>Spayed / neutered</span>
                  </label>
                  <label className="kedit__check">
                    <input
                      type="checkbox"
                      checked={form.reactive}
                      onChange={(e) => set('reactive', e.target.checked)}
                    />
                    <span>Reactive (handle with care)</span>
                  </label>
                </fieldset>
              </DenPanel>

              <DenPanel title="Behavior & care">
                <fieldset className="kedit__grid" disabled={busy}>
                  {CARE_FIELDS.map(([key, label]) => (
                    <label key={key} className="kedit__field kedit__field--wide">
                      <span className="kedit__label">{label}</span>
                      <textarea
                        className="kedit__input kedit__textarea"
                        value={form[key]}
                        onChange={(e) => set(key, e.target.value)}
                        rows={2}
                      />
                    </label>
                  ))}
                </fieldset>
              </DenPanel>

              <DenPanel title="Health">
                <fieldset className="kedit__grid" disabled={busy}>
                  {HEALTH_FIELDS.map(([key, label]) => (
                    <label key={key} className="kedit__field kedit__field--wide">
                      <span className="kedit__label">{label}</span>
                      <textarea
                        className="kedit__input kedit__textarea"
                        value={form[key]}
                        onChange={(e) => set(key, e.target.value)}
                        rows={2}
                      />
                    </label>
                  ))}
                </fieldset>
              </DenPanel>

              <DenPanel title="Owner contact">
                <fieldset className="kedit__grid" disabled={busy}>
                  {OWNER_FIELDS.map(([key, label]) => (
                    <label key={key} className="kedit__field">
                      <span className="kedit__label">{label}</span>
                      <input
                        className="kedit__input"
                        value={form[key]}
                        onChange={(e) => set(key, e.target.value)}
                      />
                    </label>
                  ))}
                </fieldset>
              </DenPanel>

              <DenPanel title="Office notes" subtitle="Staff-only.">
                <fieldset disabled={busy}>
                  <textarea
                    className="kedit__input kedit__textarea"
                    value={form.officeNotes}
                    onChange={(e) => set('officeNotes', e.target.value)}
                    rows={3}
                    aria-label="Office notes"
                  />
                </fieldset>
              </DenPanel>

              <div className="kedit__actions">
                <GhostButton
                  label={
                    archiving
                      ? 'Updating…'
                      : form.status === 'archived'
                        ? 'Restore'
                        : 'Archive'
                  }
                  onClick={() => void handleArchiveToggle()}
                  disabled={busy}
                />
                <div className="kedit__actions-right">
                  <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
                  <PrimaryButton
                    label={saving ? 'Saving…' : 'Save changes'}
                    onClick={() => void handleSave()}
                    disabled={busy || form.name.trim() === ''}
                    busy={saving}
                  />
                </div>
              </div>
            </>
          )
        }
      </AsyncRegion>
    </div>
  );
}
