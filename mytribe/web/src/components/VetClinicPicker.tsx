import { useState, type ReactNode } from 'react';
import type { VetClinicDto } from '../api/tribeApi';

/**
 * #1908 kin-vet (owner ruling 2026-11-12): "Vet is a dropdown field preloaded
 * with all vets in the entire area". The whole area vet list opens as soon as
 * the box is focused or clicked, typing narrows it, and a long list scrolls
 * rather than being cut short. Used for the household's vet on the Tribe
 * Profile and for a Kin's own vet on its edit and add forms.
 *
 * Picking a row calls [onPick]; what a pick does (save at once, or set a form
 * value) is the caller's. [footer] renders after the rows while the list is
 * open, given the typed text (the Tribe Profile's "Add as a new clinic").
 */
export function VetClinicPicker({
  id,
  label,
  clinics,
  loading,
  failed,
  onPick,
  disabled,
  footer,
}: {
  id: string;
  label: string;
  clinics: readonly VetClinicDto[];
  loading?: boolean;
  failed?: boolean;
  onPick: (clinic: VetClinicDto) => void;
  disabled?: boolean;
  footer?: (query: string) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const q = query.trim().toLowerCase();
  const rows = q === '' ? clinics : clinics.filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q));
  const listId = `${id}-list`;

  function pick(c: VetClinicDto) {
    onPick(c);
    setQuery('');
    setOpen(false);
  }

  return (
    <div className="field full" style={{ marginBottom: 10 }}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="inp"
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        autoComplete="off"
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Choose a clinic, or type to narrow the list"
      />
      {open && !disabled && (
        <div className="suggestlist" id={listId} role="listbox" aria-label="Vet clinics" style={{ maxHeight: 280, overflowY: 'auto' }}>
          {loading && <div className="suggestrow"><small>Loading the vet list…</small></div>}
          {!loading && failed && <div className="suggestrow"><small>The vet list did not load. Try again in a moment.</small></div>}
          {!loading && !failed && rows.length === 0 && (
            <div className="suggestrow"><small>{q === '' ? 'No clinics on the list yet.' : 'No clinic matches that.'}</small></div>
          )}
          {rows.map((c) => (
            <div
              className="suggestrow"
              role="option"
              aria-selected={false}
              key={c.id}
              tabIndex={0}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pick(c);
                }
              }}
            >
              <b>{c.isEmergency ? `${c.name} · 24hr` : c.name}</b>
              {c.address && <small>{c.address}</small>}
            </div>
          ))}
          {footer?.(query.trim())}
          <div className="suggestrow" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(false)}>
            <small>Close the list</small>
          </div>
        </div>
      )}
    </div>
  );
}
