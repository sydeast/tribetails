import { useEffect, useState } from 'react';
import { getBusinessSettings, type BusinessSettings } from '../api/settings';
import { saveBusinessSettings } from '../api/settingsWrite';
import { addTag, DEFAULT_TAG_COLOR, type TagDef, type TagScope } from '../lib/tags/model';
import { DenPanel } from './DenScreenKit';
import { Banner } from './Banner';
import { TagAssignField } from './TagAssignField';
import './ProfileTagsSection.css';

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
 */

interface ProfileTagsSectionProps {
  scope: TagScope;
  /** The names already on the profile doc. Seeded once (the SettingsEdit convention). */
  initialTags: string[];
  /** Persists the next name list to the profile doc (kinfolk or kin). */
  onSaveTags: (next: string[]) => Promise<void>;
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

export function ProfileTagsSection({ scope, initialTags, onSaveTags }: ProfileTagsSectionProps) {
  const copy = SCOPE_COPY[scope];
  const [tags, setTags] = useState<string[]>(initialTags);
  const [vocab, setVocab] = useState<TagDef[]>([]);
  const [vocabError, setVocabError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    getBusinessSettings()
      .then((s: BusinessSettings) => {
        if (live) setVocab(scope === 'household' ? s.householdTags : s.petTags);
      })
      .catch(
        (err: unknown) =>
          live &&
          setVocabError(
            `Couldn't load tag suggestions: ${err instanceof Error ? err.message : 'Load failed'}`,
          ),
      );
    return () => {
      live = false;
    };
  }, [scope]);

  function handleChange(next: string[]) {
    const prev = tags;
    setTags(next);
    setSaving(true);
    setSaveError(null);
    onSaveTags(next)
      .catch((err: unknown) => {
        setTags(prev); // revert the optimistic update
        setSaveError(`Couldn't save tags: ${err instanceof Error ? err.message : 'Save failed'}`);
      })
      .finally(() => setSaving(false));
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
      {vocabError !== null && (
        <Banner tone="warning" title="Tag suggestions unavailable" className="profileTags__banner">
          {vocabError}
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
        onCreateVocab={handleCreateVocab}
        disabled={saving}
        inputLabel={copy.inputLabel}
      />
    </DenPanel>
  );
}
