import { useId, useMemo, useState } from 'react';
import { normalizeTagName, type TagDef } from '../lib/tags/model';
import { suggestTags, addAssigned, removeAssigned } from '../lib/tags/assign';
import { TagChip } from './TagChip';
import './TagAssignField.css';

interface TagAssignFieldProps {
  /** The assigned tag NAMES. */
  value: string[];
  /** The relevant vocabulary (household or pet) for autocomplete + chip resolution. */
  vocab: TagDef[];
  /** Called with the next name list on every add/remove. */
  onChange: (next: string[]) => void;
  /**
   * Optional: when given, a typed name that is not already in the vocabulary
   * shows an "add to your tags" affordance. Selecting it BOTH assigns the name
   * (via onChange) and calls this so the caller can persist it to the managed
   * vocabulary. Omit to allow free-form assignment without growing the vocab.
   */
  onCreateVocab?: (name: string) => void;
  disabled?: boolean;
  /** Accessible label for the text input (defaults to "Add a tag"). */
  inputLabel?: string;
}

function lower(name: string): string {
  return normalizeTagName(name).toLowerCase();
}

/**
 * Hybrid tag assign field: the current tags as removable chips, plus a text
 * input that autocompletes from the vocabulary and also accepts a free-form
 * name. Selecting a suggestion or pressing Enter adds; the chip × removes. A
 * typed name not in the vocabulary can be promoted with "add to your tags"
 * (`onCreateVocab`), which assigns it and hands the name back to persist.
 *
 * Pure logic lives in `lib/tags/assign.ts`; this component is the thin UI shell,
 * matching the Den convention of keeping transforms out of the view.
 */
export function TagAssignField({
  value,
  vocab,
  onChange,
  onCreateVocab,
  disabled = false,
  inputLabel = 'Add a tag',
}: TagAssignFieldProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const listId = useId();

  const suggestions = useMemo(() => suggestTags(draft, vocab, value), [draft, vocab, value]);

  const trimmed = normalizeTagName(draft);
  const inVocab = vocab.some((t) => lower(t.name) === lower(trimmed));
  const canCreate = onCreateVocab !== undefined && trimmed !== '' && !inVocab;
  const showList = focused && (suggestions.length > 0 || canCreate);

  /** Prefer the vocabulary's canonical casing when the name matches an entry. */
  function canonical(name: string): string {
    const hit = vocab.find((t) => lower(t.name) === lower(name));
    return hit !== undefined ? hit.name : normalizeTagName(name);
  }

  function assign(name: string) {
    onChange(addAssigned(value, canonical(name)));
    setDraft('');
  }

  function create() {
    if (!canCreate || onCreateVocab === undefined) return;
    onCreateVocab(trimmed);
    onChange(addAssigned(value, trimmed));
    setDraft('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (trimmed !== '') assign(trimmed);
    } else if (e.key === 'Escape') {
      setDraft('');
    }
  }

  return (
    <div className="tag-assign">
      <fieldset className="tag-assign__fieldset" disabled={disabled}>
        {value.length > 0 && (
          <ul className="tag-assign__chips">
            {value.map((name) => (
              <li key={name} className="tag-assign__chip">
                <TagChip name={name} vocab={vocab} onRemove={() => onChange(removeAssigned(value, name))} />
              </li>
            ))}
          </ul>
        )}

        <div className="tag-assign__inputWrap">
          <input
            type="text"
            className="tag-assign__input"
            value={draft}
            placeholder="Type or pick a tag"
            aria-label={inputLabel}
            aria-expanded={showList}
            aria-controls={showList ? listId : undefined}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            // Delay so a suggestion's click lands before the list unmounts.
            onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          />

          {showList && (
            <div className="tag-assign__list" id={listId}>
              {suggestions.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  className="tag-assign__option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => assign(t.name)}
                >
                  {t.icon !== '' && <span aria-hidden="true">{t.icon}</span>}
                  <span>{t.name}</span>
                </button>
              ))}
              {canCreate && (
                <button
                  type="button"
                  className="tag-assign__option tag-assign__option--create"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={create}
                >
                  Add &ldquo;{trimmed}&rdquo; to your tags
                </button>
              )}
            </div>
          )}
        </div>
      </fieldset>
    </div>
  );
}
