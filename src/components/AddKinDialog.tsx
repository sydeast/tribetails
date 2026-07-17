import { useCallback, useState } from 'react';
import { createKin, NEW_KIN_SEX_OPTIONS, NEW_KIN_SPECIES_OPTIONS } from '../api/directoryWrite';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import './AddKinDialog.css';

export interface KinfolkOption {
  id: string;
  /** Display label for the picker, e.g. `kinfolkDisplayName(kf)`. */
  label: string;
}

interface AddKinDialogProps {
  /** Every household this pet could belong to. Directory already subscribes to
   * KINFOLK_QUERY for its own tab, so this dialog takes the list as a prop
   * rather than opening a second listener for the same collection. */
  kinfolkOptions: KinfolkOption[];
  /** Preselects a household (e.g. a future "Add kin" launched from that
   * household's own card). The header-launched call omits this and the
   * operator picks one from the dropdown instead. */
  initialKinfolkId?: string;
  onClose: () => void;
  /** Called once the pet is actually created, with its new doc id. Directory's
   * Kin tab is a live `onSnapshot` stream (KIN_QUERY), so it picks the new row
   * up on its own; this callback exists only so the caller can act on the
   * fresh id. */
  onCreated: (kinId: string) => void;
}

/**
 * The create half of Directory's Kin tab, opened from its "Add kin" header
 * button. Mirrors `KinEditScreen.kt`'s create path for exactly the fields this
 * form collects (name, species, breed, age, gender, plus the household
 * picker this admin needs that the wasm screen gets for free from its route
 * param); see api/directoryWrite.ts's `createKin` doc for the confirmed write
 * path (a direct, rules-backed `kin` collection create) and why it stamps
 * `updatedAt` itself.
 *
 * `status` is deliberately NOT a field here: the wasm's own create path never
 * exposes one either (`build()` always writes `"active"` for a new Kin, see
 * createKin's doc), so this form doesn't invent a control the source doesn't
 * have.
 */
export function AddKinDialog({ kinfolkOptions, initialKinfolkId, onClose, onCreated }: AddKinDialogProps) {
  const [kinfolkId, setKinfolkId] = useState(initialKinfolkId ?? '');
  const [name, setName] = useState('');
  const [species, setSpecies] = useState<string>(NEW_KIN_SPECIES_OPTIONS[0] ?? 'Dog');
  const [breed, setBreed] = useState('');
  const [age, setAge] = useState('');
  const [sex, setSex] = useState('');

  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const kinfolkError = touched && kinfolkId === '' ? 'Pick a household.' : null;
  const nameError = touched && name.trim() === '' ? "Name can't be blank." : null;
  const sexError = touched && sex === '' ? 'Pick a gender.' : null;

  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function handleSave() {
    setTouched(true);
    if (kinfolkId === '' || name.trim() === '' || sex === '' || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const id = await createKin({ kinfolkId, name, species, breed, age, sex });
      setSaving(false);
      onCreated(id);
    } catch (err) {
      setSaving(false);
      setSaveError(`createKin failed: ${err instanceof Error ? err.message : 'Create failed'}`);
    }
  }

  return (
    <Dialog
      title="Add kin"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Adding…' : 'Add kin'}
            onClick={() => void handleSave()}
            disabled={saving}
            busy={saving}
          />
        </>
      }
    >
      <fieldset className="add-kin__fields" disabled={saving}>
        <legend className="add-kin__legend">New kin</legend>

        <div className="add-kin__field">
          <label className="add-kin__label" htmlFor="add-kin-kinfolk">
            Household
          </label>
          <select
            id="add-kin-kinfolk"
            className="add-kin__select"
            value={kinfolkId}
            onChange={(e) => setKinfolkId(e.target.value)}
            aria-invalid={kinfolkError !== null}
            aria-describedby={kinfolkError !== null ? 'add-kin-kinfolk-error' : undefined}
          >
            <option value="">Choose a household…</option>
            {kinfolkOptions.map((kf) => (
              <option key={kf.id} value={kf.id}>
                {kf.label}
              </option>
            ))}
          </select>
          {kinfolkError !== null && (
            <span id="add-kin-kinfolk-error" className="add-kin__error" role="alert">
              {kinfolkError}
            </span>
          )}
        </div>

        <div className="add-kin__field">
          <label className="add-kin__label" htmlFor="add-kin-name">
            Name
          </label>
          <input
            id="add-kin-name"
            type="text"
            className="add-kin__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError !== null}
            aria-describedby={nameError !== null ? 'add-kin-name-error' : undefined}
          />
          {nameError !== null && (
            <span id="add-kin-name-error" className="add-kin__error" role="alert">
              {nameError}
            </span>
          )}
        </div>

        <div className="add-kin__row">
          <div className="add-kin__field">
            <label className="add-kin__label" htmlFor="add-kin-species">
              Species
            </label>
            <select
              id="add-kin-species"
              className="add-kin__select"
              value={species}
              onChange={(e) => setSpecies(e.target.value)}
            >
              {NEW_KIN_SPECIES_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div className="add-kin__field">
            <label className="add-kin__label" htmlFor="add-kin-breed">
              Breed
            </label>
            <input
              id="add-kin-breed"
              type="text"
              className="add-kin__input"
              value={breed}
              onChange={(e) => setBreed(e.target.value)}
            />
          </div>
        </div>

        <div className="add-kin__row">
          <div className="add-kin__field">
            <label className="add-kin__label" htmlFor="add-kin-age">
              Age
            </label>
            <input
              id="add-kin-age"
              type="text"
              className="add-kin__input"
              value={age}
              onChange={(e) => setAge(e.target.value)}
            />
          </div>
          <div className="add-kin__field">
            <label className="add-kin__label" htmlFor="add-kin-sex">
              Gender
            </label>
            <select
              id="add-kin-sex"
              className="add-kin__select"
              value={sex}
              onChange={(e) => setSex(e.target.value)}
              aria-invalid={sexError !== null}
              aria-describedby={sexError !== null ? 'add-kin-sex-error' : undefined}
            >
              <option value="">Choose…</option>
              {NEW_KIN_SEX_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {sexError !== null && (
              <span id="add-kin-sex-error" className="add-kin__error" role="alert">
                {sexError}
              </span>
            )}
          </div>
        </div>
      </fieldset>

      {saveError !== null && (
        <p className="add-kin__banner" role="alert">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}
