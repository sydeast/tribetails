import { useEffect, useId, useRef, useState } from 'react';
import { mapboxSuggest, mapboxRetrieve, newMapboxSessionToken, type MapboxSuggestion } from '../api/mapbox';
import './AddressAutofillField.css';

/** Below this, a query is too short to mean anything and we do not spend a call on it. */
const MIN_QUERY_CHARS = 3;
/** Matches the archive field and the android view model. Long enough to skip mid-word noise. */
const DEBOUNCE_MS = 250;

interface AddressAutofillFieldProps {
  /** Used for the input id, so a screen can hold more than one of these. */
  name: string;
  label: string;
  value: string;
  /** The CALLER's validation message (required, too long, ...), not a lookup failure. */
  error: string | null;
  onChange: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  /** Renders across a two-column grid, matching KinfolkEdit's `--wide` fields. */
  wide?: boolean;
}

/**
 * A street-address input with Mapbox Search Box autocomplete, ported from the
 * archive's `AddressAutofillField` (KinfolkEditScreen.kt:678).
 *
 * THE FIELD IS A PLAIN INPUT FIRST. Autocomplete is additive: the operator can
 * ignore the dropdown, type a full address by hand, and save. Every failure path
 * below keeps that true, because a household with an address Mapbox has never
 * heard of (a new build, a rural route, a gate off an unnamed drive) still has
 * to be enterable. Nothing here ever blocks or clears what was typed.
 *
 * Failures fail LOUD, in the house style: a red inline banner naming the
 * failure, plus the instruction that manual entry still works. A lookup that
 * silently returns nothing would read as "Mapbox has no such address", which is
 * a different and wrong answer.
 *
 * SESSION BILLING: one 32-hex token is generated per search and reused across
 * every keystroke, then handed to `mapboxRetrieve` for the picked suggestion,
 * and only THEN rotated. See the header of `api/mapbox.ts`. A token per
 * keystroke would bill every keystroke as its own Mapbox session.
 */
export function AddressAutofillField({
  name,
  label,
  value,
  error,
  onChange,
  onBlur,
  disabled = false,
  wide = false,
}: AddressAutofillFieldProps) {
  const id = `addr-${name}`;
  const errorId = `${id}-error`;
  const lookupErrorId = `${id}-lookup-error`;
  const listId = useId();

  const [suggestions, setSuggestions] = useState<MapboxSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<number | undefined>(undefined);
  const sessionToken = useRef<string>(newMapboxSessionToken());
  /**
   * The value we just wrote back from a retrieve. The debounce effect keys off
   * `value`, so without this the resolved address would immediately be typed
   * back into Mapbox as a fresh query: a wasted call, on the retired token, that
   * re-opens the dropdown over the answer the operator just chose.
   */
  const selfWritten = useRef<string | null>(null);
  /**
   * The first effect pass carries whatever the form LOADED with, not something
   * anyone typed. Looking that up would open a dropdown over an address the
   * operator already has, and spend a billed Mapbox session on every visit to
   * an existing household's edit screen.
   */
  const initialPass = useRef(true);

  function cancelBlurClose() {
    if (blurTimer.current !== undefined) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = undefined;
    }
  }

  // Debounced suggest. The cleanup both cancels the pending timer and marks the
  // in-flight response stale, so a slow response for "123 Mi" cannot land on top
  // of a fresh one for "123 Mill".
  useEffect(() => {
    const trimmed = value.trim();
    if (initialPass.current) {
      initialPass.current = false;
      return;
    }
    if (selfWritten.current !== null && selfWritten.current === value) {
      selfWritten.current = null;
      return;
    }
    if (trimmed.length < MIN_QUERY_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }

    let live = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rows = await mapboxSuggest(trimmed, sessionToken.current);
          if (!live) return;
          setSuggestions(rows);
          setOpen(rows.length > 0);
          setLookupError(null);
        } catch (err) {
          if (!live) return;
          setSuggestions([]);
          setOpen(false);
          setLookupError(err instanceof Error ? err.message : 'Lookup failed');
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [value]);

  // Same dismissal contract as TagAssignField: an outside pointerdown closes the
  // list even when the press lands on something that never takes focus.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      const root = rootRef.current;
      const target = e.target;
      if (root === null || !(target instanceof Node) || root.contains(target)) return;
      cancelBlurClose();
      setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => cancelBlurClose, []);

  async function pick(s: MapboxSuggestion) {
    try {
      const resolved = await mapboxRetrieve(s.mapboxId, sessionToken.current);
      selfWritten.current = resolved;
      onChange(resolved);
      setSuggestions([]);
      setOpen(false);
      setLookupError(null);
      // Mapbox billing: the session ends at the retrieve. The next search starts
      // a new one.
      sessionToken.current = newMapboxSessionToken();
    } catch (err) {
      // The typed value is deliberately left exactly as it was. A failed
      // resolution must not eat the operator's own text.
      setLookupError(err instanceof Error ? err.message : 'Lookup failed');
      setOpen(false);
    }
  }

  const showList = open && suggestions.length > 0;
  const describedBy = [error !== null ? errorId : null, lookupError !== null ? lookupErrorId : null]
    .filter((x): x is string => x !== null)
    .join(' ');

  return (
    <div className={wide ? 'addrfield addrfield--wide' : 'addrfield'} ref={rootRef}>
      <label className="addrfield__label" htmlFor={id}>
        {label}
      </label>
      <div className="addrfield__inputWrap">
        <input
          id={id}
          type="text"
          className="addrfield__input"
          value={value}
          disabled={disabled}
          autoComplete="off"
          aria-invalid={error !== null}
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          {...(describedBy !== '' ? { 'aria-describedby': describedBy } : {})}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && showList) {
              // Ours while the list is open, so a surrounding dialog is not
              // closed out from under an operator shedding suggestions. Same
              // contract as TagAssignField.
              e.stopPropagation();
              cancelBlurClose();
              setOpen(false);
            }
          }}
          onFocus={() => {
            cancelBlurClose();
            if (suggestions.length > 0) setOpen(true);
          }}
          onBlur={() => {
            cancelBlurClose();
            // Delayed so a suggestion click lands before the list unmounts.
            blurTimer.current = window.setTimeout(() => {
              blurTimer.current = undefined;
              setOpen(false);
            }, 150);
            onBlur?.();
          }}
        />

        {showList && (
          <div className="addrfield__list" id={listId}>
            {suggestions.map((s) => (
              <button
                key={s.mapboxId}
                type="button"
                className="addrfield__option"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(s)}
              >
                <span className="addrfield__optionName">{s.name !== '' ? s.name : s.fullAddress}</span>
                {s.fullAddress !== '' && s.fullAddress !== s.name && (
                  <span className="addrfield__optionAddress">{s.fullAddress}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {lookupError !== null && (
        <span id={lookupErrorId} className="addrfield__lookupError" role="alert">
          Address lookup failed: {lookupError}. Type the full street address manually.
        </span>
      )}
      {error !== null && (
        <span id={errorId} className="addrfield__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
