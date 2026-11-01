import { useState } from 'react';
import { KIN_SPECIES_OPTIONS, SPECIES_OTHER, speciesChoice } from '../lib/kinEditForm';
interface SpeciesFieldProps {
  /** Id prefix shared with the form's other inputs, so labels and tests find the control. */
  id: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | undefined;
}
/**
 * Species picker for the Kin editor. The avatar emoji is keyed off this value,
 * so a typo in a free-text box silently swapped the pet's icon. Listed species
 * are one tap; "Other" opens a text box for anything else. A stored value that
 * is not in the list (a legacy "Ferret") opens on Other with its text intact,
 * so nothing already saved is rewritten or hidden.
 */
export function SpeciesField({ id, value, onChange, error }: SpeciesFieldProps) {
  const [otherPicked, setOtherPicked] = useState(() => speciesChoice(value) === SPECIES_OTHER);
  const choice = otherPicked ? SPECIES_OTHER : speciesChoice(value);
  return (
    <div className="field">
      <label htmlFor={id}>Species</label>
      <select
        id={id}
        className="inp"
        value={choice}
        onChange={(e) => {
          const next = e.target.value;
          if (next === SPECIES_OTHER) {
            setOtherPicked(true);
            // Keep typed text when it is already a custom species; clear a listed one.
            if (speciesChoice(value) !== SPECIES_OTHER) onChange('');
          } else {
            setOtherPicked(false);
            onChange(next);
          }
        }}
      >
        <option value="">Choose a species</option>
        {KIN_SPECIES_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value={SPECIES_OTHER}>{SPECIES_OTHER}</option>
      </select>
      {otherPicked && (
        <input
          id={`${id}-other`}
          className="inp"
          type="text"
          aria-label="Other species"
          placeholder="Type the species"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && (
        <span className="hint" style={{ color: 'var(--coral)' }}>
          {error}
        </span>
      )}
    </div>
  );
}
