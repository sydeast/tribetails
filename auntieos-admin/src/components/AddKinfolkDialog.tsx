import { useCallback, useState } from 'react';
import { createKinfolk, NEW_KINFOLK_STATUS_OPTIONS, type NewKinfolkInput, type NewKinfolkStatus } from '../api/directoryWrite';
import {
  EMERGENCY_CONTACT_WHO_GETS_CALLED,
  saveEmergencyContacts,
  toDrafts,
  validateEmergencyContactDrafts,
  type EmergencyContactDraft,
} from '../api/emergencyContacts';
import {
  clearPendingAddKinfolk,
  pendingHouseholdName,
  readPendingAddKinfolk,
  savePendingAddKinfolk,
  type PendingAddKinfolk,
} from '../lib/pendingAddKinfolk';
import { AddressAutofillField } from './AddressAutofillField';
import { InfoTip } from './DenScreenKit';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import { EmergencyContactsEditor } from './EmergencyContactsEditor';
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
  /**
   * #829 review item 6: the dialog is closing with a household already created
   * (`createdId`) and its Emergency Contact still unsaved. The caller says so,
   * with a way back to that household, so an operator who walks away knows
   * there is a contact-less household on file and does not Add it a second time.
   */
  onLeftWithoutContact?: (kinfolkId: string) => void;
  /**
   * #890: the signed-in operator. A household created without its Emergency
   * Contact is kept under this uid (lib/pendingAddKinfolk.ts), so opening Add
   * again offers to continue it instead of creating a second household. Without
   * a uid nothing is kept, which is the behavior before #890.
   */
  operatorUid?: string | null;
}

/**
 * The create half of Directory's Kinfolk tab, opened from its "Add kinfolk"
 * header button. Mirrors `KinfolkEditScreen.kt`'s create path for exactly the
 * fields this trimmed-down form collects (name/first/last, phone, email,
 * status, address); see api/directoryWrite.ts's `createKinfolk` doc for the
 * write path (the `createKinfolk` callable since #890) and for which of the full
 * wasm Kinfolk fields are deliberately left at their real default here rather
 * than fabricated.
 *
 * Same shape as the other Dialog editors (HouseholdSectionDialog,
 * MediaUploadDialog): disabled-while-busy, fail-loud on a
 * rejected write (names the failing call, leaves the form exactly as typed),
 * Escape/backdrop-close routed through Dialog but suppressed mid-save.
 *
 * #890, THE PENDING HOUSEHOLD. From the moment the household is created until its
 * Emergency Contact saves, it is kept outside this dialog. Closing and reopening
 * Add then asks first: continue adding the Emergency Contact for that household,
 * or Discard, which starts a blank Add and leaves the household as it was created
 * (it shows No Emergency Contact). A `duplicateOf` answer from the server is the
 * same situation reached from the other side, so the dialog simply continues
 * with that household.
 */
export function AddKinfolkDialog({ onClose, onCreated, onLeftWithoutContact, operatorUid = null }: AddKinfolkDialogProps) {
  /** Read once, when the dialog opens: the household this operator left waiting on its contact. */
  const [offered, setOffered] = useState<PendingAddKinfolk | null>(() => readPendingAddKinfolk(operatorUid));
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<NewKinfolkStatus>('active');
  const [serviceAddress, setServiceAddress] = useState('');
  const [ecDrafts, setEcDrafts] = useState<EmergencyContactDraft[]>(toDrafts([]));
  /** Set once the household exists, so a failed contact save retries the contact alone. */
  const [createdId, setCreatedId] = useState<string | null>(null);

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
    if (saving) return;
    if (createdId !== null) onLeftWithoutContact?.(createdId);
    onClose();
  }, [saving, onClose, createdId, onLeftWithoutContact]);

  function householdInput(): NewKinfolkInput {
    return { firstName, lastName, phoneNumber, email, status, serviceAddress };
  }

  /** #890: keep the created household, with the contact as typed, until the contact saves. */
  function keepPending(id: string, contacts: EmergencyContactDraft[]) {
    savePendingAddKinfolk(operatorUid, { kinfolkId: id, household: householdInput(), contacts });
  }

  function changeContacts(next: EmergencyContactDraft[]) {
    setEcDrafts(next);
    if (createdId !== null) keepPending(createdId, next);
  }

  function continuePending(pending: PendingAddKinfolk) {
    setFirstName(pending.household.firstName);
    setLastName(pending.household.lastName);
    setPhoneNumber(pending.household.phoneNumber);
    setEmail(pending.household.email);
    setStatus(pending.household.status);
    setServiceAddress(pending.household.serviceAddress);
    setEcDrafts(pending.contacts.length > 0 ? pending.contacts : toDrafts([]));
    setCreatedId(pending.kinfolkId);
    setOffered(null);
  }

  function discardPending() {
    clearPendingAddKinfolk(operatorUid);
    setOffered(null);
  }

  /**
   * The Emergency Contact write, split from household creation so a failed
   * save retries ONLY the contact (#829): `createdId`, once set, never resets,
   * so this can never run `createKinfolk` a second time.
   */
  async function saveContact(id: string) {
    try {
      await saveEmergencyContacts(id, ecDrafts);
      clearPendingAddKinfolk(operatorUid);
      setSaving(false);
      onCreated(id);
    } catch (err) {
      keepPending(id, ecDrafts);
      setSaving(false);
      // #829 review item 4: the server's own message, as the portals show it,
      // then what state that leaves the household in.
      const reason = err instanceof Error && err.message !== '' ? err.message : 'The Emergency Contact was not saved.';
      setSaveError(`${reason} The household was created and shows No Emergency Contact until this is saved.`);
    }
  }

  async function handleSave() {
    setTouched({ firstName: true, lastName: true });
    if (saving) return;
    if (createdId !== null) {
      // Retry path: the household already exists, so `createKinfolk` never
      // runs again. But the Emergency Contact editor sits OUTSIDE the locked
      // household fieldset on purpose (#829: it must stay usable for exactly
      // this retry), so it is still live, an operator can clear it or type
      // the household's own phone before pressing this button. The same gate
      // the first-save path runs, so a bad retry is refused with the plain
      // spec message instead of a round trip to the callable.
      const retryEcError = validateEmergencyContactDrafts(ecDrafts, {
        names: [`${firstName} ${lastName}`],
        phones: [phoneNumber],
      });
      if (retryEcError) {
        setSaveError(retryEcError);
        return;
      }
      setSaving(true);
      setSaveError(null);
      await saveContact(createdId);
      return;
    }
    if (firstName.trim() === '' || lastName.trim() === '') return;
    const ecError = validateEmergencyContactDrafts(ecDrafts, {
      names: [`${firstName} ${lastName}`],
      phones: [phoneNumber],
    });
    if (ecError) {
      setSaveError(ecError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    let id: string;
    try {
      // #890: a `duplicateOf` answer means this operator created this household
      // minutes ago. `kinfolkId` is that household, and Add carries on with it.
      id = (await createKinfolk(householdInput())).kinfolkId;
    } catch (err) {
      setSaving(false);
      setSaveError(`createKinfolk failed: ${err instanceof Error ? err.message : 'Create failed'}`);
      return;
    }
    setCreatedId(id);
    // Kept before the contact save even starts, so a tab closed mid-save still
    // offers this household the next time Add opens.
    keepPending(id, ecDrafts);
    await saveContact(id);
  }

  if (offered !== null) {
    const name = pendingHouseholdName(offered);
    return (
      <Dialog
        title="Add kinfolk"
        onClose={onClose}
        footer={
          <>
            <GhostButton label="Discard" onClick={discardPending} />
            <PrimaryButton label={`Continue adding the Emergency Contact for ${name}`} onClick={() => continuePending(offered)} />
          </>
        }
      >
        <p className="add-kinfolk__pending">
          {name} was created, but the Emergency Contact did not save. The household shows No Emergency Contact until it
          is saved.
        </p>
        <p className="add-kinfolk__pending">Discard starts a new Add and leaves {name} as it is.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Add kinfolk"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={closeUnlessSaving} disabled={saving} />
          <PrimaryButton
            label={
              saving
                ? createdId !== null
                  ? 'Saving…'
                  : 'Adding…'
                : createdId !== null
                  ? 'Save Emergency Contact'
                  : 'Add kinfolk'
            }
            onClick={() => void handleSave()}
            disabled={saving}
            busy={saving}
          />
        </>
      }
    >
      {/* Disabled once the household exists (a failed contact save retries the
          contact alone, #829): there is nothing left on this half of the form
          to change or re-send. */}
      <fieldset className="add-kinfolk__fields" disabled={saving || createdId !== null}>
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

      {/* Outside the household fieldset on purpose: once the household exists
          (`createdId !== null`) this editor is the only thing left to retry, so
          it stays enabled while the fields above it are locked. */}
      <div className="add-kinfolk__section">
        <h3 className="add-kinfolk__label add-kinfolk__section-title">
          Emergency Contacts <InfoTip text={EMERGENCY_CONTACT_WHO_GETS_CALLED} />
        </h3>
        <EmergencyContactsEditor idPrefix="add-kinfolk" value={ecDrafts} onChange={changeContacts} disabled={saving} />
      </div>

      {saveError !== null && (
        <p className="add-kinfolk__banner" role="alert">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}
