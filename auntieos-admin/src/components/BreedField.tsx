import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  breedDropdownOptions,
  isExactBreed,
} from '../lib/breedSearch';
import './BreedField.css';

interface BreedFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** The seeded bank for the current species. Empty means free text. */
  catalog: readonly string[];
  /**
   * Disclosed degradation. Set when the species SHOULD have a bank but the
   * catalog came back empty, so the operator is told why the dropdown is gone
   * rather than left wondering whether breed still saves.
   */
  note?: string | null;
  disabled?: boolean;
  label?: string;
  /** Distinguishes the two instances on a page so their ids never collide. */
  name?: string;
  /** Spans a two-column grid, matching the surrounding form's wide fields. */
  wide?: boolean;
}

/**
 * The Kin breed input: a type-to-search dropdown over the seeded dog / cat bank
 * (`api/breeds.ts`), restoring what the React port dropped when it replaced the
 * Kotlin `BreedField` with a plain text box.
 *
 * FREE TEXT PASSES THROUGH, and that is the deliberate difference from
 * `VetClinicPicker`, which refuses anything not already in its catalog. A vet
 * clinic is a shared record that must not gain a fourth spelling; a breed is a
 * description of one animal, and "Lab / pit mix" is a real, correct answer that
 * no 478-row bank will ever contain. So the bank is an accelerator here, not a
 * gate: the typed string is always the value, and picking from the list is a
 * shortcut for typing it exactly.
 *
 * Opening the field with nothing typed shows the HEAD of the bank rather than
 * an empty popover (operator A8 feedback: the old search-only field read as
 * "breed isn't pulling the DB"). Once the value exactly names a breed in the
 * bank the list stops appearing, so a committed choice does not sit under a
 * permanently open dropdown.
 *
 * Dismissal follows TagAssignField's contract, reused rather than reinvented:
 * outside pointerdown, a delayed blur so a click on an option still lands, and
 * Escape.
 */
export function BreedField({
  value,
  onChange,
  catalog,
  note = null,
  disabled = false,
  label = 'Breed',
  name = 'kin',
  wide = false,
}: BreedFieldProps) {
  const id = `breedfield-${name}`;
  const listId = useId();

  const [open, setOpen] = useState(false);
  /** Keyboard cursor into `options`; -1 means "no option highlighted, the typed text stands". */
  const [active, setActive] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<number | undefined>(undefined);

  const options = useMemo(() => breedDropdownOptions(value, catalog), [value, catalog]);
  const exact = useMemo(() => isExactBreed(value, catalog), [value, catalog]);

  const showList = open && !disabled && options.length > 0 && !exact;

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

  // The highlight indexes into a list that rewrites itself on every keystroke.
  // Resetting it when the options change is what stops Enter from committing
  // whatever breed happens to have slid into the old slot.
  useEffect(() => setActive(-1), [options]);

  function commit(breed: string) {
    onChange(breed);
    cancelBlurClose();
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // Ours while the list is open, so a keystroke meant to shed suggestions
      // does not also close the dialog this field sits in.
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
    if (e.key === 'Enter') {
      // Only intercepted when a suggestion is actually highlighted. Otherwise
      // Enter belongs to the surrounding form, and the typed value stands,
      // which is the free-text contract.
      if (showList && active >= 0) {
        const picked = options[active];
        if (picked !== undefined) {
          e.preventDefault();
          commit(picked);
        }
      }
    }
  }

  const activeId = active >= 0 ? `${listId}-opt-${String(active)}` : undefined;

  return (
    <div className={wide ? 'breedfield breedfield--wide' : 'breedfield'} ref={rootRef}>
      <label className="breedfield__label" htmlFor={id}>
        {label}
      </label>

      <div className="breedfield__inputWrap">
        <input
          id={id}
          type="text"
          className="breedfield__input"
          value={value}
          disabled={disabled}
          autoComplete="off"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-activedescendant={activeId}
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
          <ul className="breedfield__list" id={listId} role="listbox" aria-label={`${label} suggestions`}>
            {options.map((breed, i) => (
              <li key={breed} role="none">
                <button
                  type="button"
                  id={`${listId}-opt-${String(i)}`}
                  role="option"
                  aria-selected={i === active}
                  className={
                    i === active ? 'breedfield__option breedfield__option--active' : 'breedfield__option'
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

      {note !== null && note !== '' && (
        <p className="breedfield__note" data-testid="breedfield-note">
          {note}
        </p>
      )}
    </div>
  );
}
