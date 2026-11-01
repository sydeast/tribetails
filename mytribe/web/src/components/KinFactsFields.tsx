import { KIN_SEX_OPTIONS } from '../lib/kinEditForm';

interface SexFieldProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  error?: string | undefined;
}

/**
 * Sex picker for the Kin editor (#1310). Male / Female / Unknown, the admin's
 * own three. A stored value outside them (the admin has written "F" and "M")
 * stays selectable as its own entry, so opening the editor never silently
 * rewrites what the admin entered.
 */
export function SexField({ id, value, onChange, error }: SexFieldProps) {
  const trimmed = value.trim();
  const listed = KIN_SEX_OPTIONS.some((o) => o === trimmed);
  return (
    <div className="field">
      <label htmlFor={id}>Sex</label>
      <select id={id} className="inp" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Not set</option>
        {KIN_SEX_OPTIONS.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        {trimmed !== '' && !listed && <option value={value}>{value}</option>}
      </select>
      {error && (
        <span className="hint" style={{ color: 'var(--coral)' }}>
          {error}
        </span>
      )}
    </div>
  );
}

interface FixedFieldProps {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

/** Spayed / neutered checkbox (#1310). */
export function FixedField({ id, checked, onChange }: FixedFieldProps) {
  return (
    <div className="field">
      <label htmlFor={id}>
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Spayed / neutered
      </label>
    </div>
  );
}
