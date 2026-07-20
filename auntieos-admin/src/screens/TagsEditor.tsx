import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { getBusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import {
  TAG_PALETTE,
  DEFAULT_TAG_COLOR,
  normalizeTagName,
  addTag,
  editTag,
  removeTag,
  type TagColor,
  type TagDef,
} from '../lib/tags/model';
import { type Async } from '../lib/async';
import { DenScreenHeading, DenPanel } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { TagChip } from '../components/TagChip';
import './TagsEditor.css';

/**
 * The Business-settings Tags panel: manage the two tag vocabularies (household
 * and pet) that label kinfolk + kin. Reached in place from `Settings.tsx` via
 * the same panel-swap the notification gate uses. Loads the single
 * `business_settings` doc one-shot (like `SettingsEdit`), edits the two
 * `TagDef[]` lists locally, and saves both at once through `saveBusinessSettings`
 * (a `setDoc` merge; no callable). Fail-loud on both load and save.
 *
 * Add / edit-color-and-icon / remove only: renaming a tag in place would orphan
 * every assignment referencing the old name (the name is the key), so v1 has no
 * rename. Removing a tag drops the vocab entry but leaves existing assignments,
 * which then render as neutral chips (see `resolveTag`) rather than vanishing.
 */

interface TagsEditorProps {
  onBack: () => void;
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
  disabled: boolean;
}

function TagVocabSection({ title, subtitle, scopeNoun, tags, onChange, disabled }: TagVocabSectionProps) {
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
                  <GhostButton label="Remove" onClick={() => onChange(removeTag(tags, t.name))} />
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

export function TagsEditor({ onBack }: TagsEditorProps) {
  const [loaded, setLoaded] = useState<Async<Vocabs>>({ status: 'loading' });
  const [household, setHousehold] = useState<TagDef[]>([]);
  const [pet, setPet] = useState<TagDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

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
        subtitle="Manage the tags you put on households and pets."
        trailing={<GhostButton label="Back to settings" onClick={onBack} disabled={busy} />}
      />

      {error !== null && (
        <Banner tone="error" title="Save failed" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}

      <Banner tone="info" dashed pillLabel="Heads up">
        Removing a tag here just takes it off the suggestion list. Households or pets already carrying that
        tag keep it, shown plainly until you re-add it or take it off each one.
      </Banner>

      <AsyncRegion
        state={loaded}
        what="tags"
        isEmpty={() => false}
        loading={<p className="tagsEditor__hint">Loading tags…</p>}
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
              disabled={busy}
            />

            <TagVocabSection
              title="Pet tags"
              subtitle="Label a pet (a kin), e.g. Reactive or On meds."
              scopeNoun="pet"
              tags={pet}
              onChange={editPet}
              disabled={busy}
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
    </div>
  );
}
