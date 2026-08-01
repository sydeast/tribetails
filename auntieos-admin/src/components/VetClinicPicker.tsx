import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { clinicDetail, clinicName, type VetClinic } from '../api/vetClinics';
import { vetClinicSuggestions } from '../lib/vetClinicSearch';
import { submitVetClinic, type ClinicCandidate } from '../api/vetClinicsWrite';
import './VetClinicPicker.css';

/**
 * What a household stores for a vet: the catalog id, plus the name, phone and
 * address denormalized onto the kinfolk doc.
 *
 * The denormalized copy is not redundancy for its own sake. An Auntie standing
 * on a doorstep needs the clinic's phone number off the household record
 * without a second read, and a clinic later renamed or deleted from the bank
 * must not blank the number on file. `clinicId` is what makes the link
 * repairable; the three strings are what make it useful offline.
 *
 * A LEGACY household has the three strings and an empty `clinicId`. That is a
 * valid, renderable state, not an error, and the picker says so rather than
 * dropping the name.
 */
export interface VetClinicSelection {
  clinicId: string;
  name: string;
  phone: string;
  address: string;
}

export const EMPTY_VET_CLINIC: VetClinicSelection = { clinicId: '', name: '', phone: '', address: '' };

interface VetClinicPickerProps {
  name: string;
  label: string;
  /** The catalog to search. The EMERGENCY instance passes a pre-filtered list. */
  clinics: readonly VetClinic[];
  value: VetClinicSelection;
  onChange: (next: VetClinicSelection) => void;
  disabled?: boolean;
  /** Seeds the create form's emergency toggle. True for the emergency-vet instance. */
  createAsEmergency?: boolean;
  /** Spans a two-column grid, matching KinfolkEdit's `--wide` fields. */
  wide?: boolean;
}

/**
 * The vet clinic field, per the operator's spec (issue #13): a search box whose
 * dropdown lists matches from the curated `vet_clinics` bank, with a button
 * PINNED at the very bottom, always visible including when nothing matches,
 * that creates the clinic the operator just typed.
 *
 * NO FREE-TEXT PASSTHROUGH. This is an explicit operator ruling and it diverges
 * from the archive, which let a typed name stand as the value. Typing here is a
 * SEARCH; the field's value is always a row in the database. That is why the
 * selection renders as a chip beside the box rather than as text inside it: if
 * the typed string were the value, a typo would silently become a fourth
 * spelling of a clinic the bank already holds, which is the mess the shared
 * catalog exists to prevent. The create button is the deliberate way to add
 * something genuinely new, and it goes through the deduping callable.
 *
 * Dismissal is TagAssignField's contract, reused rather than reinvented:
 * outside pointerdown, a delayed blur so a click on an option still lands, and
 * Escape.
 */
export function VetClinicPicker({
  name,
  label,
  clinics,
  value,
  onChange,
  disabled = false,
  createAsEmergency = false,
  wide = false,
}: VetClinicPickerProps) {
  const id = `vetpick-${name}`;
  const listId = useId();

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  /** Set when a create resolved to an existing clinic, so the operator is told. */
  const [dedupedName, setDedupedName] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const blurTimer = useRef<number | undefined>(undefined);

  const matches = useMemo(() => vetClinicSuggestions(query, clinics), [query, clinics]);

  function cancelBlurClose() {
    if (blurTimer.current !== undefined) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = undefined;
    }
  }

  const showList = open && query.trim() !== '' && !creating;

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

  function select(c: VetClinic) {
    onChange({
      clinicId: c._id,
      name: clinicName(c),
      phone: (c.phone ?? '').trim(),
      address: (c.address ?? '').trim(),
    });
    setQuery('');
    setOpen(false);
    setCreating(false);
  }

  const hasSelection = value.clinicId !== '' || value.name.trim() !== '';
  const unlinked = value.clinicId === '' && value.name.trim() !== '';

  return (
    <div className={wide ? 'vetpick vetpick--wide' : 'vetpick'} ref={rootRef}>
      <label className="vetpick__label" htmlFor={id}>
        {label}
      </label>

      {hasSelection && (
        <div className="vetpick__selected" data-testid="vetpick-selected">
          <div className="vetpick__selectedText">
            <span className="vetpick__selectedName">{value.name}</span>
            {(value.phone !== '' || value.address !== '') && (
              <span className="vetpick__selectedDetail">
                {[value.phone, value.address].filter((s) => s !== '').join(' · ')}
              </span>
            )}
            {unlinked && (
              // Honest, not alarming: the record works, it just is not joined to
              // the bank yet, which is the state EVERY household is in today.
              <span className="vetpick__selectedNote">
                Not linked to the shared catalog. Clear it and search to link this household to a
                clinic record.
              </span>
            )}
          </div>
          <button
            type="button"
            className="vetpick__clear"
            disabled={disabled}
            onClick={() => onChange({ ...EMPTY_VET_CLINIC })}
          >
            Clear
          </button>
        </div>
      )}

      <div className="vetpick__inputWrap">
        <input
          id={id}
          type="text"
          className="vetpick__input"
          value={query}
          disabled={disabled}
          autoComplete="off"
          placeholder={
            clinics.length === 0 ? 'No clinics in the catalog yet' : `Type to search ${clinics.length} clinics`
          }
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Ours while the list is open, so a surrounding dialog is not
              // closed by a keystroke meant only to shed suggestions.
              if (showList) e.stopPropagation();
              cancelBlurClose();
              setOpen(false);
            } else if (e.key === 'Enter') {
              // Enter deliberately does NOT commit the typed text: the value is
              // always a catalog row. Swallowed so it cannot submit a form
              // around this field either.
              e.preventDefault();
            }
          }}
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
          <div className="vetpick__list" id={listId}>
            <div className="vetpick__options">
              {matches.map((c) => (
                <button
                  key={c._id}
                  type="button"
                  className="vetpick__option"
                  data-testid="vetpick-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => select(c)}
                >
                  <span className="vetpick__optionName">{clinicName(c)}</span>
                  {clinicDetail(c) !== '' && (
                    <span className="vetpick__optionDetail">{clinicDetail(c)}</span>
                  )}
                </button>
              ))}
              {matches.length === 0 && (
                <p className="vetpick__noMatch">No clinic in the catalog matches that.</p>
              )}
            </div>

            {/* PINNED, always last, always present. Outside the scrolling
                options block on purpose: with a long match list the operator
                must not have to scroll to reach the one action that handles a
                clinic the bank has never heard of. */}
            <button
              type="button"
              className="vetpick__create"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                cancelBlurClose();
                setCreating(true);
              }}
            >
              Create &quot;{query.trim()}&quot; as a new vet clinic
            </button>
          </div>
        )}
      </div>

      {creating && (
        <CreateClinicForm
          fieldName={name}
          initialName={query.trim()}
          initialEmergency={createAsEmergency}
          onCancel={() => {
            setCreating(false);
            setOpen(false);
          }}
          onCreated={(selection, deduped) => {
            onChange(selection);
            setQuery('');
            setOpen(false);
            setCreating(false);
            setDedupedName(deduped ? selection.name : null);
          }}
        />
      )}

      {dedupedName !== null && (
        // Not an error and not silent. The operator asked to create a clinic and
        // got an existing one selected instead; saying which is the difference
        // between that reading as "it worked" and as "nothing happened".
        <p className="vetpick__note">
          {dedupedName} was already in the catalog, so this household is linked to that record
          instead of a duplicate.
        </p>
      )}
    </div>
  );
}

interface CreateClinicFormProps {
  fieldName: string;
  initialName: string;
  initialEmergency: boolean;
  onCancel: () => void;
  onCreated: (selection: VetClinicSelection, deduped: boolean) => void;
}

/**
 * The inline "this clinic is not in the bank yet" form. Deliberately inline
 * rather than a modal: the operator is mid-edit on a household, and a dialog
 * over a dialog is the kind of stack that loses a half-typed form.
 */
function CreateClinicForm({
  fieldName,
  initialName,
  initialEmergency,
  onCancel,
  onCreated,
}: CreateClinicFormProps) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [website, setWebsite] = useState('');
  const [isEmergency, setIsEmergency] = useState(initialEmergency);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Near-matches the server offered. While this is non-empty NOTHING has been
   * written and the operator has a choice to make: use one of these, or say the
   * clinic really is different (operator ruling 2026-08-01). Silently taking
   * the first match is exactly what this replaces.
   */
  const [candidates, setCandidates] = useState<ClinicCandidate[]>([]);

  const idFor = (part: string) => `vetpick-${fieldName}-new-${part}`;

  async function save(acknowledged: readonly string[] = []) {
    if (saving) return;
    if (name.trim() === '') {
      setNameError("Clinic name can't be blank.");
      return;
    }
    setNameError(null);
    setSaving(true);
    setError(null);
    try {
      const res = await submitVetClinic(
        { name, phone, address, website, isEmergency },
        acknowledged,
      );
      setSaving(false);
      if (res.status === 'needs_choice') {
        // NOT an error, and NOT a silent selection. The bank already holds
        // something that looks like this practice, and which one this household
        // should point at is the operator's call, not the server's.
        setCandidates(res.candidates);
        return;
      }
      setCandidates([]);
      onCreated(
        { clinicId: res.clinicId, name: name.trim(), phone: phone.trim(), address: address.trim() },
        false,
      );
    } catch (err) {
      setSaving(false);
      setError(`submitVetClinic failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    }
  }
  /** Use an offered clinic. Pure client-side: it already has the id. */
  function useCandidate(c: ClinicCandidate) {
    setCandidates([]);
    onCreated({ clinicId: c.id, name: c.name, phone: c.phone, address: c.address }, true);
  }

  return (
    <div className="vetpick__createForm">
      <p className="vetpick__createTitle">Add this clinic to the shared catalog</p>

      <div className="vetpick__createGrid">
        <div className="vetpick__createField">
          <label className="vetpick__label" htmlFor={idFor('name')}>
            Clinic name
          </label>
          <input
            id={idFor('name')}
            className="vetpick__input"
            value={name}
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError !== null}
          />
          {nameError !== null && (
            <span className="vetpick__error" role="alert">
              {nameError}
            </span>
          )}
        </div>

        <div className="vetpick__createField">
          <label className="vetpick__label" htmlFor={idFor('phone')}>
            Clinic phone
          </label>
          <input
            id={idFor('phone')}
            className="vetpick__input"
            value={phone}
            disabled={saving}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>

        <div className="vetpick__createField vetpick__createField--wide">
          <label className="vetpick__label" htmlFor={idFor('address')}>
            Clinic address
          </label>
          <input
            id={idFor('address')}
            className="vetpick__input"
            value={address}
            disabled={saving}
            onChange={(e) => setAddress(e.target.value)}
          />
        </div>

        <div className="vetpick__createField vetpick__createField--wide">
          <label className="vetpick__label" htmlFor={idFor('website')}>
            Website
          </label>
          <input
            id={idFor('website')}
            className="vetpick__input"
            value={website}
            disabled={saving}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        <label className="vetpick__toggle" htmlFor={idFor('emergency')}>
          <input
            id={idFor('emergency')}
            type="checkbox"
            checked={isEmergency}
            disabled={saving}
            onChange={(e) => setIsEmergency(e.target.checked)}
          />
          <span>24 hour / emergency clinic</span>
        </label>
      </div>

      {error !== null && (
        <p className="vetpick__banner" role="alert">
          {error}
        </p>
      )}

      {/* THE CHOICE. The bank already holds something that looks like this
          practice, and nothing has been written. Using an existing clinic is
          listed first; creating a second record is the deliberate fallback. */}
      {candidates.length > 0 && (
        <div className="vetpick__candidates" role="group" aria-label="Possible matches">
          <p className="vetpick__createTitle">
            A clinic like this is already in the bank. Use it, or add yours separately.
          </p>
          {candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              className="vetpick__candidate"
              onClick={() => useCandidate(c)}
            >
              <b>{c.isEmergency ? `${c.name} · 24hr` : c.name}</b>
              <small>
                {[c.address, c.phone].filter((v) => v !== '').join(' · ')}
                {!c.verified && ' · waiting for approval'}
              </small>
            </button>
          ))}
          <button
            type="button"
            className="vetpick__ghost"
            disabled={saving}
            onClick={() => void save(candidates.map((c) => c.id))}
          >
            {saving ? 'Saving…' : `No, add "${name.trim()}" as a different clinic`}
          </button>
        </div>
      )}
      <div className="vetpick__createActions">
        <button type="button" className="vetpick__ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="vetpick__primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save clinic'}
        </button>
      </div>
    </div>
  );
}
