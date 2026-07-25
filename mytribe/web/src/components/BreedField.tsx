import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { breedDropdownOptions, isExactBreed } from '../lib/breedSearch';

interface BreedFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** The seeded bank for the current species. Empty means plain free text. */
  catalog: readonly string[];
  /** Validation message from the form, rendered in the same slot `textField` uses. */
  error?: string | undefined;
  /**
   * Disclosed degradation, shown when the species should have a bank but the
   * catalog came back empty — so a kinfolk is told why the list is missing
   * rather than left wondering whether breed still saves.
   */
  note?: string | null;
}

/**
 * Breed input for the Kin editor: a type-to-search dropdown over the seeded
 * dog / cat bank (`api/breeds.ts`).
 *
 * FREE TEXT IS THE VALUE. Picking from the list is a shortcut for typing the
 * name exactly, never a gate: "Lab / pit mix" is a real answer about a real
 * animal and no 478-row bank will ever hold it. Opening the field with nothing
 * typed shows the head of the bank rather than an empty popover, and once the
 * value exactly names a breed the list stops appearing so a made choice does
 * not sit under an open dropdown.
 *
 * Markup deliberately reuses the editor's own `field` / `inp` / `hint` classes
 * so it reads as one of the form's fields, not a bolted-on widget; only the
 * popover is new (styles/breedfield.css).
 */
export function BreedField({ value, onChange, catalog, error, note = null }: BreedFieldProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  /** Keyboard cursor into `options`; -1 means no highlight, so the typed text stands. */
  const [active, setActive] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<number | undefined>(undefined);

  const options = useMemo(() => breedDropdownOptions(value, catalog), [value, catalog]);
  const exact = useMemo(() => isExactBreed(value, catalog), [value, catalog]);
  const showList = open && options.length > 0 && !exact;

  function cancelBlurClose() {
    if (blurTimer.current !== undefined) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = undefined;
    }
  }

  useEffect(() => {
    if (!showList) return;
    function onPointerDown(e: PointerEvent) {
      const root = rootRef.current;
      const target = e.target;
      if (root === null || !(target instanceof Node) || root.contains(target)) return;
      cancelBlurClose();
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showList]);

  useEffect(() => cancelBlurClose, []);

  // The list rewrites itself on every keystroke, so the highlight has to reset
  // with it; otherwise Enter commits whichever breed slid into the old slot.
  useEffect(() => setActive(-1), [options]);

  function commit(breed: string) {
    onChange(breed);
    cancelBlurClose();
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (showList) e.stopPropagation();
      cancelBlurClose();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!showList) {
        setOpen(true);
        return;
      }
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((prev) => {
        const next = prev + step;
        if (next < 0) return options.length - 1;
        if (next >= options.length) return 0;
        return next;
      });
      return;
    }
    if (e.key === 'Enter' && showList && active >= 0) {
      // Intercepted only while a suggestion is highlighted. Otherwise Enter
      // belongs to the form and the typed value stands.
      const picked = options[active];
      if (picked !== undefined) {
        e.preventDefault();
        commit(picked);
      }
    }
  }

  return (
    <div className="field breedfield" ref={rootRef}>
      <label htmlFor="kin-breed">Breed</label>
      <div className="breedfield__wrap">
        <input
          id="kin-breed"
          className="inp"
          type="text"
          value={value}
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={active >= 0 ? `${listId}-opt-${String(active)}` : undefined}
          aria-autocomplete="list"
          placeholder={catalog.length === 0 ? '' : 'Type to search, or pick from the list'}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            cancelBlurClose();
            setOpen(true);
          }}
          onBlur={() => {
            cancelBlurClose();
            blurTimer.current = window.setTimeout(() => {
              blurTimer.current = undefined;
              setOpen(false);
            }, 150);
          }}
        />
        {showList && (
          <ul className="breedfield__list" id={listId} role="listbox" aria-label="Breed suggestions">
            {options.map((breed, i) => (
              <li key={breed} role="none">
                <button
                  type="button"
                  id={`${listId}-opt-${String(i)}`}
                  role="option"
                  aria-selected={i === active}
                  className={
                    i === active ? 'breedfield__opt breedfield__opt--active' : 'breedfield__opt'
                  }
                  data-testid="breedfield-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(breed)}
                >
                  {breed}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error !== undefined && error !== '' && (
        <span className="hint" style={{ color: 'var(--coral)' }}>
          {error}
        </span>
      )}
      {note !== null && note !== '' && (
        <span className="hint" data-testid="breedfield-note">
          {note}
        </span>
      )}
    </div>
  );
}
