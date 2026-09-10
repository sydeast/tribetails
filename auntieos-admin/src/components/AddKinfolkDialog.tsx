import { useCallback, useState } from 'react';
import { createKinfolk, NEW_KINFOLK_STATUS_OPTIONS, type NewKinfolkStatus } from '../api/directoryWrite';
import { AddressAutofillField } from './AddressAutofillField';
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
 * Same shape as the other Dialog editors (HouseholdSectionDialog,
 * MediaUploadDialog): disabled-while-busy, fail-loud on a
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
  // AO-44: per-field touched, so a required field's error surfaces the moment
  // the operator LEAVES it blank (onBlur), not only after a save attempt. Save
  // still marks every field touched, so clicking Add on an empty form reveals
  // all errors at once (the wasm form gated everything on save alone).
  const [touched, setTouched] = useState<{ firstName: boolean; lastName: boolean }>({
    firstName: false,
    lastName: false,
  });
  const [saveError, setSaveError] = useState<string | null>(null);

  const firstNameError = touched.firstName && firstName.trim() === '' ? "First name can't be blank." : null;
  const lastNameError = touched.lastName && lastName.trim() === '' ? "Last name can't be blank." : null;

  function markTouched(field: 'firstName' | 'lastName') {
    setTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  }

  // Memoized: Dialog's focus-management effect depends on this identity, so an
  // inline function here would be a new reference on every keystroke and would
  // steal focus off whichever field is active.
  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function handleSave() {
    setTouched({ firstName: true, lastName: true });
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
              onBlur={() => markTouched('firstName')}
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
              onBlur={() => markTouched('lastName')}
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

        {/* Mapbox autofill, same field as KinfolkEdit's service address so a
            household's address is entered the same way whichever door it comes
            in through. Additive: the input still takes a typed address, and a
            failed lookup never blocks the create. */}
        <AddressAutofillField
          name="add-kinfolk-address"
          label="Address"
          value={serviceAddress}
          error={null}
          onChange={setServiceAddress}
          disabled={saving}
        />
      </fieldset>

      {saveError !== null && (
        <p className="add-kinfolk__banner" role="alert">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}
