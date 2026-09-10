import { useCallback, useId, useMemo, useState } from 'react';
import { Dialog } from './Dialog';
import { Banner } from './Banner';
import { GhostButton, PrimaryButton } from './Buttons';
import {
  EDITABLE_HOUSEHOLD_SECTIONS,
  sectionErrors,
  validateHouseholdData,
  type HouseholdFieldSpec,
  type HouseholdFields,
  type HouseholdSectionSpec,
} from '../lib/householdDataSchema';
import { saveHouseholdSection, type HouseholdRecord } from '../api/householdData';
import './HouseholdSectionDialog.css';

interface Props {
  section: HouseholdSectionSpec;
  /** Named in the dialog title so a modal opened from a list is never ambiguous. */
  kinfolkName: string;
  /** The record as last read or last saved. Seeds every input, so the form never opens blank. */
  record: HouseholdRecord;
  onClose: () => void;
  /** Called with the saved record ONLY once the write has actually landed. */
  onSaved: (next: HouseholdRecord) => void;
}

/**
 * The edit surface for ONE section of a household's record.
 *
 * One section at a time, rather than the android screen's single 30-field form
 * with one "Save Household Data" button at the bottom. Two reasons, both about
 * what the save means: a section-sized save writes only the fields in front of
 * the operator (see `saveHouseholdSection`, which patches rather than
 * overwrites), and a 30-field form on the web is a scroll where the error you
 * need to fix is off screen from the button that told you about it.
 *
 * Fail-loud on save, the shared Dialog-editor convention: the fieldset locks
 * while the write is in flight, the dialog cannot be dismissed mid-save, and a
 * rejection leaves every edit exactly where the operator left it under a
 * persistent Banner. The success TOAST is not raised here, the caller raises it,
 * so the confirmation outlives this component's unmount.
 *
 * TEXT SECTIONS ONLY, and the refusal below is enforced here rather than trusted
 * to the caller. `EDITABLE_HOUSEHOLD_SECTIONS` is the list of sections whose
 * values are prose an operator types; the veterinary section is not on it,
 * because its two real values are `vet_clinics` document ids picked by search.
 * Rendering those as text boxes is how a household ends up pointed at an
 * arbitrary clinic, and saving from here also patched the seven retired
 * free-text vet keys straight back onto the record. See `VetSectionDialog`.
 */
export function HouseholdSectionDialog({ section, kinfolkName, record, onClose, onSaved }: Props) {
  // Seeded from the WHOLE record, not just this section, so validation runs over
  // a complete object and the patch below can still be narrowed to the section.
  const [values, setValues] = useState<HouseholdFields>(() => ({ ...record }));
  const [saving, setSaving] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const errors = useMemo(() => sectionErrors(validateHouseholdData(values), section), [values, section]);
  const blocked = Object.keys(errors).length > 0;

  // Memoized: Dialog's focus effect keys off this identity, and a fresh arrow on
  // every keystroke re-focused the panel and stole the caret out of the input
  // after its first character.
  const closeUnlessSaving = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  // After every hook, so the refusal cannot make them conditional. No fieldset
  // and no Save button in this branch: a guard that only blocked the write would
  // still have put a raw document id in an editable box on the way there.
  if (!EDITABLE_HOUSEHOLD_SECTIONS.some((s) => s.id === section.id)) {
    return (
      <Dialog
        title={`${section.title} · ${kinfolkName}`}
        onClose={onClose}
        footer={<GhostButton label="Close" onClick={onClose} />}
      >
        <Banner tone="error" title="This section has no text form">
          <p>
            {section.title} is chosen from the shared vet bank by search, so there is nothing here
            to type. Nothing was changed. Close this and use Edit veterinary, which searches the
            bank.
          </p>
        </Banner>
      </Dialog>
    );
  }

  function set(key: keyof HouseholdFields, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSave() {
    setAttempted(true);
    if (blocked || saving) return;

    setSaving(true);
    setSaveError(null);
    try {
      // Only this section's keys travel. A field the operator never opened is
      // not in the patch, so it cannot be rewritten with a stale value.
      const patch: Partial<HouseholdFields> = {};
      for (const field of section.fields) patch[field.key] = values[field.key].trim();

      const next = await saveHouseholdSection(record, patch);
      setSaving(false);
      onSaved(next);
    } catch (err) {
      setSaving(false);
      setSaveError(err instanceof Error ? err.message : 'The save did not go through.');
    }
  }

  return (
    <Dialog
      title={`${section.title} · ${kinfolkName}`}
      onClose={closeUnlessSaving}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Saving…' : 'Save section'}
            onClick={() => void handleSave()}
            disabled={saving}
            busy={saving}
          />
        </>
      }
    >
      <p className="hsection__blurb">{section.blurb}</p>

      <fieldset className="hsection__fields" disabled={saving}>
        <legend className="hsection__legend">{section.title}</legend>
        {section.fields.map((field) => (
          <SectionField
            key={field.key}
            field={field}
            value={values[field.key]}
            error={attempted ? (errors[field.key] ?? null) : null}
            onChange={(next) => set(field.key, next)}
          />
        ))}
      </fieldset>

      {saveError !== null && (
        <Banner tone="error" title="That section did not save">
          {/* Persistent, not a toast: an operator who walked away still finds out. */}
          <p>
            Firestore rejected the write to household_data: {saveError}. Your edits are still here,
            nothing was lost.
          </p>
        </Banner>
      )}
    </Dialog>
  );
}

interface SectionFieldProps {
  field: HouseholdFieldSpec;
  value: string;
  error: string | null;
  onChange: (next: string) => void;
}

/** One labelled input, with its inline message wired through aria-describedby. */
function SectionField({ field, value, error, onChange }: SectionFieldProps) {
  const inputId = useId();
  const errorId = useId();
  // A secret is typed hidden by default and revealed deliberately, the same
  // resting state MaskedValue gives it in the read view. Local per-field state,
  // so revealing the alarm code does not also reveal everything else on screen.
  const [revealed, setRevealed] = useState(false);

  const describedBy = error !== null ? errorId : undefined;
  const invalid = error !== null;

  return (
    <div className={field.kind === 'multiline' ? 'hsection__field hsection__field--wide' : 'hsection__field'}>
      <label className="hsection__label" htmlFor={inputId}>
        {field.label}
      </label>

      {field.kind === 'multiline' ? (
        <textarea
          id={inputId}
          className="hsection__input hsection__input--area"
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid}
          aria-describedby={describedBy}
        />
      ) : (
        <span className="hsection__control">
          <input
            id={inputId}
            className="hsection__input"
            type={field.secret === true && !revealed ? 'password' : field.kind === 'phone' ? 'tel' : 'text'}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={describedBy}
          />
          {field.secret === true && (
            <button
              type="button"
              className="hsection__reveal"
              aria-label={`${revealed ? 'Hide' : 'Show'} ${field.label.toLowerCase()}`}
              aria-expanded={revealed}
              aria-controls={inputId}
              onClick={() => setRevealed((r) => !r)}
            >
              {revealed ? 'Hide' : 'Show'}
            </button>
          )}
        </span>
      )}

      {error !== null && (
        <span id={errorId} className="hsection__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
