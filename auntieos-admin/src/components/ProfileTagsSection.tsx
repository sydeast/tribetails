import { useCallback, useEffect, useState } from 'react';
import { type BusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import { getWorkSettingsFor } from '../api/workSettings';
import { currentSessionSeat } from '../lib/sessionSeat';
import { addTag, DEFAULT_TAG_COLOR, type TagDef, type TagScope } from '../lib/tags/model';
import { DenPanel } from './DenScreenKit';
import { Banner } from './Banner';
import { GhostButton } from './Buttons';
import { LoadingRow } from './LoadingRow';
import { TagAssignField } from './TagAssignField';
import './ProfileTagsSection.css';

/** The words on the wait, exported so tests spell it once. */
export const TAG_SUGGESTIONS_LOADING = 'Loading tag suggestions…';

/**
 * Where the suggestions stand. `canGrow` is whether this session may add a
 * typed name to the business's tag list: the owner may (Business Settings is
 * hers), an Auntie may not (#2186), and nobody may before the list has loaded,
 * because the save replaces the whole list and an empty one would wipe it.
 */
type VocabLoad =
  | { status: 'loading' }
  | { status: 'ready'; canGrow: boolean }
  | { status: 'error'; message: string };

/**
 * The "Tags" panel shared by the kinfolk profile (household tags) and the kin
 * profile (pet tags). Loads the relevant vocabulary from `business_settings`
 * for autocomplete + rich chip resolution, and saves each add/remove through
 * the caller's write function (`updateKinfolkTags` / `updateKinTags`) the moment
 * it happens, optimistically. A save failure reverts the chip and surfaces the
 * error (fail-loud), never a silent no-op.
 *
 * A typed name that is not yet in the vocabulary can be promoted to it inline
 * ("add to your tags"): that both assigns the name and appends a default-colored
 * `TagDef` to the right vocabulary list via `saveBusinessSettings`, so it becomes
 * a reusable suggestion (recolorable later in the Tags settings panel).
 *
 * #2186: the vocabulary comes through the work-settings read, so an Auntie, who
 * cannot read `business_settings`, gets the suggestions from the narrow staff
 * read (names only) while the owner's read stays her direct one. An Auntie is
 * never offered "add to your tags": that edits Business Settings, which is the
 * owner's.
 */

interface ProfileTagsSectionProps {
  scope: TagScope;
  /** The names already on the profile doc. Seeded once (the SettingsEdit convention). */
  initialTags: string[];
  /** Persists the next name list to the profile doc (kinfolk or kin). */
  onSaveTags: (next: string[]) => Promise<void>;
  /**
   * Told when a save starts and when it settles (#1271). A host that can close
   * this panel holds its close control while a save is in flight, so the panel
   * cannot be dismissed, and the screen left, before the server has the change.
   */
  onSavingChange?: (saving: boolean) => void;
  /** Told the list the server accepted, so a host showing the tags elsewhere can repaint them. */
  onSaved?: (saved: string[]) => void;
}

const SCOPE_COPY: Record<TagScope, { subtitle: string; inputLabel: string }> = {
  household: {
    subtitle: 'Labels on this household. Broadcasts and KinTale rules can target them.',
    inputLabel: 'Add a household tag',
  },
  pet: {
    subtitle: 'Labels on this pet, e.g. Reactive or On meds.',
    inputLabel: 'Add a pet tag',
  },
};

export function ProfileTagsSection({
  scope,
  initialTags,
  onSaveTags,
  onSavingChange,
  onSaved,
}: ProfileTagsSectionProps) {
  const copy = SCOPE_COPY[scope];
  const [tags, setTags] = useState<string[]>(initialTags);
  const [vocab, setVocab] = useState<TagDef[]>([]);
  const [vocabLoad, setVocabLoad] = useState<VocabLoad>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const retryVocab = useCallback(() => setAttempt((n) => n + 1), []);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    setVocabLoad({ status: 'loading' });
    // Its own read per mount, never the shared cache: the owner may have just
    // added a tag on another profile, and this list should carry it.
    currentSessionSeat()
      .then(async (seat) => ({ seat, settings: await getWorkSettingsFor(seat) }))
      .then(({ seat, settings }) => {
        if (!live) return;
        setVocab(scope === 'household' ? settings.householdTags : settings.petTags);
        setVocabLoad({ status: 'ready', canGrow: !seat.caretaker });
      })
      .catch((err: unknown) => {
        if (!live) return;
        const detail = (err instanceof Error && err.message.trim() !== '' ? err.message.trim() : 'Load failed').replace(/\.+$/, '');
        setVocabLoad({ status: 'error', message: `Couldn't load tag suggestions: ${detail}` });
      });
    return () => {
      live = false;
    };
  }, [scope, attempt]);

  function handleChange(next: string[]) {
    const prev = tags;
    setTags(next);
    setSaving(true);
    onSavingChange?.(true);
    setSaveError(null);
    onSaveTags(next)
      .then(() => onSaved?.(next))
      .catch((err: unknown) => {
        setTags(prev); // revert the optimistic update
        setSaveError(`Couldn't save tags: ${err instanceof Error ? err.message : 'Save failed'}`);
      })
      .finally(() => {
        setSaving(false);
        onSavingChange?.(false);
      });
  }

  function handleCreateVocab(name: string) {
    let nextVocab: TagDef[];
    try {
      nextVocab = addTag(vocab, { name, color: DEFAULT_TAG_COLOR, icon: '' });
    } catch {
      // Already in the vocab (or blank): nothing to persist here; the assignment
      // itself is handled by the field's own onChange -> handleChange.
      return;
    }
    const prev = vocab;
    setVocab(nextVocab);
    const patch: Partial<BusinessSettings> =
      scope === 'household' ? { householdTags: nextVocab } : { petTags: nextVocab };
    saveBusinessSettings(patch).catch((err: unknown) => {
      setVocab(prev); // revert
      setSaveError(
        `Couldn't add that tag to your list: ${err instanceof Error ? err.message : 'Save failed'}`,
      );
    });
  }

  return (
    <DenPanel title="Tags" subtitle={copy.subtitle}>
      {vocabLoad.status === 'loading' && <LoadingRow label={TAG_SUGGESTIONS_LOADING} className="profileTags__loading" />}
      {vocabLoad.status === 'error' && (
        <Banner
          tone="warning"
          title="Tag suggestions unavailable"
          className="profileTags__banner"
          trailing={<GhostButton label="Try again" onClick={retryVocab} />}
        >
          {vocabLoad.message}. Tags you type still save.
        </Banner>
      )}
      {saveError !== null && (
        <Banner tone="error" title="Save failed" onDismiss={() => setSaveError(null)} className="profileTags__banner">
          {saveError}
        </Banner>
      )}
      <TagAssignField
        value={tags}
        vocab={vocab}
        onChange={handleChange}
        {...(vocabLoad.status === 'ready' && vocabLoad.canGrow ? { onCreateVocab: handleCreateVocab } : {})}
        disabled={saving}
        inputLabel={copy.inputLabel}
      />
    </DenPanel>
  );
}
