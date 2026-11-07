import { useMemo, useState } from 'react';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import { saveMediaTags, mediaTagsErrorMessage, MAX_TAGGED_KIN } from '../api/mediaTags';
import { groupKinByHousehold, mediaCaption, mediaTaggedKinIds, taggableKin } from '../lib/mediaFormat';
import { str } from '../lib/coerce';
import { type MediaFile } from '../api/gallery';
import { type Kin } from '../api/directory';
import './TagKinDialog.css';

export interface TagKinDialogProps {
  media: MediaFile;
  /** The full kin roster. Narrowed to the file's household here, not by the caller, so the rule lives in one place. */
  allKin: Kin[];
  /**
   * Household display names by id (#1604). Used to put a household heading over
   * each group when the file has no household and the whole roster is offered,
   * and to name the household when the file has one. Safely omitted: a household
   * that does not resolve reads "Household unavailable", never a raw id.
   */
  householdLabels?: Map<string, string>;
  /** True while the roster stream is still resolving: an empty list then is "not loaded yet", not "no kin". */
  kinLoading: boolean;
  /** Non-null when the roster stream FAILED. An empty list then is unknown, and the dialog says so instead of claiming the household has no kin. */
  kinError: string | null;
  onClose: () => void;
  /** Fired after a successful save with the list AS STORED, so the caller can reflect it without a reload. */
  onSaved: (taggedKinIds: string[]) => void;
}

/**
 * "Tag kin in this photo" -- the dialog Android's Gallery hands off to from its
 * media viewer (`GalleryScreen.kt`'s `TagKinDialog`, reached via
 * `MediaViewerDialog`'s `onTag`), ported to web to close #447.
 *
 * A HAND-OFF, NOT A NESTED MODAL. Android dismisses the viewer and opens this
 * (`onTag = { selected = media; pendingView = null }`), and Gallery.tsx does the
 * same. That is not only parity: `Dialog`'s Escape handler is registered on
 * `document` in the capture phase, and two of them would BOTH fire for one
 * Escape (`stopPropagation` does not stop a listener on the same node), so a
 * nested tag dialog would close itself and the viewer underneath it in one
 * keystroke. One dialog at a time, and `Dialog` restores focus to the tile that
 * started the whole flow when this one closes.
 *
 * THE CHECKBOXES ARE REAL CHECKBOXES. Android draws its own tick box on a
 * clickable Row; on the web an `<input type="checkbox">` inside its `<label>`
 * gets Tab-reachability, Space to toggle, the checked state exposed to a screen
 * reader, and the kin's name as its accessible name -- all for free, and none of
 * it correctly re-implementable on a `<div>`. The visual tick is drawn from the
 * input's own `:checked` state in CSS.
 *
 * STATES, all four of them, because an empty picker has four different causes
 * and they are not the same news: the roster is still loading; the roster read
 * FAILED (so what this household has is unknown); the household genuinely has no
 * kin; or the save itself was rejected. Only the last one leaves the operator's
 * selection intact and offers a retry -- the others have nothing to retry yet.
 */
export function TagKinDialog({
  media,
  allKin,
  householdLabels,
  kinLoading,
  kinError,
  onClose,
  onSaved,
}: TagKinDialogProps) {
  const options = useMemo(() => taggableKin(media, allKin), [media, allKin]);
  const [picked, setPicked] = useState<string[]>(() => mediaTaggedKinIds(media));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const caption = mediaCaption(media);
  const mediaHouseholdId = str(media.kinfolkId).trim();
  const mediaHousehold = mediaHouseholdId === '' ? '' : (householdLabels?.get(mediaHouseholdId) ?? '');
  const overLimit = picked.length > MAX_TAGGED_KIN;

  function toggle(kinId: string) {
    setPicked((prev) => (prev.includes(kinId) ? prev.filter((id) => id !== kinId) : [...prev, kinId]));
  }

  async function handleSave() {
    if (saving || overLimit) return;
    setSaveError(null);
    setSaving(true);
    try {
      const res = await saveMediaTags(media._id, picked);
      setSaving(false);
      onSaved(res.taggedKinIds);
    } catch (err) {
      // The selection is deliberately LEFT AS IS: a rejected save must not
      // silently discard the operator's work, and Save stays live to retry.
      setSaveError(mediaTagsErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Dialog
      title="Tag kin in this photo"
      onClose={saving ? () => undefined : onClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Saving tags…' : 'Save tags'}
            onClick={() => void handleSave()}
            disabled={saving || overLimit}
            busy={saving}
          />
        </>
      }
    >
      <div className="tag-kin">
        {caption !== '' && <p className="tag-kin__caption">{caption}</p>}
        {mediaHousehold !== '' && <p className="tag-kin__caption">Household: {mediaHousehold}</p>}

        <PickerBody
          options={options}
          picked={picked}
          onToggle={toggle}
          disabled={saving}
          kinLoading={kinLoading}
          kinError={kinError}
          scopedToHousehold={mediaHouseholdId !== ''}
          householdLabels={householdLabels}
        />

        {overLimit && (
          <p className="tag-kin__error" role="alert">
            {picked.length} kin selected. At most {MAX_TAGGED_KIN} can be tagged in one photo.
          </p>
        )}

        {saveError !== null && (
          <p className="tag-kin__error" role="alert">
            Saving tags failed: {saveError}
          </p>
        )}
      </div>
    </Dialog>
  );
}

interface PickerBodyProps {
  options: Kin[];
  picked: string[];
  onToggle: (kinId: string) => void;
  disabled: boolean;
  kinLoading: boolean;
  kinError: string | null;
  scopedToHousehold: boolean;
  householdLabels: Map<string, string> | undefined;
}

/**
 * The list, or the reason there isn't one. Loading and failed are checked BEFORE
 * empty, because both of them make "no kin on this household" a claim this
 * screen has no evidence for -- the false-empty-on-error class the Gallery port
 * refuses to ship.
 */
function PickerBody({
  options,
  picked,
  onToggle,
  disabled,
  kinLoading,
  kinError,
  scopedToHousehold,
  householdLabels,
}: PickerBodyProps) {
  if (kinLoading) {
    return (
      <p className="tag-kin__hint" aria-live="polite">
        Loading kin…
      </p>
    );
  }

  if (kinError !== null) {
    return (
      <p className="tag-kin__error" role="alert">
        Couldn&rsquo;t load the kin roster, so there is nothing to choose from: {kinError}
      </p>
    );
  }

  if (options.length === 0) {
    return (
      <p className="tag-kin__hint">
        {scopedToHousehold
          ? 'No kin on this household to tag.'
          : 'No kin on file yet. Add one in Directory first.'}
      </p>
    );
  }

  // A file with a household offers that household's kin, so one flat list is
  // unambiguous. A file with none offers the whole roster (#1604): group it
  // under each household's name so two pets called Biscuit can be told apart.
  const groups = scopedToHousehold
    ? [{ kinfolkId: '', label: '', kin: options }]
    : groupKinByHousehold(options, (id) => householdLabels?.get(id));
  return (
    <fieldset className="tag-kin__fields" disabled={disabled}>
      <legend className="tag-kin__legend">Kin in this photo</legend>
      <div className={scopedToHousehold ? undefined : 'tag-kin__scroll'}>
        {groups.map((group) => (
          <section key={group.kinfolkId} className="tag-kin__group">
            {!scopedToHousehold && <h3 className="tag-kin__household">{group.label}</h3>}
            <ul className="tag-kin__list">
              {group.kin.map((kin) => {
                const name = str(kin.name).trim() !== '' ? str(kin.name).trim() : 'Unnamed';
                const sub = [str(kin.species).trim(), str(kin.breed).trim()].filter((s) => s !== '').join(' · ');
                return (
                  <li key={kin._id} className="tag-kin__row">
                    <label className="tag-kin__option">
                      <input
                        type="checkbox"
                        className="tag-kin__checkbox"
                        checked={picked.includes(kin._id)}
                        onChange={() => onToggle(kin._id)}
                      />
                      <span className="tag-kin__names">
                        <span className="tag-kin__name">{name}</span>
                        {sub !== '' && <span className="tag-kin__sub">{sub}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </fieldset>
  );
}
