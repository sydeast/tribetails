import { useCallback, useState } from 'react';
import { saveUserProfile } from '../api/accountWrite';
import { type UserProfile } from '../api/account';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import './EditProfileDialog.css';

interface EditProfileDialogProps {
  uid: string;
  /** The just-loaded profile, seeding every field so the form never opens blank. */
  profile: UserProfile;
  onClose: () => void;
  /** Called once the save actually lands, so the caller can close and reload. */
  onSaved: () => void;
}

/**
 * The write/save surface Account.tsx's read-only overview defers. Opened as a
 * Dialog from that screen's "Edit profile" button (see Account.tsx), never
 * routed on its own, the same "editor lives in a modal over the read screen"
 * shape FormSchemas.tsx uses for its delete confirm.
 *
 * Editable fields match the wasm SettingsScreen's profile card exactly:
 * displayName, firstName, lastName, phone, title, bio. uid/email/photoUrl are
 * NOT editable here (uid is the doc key, email is Firebase Auth's, photoUrl has
 * no upload UI yet), matching accountWrite.ts's UserProfilePatch.
 *
 * Disabled-while-busy, fail-loud on save error (FormSchemas.tsx's confirmDelete
 * convention): the fieldset locks, the Dialog cannot be dismissed mid-save, and
 * a rejected save replaces nothing, it just adds a banner naming the callable
 * and leaves the form exactly as the operator left it, so a failed save never
 * looks like a silent no-op or a lost edit.
 */
export function EditProfileDialog({ uid, profile, onClose, onSaved }: EditProfileDialogProps) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [firstName, setFirstName] = useState(profile.firstName);
  const [lastName, setLastName] = useState(profile.lastName);
  const [phone, setPhone] = useState(profile.phone);
  const [title, setTitle] = useState(profile.title);
  const [bio, setBio] = useState(profile.bio);

  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const trimmedName = displayName.trim();
  // required-ish: only announced once the operator has attempted a save, same
  // as most inline-form conventions, so opening the dialog never greets a
  // pre-filled field with a red error.
  const nameError = touched && trimmedName === '' ? "Display name can't be blank." : null;

  // Memoized: Dialog's own focus-management effect depends on this identity
  // ([onClose] in Dialog.tsx) and re-runs on every change, re-focusing the
  // dialog panel. An inline/plain function here is a NEW reference on every
  // keystroke (any field's onChange re-renders this component), which stole
  // focus off the input field after its very first character. Stable across
  // re-renders, only changing when `saving` or the caller's `onClose` actually
  // do, so typing in a field never gets interrupted.
  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  async function handleSave() {
    setTouched(true);
    if (trimmedName === '' || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await saveUserProfile(uid, {
        displayName: trimmedName,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phone: phone.trim(),
        title: title.trim(),
        bio: bio.trim(),
      });
      setSaving(false);
      onSaved();
    } catch (err) {
      setSaving(false);
      setSaveError(`saveUserProfile failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    }
  }

  return (
    <Dialog
      title="Edit your profile"
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Saving…' : 'Save'}
            onClick={() => void handleSave()}
            disabled={saving}
            busy={saving}
          />
        </>
      }
    >
      <fieldset className="edit-profile__fields" disabled={saving}>
        <legend className="edit-profile__legend">Profile</legend>

        <div className="edit-profile__field">
          <label className="edit-profile__label" htmlFor="edit-profile-display-name">
            Display name
          </label>
          <input
            id="edit-profile-display-name"
            type="text"
            className="edit-profile__input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            aria-invalid={nameError !== null}
            aria-describedby={nameError !== null ? 'edit-profile-name-error' : undefined}
          />
          {nameError !== null && (
            <span id="edit-profile-name-error" className="edit-profile__error" role="alert">
              {nameError}
            </span>
          )}
        </div>

        <div className="edit-profile__row">
          <div className="edit-profile__field">
            <label className="edit-profile__label" htmlFor="edit-profile-first-name">
              First name
            </label>
            <input
              id="edit-profile-first-name"
              type="text"
              className="edit-profile__input"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>
          <div className="edit-profile__field">
            <label className="edit-profile__label" htmlFor="edit-profile-last-name">
              Last name
            </label>
            <input
              id="edit-profile-last-name"
              type="text"
              className="edit-profile__input"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
        </div>

        <div className="edit-profile__row">
          <div className="edit-profile__field">
            <label className="edit-profile__label" htmlFor="edit-profile-phone">
              Phone
            </label>
            <input
              id="edit-profile-phone"
              type="tel"
              className="edit-profile__input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>
          <div className="edit-profile__field">
            <label className="edit-profile__label" htmlFor="edit-profile-title">
              Title
            </label>
            <input
              id="edit-profile-title"
              type="text"
              className="edit-profile__input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
        </div>

        <div className="edit-profile__field">
          <label className="edit-profile__label" htmlFor="edit-profile-bio">
            Bio
          </label>
          <textarea
            id="edit-profile-bio"
            className="edit-profile__textarea"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={4}
          />
        </div>
      </fieldset>

      {saveError !== null && (
        <p className="edit-profile__banner" role="alert">
          {saveError}
        </p>
      )}
    </Dialog>
  );
}
