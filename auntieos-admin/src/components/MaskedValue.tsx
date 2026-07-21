import { useId, useState } from 'react';
import './MaskedValue.css';

/**
 * The mask is a FIXED six glyphs, never one per character. A per-character mask
 * silently publishes the secret's length, which is the single most useful thing
 * an onlooker can learn without reading it (a 4-digit gate code vs a 20-character
 * passphrase narrows a guess enormously). Every masked field looks identical.
 */
const MASK = '••••••';

interface MaskedValueProps {
  /** The secret itself. Blank renders the "Not set" treatment with no toggle. */
  value: string;
  /**
   * The field named as it should be spoken, lowercase (e.g. "gate code"), so the
   * toggle reads "Show gate code" rather than a bare "Show" repeated down a list.
   */
  field: string;
}

/**
 * A household access secret (gate code, Wi-Fi password) rendered hidden, with a
 * toggle to reveal it. These screens get read over an operator's shoulder, on a
 * phone at a doorstep and on a shared desktop, so a code that is on screen the
 * whole time a household is open is a code that leaks. Hidden is the resting
 * state; revealing is a deliberate act.
 *
 * Reveal is per-mount local state on purpose: navigating away and back re-hides,
 * so a revealed code cannot outlive the moment it was needed.
 */
export function MaskedValue({ value, field }: MaskedValueProps) {
  const [shown, setShown] = useState(false);
  const valueId = useId();

  // Matches the Fact/Field "Not set" treatment used across the Den rather than
  // offering a toggle that would reveal nothing.
  if (value.trim() === '') {
    return <span className="masked-value__unset">Not set</span>;
  }

  return (
    <span className="masked-value">
      {shown ? (
        <span id={valueId} className="masked-value__secret">
          {value}
        </span>
      ) : (
        // aria-hidden: the dots are a visual placeholder, and "bullet bullet
        // bullet" is noise to a screen reader. The button's name carries the
        // meaning instead.
        <span id={valueId} className="masked-value__mask" aria-hidden="true">
          {MASK}
        </span>
      )}
      <button
        type="button"
        className="masked-value__toggle"
        aria-label={`${shown ? 'Hide' : 'Show'} ${field}`}
        aria-expanded={shown}
        aria-controls={valueId}
        onClick={() => setShown((s) => !s)}
      >
        {shown ? 'Hide' : 'Show'}
      </button>
    </span>
  );
}
