import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { getBusinessSettings } from '../api/settings';
import { saveBusinessSettings, removeBusinessTag } from '../api/settingsWrite';
import {
  TAG_PALETTE,
  DEFAULT_TAG_COLOR,
  normalizeTagName,
  addTag,
  editTag,
  removeTag,
  type TagColor,
  type TagDef,
  type TagScope,
} from '../lib/tags/model';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { LoadingRow } from '../components/LoadingRow';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Dialog } from '../components/Dialog';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { TagChip } from '../components/TagChip';
import './TagsEditor.css';

/**
 * The Business-settings Tags panel: manage the two tag vocabularies (household
 * and pet) that label kinfolk + kin. Reached in place from `Settings.tsx` via
 * the same panel-swap the notification gate uses. Loads the single
 * `business_settings` doc one-shot (like the other Settings sections), edits the two
 * `TagDef[]` lists locally, and saves both at once through `saveBusinessSettings`
 * (a `setDoc` merge; no callable). Fail-loud on both load and save.
 *
 * Add / edit-color-and-icon / remove only: renaming a tag in place would orphan
 * every assignment referencing the old name (the name is the key), so v1 has no
 * rename.
 *
 * REMOVE IS THE ONE EDIT THAT DOES NOT WAIT FOR SAVE (#713). It used to be a
 * local list filter like the others, which left every household and pet holding
 * the deleted name. The operator ruled that wrong: "IF THE TAG IS DELETED THEN
 * IT GOES AWAY COMPLETELY." So Remove asks for confirmation and then calls
 * `removeBusinessTag`, which drops the vocabulary row AND strips the name off
 * every `kinfolk` (household scope) or `kin` (pet scope) doc carrying it, in
 * one server-side pass. The count it reports is shown afterwards, because this
 * screen reads `business_settings` alone and cannot count the directory itself.
 *
 * On success the row is dropped from BOTH the working list and the loaded
 * baseline, so a delete never leaves the Save button armed with a change the
 * server has already made, and any other unsaved edit stays dirty.
 */

interface TagsEditorProps {
  /**
   * Supplied only when Tags is opened as its own standalone view that needs a
   * way back. The merged `Settings` screen renders it inline as one section
   * behind the always-present section nav, so there is nothing to go "back" to
   * and it passes nothing; the "Back to settings" button is then omitted,
   * matching `NotificationGate`'s optional `onBack`.
   */
  onBack?: () => void;
}

interface Vocabs {
  household: TagDef[];
  pet: TagDef[];
}

const COLOR_LABELS: Record<string, string> = {
  teal: 'Teal',
  orange: 'Orange',
  pink: 'Pink',
  purple: 'Purple',
  coral: 'Coral',
  gold: 'Gold',
  green: 'Green',
};

// A small curated set (no emoji-picker dependency); the text field beside it
// takes any other emoji the operator types or pastes.
const CURATED_EMOJI = ['⭐', '🐾', '❤️', '🔥', '🦴', '🏠', '🚩', '💊', '🍗', '⚠️', '✅', '💤', '🌙', '📌'];

function TagColorPicker({ value, onChange }: { value: TagColor; onChange: (c: TagColor) => void }) {
  return (
    <div className="tagsEditor__swatches" role="group" aria-label="Tag color">
      {TAG_PALETTE.map((c) => {
        const selected = c.token === value.token;
        return (
          <button
            key={c.token}
            type="button"
            className={selected ? 'tagsEditor__swatch tagsEditor__swatch--selected' : 'tagsEditor__swatch'}
            style={{ '--tag-tone': c.css } as CSSProperties}
            aria-label={COLOR_LABELS[c.token] ?? c.token}
            aria-pressed={selected}
            onClick={() => onChange(c)}
          />
        );
      })}
    </div>
  );
}

function TagEmojiPicker({ value, onChange }: { value: string; onChange: (icon: string) => void }) {
  return (
    <div className="tagsEditor__emoji">
      <div className="tagsEditor__emojiRow" role="group" aria-label="Tag emoji">
        <button
          type="button"
          className={value === '' ? 'tagsEditor__emojiBtn tagsEditor__emojiBtn--selected' : 'tagsEditor__emojiBtn'}
          aria-label="No emoji"
          aria-pressed={value === ''}
          onClick={() => onChange('')}
        >
          None
        </button>
        {CURATED_EMOJI.map((e) => (
          <button
            key={e}
            type="button"
            className={value === e ? 'tagsEditor__emojiBtn tagsEditor__emojiBtn--selected' : 'tagsEditor__emojiBtn'}
            aria-label={`Emoji ${e}`}
            aria-pressed={value === e}
            onClick={() => onChange(e)}
          >
            {e}
          </button>
        ))}
      </div>
      <input
        type="text"
        className="tagsEditor__emojiInput"
        aria-label="Custom emoji"
        placeholder="or type one"
        maxLength={8}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

interface TagVocabSectionProps {
  title: string;
  subtitle: string;
  /** Singular noun for copy + input labels, e.g. "household" / "pet". */
  scopeNoun: string;
  tags: TagDef[];
  onChange: (next: TagDef[]) => void;
  /**
   * Remove is a server action now, not a list edit, so the section asks the
   * screen to run it rather than handing back a shortened array. See the file
   * header.
   */
  onRequestRemove: (name: string) => void;
  disabled: boolean;
}

function TagVocabSection({
  title,
  subtitle,
  scopeNoun,
  tags,
  onChange,
  onRequestRemove,
  disabled,
}: TagVocabSectionProps) {
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TagColor>(DEFAULT_TAG_COLOR);
  const [newIcon, setNewIcon] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  function add() {
    try {
      onChange(addTag(tags, { name: newName, color: newColor, icon: newIcon }));
      setNewName('');
      setNewColor(DEFAULT_TAG_COLOR);
      setNewIcon('');
      setAddError(null);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Could not add that tag.');
    }
  }

  return (
    <DenPanel title={title} subtitle={subtitle}>
      <fieldset className="tagsEditor__fieldset" disabled={disabled}>
        {tags.length === 0 ? (
          <p className="tagsEditor__hint">No {scopeNoun} tags yet. Add one below.</p>
        ) : (
          <ul className="tagsEditor__list">
            {tags.map((t) => (
              <li key={t.name} className="tagsEditor__row">
                <span className="tagsEditor__rowChip">
                  <TagChip name={t.name} vocab={tags} />
                </span>
                <div className="tagsEditor__rowControls">
                  <TagColorPicker value={t.color} onChange={(c) => onChange(editTag(tags, t.name, { color: c }))} />
                  <TagEmojiPicker value={t.icon} onChange={(icon) => onChange(editTag(tags, t.name, { icon }))} />
                  <GhostButton label="Remove" onClick={() => onRequestRemove(t.name)} />
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="tagsEditor__addForm">
          {addError !== null && (
            <Banner tone="error" title="Couldn't add tag" onDismiss={() => setAddError(null)}>
              {addError}
            </Banner>
          )}
          <label className="tagsEditor__field">
            <span className="tagsEditor__label">New tag name</span>
            <input
              type="text"
              className="tagsEditor__input"
              value={newName}
              aria-label={`New ${scopeNoun} tag name`}
              placeholder="e.g. VIP"
              onChange={(e) => setNewName(e.target.value)}
            />
          </label>
          <div className="tagsEditor__addPickers">
            <TagColorPicker value={newColor} onChange={setNewColor} />
            <TagEmojiPicker value={newIcon} onChange={setNewIcon} />
          </div>
          <PrimaryButton label="Add tag" onClick={add} disabled={normalizeTagName(newName) === ''} />
        </div>
      </fieldset>
    </DenPanel>
  );
}

/**
 * What the delete actually did, in the operator's terms. The count comes from
 * the server rather than from this screen: TagsEditor reads `business_settings`
 * alone and has no directory stream to count against, so a number invented here
 * would be a guess about records it never loaded.
 */
function removedSummary(r: { name: string; noun: string; count: number }): string {
  const plural = r.noun === 'household' ? 'households' : 'Kin';
  if (r.count === 0) return `"${r.name}" is gone. No ${plural} were carrying it.`;
  if (r.count === 1) return `"${r.name}" is gone. It came off 1 ${r.noun}.`;
  return `"${r.name}" is gone. It came off ${r.count} ${plural}.`;
}

export function TagsEditor({ onBack }: TagsEditorProps) {
  const [loaded, setLoaded] = useState<Async<Vocabs>>({ status: 'loading' });
  const [household, setHousehold] = useState<TagDef[]>([]);
  const [pet, setPet] = useState<TagDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  /** The tag the operator pressed Remove on, held until they confirm the cascade. */
  const [pendingRemove, setPendingRemove] = useState<{ scope: TagScope; name: string } | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** What the last successful delete actually did, reported once it is done. */
  const [removed, setRemoved] = useState<{ name: string; noun: string; count: number } | null>(null);

  const load = useCallback(() => {
    let live = true;
    setLoaded({ status: 'loading' });
    getBusinessSettings()
      .then((s) => {
        if (!live) return;
        setLoaded({ status: 'ready', data: { household: s.householdTags, pet: s.petTags } });
        setHousehold(s.householdTags);
        setPet(s.petTags);
      })
      .catch(
        (err: unknown) =>
          live &&
          setLoaded({
            status: 'error',
            message: `Couldn't read tags: ${err instanceof Error ? err.message : 'Load failed'}`,
            retry: load,
          }),
      );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => load(), [load]);

  const baseline = loaded.status === 'ready' ? loaded.data : null;
  const dirty =
    baseline !== null &&
    (JSON.stringify(household) !== JSON.stringify(baseline.household) ||
      JSON.stringify(pet) !== JSON.stringify(baseline.pet));

  function editHousehold(next: TagDef[]) {
    setHousehold(next);
    setJustSaved(false);
  }
  function editPet(next: TagDef[]) {
    setPet(next);
    setJustSaved(false);
  }

  /**
   * Runs the delete. On success the row leaves the working list AND the
   * baseline: the server has already applied it, so leaving it in the baseline
   * would arm Save with a change that is no longer a change, and leaving it in
   * the working list would show a tag the operator just deleted.
   *
   * A failure is fail-loud and CHANGES NOTHING locally. The callable strips
   * assignments before it touches the vocabulary, so a half-finished run leaves
   * the row on screen and pressing Remove again finishes it.
   */
  async function confirmRemove() {
    if (pendingRemove === null || removing) return;
    const target = pendingRemove;
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await removeBusinessTag(target.scope, target.name);
      const shorten = (list: TagDef[]) => removeTag(list, target.name);
      if (target.scope === 'household') setHousehold(shorten);
      else setPet(shorten);
      setLoaded((prev) =>
        prev.status === 'ready'
          ? {
              status: 'ready',
              data:
                target.scope === 'household'
                  ? { ...prev.data, household: shorten(prev.data.household) }
                  : { ...prev.data, pet: shorten(prev.data.pet) },
            }
          : prev,
      );
      setRemoved({
        name: res.name,
        noun: target.scope === 'household' ? 'household' : 'Kin',
        count: res.recordsTouched,
      });
      setPendingRemove(null);
    } catch (err) {
      setRemoveError(
        `Couldn't remove "${target.name}": ${err instanceof Error ? err.message : 'Remove failed'}`,
      );
      setPendingRemove(null);
    } finally {
      setRemoving(false);
    }
  }

  async function handleSave() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveBusinessSettings({ householdTags: household, petTags: pet });
      setLoaded({ status: 'ready', data: { household, pet } });
      setJustSaved(true);
    } catch (err) {
      setError(`Couldn't save tags: ${err instanceof Error ? err.message : 'Save failed'}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Admin"
        title="Tags"
        subtitle="Manage the tags you put on households and Kin."
        trailing={onBack ? <GhostButton label="Back to settings" onClick={onBack} disabled={busy} /> : undefined}
      />

      {error !== null && (
        <Banner tone="error" title="Save failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      {removeError !== null && (
        <Banner tone="error" title="Remove failed" onDismiss={() => setRemoveError(null)}>
          <p className="tagsEditor__hint">{removeError}</p>
          <p className="tagsEditor__hint">The tag is still on the list, so you can try again.</p>
        </Banner>
      )}

      {removed !== null && (
        <Banner tone="success" title="Tag removed" onDismiss={() => setRemoved(null)}>
          {removedSummary(removed)}
        </Banner>
      )}

      <Banner tone="info" dashed pillLabel="Heads up">
        Removing a tag deletes it everywhere. It comes off the list here and off every household or Kin
        carrying it, as soon as you confirm. Adding the same name back later starts it with nobody on it.
      </Banner>

      <AsyncRegion
        state={loaded}
        what="tags"
        isEmpty={() => false}
        loading={<LoadingRow label="Loading tags…" className="tagsEditor__hint" />}
        empty={<p className="tagsEditor__hint">No tags found.</p>}
      >
        {() => (
          <>
            <TagVocabSection
              title="Household tags"
              subtitle="Label a household (a kinfolk), e.g. VIP or Slow pay. Used by broadcasts and KinTale rules."
              scopeNoun="household"
              tags={household}
              onChange={editHousehold}
              onRequestRemove={(name) => setPendingRemove({ scope: 'household', name })}
              disabled={busy || removing}
            />

            <TagVocabSection
              title="Kin tags"
              subtitle="Label a Kin, e.g. Reactive or On meds."
              scopeNoun="pet"
              tags={pet}
              onChange={editPet}
              onRequestRemove={(name) => setPendingRemove({ scope: 'pet', name })}
              disabled={busy || removing}
            />

            <div className="tagsEditor__saveRow">
              <PrimaryButton
                label={busy ? 'Saving…' : 'Save tags'}
                onClick={() => void handleSave()}
                disabled={!dirty || busy}
                busy={busy}
              />
              {justSaved && !dirty ? <span className="tagsEditor__savedNote">Saved</span> : null}
            </div>
          </>
        )}
      </AsyncRegion>

      {pendingRemove !== null && (
        <Dialog
          title={`Remove "${pendingRemove.name}"?`}
          onClose={() => {
            if (!removing) setPendingRemove(null);
          }}
          footer={
            <>
              <GhostButton
                label="Cancel"
                onClick={() => setPendingRemove(null)}
                disabled={removing}
              />
              <PrimaryButton
                label={removing ? 'Removing…' : 'Remove everywhere'}
                onClick={() => void confirmRemove()}
                disabled={removing}
                busy={removing}
              />
            </>
          }
        >
          <p className="tagsEditor__hint">
            {pendingRemove.scope === 'household'
              ? `This takes "${pendingRemove.name}" off the household tag list and off every household carrying it.`
              : `This takes "${pendingRemove.name}" off the Kin tag list and off every Kin carrying it.`}{' '}
            It happens right away, without waiting for Save, and it cannot be undone.
          </p>
        </Dialog>
      )}
    </div>
  );
}
