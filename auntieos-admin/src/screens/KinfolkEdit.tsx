import { useCallback, useEffect, useState } from 'react';
import { getKinfolkProfile, type KinfolkProfile } from '../api/kinfolkProfile';
import {
  archiveKinfolk,
  changedKinfolkEditFields,
  unarchiveKinfolk,
  updateKinfolkProfile,
  type KinfolkEditPatch,
} from '../api/kinfolkProfileWrite';
import { updateKinfolkTags } from '../api/directoryWrite';
import {
  KINFOLK_ARCHIVED_STATUS,
  KINFOLK_STATUS_OPTIONS,
  validateKinfolkEdit,
  type KinfolkEditErrors,
  type KinfolkEditInput,
  type KinfolkPickableStatus,
} from '../lib/kinfolkEditSchema';
import { joinDateForEdit } from '../lib/joinDate';
import { type Async } from '../lib/async';
import {
  EMERGENCY_CONTACT_WHO_GETS_CALLED,
  draftsEqual,
  isBlankDrafts,
  saveEmergencyContacts,
  toDrafts,
  validateEmergencyContactDrafts,
  type EmergencyContactDraft,
} from '../api/emergencyContacts';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AddressAutofillField } from '../components/AddressAutofillField';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Dialog } from '../components/Dialog';
import { MaskedValue } from '../components/MaskedValue';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { ProfileTagsSection } from '../components/ProfileTagsSection';
import { EmergencyContactsEditor } from '../components/EmergencyContactsEditor';
import { NoEmergencyContactFlag } from '../components/NoEmergencyContactFlag';
import { useToast } from '../components/Toast';
import './KinfolkEdit.css';

/**
 * Kinfolk (household) editor: the WRITE surface for `kinfolk/{id}`, ported from
 * android `ui/directory/EditKinfolkScreen.kt`. Until now web could CREATE a
 * Kinfolk (AddKinfolkDialog) and VIEW one (KinfolkProfile), but the only
 * mutation it had was `updateKinfolkTags`.
 *
 * Loads through `getKinfolkProfile` (one-shot getDoc, same read the profile
 * uses) and saves through `updateKinfolkProfile`, which is a FIELD-LEVEL MERGE.
 * Read that module's header before changing anything about what this form
 * sends: both Kotlin clients save a household by overwriting the whole
 * document, which destroys the portal-auth linkage (`uid`), `myTribeLinkedAt`,
 * the archive audit trail, and four backend-only fields. This screen cannot do
 * that, because the patch is a fixed key list and `updateDoc` only touches the
 * keys it is given.
 *
 * RESTORED 2026-07-25 (operator issues #12 and #13), both of which this header
 * previously recorded as deferred for want of a transport:
 *
 *  - Mapbox address autofill on Service address. The transport existed after
 *    all: `mapboxSearch` / `mapboxRetrieve` are deployed MyTribe callables
 *    holding `MAPBOX_ACCESS_TOKEN` server-side, so no key reaches the browser.
 *    See `components/AddressAutofillField.tsx`.
 *  - The vet-clinic catalog picker, now `components/VetClinicPicker.tsx`
 *    against the `vet_clinics` collection, plus a second instance for the
 *    household's emergency vet.
 *
 * STILL DEFERRED, verified genuinely absent on this surface rather than merely
 * awkward:
 *
 *  - Photo upload (:57). `api/mediaUpload.ts` DOES have a working KINFOLK
 *    pipeline, so this one is a real gap rather than a missing capability: its
 *    orchestrator returns the new media_files doc id, not the Cloudinary URL,
 *    so nothing here can set `profilePictureUrl` without widening that shared
 *    module. Left to the media surface that owns it.
 *
 * TAGS EDITING LIVES HERE (#681, moved off the read-only profile). It used to
 * sit as a `ProfileTagsSection` panel at the foot of `KinfolkProfile`'s left
 * column; the operator wanted household tags shown as read-only pills in the
 * hero instead, and reusing the SAME `ProfileTagsSection` component here rather
 * than a second one keeps `updateKinfolkTags` the only writer of this field.
 */

interface KinfolkEditProps {
  kinfolkId: string;
  /** From the profile/Directory row, so the heading names the Kinfolk before the doc loads. */
  kinfolkName: string;
  /** Called after a successful save or archive so the caller reloads the profile. */
  onDone: () => void;
  onCancel: () => void;
}

type FormState = KinfolkEditInput;
type Touched = Partial<Record<keyof KinfolkEditInput, boolean>>;


/** The loaded household as the form's shape. Fields the form does not own are dropped. */
function toForm(p: KinfolkProfile): FormState {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    phoneNumber: p.phoneNumber,
    email: p.email,
    // A legacy doc can hold a status this form has no option for. It is kept as
    // loaded rather than snapped to "active": silently changing a household's
    // status because the picker did not recognise it is a data edit nobody asked
    // for. The picker shows nothing selected until the operator chooses.
    status: normaliseStatus(p.status),
    // The date picker can only hold `YYYY-MM-DD`, and the schema now says the
    // same, so a legacy string is coerced (a stored ISO instant) or cleared
    // (anything unreadable) HERE, once, on the way in. The cleared case is not
    // silent: `joinDateForEdit` also returns the note the field renders, naming
    // the string that is still in Firestore. See lib/joinDate.ts.
    joinDate: joinDateForEdit(p.joinDate).value,
    secondaryPhone: p.secondaryPhone,
    secondaryEmail: p.secondaryEmail,
    serviceAddress: p.serviceAddress,
    gateCode: p.gateCode,
    parkingInstructions: p.parkingInstructions,
    entryNotes: p.entryNotes,
    wifiName: p.wifiName,
    wifiPassword: p.wifiPassword,
  };
}

/**
 * The form as the write's patch shape. Built key by key, not spread: the patch
 * type is exactly what the write is allowed to touch, and nothing that rode
 * along on the form can leak in.
 */
function toPatch(form: FormState): KinfolkEditPatch {
  return {
    firstName: form.firstName,
    lastName: form.lastName,
    phoneNumber: form.phoneNumber,
    email: form.email,
    status: form.status,
    joinDate: form.joinDate,
    secondaryPhone: form.secondaryPhone,
    secondaryEmail: form.secondaryEmail,
    serviceAddress: form.serviceAddress,
    gateCode: form.gateCode,
    parkingInstructions: form.parkingInstructions,
    entryNotes: form.entryNotes,
    wifiName: form.wifiName,
    wifiPassword: form.wifiPassword,
  };
}

/**
 * #829 review item 5: what is STORED, as the patch shape, for the diff. The raw
 * loaded values, not `toForm`'s cleaned ones, so a legacy join date or status
 * the form had to normalise still counts as a change the save will make.
 */
function storedPatch(p: KinfolkProfile): KinfolkEditPatch {
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    phoneNumber: p.phoneNumber,
    email: p.email,
    status: p.status,
    joinDate: p.joinDate,
    secondaryPhone: p.secondaryPhone,
    secondaryEmail: p.secondaryEmail,
    serviceAddress: p.serviceAddress,
    gateCode: p.gateCode,
    parkingInstructions: p.parkingInstructions,
    entryNotes: p.entryNotes,
    wifiName: p.wifiName,
    wifiPassword: p.wifiPassword,
  };
}

function normaliseStatus(raw: string): FormState['status'] {
  const s = raw.trim().toLowerCase();
  if (s === KINFOLK_ARCHIVED_STATUS) return KINFOLK_ARCHIVED_STATUS;
  const match = KINFOLK_STATUS_OPTIONS.find((o) => o === s);
  return match ?? 'active';
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The plain text inputs, grouped by the panel they sit in. */
const CONTACT_FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['phoneNumber', 'Primary phone'],
  ['email', 'Email'],
  ['secondaryPhone', 'Secondary phone'],
  ['secondaryEmail', 'Secondary email'],
] as const;

export function KinfolkEdit({ kinfolkId, kinfolkName, onDone, onCancel }: KinfolkEditProps) {
  const [loaded, setLoaded] = useState<Async<KinfolkProfile>>({ status: 'loading' });
  const [form, setForm] = useState<FormState | null>(null);
  const [touched, setTouched] = useState<Touched>({});
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [askArchive, setAskArchive] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();

  // Emergency Contacts (#829): drafts editable independently of the rest of the
  // form, seeded from the profile this screen already loads (the same place the
  // form state below is seeded from `loaded`, no second read, no callable).
  const [ecDrafts, setEcDrafts] = useState<EmergencyContactDraft[]>(toDrafts([]));
  const [ecBaseline, setEcBaseline] = useState<EmergencyContactDraft[]>(toDrafts([]));
  /** A contact refusal or a failed contact save, shown on the contact editor rather than the page banner. */
  const [ecError, setEcError] = useState<string | null>(null);
  /**
   * #829 review item 5: what the household record holds, as far as this form
   * knows. Seeded from the load, moved forward by each successful write, so a
   * retry after a contact problem does not re-send fields that already landed.
   */
  const [householdBaseline, setHouseholdBaseline] = useState<KinfolkEditPatch | null>(null);

  const load = useCallback(() => {
    let live = true;
    setLoaded({ status: 'loading' });
    void (async () => {
      try {
        const data = await getKinfolkProfile(kinfolkId);
        if (live) {
          setLoaded({ status: 'ready', data });
          setForm(toForm(data));
          setHouseholdBaseline(storedPatch(data));
          // Seeded in the SAME commit as the form above (no second read, no
          // callable), not a separate effect keyed on `loaded`: that shape
          // committed the ready state (and thus rendered the editor with a
          // still-blank draft) one render ahead of the seed landing, a real
          // window where a fast interaction could type into the blank slot
          // just before the seeding effect overwrote it.
          setEcDrafts(toDrafts(data.emergencyContacts));
          setEcBaseline(toDrafts(data.emergencyContacts));
        }
      } catch (err) {
        if (live) {
          setLoaded({
            status: 'error',
            message: `getKinfolkProfile failed: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          });
        }
      }
    })();
    return () => {
      live = false;
    };
  }, [kinfolkId]);

  useEffect(() => load(), [load]);

  const errors: KinfolkEditErrors = form ? validateKinfolkEdit(form) : {};
  const busy = saving || archiving;
  const isArchived = form?.status === KINFOLK_ARCHIVED_STATUS;

  // What the stored join date was, when it is not what the picker is showing.
  // Held until the operator changes the field, then it has been answered and the
  // note goes away rather than describing a value that is no longer in play.
  const openedJoinDate = joinDateForEdit(loaded.status === 'ready' ? loaded.data.joinDate : '');
  const joinDateNote =
    form !== null && form.joinDate === openedJoinDate.value ? openedJoinDate.note : null;

  // The name as it should be SPOKEN, for the archive dialog and the toasts. Falls
  // back to what the caller passed, then to the id, so a confirmation is never
  // "Archive ?" with a blank where a Kinfolk's name belongs.
  const displayName =
    form && `${form.firstName} ${form.lastName}`.trim() !== ''
      ? `${form.firstName} ${form.lastName}`.trim()
      : kinfolkName.trim() !== ''
        ? kinfolkName.trim()
        : kinfolkId;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  /**
   * AO-44: reveal a field's error the moment the operator LEAVES it, not only
   * after a save attempt. Matches AddKinfolkDialog, which already does this.
   */
  function markTouched(key: keyof KinfolkEditInput) {
    setTouched((prev) => (prev[key] === true ? prev : { ...prev, [key]: true }));
  }

  /** A field's message, but only once the operator has been given a chance to fill it. */
  function errorFor(key: keyof KinfolkEditInput): string | null {
    if (touched[key] !== true && !attempted) return null;
    return errors[key] ?? null;
  }

  // #829 review item 14: an "Unsaved changes" status, from the same trimmed
  // comparisons the save makes, so the indicator and the write never disagree.
  const householdChanges =
    form !== null && householdBaseline !== null ? changedKinfolkEditFields(householdBaseline, toPatch(form)) : {};
  const dirty =
    form !== null &&
    householdBaseline !== null &&
    (Object.keys(householdChanges).length > 0 || !draftsEqual(ecDrafts, ecBaseline));

  /**
   * #829 review items 5 and 14.
   *
   * ONLY WHAT CHANGED IS WRITTEN. The household write carries the fields that
   * differ from the stored record, and is skipped entirely when none do, so a
   * contacts-only save touches the kinfolk document not at all.
   *
   * THE CONTACT NEVER BLOCKS THE HOUSEHOLD (operator ruling). A cleared or
   * half-filled contact, or a refused contact save, used to stop the whole form.
   * Now the household saves first; the contact problem is then shown on the
   * contact editor, the screen stays open so it can be fixed, and a retry sends
   * only what is still unsaved.
   */
  async function handleSave() {
    if (!form || busy || householdBaseline === null) return;
    // Save marks everything touched, so pressing Save on a form with three
    // problems shows all three at once rather than one per attempt.
    setAttempted(true);
    if (Object.keys(errors).length > 0) {
      setError('Some details still need fixing. The fields below say which.');
      return;
    }

    const changes = changedKinfolkEditFields(householdBaseline, toPatch(form));
    const ecChanged = !draftsEqual(ecDrafts, ecBaseline);
    // A household that has none and is not adding one right now has nothing to
    // send. Everyone else who touched the list must end with a valid one.
    const ecSkipped = isBlankDrafts(ecBaseline) && isBlankDrafts(ecDrafts);
    const saveContacts = ecChanged && !ecSkipped;
    const contactProblem = saveContacts
      ? validateEmergencyContactDrafts(ecDrafts, {
          names: [`${form.firstName} ${form.lastName}`],
          phones: [form.phoneNumber, form.secondaryPhone],
        })
      : null;

    setSaving(true);
    setError(null);
    setEcError(null);

    let householdSaved = false;
    if (Object.keys(changes).length > 0) {
      try {
        await updateKinfolkProfile(kinfolkId, changes);
        householdSaved = true;
        setHouseholdBaseline((prev) => (prev ? { ...prev, ...changes } : prev));
      } catch (err) {
        setSaving(false);
        setError(`updateKinfolkProfile failed: ${err instanceof Error ? err.message : 'Save failed'}`);
        return;
      }
    }

    if (saveContacts) {
      let problem = contactProblem;
      if (problem === null) {
        try {
          await saveEmergencyContacts(kinfolkId, ecDrafts);
          setEcBaseline(ecDrafts);
        } catch (err) {
          // The server's own message, as the portals show it.
          problem = err instanceof Error && err.message !== '' ? err.message : 'The Emergency Contacts were not saved. Try again.';
        }
      }
      if (problem !== null) {
        setSaving(false);
        setEcError(problem);
        if (householdSaved) showToast(`Saved ${displayName}. The Emergency Contact still needs attention.`);
        return;
      }
    }

    setSaving(false);
    showToast(`Saved ${displayName}.`);
    onDone();
  }

  async function handleArchive() {
    if (busy) return;
    setArchiving(true);
    setError(null);
    try {
      await archiveKinfolk(kinfolkId, archiveReason);
      setArchiving(false);
      setAskArchive(false);
      setArchiveReason('');
      showToast(`${displayName} is archived.`);
      onDone();
    } catch (err) {
      setArchiving(false);
      setError(`archiveKinfolk failed: ${err instanceof Error ? err.message : 'Archive failed'}`);
    }
  }

  async function handleUnarchive() {
    if (busy) return;
    setArchiving(true);
    setError(null);
    try {
      await unarchiveKinfolk(kinfolkId);
      setArchiving(false);
      showToast(`${displayName} is active again.`);
      onDone();
    } catch (err) {
      setArchiving(false);
      setError(`unarchiveKinfolk failed: ${err instanceof Error ? err.message : 'Restore failed'}`);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Directory"
        title={`Edit ${kinfolkName || kinfolkId}`}
        subtitle="Contact, access, and vet details for this household."
        trailing={<GhostButton label="Cancel" onClick={onCancel} disabled={busy} />}
      />

      {error !== null && (
        <Banner tone="error" title="That didn't save" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <AsyncRegion
        state={loaded}
        what="household"
        // A missing document is an ERROR, not an empty: `getKinfolkProfile`
        // throws on it, so this branch is unreachable by construction. The node
        // below still says something true rather than "no data", because an
        // empty state that appears anyway must not be the first lie on screen.
        isEmpty={() => false}
        loading={<EditSkeleton />}
        empty={<p className="kfedit__hint">This household record has no details on file yet.</p>}
      >
        {() =>
          form === null ? (
            <EditSkeleton />
          ) : (
            <>
              {isArchived && (
                <Banner tone="warning" title="This Kinfolk is archived" pillLabel="ARCHIVED">
                  {displayName} is hidden from active lists. Restore them to bring the household back.
                </Banner>
              )}

              <DenPanel title="Contact" subtitle="How Auntie reaches this household.">
                <fieldset className="kfedit__grid" disabled={busy}>
                  {CONTACT_FIELDS.map(([key, label]) => (
                    <TextField
                      key={key}
                      name={key}
                      label={label}
                      value={form[key]}
                      error={errorFor(key)}
                      onChange={(v) => set(key, v)}
                      onBlur={() => markTouched(key)}
                    />
                  ))}
                </fieldset>
              </DenPanel>

              <DenPanel title="Standing" subtitle="Where this household sits with the Tribe.">
                <fieldset className="kfedit__grid" disabled={busy}>
                  {isArchived ? (
                    <p className="kfedit__hint kfedit__field--wide">
                      Status is held at archived. Restore the household to set it again.
                    </p>
                  ) : (
                    <div className="kfedit__field kfedit__field--wide">
                      <span className="kfedit__label" id="kfedit-status-label">
                        Status
                      </span>
                      <div className="kfedit__chips" role="radiogroup" aria-labelledby="kfedit-status-label">
                        {KINFOLK_STATUS_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            className="kfedit__chip"
                            role="radio"
                            aria-checked={form.status === option}
                            data-selected={form.status === option}
                            disabled={busy}
                            onClick={() => set('status', option as KinfolkPickableStatus)}
                          >
                            {titleCase(option)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <DateField
                    name="joinDate"
                    label="Join date"
                    value={form.joinDate}
                    error={errorFor('joinDate')}
                    hint={joinDateNote}
                    onChange={(v) => set('joinDate', v)}
                    onBlur={() => markTouched('joinDate')}
                  />
                </fieldset>
              </DenPanel>

              {/* Household tags (#681): moved here from the read-only profile,
                  which now shows them as pills in the hero instead. Reuses the
                  same `ProfileTagsSection` the profile used to render, so
                  `updateKinfolkTags` stays the one writer of this field. It
                  saves each add/remove immediately, independent of this form's
                  own Save button. */}
              <ProfileTagsSection
                scope="household"
                initialTags={loaded.status === 'ready' ? loaded.data.tags : []}
                onSaveTags={(next) => updateKinfolkTags(kinfolkId, next)}
              />

              <DenPanel title="Home & access" subtitle="Gate codes, parking, and how to get in the door.">
                <fieldset className="kfedit__grid" disabled={busy}>
                  <AddressAutofillField
                    name="serviceAddress"
                    label="Service address"
                    value={form.serviceAddress}
                    error={errorFor('serviceAddress')}
                    onChange={(v) => set('serviceAddress', v)}
                    onBlur={() => markTouched('serviceAddress')}
                    disabled={busy}
                    wide
                  />
                  <SecretField
                    name="gateCode"
                    label="Gate code"
                    spoken="gate code"
                    value={form.gateCode}
                    disabled={busy}
                    onChange={(v) => set('gateCode', v)}
                  />
                  <TextField
                    name="wifiName"
                    label="Wi-Fi network"
                    value={form.wifiName}
                    error={errorFor('wifiName')}
                    onChange={(v) => set('wifiName', v)}
                    onBlur={() => markTouched('wifiName')}
                  />
                  <SecretField
                    name="wifiPassword"
                    label="Wi-Fi password"
                    spoken="Wi-Fi password"
                    value={form.wifiPassword}
                    disabled={busy}
                    onChange={(v) => set('wifiPassword', v)}
                  />
                  <TextField
                    name="parkingInstructions"
                    label="Parking"
                    value={form.parkingInstructions}
                    error={errorFor('parkingInstructions')}
                    onChange={(v) => set('parkingInstructions', v)}
                    onBlur={() => markTouched('parkingInstructions')}
                    wide
                    multiline
                  />
                  <TextField
                    name="entryNotes"
                    label="Entry notes"
                    value={form.entryNotes}
                    error={errorFor('entryNotes')}
                    onChange={(v) => set('entryNotes', v)}
                    onBlur={() => markTouched('entryNotes')}
                    wide
                    multiline
                  />
                </fieldset>
              </DenPanel>

              {/* #829 review item 3: no explanatory subtitle. DenPanel draws its
                  `subtitle` prop as the kit's info button beside the title
                  (KitTooltip: hover, focus or a tap opens it), never as a line
                  of copy, so it carries the one shared sentence every client
                  shows behind its tip. */}
              <DenPanel title="Emergency Contacts" subtitle={EMERGENCY_CONTACT_WHO_GETS_CALLED}>
                {isBlankDrafts(ecBaseline) && <NoEmergencyContactFlag />}
                <EmergencyContactsEditor
                  idPrefix="kfedit"
                  value={ecDrafts}
                  onChange={(next) => {
                    setEcDrafts(next);
                    setEcError(null);
                  }}
                  disabled={saving}
                />
                {ecError !== null && (
                  <p className="kfedit__error" role="alert" data-testid="kfedit-ec-error">
                    {ecError}
                  </p>
                )}
              </DenPanel>

              {/* THE VET PANEL IS GONE, and its absence is the fix.
                  Operator ruling 2026-08-01: "vet info lives on household data,
                  it can be seen on the kin profile" (page-specs 04 item 3).
                  This panel wrote eight `vetClinic*` / `emergencyVetClinic*`
                  keys onto the kinfolk doc, which is what made that doc a second
                  writable copy of a fact `household_data` already owned, with
                  nothing tying the two together and no rule about which was
                  true. The vet is now chosen on Household Data, against the
                  shared catalog, and this screen neither reads nor writes it. */}
              <div className="kfedit__actions">
                {isArchived ? (
                  <GhostButton
                    label={archiving ? 'Restoring…' : 'Restore'}
                    onClick={() => void handleUnarchive()}
                    disabled={busy}
                  />
                ) : (
                  <GhostButton label="Archive" onClick={() => setAskArchive(true)} disabled={busy} />
                )}
                <div className="kfedit__actions-right">
                  {dirty && (
                    <span className="kfedit__hint" role="status" data-testid="kfedit-unsaved">
                      Unsaved changes
                    </span>
                  )}
                  <GhostButton label="Cancel" onClick={onCancel} disabled={busy} />
                  <PrimaryButton
                    label={saving ? 'Saving…' : 'Save changes'}
                    onClick={() => void handleSave()}
                    disabled={busy}
                    busy={saving}
                  />
                </div>
              </div>
            </>
          )
        }
      </AsyncRegion>

      {askArchive && (
        <Dialog
          title="Archive this Kinfolk"
          onClose={() => {
            if (!archiving) {
              setAskArchive(false);
              setArchiveReason('');
            }
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => {
                  setAskArchive(false);
                  setArchiveReason('');
                }}
                disabled={archiving}
              />
              <PrimaryButton
                label={archiving ? 'Archiving…' : 'Archive'}
                onClick={() => void handleArchive()}
                disabled={archiving}
                busy={archiving}
              />
            </>
          }
        >
          {/* Names the Kinfolk. A confirmation that says "this household" is a
              confirmation an operator can give on the wrong record. */}
          <p className="kfedit__confirm">
            Hide <strong>{displayName}</strong> from active lists? This is reversible, you can restore
            the household from this screen any time.
          </p>
          <label className="kfedit__field">
            <span className="kfedit__label">Reason (optional)</span>
            <textarea
              className="kfedit__input kfedit__textarea"
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              rows={2}
              placeholder="e.g. moved away, paused service"
              disabled={archiving}
            />
          </label>
        </Dialog>
      )}
    </div>
  );
}

// ── field controls ──────────────────────────────────────────────────────────

interface TextFieldProps {
  name: string;
  label: string;
  value: string;
  error: string | null;
  onChange: (value: string) => void;
  onBlur: () => void;
  wide?: boolean;
  multiline?: boolean;
}

function TextField({ name, label, value, error, onChange, onBlur, wide, multiline }: TextFieldProps) {
  const id = `kfedit-${name}`;
  const errorId = `${id}-error`;
  const shared = {
    id,
    className: multiline === true ? 'kfedit__input kfedit__textarea' : 'kfedit__input',
    value,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
    onBlur,
    'aria-invalid': error !== null,
    ...(error !== null ? { 'aria-describedby': errorId } : {}),
  };

  return (
    <div className={wide === true ? 'kfedit__field kfedit__field--wide' : 'kfedit__field'}>
      <label className="kfedit__label" htmlFor={id}>
        {label}
      </label>
      {multiline === true ? <textarea {...shared} rows={2} /> : <input {...shared} />}
      {error !== null && (
        <span id={errorId} className="kfedit__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

interface DateFieldProps {
  name: string;
  label: string;
  /** `YYYY-MM-DD`, or blank. Anything else is a value the control cannot show. */
  value: string;
  error: string | null;
  /** What the stored value was, when the picker could not open it as-is. */
  hint: string | null;
  onChange: (value: string) => void;
  onBlur: () => void;
}

/**
 * A calendar day. Same shell as TextField, kept separate rather than adding a
 * `type` flag to a control fifteen text fields share: a date input has its own
 * value contract (`YYYY-MM-DD` or blank, never free text) and its own failure
 * mode (a value it cannot parse renders as an EMPTY field, with no hint that
 * anything was dropped), and the `hint` line exists to answer exactly that.
 */
function DateField({ name, label, value, error, hint, onChange, onBlur }: DateFieldProps) {
  const id = `kfedit-${name}`;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error !== null ? errorId : null, hint !== null ? hintId : null]
    .filter((x): x is string => x !== null)
    .join(' ');

  return (
    <div className="kfedit__field">
      <label className="kfedit__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="date"
        className="kfedit__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        aria-invalid={error !== null}
        {...(describedBy !== '' ? { 'aria-describedby': describedBy } : {})}
      />
      {hint !== null && (
        <span id={hintId} className="kfedit__hint">
          {hint}
        </span>
      )}
      {error !== null && (
        <span id={errorId} className="kfedit__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

interface SecretFieldProps {
  name: string;
  label: string;
  /** The field named as it should be spoken, for the reveal toggle and the edit button. */
  spoken: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

/**
 * A household access secret in an EDIT form: masked at rest, typeable once the
 * operator asks for it.
 *
 * The obvious control, `<input type="password">`, is the wrong one here and the
 * reason is written into MaskedValue itself: its mask is a FIXED six glyphs so
 * the secret's LENGTH does not leak, and a password input renders one dot per
 * character, which publishes exactly that. A four digit gate code and a twenty
 * character passphrase would look different across the room.
 *
 * So the resting state is MaskedValue, unchanged, the same control the profile
 * screen shows, and the secret is not in the DOM until someone asks. Editing is
 * a second deliberate act that swaps in a plain input. Once an operator has
 * chosen to type a code, hiding the characters from them while they type helps
 * nobody: they cannot check what they entered, and the value is already on
 * screen because they just typed it.
 */
function SecretField({ name, label, spoken, value, disabled, onChange }: SecretFieldProps) {
  const [editing, setEditing] = useState(false);
  const id = `kfedit-${name}`;

  if (editing) {
    return (
      <div className="kfedit__field">
        <label className="kfedit__label" htmlFor={id}>
          {label}
        </label>
        <input
          id={id}
          className="kfedit__input"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    );
  }

  return (
    <div className="kfedit__field">
      <span className="kfedit__label">{label}</span>
      <div className="kfedit__secret">
        <MaskedValue value={value} field={spoken} />
        <button
          type="button"
          className="kfedit__secret-edit"
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          {value.trim() === '' ? `Add ${spoken}` : `Change ${spoken}`}
        </button>
      </div>
    </div>
  );
}

/**
 * Load skeleton: panel-shaped blocks, so the page does not reflow from one line
 * of text into six panels the instant the read lands. `AsyncRegion` wraps this
 * in the role="status" live region, so it is announced rather than silent.
 */
function EditSkeleton() {
  return (
    <div className="kfedit__skeleton" aria-hidden="true">
      {[0, 1, 2].map((panel) => (
        <div key={panel} className="kfedit__skeleton-panel">
          <span className="kfedit__skeleton-title" />
          <span className="kfedit__skeleton-row" />
          <span className="kfedit__skeleton-row" />
        </div>
      ))}
    </div>
  );
}
