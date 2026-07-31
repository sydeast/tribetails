import { useState } from 'react';

/**
 * A masked input field for sensitive data (gate codes, passwords, etc).
 * By default shows masked dots, with an explicit show/hide toggle.
 * The value is still fully editable even while masked, and autocomplete
 * is disabled to prevent credential managers storing these values.
 */
export function SecretField(props: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const { value, onChange, label, placeholder, className, id } = props;
  const [isRevealed, setIsRevealed] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <div style={{ flex: 1 }}>
        {label && <label htmlFor={id}>{label}</label>}
        <input
          id={id}
          className={className}
          type={isRevealed ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
        />
      </div>
      <button
        type="button"
        onClick={() => setIsRevealed(!isRevealed)}
        style={{
          padding: '6px 12px',
          borderRadius: 4,
          border: '1px solid var(--border)',
          backgroundColor: 'transparent',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 500,
        }}
        title={isRevealed ? 'Hide' : 'Show'}
      >
        {isRevealed ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
