import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Accessible name; required since the visual control carries no text. */
  label: string;
  className?: string;
}

/**
 * The Den switch. Ports the Compose AuntieToggle: a track + sliding thumb, the
 * brand accent when on. A real <button role="switch"> so it is keyboard- and
 * screen-reader-operable by default (one of the things the wasm canvas admin
 * could not offer, AO-15).
 */
export function Toggle({ checked, onChange, disabled = false, label, className }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={['toggle', checked ? 'toggle--on' : '', className].filter(Boolean).join(' ')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__thumb" aria-hidden="true" />
    </button>
  );
}
