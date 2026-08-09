import { useEffect, useState } from 'react';
import {
  getFormSchema,
  saveFormSchema,
  FIELD_TYPES,
  APPLIES_TO,
  type FieldType,
  type FormField,
  type FormSection,
  type FormSchemaDetail,
} from '../api/formSchemasWrite';
import { Dialog } from '../components/Dialog';
import { WizardModal, type WizardStep } from '../components/WizardModal';
import { SchemaPreview } from '../components/SchemaPreview';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import './FormSchemaEditor.css';

/**
 * Create + edit for formSchemas/{id}. Pairs with FormSchemas.tsx (the
 * read-only list, which already deletes via deleteFormSchema): this is what its
 * onNew / onSelect placeholders open.
 *
 * IT IS A WORKFLOW MODAL, one section per step (`components/WizardModal`), on
 * the operator's instruction of 2026-08-08: the 2026-08-06 layout review found
 * this and the KinTale template editor to be the two tallest screens in the set,
 * both of them long always-expanded single-column forms, and splitting the
 * sections across named steps is the chosen answer. The list stays behind the
 * modal (`routes/FormSchemasView.tsx`) instead of being replaced by the editor,
 * so backing out returns to exactly the row that was clicked.
 *
 * NOTHING IS FOLDED. The per-field helper text / placeholder / default / group
 * used to live behind a `<details>Advanced</details>`; they are drawn in full
 * now. Hiding fields inside a screen was rejected by operator ruling on
 * 2026-08-08 (a PR that answered the same length problem with an "Advanced"
 * disclosure was closed for it), and shipping the wizard with that disclosure
 * still in it would have re-shipped the rejected pattern inside the feature
 * meant to replace it.
 *
 * THE LIVE PREVIEW SURVIVED THE SPLIT AS THE WIZARD'S `aside`, not as a fourth
 * step. `SchemaPreview` earns its place by being visible WHILE the fields it
 * previews are typed, so making it a step the operator has to leave the fields
 * to reach would have taken the feature away while appearing to keep it. It
 * keeps the sticky-column-then-stack behaviour it shipped with; that rule moved
 * into `WizardModal.css` so the next consumer with a persistent panel inherits
 * it rather than restating it.
 *
 * SCOPE NARROWING FROM THE WASM SOURCE, disclosed here rather than silently:
 * FormSchemaEditorScreen.kt authors an arbitrary number of named SECTIONS,
 * each with its own field list. The backend contract (saveFormSchema.ts)
 * requires that structure, `sections: SectionSchema[]`, each section itself
 * requiring a non-empty `fields` array. This screen edits ONE flat field
 * list and wraps it in a single implicit section on save, because every
 * schema actually authored in this app to date is single-section (tribeProfile,
 * vetInfo, etc.) and a flat list is the simpler, faster-to-build surface the
 * task asked for. Loading a schema that genuinely has more than one section
 * merges their fields into one list and shows a visible warning banner
 * (never silently), see `flattenSections` below; saving from that state loses
 * the original section boundaries. If a schema with real multiple sections
 * needs editing, this screen is not yet the right tool for that edit.
 */

const DEFAULT_SECTION_TITLE = 'Fields';

/** Field-key regex, ported verbatim from saveFormSchema.ts's Zod contract. */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** Schema-id regex, ported verbatim from saveFormSchema.ts's Zod contract. */
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

export interface SectionMeta {
  title: string;
  description: string | null;
}

/** True when `schemaId` means "create a fresh schema" rather than "edit id". Mirrors the wasm's isCreateMode. */
export function isCreateMode(schemaId: string | undefined): boolean {
  return !schemaId || schemaId.trim().length === 0;
}

export function emptyField(): FormField {
  return {
    key: '',
    label: '',
    type: 'text',
    required: false,
    helperText: null,
    placeholder: null,
    options: null,
    defaultValue: null,
    group: null,
  };
}

/**
 * Flattens every field across every section into one ordered list.
 *
 * Round-trips losslessly for the common single-section case (keeps that
 * section's own title/description so an immediate load-then-save is a no-op
 * on the wire). A schema with zero or multiple sections falls back to a
 * fixed "Fields" title, since there is no longer one section's identity to
 * preserve; `wasMultiSection` tells the caller to warn rather than pretend
 * nothing changed.
 */
export function flattenSections(sections: FormSection[]): {
  fields: FormField[];
  meta: SectionMeta;
  wasMultiSection: boolean;
} {
  if (sections.length === 0) {
    return { fields: [], meta: { title: DEFAULT_SECTION_TITLE, description: null }, wasMultiSection: false };
  }
  if (sections.length === 1) {
    const only = sections[0]!;
    return {
      fields: only.fields,
      meta: { title: only.title || DEFAULT_SECTION_TITLE, description: only.description },
      wasMultiSection: false,
    };
  }
  return {
    fields: sections.flatMap((s) => s.fields),
    meta: { title: DEFAULT_SECTION_TITLE, description: null },
    wasMultiSection: true,
  };
}

/** The inverse of flattenSections: wraps a flat field list back into the one-section shape the backend requires. */
export function buildSections(meta: SectionMeta, fields: FormField[]): FormSection[] {
  return [{ title: meta.title, description: meta.description, fields }];
}

export interface FieldValidation {
  keyError: string | null;
  labelError: string | null;
  optionsError: string | null;
}

/** Per-field validation, ported from saveFormSchema.ts's FieldSchema + its superRefine. */
export function validateField(field: FormField, seenKeys: ReadonlySet<string>): FieldValidation {
  let keyError: string | null = null;
  const trimmedKey = field.key.trim();
  if (!trimmedKey) {
    keyError = 'Key is required.';
  } else if (!KEY_RE.test(trimmedKey)) {
    keyError = 'Key must start with a letter and contain only letters, numbers, or underscore.';
  } else if (seenKeys.has(trimmedKey)) {
    keyError = `Duplicate key "${trimmedKey}".`;
  }

  const labelError = field.label.trim() ? null : 'Label is required.';

  const needsOptions = field.type === 'select' || field.type === 'multiselect';
  const optionsError =
    needsOptions && (!field.options || field.options.length === 0)
      ? 'At least one option is required for this field type.'
      : null;

  return { keyError, labelError, optionsError };
}

/**
 * The schema's own identity problems: id and name.
 *
 * Split from the field-list half so the wizard can report each problem ON THE
 * STEP THAT OWNS THE FIELD, and so the rail can flag that step. A single flat
 * error list at the bottom of the form is what the pre-wizard screen had, and it
 * meant an operator scrolled past the broken field to find out it was broken.
 */
export function schemaMetaErrors(input: { id: string; name: string }): string[] {
  const errors: string[] = [];
  const trimmedId = input.id.trim();
  if (!trimmedId) {
    errors.push('Schema id is required.');
  } else if (!ID_RE.test(trimmedId)) {
    errors.push('Schema id must start with a letter and contain only letters, numbers, underscore, period, or hyphen.');
  }
  if (!input.name.trim()) errors.push('Schema name is required.');
  return errors;
}

/** The field list's problems: the at-least-one rule, then every field's own, numbered. */
export function fieldListErrors(fields: readonly FormField[]): string[] {
  const errors: string[] = [];
  if (fields.length === 0) errors.push('At least one field is required.');

  const seen = new Set<string>();
  fields.forEach((field, i) => {
    const v = validateField(field, seen);
    if (v.keyError) errors.push(`Field ${i + 1}: ${v.keyError}`);
    if (v.labelError) errors.push(`Field ${i + 1}: ${v.labelError}`);
    if (v.optionsError) errors.push(`Field ${i + 1}: ${v.optionsError}`);
    const trimmedKey = field.key.trim();
    if (trimmedKey) seen.add(trimmedKey);
  });
  return errors;
}

/** Whole-schema validation: id/name/field-list invariants, ported from saveFormSchema.ts's SchemaInputSchema + SectionSchema. */
export function validateSchema(input: { id: string; name: string; fields: FormField[] }): string[] {
  return [...schemaMetaErrors(input), ...fieldListErrors(input.fields)];
}

/** Reorders one step earlier. No-op at the top (idx 0) or out of range. */
export function moveUp<T>(arr: readonly T[], idx: number): T[] {
  if (idx <= 0 || idx >= arr.length) return [...arr];
  const copy = [...arr];
  const above = copy[idx - 1]!;
  const at = copy[idx]!;
  copy[idx - 1] = at;
  copy[idx] = above;
  return copy;
}

/** Reorders one step later. No-op at the bottom or out of range. */
export function moveDown<T>(arr: readonly T[], idx: number): T[] {
  return moveUp(arr, idx + 1);
}

/**
 * AO-49: derive a field key from a label so the operator doesn't hand-type it.
 * camelCase to match this app's own field-key convention (the examples are
 * `firstName`, `tribeProfile`, not snake_case), and satisfying KEY_RE: a
 * leading letter, then letters/digits/underscore. Returns '' when the label
 * has no usable letters/digits (the caller then leaves the key untouched).
 *
 * "First name" -> "firstName", "Pet's Age (yrs)" -> "petsAgeYrs",
 * "2nd contact" -> "ndContact" (leading digits dropped so KEY_RE passes).
 */
export function deriveFieldKey(label: string): string {
  // Drop apostrophes first so "Pet's" stays one word ("pets"), not "pet" + "s".
  const words = label.replace(/['’]/g, '').split(/[^a-zA-Z0-9]+/).filter((w) => w.length > 0);
  if (words.length === 0) return '';
  const camel = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  // KEY_RE requires a leading letter; strip any leading digits rather than emit an invalid key.
  return camel.replace(/^[0-9]+/, '');
}

function csvToOptions(csv: string): string[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface FormSchemaEditorProps {
  /** Blank / omitted => create mode. A real id => edit mode, fetched via getFormSchema. */
  schemaId?: string;
  /** Called with the saved id once saveFormSchema succeeds. The caller (router) navigates back to the list. */
  onSaved: (id: string) => void;
  /** Called when the operator backs out without saving. */
  onCancel: () => void;
}

export function FormSchemaEditor({ schemaId, onSaved, onCancel }: FormSchemaEditorProps) {
  const creating = isCreateMode(schemaId);

  const [loading, setLoading] = useState(!creating);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [multiSectionWarning, setMultiSectionWarning] = useState(false);

  const [id, setId] = useState(creating ? '' : (schemaId ?? '').trim());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [appliesTo, setAppliesTo] = useState('NONE');
  const [version, setVersion] = useState(0);
  const [sectionMeta, setSectionMeta] = useState<SectionMeta>({ title: DEFAULT_SECTION_TITLE, description: null });
  const [fields, setFields] = useState<FormField[]>([]);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (creating) return;
    const targetId = (schemaId ?? '').trim();
    let live = true;
    setLoading(true);
    setLoadError(null);
    getFormSchema(targetId)
      .then((schema) => {
        if (!live) return;
        const { fields: flat, meta, wasMultiSection } = flattenSections(schema.sections);
        setId(schema.id);
        setName(schema.name);
        setDescription(schema.description ?? '');
        setAppliesTo(schema.appliesTo);
        setVersion(schema.version);
        setSectionMeta(meta);
        setFields(flat);
        setMultiSectionWarning(wasMultiSection);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setLoadError(`getFormSchema failed: ${err instanceof Error ? err.message : 'Load failed'}`);
        setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [creating, schemaId]);

  const [step, setStep] = useState('schema');
  /**
   * Whether closing would throw work away. Set by every edit rather than derived
   * by diffing against the loaded schema: a diff would call a typed-then-deleted
   * character "clean", and the point of the guard is to be pessimistic about the
   * operator's work, not clever about it.
   */
  const [dirty, setDirty] = useState(false);
  /**
   * The steps the operator has edited. A step's problems are quoted back to them
   * once they have worked on that step (or asked to save, which `WizardModal`
   * handles): a schema they have only just opened has not been got wrong yet,
   * and greeting a blank form with "Schema id is required." is the defect the
   * 2026-08-09 screenshot review caught.
   *
   * A step, not a field, is the unit here because a step is the unit this wizard
   * already reports in: the rail flags steps, and the errors are sentences owned
   * by a step rather than values hung off one input. So typing in Name reveals
   * the schema step's problems including the id, which reads as "here is what is
   * left on the step you are filling in" rather than an accusation.
   */
  const [touchedSteps, setTouchedSteps] = useState<ReadonlySet<string>>(() => new Set<string>());

  /**
   * One edit: it dirties the record and marks the step being edited. Only the
   * ACTIVE step's body is mounted (`WizardModal` renders one step, never all of
   * them behind CSS), so the step under `step` is always the one the operator
   * just typed into.
   */
  function touch() {
    setDirty(true);
    setTouchedSteps((prev) => (prev.has(step) ? prev : new Set(prev).add(step)));
  }

  const metaErrors = schemaMetaErrors({ id, name });
  const fieldErrors = fieldListErrors(fields);
  const canSave = metaErrors.length === 0 && fieldErrors.length === 0 && !saving && !loading;
  /**
   * Only a schema being CREATED starts quiet. A loaded one that is already
   * invalid was broken before this modal opened, so its errors describe the
   * record rather than the operator, and hiding them would hide the reason the
   * save is about to be refused.
   */
  const untouched = (key: string) => creating && !touchedSteps.has(key);

  function updateField(idx: number, transform: (f: FormField) => FormField) {
    touch();
    setFields((prev) => prev.map((f, i) => (i === idx ? transform(f) : f)));
  }

  function addField() {
    touch();
    setFields((prev) => [...prev, emptyField()]);
  }
  function removeField(idx: number) {
    touch();
    setFields((prev) => prev.filter((_, i) => i !== idx));
  }
  function reorderFields(next: (prev: FormField[]) => FormField[]) {
    touch();
    setFields(next);
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    const schema: FormSchemaDetail = {
      id: id.trim(),
      name,
      description: description.trim() ? description : null,
      appliesTo,
      version,
      sections: buildSections(sectionMeta, fields),
    };
    try {
      const res = await saveFormSchema(schema);
      setSaving(false);
      setVersion(res.version);
      // Cleared BEFORE handing back: the caller closes the modal, and a stale
      // dirty flag would ask the operator to confirm discarding work that has
      // just been written.
      setDirty(false);
      onSaved(res.id);
    } catch (err) {
      setSaving(false);
      setSaveError(`saveFormSchema failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    }
  }

  const modalTitle = creating ? 'New Form Schema' : 'Edit Form Schema';

  // There is no form to walk through until the record has arrived, so the load
  // and the load failure are the plain shared modal rather than a one-step
  // wizard whose rail describes steps nothing can reach.
  if (loading || loadError) {
    return (
      <Dialog
        title={modalTitle}
        onClose={onCancel}
        footer={<GhostButton label="Close" onClick={onCancel} />}
      >
        {loadError ? (
          <Banner tone="error" title="Couldn&rsquo;t load schema">
            {loadError}
          </Banner>
        ) : (
          <p className="fse__hint" role="status" aria-live="polite">
            Loading schema…
          </p>
        )}
      </Dialog>
    );
  }

  const seenKeys = new Set<string>();

  const steps: WizardStep[] = [
    {
      key: 'schema',
      label: 'Schema',
      heading: 'Schema',
      blurb: 'What this schema is called, and where it applies.',
      errors: metaErrors,
      pristine: untouched('schema'),
      body: (
        <div className="fse__grid">
          <div className="fse__field">
            <label className="fse__field-label">
              <span className="fse__label">Schema id</span>
              <input
                type="text"
                className="fse__input"
                value={id}
                disabled={!creating}
                onChange={(e) => {
                  touch();
                  setId(e.target.value);
                }}
                placeholder="e.g. tribeProfile"
              />
            </label>
            {/* Outside the <label> on purpose: any text inside a <label> joins the
                control's accessible name, so this note would otherwise get read
                (and matched by getByLabelText) as part of "Schema id". */}
            {!creating && <span className="fse__note">Id is fixed once a schema is created.</span>}
          </div>

          <label className="fse__field">
            <span className="fse__label">Name</span>
            <input
              type="text"
              className="fse__input"
              value={name}
              onChange={(e) => {
                touch();
                setName(e.target.value);
              }}
              placeholder="e.g. Tribe Profile"
            />
          </label>

          <label className="fse__field fse__field--wide">
            <span className="fse__label">Description</span>
            <input
              type="text"
              className="fse__input"
              value={description}
              onChange={(e) => {
                touch();
                setDescription(e.target.value);
              }}
              placeholder="Optional"
            />
          </label>

          <label className="fse__field">
            <span className="fse__label">Applies to</span>
            <select
              className="fse__input"
              value={appliesTo}
              onChange={(e) => {
                touch();
                setAppliesTo(e.target.value);
              }}
            >
              {(APPLIES_TO as readonly string[]).includes(appliesTo)
                ? null
                : (
                  // Preserves a stray stored value rather than silently
                  // discarding it the moment this select renders.
                  <option value={appliesTo}>{appliesTo} (unrecognised)</option>
                )}
              {APPLIES_TO.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      ),
    },
    {
      key: 'fields',
      label: 'Fields',
      heading: 'Fields',
      blurb: 'One card per input. Order here is the order kinfolk see them.',
      errors: fieldErrors,
      pristine: untouched('fields'),
      body: (
        <>
          <div className="fse__step-actions">
            <PrimaryButton label="Add field" onClick={addField} />
          </div>

          {fields.length === 0 ? (
            <p className="fse__hint">No fields yet. Click Add field to create one.</p>
          ) : (
            <ul className="fse__fields">
              {fields.map((field, idx) => {
                const v = validateField(field, seenKeys);
                if (field.key.trim()) seenKeys.add(field.key.trim());
                const needsOptions = field.type === 'select' || field.type === 'multiselect';
                return (
                  <li key={idx} className="fse__field-card">
                    <div className="fse__field-row">
                      {/* Error text sits OUTSIDE each <label> on purpose: a <label>'s
                          accessible name is computed from all of its text content, so an
                          error message nested inside it would silently fold into the
                          control's name (e.g. "KeyKey is required."). */}
                      <div className="fse__field">
                        <label className="fse__field-label">
                          <span className="fse__label">Key</span>
                          <input
                            type="text"
                            className="fse__input"
                            value={field.key}
                            onChange={(e) => updateField(idx, (f) => ({ ...f, key: e.target.value }))}
                            placeholder="e.g. firstName"
                            aria-invalid={v.keyError ? true : undefined}
                          />
                        </label>
                        {v.keyError && <span className="fse__error">{v.keyError}</span>}
                      </div>

                      <div className="fse__field">
                        <label className="fse__field-label">
                          <span className="fse__label">Label</span>
                          <input
                            type="text"
                            className="fse__input"
                            value={field.label}
                            onChange={(e) => updateField(idx, (f) => ({ ...f, label: e.target.value }))}
                            onBlur={() =>
                              // AO-49: auto-fill the key from the label ONLY when the
                              // operator hasn't typed one, never clobbering a hand-set key.
                              updateField(idx, (f) =>
                                f.key.trim() === '' && deriveFieldKey(f.label) !== ''
                                  ? { ...f, key: deriveFieldKey(f.label) }
                                  : f,
                              )
                            }
                            placeholder="e.g. First name"
                            aria-invalid={v.labelError ? true : undefined}
                          />
                        </label>
                        {v.labelError && <span className="fse__error">{v.labelError}</span>}
                      </div>

                      <label className="fse__field">
                        <span className="fse__label">Type</span>
                        <select
                          className="fse__input"
                          value={field.type}
                          onChange={(e) =>
                            updateField(idx, (f) => {
                              const type = e.target.value as FieldType;
                              const needsOpts = type === 'select' || type === 'multiselect';
                              return { ...f, type, options: needsOpts ? (f.options ?? []) : null };
                            })
                          }
                        >
                          {FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="fse__field fse__field--checkbox">
                        <input
                          type="checkbox"
                          checked={field.required}
                          onChange={(e) => updateField(idx, (f) => ({ ...f, required: e.target.checked }))}
                        />
                        <span className="fse__label">Required</span>
                      </label>

                      <div className="fse__field-actions">
                        <IconButton
                          icon={<UpGlyph />}
                          label={`Move ${field.label || field.key || 'field'} up`}
                          onClick={() => reorderFields((prev) => moveUp(prev, idx))}
                          disabled={idx === 0}
                          size={32}
                        />
                        <IconButton
                          icon={<DownGlyph />}
                          label={`Move ${field.label || field.key || 'field'} down`}
                          onClick={() => reorderFields((prev) => moveDown(prev, idx))}
                          disabled={idx === fields.length - 1}
                          size={32}
                        />
                        <IconButton
                          icon={<TrashGlyph />}
                          label={`Remove ${field.label || field.key || 'field'}`}
                          onClick={() => removeField(idx)}
                          destructive
                          size={32}
                        />
                      </div>
                    </div>

                    {needsOptions && (
                      <div className="fse__field fse__field--wide">
                        <label className="fse__field-label">
                          <span className="fse__label">Options (comma separated)</span>
                          <input
                            type="text"
                            className="fse__input"
                            value={(field.options ?? []).join(', ')}
                            onChange={(e) =>
                              updateField(idx, (f) => ({ ...f, options: csvToOptions(e.target.value) }))
                            }
                            placeholder="e.g. Dog, Cat, Other"
                            aria-invalid={v.optionsError ? true : undefined}
                          />
                        </label>
                        {v.optionsError && <span className="fse__error">{v.optionsError}</span>}
                      </div>
                    )}

                    {/* Drawn, not folded. These four used to sit behind a
                        `<details>Advanced</details>`; see the file header for
                        the ruling that took it out. */}
                    <div className="fse__grid">
                      <label className="fse__field">
                        <span className="fse__label">Helper text</span>
                        <input
                          type="text"
                          className="fse__input"
                          value={field.helperText ?? ''}
                          onChange={(e) =>
                            updateField(idx, (f) => ({ ...f, helperText: e.target.value || null }))
                          }
                        />
                      </label>
                      <label className="fse__field">
                        <span className="fse__label">Placeholder</span>
                        <input
                          type="text"
                          className="fse__input"
                          value={field.placeholder ?? ''}
                          onChange={(e) =>
                            updateField(idx, (f) => ({ ...f, placeholder: e.target.value || null }))
                          }
                        />
                      </label>
                      <label className="fse__field">
                        <span className="fse__label">Default value</span>
                        <input
                          type="text"
                          className="fse__input"
                          value={field.defaultValue ?? ''}
                          onChange={(e) =>
                            updateField(idx, (f) => ({ ...f, defaultValue: e.target.value || null }))
                          }
                        />
                      </label>
                      <label className="fse__field">
                        <span className="fse__label">Group</span>
                        <input
                          type="text"
                          className="fse__input"
                          value={field.group ?? ''}
                          onChange={(e) => updateField(idx, (f) => ({ ...f, group: e.target.value || null }))}
                        />
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ),
    },
    {
      key: 'review',
      label: 'Review',
      heading: 'Review',
      blurb: 'What will be written when you save.',
      errors: [],
      body: (
        <div className="fse__review">
          <dl className="fse__review-meta">
            {/* "Not set" rather than a dash: the settings overview already says
                that for a value nobody has filled in, and a dash reads as a
                value on a summary whose whole job is to be read quickly. */}
            <div>
              <dt>Schema id</dt>
              <dd>{id.trim() || 'Not set'}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{name.trim() || 'Not set'}</dd>
            </div>
            <div>
              <dt>Description</dt>
              <dd>{description.trim() || 'Not set'}</dd>
            </div>
            <div>
              <dt>Applies to</dt>
              <dd>{appliesTo}</dd>
            </div>
          </dl>

          <h4 className="fse__review-heading">
            {fields.length === 1 ? '1 field' : `${fields.length} fields`}
          </h4>
          {fields.length === 0 ? (
            <p className="fse__hint">No fields yet. Add at least one on the Fields step.</p>
          ) : (
            /* Named, because the live preview beside this step renders the same
               labels as real form controls: without a name on the list there is
               no way for a reader (or a test) to say which "First name" is the
               summary row and which is the previewed input. */
            <ol className="fse__review-fields" aria-label="Fields in this schema">
              {fields.map((f, i) => (
                <li key={i}>
                  <span className="fse__review-field-label">{f.label.trim() || 'Unnamed field'}</span>
                  <span className="fse__review-field-meta">
                    {f.key.trim() || 'no key'} · {f.type}
                    {f.required ? ' · required' : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ),
    },
  ];

  return (
    <WizardModal
      title={modalTitle}
      steps={steps}
      currentStepKey={step}
      onStepChange={setStep}
      onClose={onCancel}
      dirty={dirty}
      onFinish={() => void handleSave()}
      finishLabel={saving ? 'Saving…' : 'Save schema'}
      finishBusy={saving}
      notice={
        <>
          {multiSectionWarning && (
            <Banner tone="warning" title="Sections merged">
              This schema had more than one section. They have been merged into one field list; saving will
              replace the original sections with a single one.
            </Banner>
          )}
          {saveError && (
            <Banner tone="error" title="Save failed" onDismiss={() => setSaveError(null)}>
              {saveError}
            </Banner>
          )}
        </>
      }
      aside={
        /* Reads the SAME sectionMeta / fields state the steps write, so it
           cannot drift from what Save would persist; there is no second copy of
           the schema to keep in step. */
        <SchemaPreview
          sectionTitle={sectionMeta.title}
          sectionDescription={sectionMeta.description}
          fields={fields}
        />
      }
    />
  );
}


function UpGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

function DownGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}
