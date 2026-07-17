import { useCallback, useState } from 'react';
import { createKinfolk, NEW_KINFOLK_STATUS_OPTIONS, type NewKinfolkStatus } from '../api/directoryWrite';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import './AddKinfolkDialog.css';

interface AddKinfolkDialogProps {
  onClose: () => void;
  /**
   * Called once the household is actually created, with its new doc id.
   * Directory's own Kinfolk list is a live `onSnapshot` stream (KINFOLK_QUERY
   * in api/directory.ts), so it picks the new row up on its own the moment the
   * write lands, this callback exists only so the caller can act on the fresh
   * id (a toast, a future "open the new profile" hop), not to force a refetch.
   */
  onCreated: (kinfolkId: string) => void;
}

/**
 * The create half of Directory's Kinfolk tab, opened from its "Add kinfolk"
 * header button. Mirrors `KinfolkEditScreen.kt`'s create path for exactly the
 * fields this trimmed-down form collects (name/first/last, phone, email,
 * status, address); see api/directoryWrite.ts's `createKinfolk` doc for the
 * confirmed write path (a direct, rules-backed `kinfolk` collection create,
 * not a callable) and for which of the full wasm Kinfolk fields are
 * deliberately left at their real default here rather than fabricated.
 *
 * Same shape as EditProfileDialog: disabled-while-busy, fail-loud on a
 * rejected write (names the failing call, leaves the form exactly as typed),
 * Escape/backdrop-close routed through Dialog but suppressed mid-save.
 */
export function AddKinfolkDialog({ onClose, onCreated }: AddKinfolkDialogProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<NewKinfolkStatus>('active');
  const [serviceAddress, setServiceAddress] = useState('');

  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const firstNameError = touched && firstName.trim() === '' ? "First name can't be blank." : null;
  const lastNameError = touched && lastName.trim() === '' ? "Last name can't be blank." : null;

  // See EditProfileDialog's identical note: Dialog's focus-management effect
  // depends on this identity, an inline function here would be a new
  // reference every keystroke and steal focus off whichever field is active.
  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function handleSave() {
    setTouched(true);
    if (firstName.trim() === '' || lastName.trim() === '' || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const id = await createKinfolk({ firstName, lastName, phoneNumber, email, status, serviceAddress });
      setSaving(false);
      onCreated(id);
    } catch (err) {
      setSaving(false);
      setSaveError(`createKinfolk failed: ${err instanceof Error ? err.message : 'Create failed'}`);
    }
  }

  return (
    <Dialog
      title="Add kinfolk"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Adding…' : 'Add kinfolk'}
            onClick={() => void handleSave()}
            disabled={saving}
            busy={saving}
          />
        </>
      }
    >
      <fieldset className="add-kinfolk__fields" disabled={saving}>
        <legend className="add-kinfolk__legend">New household</legend>

        <div className="add-kinfolk__row">
          <div className="add-kinfolk__field">
            <label className="add-kinfolk__label" htmlFor="add-kinfolk-first-name">
              First name
            </label>
            <input
              id="add-kinfolk-first-name"
              type="text"
              className="add-kinfolk__input"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              aria-invalid={firstNameError !== null}
              aria-describedby={firstNameError !== null ? 'add-kinfolk-first-name-error' : undefined}
            />
            {firstNameError !== null && (
              <span id="add-kinfolk-first-name-error" className="add-kinfolk__error" role="alert">
                {firstNameError}
              </span>
            )}
          </div>
          <div className="add-kinfolk__field">
            <label className="add-kinfolk__label" htmlFor="add-kinfolk-last-name">
              Last name
            </label>
            <input
              id="add-kinfolk-last-name"
              type="text"
              className="add-kinfolk__input"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              aria-invalid={lastNameError !== null}
              aria-describedby={lastNameError !== null ? 'add-kinfolk-last-name-error' : undefined}
            />
            {lastNameError !== null && (
              <span id="add-kinfolk-last-name-error" className="add-kinfolk__error" role="alert">
                {lastNameError}
              </span>
            )}
          </div>
        </div>

        <div className="add-kinfolk__field">
          <label className="add-kinfolk__label" htmlFor="add-kinfolk-status">
            Status
          </label>
          <select
            id="add-kinfolk-status"
            className="add-kinfolk__select"
            value={status}
            onChange={(e) => setStatus(e.target.value as NewKinfolkStatus)}
          >
            {NEW_KINFOLK_STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="add-kinfolk__row">
          <div className="add-kinfolk__field">
            <label className="add-kinfolk__label" htmlFor="add-kinfolk-phone">
              Phone
            </label>
            <input
              id="add-kinfolk-phone"
              type="tel"
              className="add-kinfolk__input"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
            />
          </div>
          <div className="add-kinfolk__field">
            <label className="add-kinfolk__label" htmlFor="add-kinfolk-email">
              Email
            </label>
            <input
              id="add-kinfolk-email"
              type="email"
              className="add-kinfolk__input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>

        <div className="add-kinfolk__field">
          <label className="add-kinfolk__label" htmlFor="add-kinfolk-address">
            Address
          </label>
          <input
            id="add-kinfolk-address"
            type="text"
            className="add-kinfolk__input"
            value={serviceAddress}
            onChange={(e) => setServiceAddress(e.target.value)}
          />
        </div>
      </fieldset>

      {saveError !== null && (
        <p className="add-kinfolk__banner" role="alert">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}
