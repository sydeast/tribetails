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
 * IT IS A WORKFLOW MODAL (`components/WizardModal`), on the operator's
 * instruction of 2026-08-08: the 2026-08-06 layout review found this and the
 * KinTale template editor to be the two tallest screens in the set, both of
 * them long always-expanded single-column forms, and splitting the form
 * across named steps is the chosen answer. The list stays behind the modal
 * (`routes/FormSchemasView.tsx`) instead of being replaced by the editor, so
 * backing out returns to exactly the row that was clicked.
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
 * SECTIONS ARE REAL, not flattened (issue #397, M17). This screen used to edit
 * one flat field list and wrap it in a single implicit section on save: a
 * schema with more than one section had its fields merged into one list on
 * load, with a visible warning banner, and saving from that state replaced the
 * original section boundaries with a single one. That defect is fixed here.
 * The wizard's second step is now "Sections": every section the schema
 * actually has is drawn as its own card, in order, each with its own title,
 * description, and field list, exactly the shape `saveFormSchema.ts`'s
 * `sections: SectionSchema[]` contract requires and `getFormSchema.ts` hands
 * back. A schema round-trips losslessly: load, edit, save, reload, section
 * boundaries intact.
 *
 * MATCHES ANDROID, not a new model: `FormSchemaEditorViewModel.kt` holds
 * `sections: List<FormSchemaSection>` directly (no flatten step at all), a
 * blank new schema seeds ONE section with a blank title
 * (`FormSchemaEditorViewModel.load(null)`), and duplicate field keys are
 * checked WITHIN a section, never across sections, exactly like the backend's
 * `SectionSchema.superRefine`. This screen mirrors all three: no flatten, one
 * blank-titled section to start, and per-section key uniqueness. A schema
 * whose two sections happen to reuse the same field key is not an error here,
 * because the reference implementations do not treat it as one.
 */

/** Field-key regex, ported verbatim from saveFormSchema.ts's Zod contract. */
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** Schema-id regex, ported verbatim from saveFormSchema.ts's Zod contract. */
const ID_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

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
 * A brand-new section: blank title, no description, no fields yet.
 *
 * The blank title (not a "Fields" placeholder) is deliberate parity with
 * Android's `FormSchemaEditorViewModel.load(null)`, which seeds
 * `FormSchemaSection(title = "")`: the operator names the section, the same
 * way the mock's "Section title *" marks it required rather than optional.
 */
export function emptySection(): FormSection {
  return { title: '', description: null, fields: [] };
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
 * Split from the section-list half so the wizard can report each problem ON
 * THE STEP THAT OWNS THE FIELD, and so the rail can flag that step. A single
 * flat error list at the bottom of the form is what the pre-wizard screen had,
 * and it meant an operator scrolled past the broken field to find out it was
 * broken.
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

/**
 * One section's own problems: its title, then its own field list, numbered
 * within the section. Duplicate keys are checked WITHIN this section only,
 * mirroring `SectionSchema.superRefine` on the server (and Android's
 * `FormSchemaValidator.validateField`, which resets `seenKeysInSection` per
 * section) rather than across the whole schema.
 */
export function sectionErrors(section: FormSection, sectionNumber: number): string[] {
  const errors: string[] = [];
  if (!section.title.trim()) errors.push(`Section ${sectionNumber}: Section title is required.`);
  if (section.fields.length === 0) errors.push(`Section ${sectionNumber}: At least one field is required.`);

  const seen = new Set<string>();
  section.fields.forEach((field, i) => {
    const v = validateField(field, seen);
    if (v.keyError) errors.push(`Section ${sectionNumber}, Field ${i + 1}: ${v.keyError}`);
    if (v.labelError) errors.push(`Section ${sectionNumber}, Field ${i + 1}: ${v.labelError}`);
    if (v.optionsError) errors.push(`Section ${sectionNumber}, Field ${i + 1}: ${v.optionsError}`);
    const trimmedKey = field.key.trim();
    if (trimmedKey) seen.add(trimmedKey);
  });
  return errors;
}

/** The section list's problems: the at-least-one-section rule, then every section's own, numbered. */
export function sectionListErrors(sections: readonly FormSection[]): string[] {
  const errors: string[] = [];
  if (sections.length === 0) errors.push('At least one section is required.');
  sections.forEach((section, i) => errors.push(...sectionErrors(section, i + 1)));
  return errors;
}

/** Whole-schema validation: id/name/section invariants, ported from saveFormSchema.ts's SchemaInputSchema + SectionSchema. */
export function validateSchema(input: { id: string; name: string; sections: FormSection[] }): string[] {
  return [...schemaMetaErrors(input), ...sectionListErrors(input.sections)];
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

  const [id, setId] = useState(creating ? '' : (schemaId ?? '').trim());
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [appliesTo, setAppliesTo] = useState('NONE');
  const [version, setVersion] = useState(0);
  // Parity with Android's `load(null)`: a brand-new schema starts with ONE
  // section, blank title, no fields, never zero sections. An existing schema
  // loads whatever it actually has, verbatim, never merged or truncated.
  const [sections, setSections] = useState<FormSection[]>(() => (creating ? [emptySection()] : []));

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
        setId(schema.id);
        setName(schema.name);
        setDescription(schema.description ?? '');
        setAppliesTo(schema.appliesTo);
        setVersion(schema.version);
        setSections(schema.sections);
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
  const sectionErrorsAll = sectionListErrors(sections);
  const canSave = metaErrors.length === 0 && sectionErrorsAll.length === 0 && !saving && !loading;
  /**
   * Only a schema being CREATED starts quiet. A loaded one that is already
   * invalid was broken before this modal opened, so its errors describe the
   * record rather than the operator, and hiding them would hide the reason the
   * save is about to be refused.
   */
  const untouched = (key: string) => creating && !touchedSteps.has(key);

  function updateSection(idx: number, transform: (s: FormSection) => FormSection) {
    touch();
    setSections((prev) => prev.map((s, i) => (i === idx ? transform(s) : s)));
  }
  function addSection() {
    touch();
    setSections((prev) => [...prev, emptySection()]);
  }
  function removeSection(idx: number) {
    touch();
    setSections((prev) => prev.filter((_, i) => i !== idx));
  }
  function reorderSections(next: (prev: FormSection[]) => FormSection[]) {
    touch();
    setSections(next);
  }

  function updateField(sectionIdx: number, fieldIdx: number, transform: (f: FormField) => FormField) {
    touch();
    setSections((prev) =>
      prev.map((s, i) =>
        i === sectionIdx ? { ...s, fields: s.fields.map((f, j) => (j === fieldIdx ? transform(f) : f)) } : s,
      ),
    );
  }
  function addField(sectionIdx: number) {
    touch();
    setSections((prev) => prev.map((s, i) => (i === sectionIdx ? { ...s, fields: [...s.fields, emptyField()] } : s)));
  }
  function removeField(sectionIdx: number, fieldIdx: number) {
    touch();
    setSections((prev) =>
      prev.map((s, i) => (i === sectionIdx ? { ...s, fields: s.fields.filter((_, j) => j !== fieldIdx) } : s)),
    );
  }
  function reorderFields(sectionIdx: number, next: (prev: FormField[]) => FormField[]) {
    touch();
    setSections((prev) => prev.map((s, i) => (i === sectionIdx ? { ...s, fields: next(s.fields) } : s)));
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
      sections,
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

  const totalFields = sections.reduce((sum, s) => sum + s.fields.length, 0);

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
      key: 'sections',
      label: 'Sections',
      heading: 'Sections',
      blurb: 'Each section groups the fields a kinfolk fills in. Need at least one section, each with at least one field.',
      errors: sectionErrorsAll,
      pristine: untouched('sections'),
      body: (
        <>
          {sections.length === 0 ? (
            <p className="fse__hint">No sections yet. Use Add section to create one.</p>
          ) : (
            <ul className="fse__sections">
              {sections.map((section, sIdx) => (
                <SectionCard
                  key={sIdx}
                  index={sIdx}
                  isFirst={sIdx === 0}
                  isLast={sIdx === sections.length - 1}
                  section={section}
                  // The inline title error is gated on the step being touched (or
                  // loaded, never a blank create-mode form): the seeded blank
                  // section exists before any keystroke, and an unconditional
                  // "Section title is required." on an untouched form is exactly
                  // the pre-emptive telling-off the 2026-08-09 screenshot review
                  // caught (see the `pristine` doc on WizardStep).
                  showTitleError={!untouched('sections')}
                  onTitleChange={(v) => updateSection(sIdx, (s) => ({ ...s, title: v }))}
                  onDescriptionChange={(v) => updateSection(sIdx, (s) => ({ ...s, description: v || null }))}
                  onRemove={() => removeSection(sIdx)}
                  onMoveUp={() => reorderSections((prev) => moveUp(prev, sIdx))}
                  onMoveDown={() => reorderSections((prev) => moveDown(prev, sIdx))}
                  onAddField={() => addField(sIdx)}
                  onUpdateField={(fIdx, transform) => updateField(sIdx, fIdx, transform)}
                  onRemoveField={(fIdx) => removeField(sIdx, fIdx)}
                  onMoveFieldUp={(fIdx) => reorderFields(sIdx, (prev) => moveUp(prev, fIdx))}
                  onMoveFieldDown={(fIdx) => reorderFields(sIdx, (prev) => moveDown(prev, fIdx))}
                />
              ))}
            </ul>
          )}

          <div className="fse__step-actions">
            <GhostButton label="Add section" onClick={addSection} />
          </div>
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
            {totalFields === 1 ? '1 field' : `${totalFields} fields`}
            {sections.length > 1 ? ` across ${sections.length} sections` : null}
          </h4>

          {sections.length === 0 ? (
            <p className="fse__hint">No sections yet. Add at least one on the Sections step.</p>
          ) : (
            sections.map((section, sIdx) => {
              const sectionName = section.title.trim() || `Section ${sIdx + 1}`;
              return (
                <div key={sIdx} className="fse__review-section">
                  <h5 className="fse__review-section-heading">{sectionName}</h5>
                  {section.fields.length === 0 ? (
                    <p className="fse__hint">No fields yet. Add at least one on the Sections step.</p>
                  ) : (
                    /* Named, because the live preview beside this step renders the same
                       labels as real form controls: without a name on the list there is
                       no way for a reader (or a test) to say which "First name" is the
                       summary row and which is the previewed input. */
                    <ol className="fse__review-fields" aria-label={`Fields in ${sectionName}`}>
                      {section.fields.map((f, i) => (
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
              );
            })
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
        saveError && (
          <Banner tone="error" title="Save failed" onDismiss={() => setSaveError(null)}>
            {saveError}
          </Banner>
        )
      }
      aside={
        /* Reads the SAME `sections` state the steps write, so it cannot drift
           from what Save would persist; there is no second copy of the schema
           to keep in step. */
        <SchemaPreview sections={sections} />
      }
    />
  );
}

interface SectionCardProps {
  index: number;
  isFirst: boolean;
  isLast: boolean;
  section: FormSection;
  showTitleError: boolean;
  onTitleChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddField: () => void;
  onUpdateField: (fieldIdx: number, transform: (f: FormField) => FormField) => void;
  onRemoveField: (fieldIdx: number) => void;
  onMoveFieldUp: (fieldIdx: number) => void;
  onMoveFieldDown: (fieldIdx: number) => void;
}

/**
 * One section: its own title/description, its own field list, and the
 * reorder/remove controls for the section itself. Mirrors
 * `FormSchemaEditorScreen.kt#SectionCard` and the "Section {n}" card in
 * `ui-ideas/auntieos-formschema-editor-2026-05-27.html`.
 */
function SectionCard({
  index,
  isFirst,
  isLast,
  section,
  showTitleError,
  onTitleChange,
  onDescriptionChange,
  onRemove,
  onMoveUp,
  onMoveDown,
  onAddField,
  onUpdateField,
  onRemoveField,
  onMoveFieldUp,
  onMoveFieldDown,
}: SectionCardProps) {
  // Fresh per section, never hoisted across the whole step: duplicate-key
  // checking is scoped to THIS section only (see `sectionErrors` above), so a
  // key shared with a different section must not light up here either.
  const seenKeys = new Set<string>();
  const titleError = section.title.trim() ? null : 'Section title is required.';

  return (
    <li className="fse__section-card">
      <div className="fse__section-header">
        <span className="fse__section-tag">Section {index + 1}</span>
        <div className="fse__section-actions">
          <IconButton
            icon={<UpGlyph />}
            label={`Move ${section.title || `section ${index + 1}`} up`}
            onClick={onMoveUp}
            disabled={isFirst}
            size={32}
          />
          <IconButton
            icon={<DownGlyph />}
            label={`Move ${section.title || `section ${index + 1}`} down`}
            onClick={onMoveDown}
            disabled={isLast}
            size={32}
          />
          <IconButton
            icon={<TrashGlyph />}
            label={`Remove ${section.title || `section ${index + 1}`}`}
            onClick={onRemove}
            destructive
            size={32}
          />
        </div>
      </div>

      <div className="fse__field">
        <label className="fse__field-label">
          <span className="fse__label">Section title</span>
          <input
            type="text"
            className="fse__input"
            value={section.title}
            onChange={(e) => onTitleChange(e.target.value)}
            aria-invalid={showTitleError && titleError ? true : undefined}
          />
        </label>
        {showTitleError && titleError && <span className="fse__error">{titleError}</span>}
      </div>

      <label className="fse__field">
        <span className="fse__label">Section description</span>
        <input
          type="text"
          className="fse__input"
          value={section.description ?? ''}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="Optional"
        />
      </label>

      <div className="fse__section-fields-row">
        <h5 className="fse__section-fields-heading">
          Fields ({section.fields.length})
        </h5>
      </div>

      {section.fields.length === 0 ? (
        <p className="fse__hint">No fields in this section yet.</p>
      ) : (
        <ul className="fse__fields">
          {section.fields.map((field, idx) => {
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
                        onChange={(e) => onUpdateField(idx, (f) => ({ ...f, key: e.target.value }))}
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
                        onChange={(e) => onUpdateField(idx, (f) => ({ ...f, label: e.target.value }))}
                        onBlur={() =>
                          // AO-49: auto-fill the key from the label ONLY when the
                          // operator hasn't typed one, never clobbering a hand-set key.
                          onUpdateField(idx, (f) =>
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
                        onUpdateField(idx, (f) => {
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
                      onChange={(e) => onUpdateField(idx, (f) => ({ ...f, required: e.target.checked }))}
                    />
                    <span className="fse__label">Required</span>
                  </label>

                  <div className="fse__field-actions">
                    <IconButton
                      icon={<UpGlyph />}
                      label={`Move ${field.label || field.key || 'field'} up`}
                      onClick={() => onMoveFieldUp(idx)}
                      disabled={idx === 0}
                      size={32}
                    />
                    <IconButton
                      icon={<DownGlyph />}
                      label={`Move ${field.label || field.key || 'field'} down`}
                      onClick={() => onMoveFieldDown(idx)}
                      disabled={idx === section.fields.length - 1}
                      size={32}
                    />
                    <IconButton
                      icon={<TrashGlyph />}
                      label={`Remove ${field.label || field.key || 'field'}`}
                      onClick={() => onRemoveField(idx)}
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
                          onUpdateField(idx, (f) => ({ ...f, options: csvToOptions(e.target.value) }))
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
                        onUpdateField(idx, (f) => ({ ...f, helperText: e.target.value || null }))
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
                        onUpdateField(idx, (f) => ({ ...f, placeholder: e.target.value || null }))
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
                        onUpdateField(idx, (f) => ({ ...f, defaultValue: e.target.value || null }))
                      }
                    />
                  </label>
                  <label className="fse__field">
                    <span className="fse__label">Group</span>
                    <input
                      type="text"
                      className="fse__input"
                      value={field.group ?? ''}
                      onChange={(e) => onUpdateField(idx, (f) => ({ ...f, group: e.target.value || null }))}
                    />
                  </label>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="fse__step-actions">
        <PrimaryButton label="Add field" onClick={onAddField} />
      </div>
    </li>
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
