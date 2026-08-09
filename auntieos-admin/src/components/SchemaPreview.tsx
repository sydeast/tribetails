import { useId } from 'react';
import type { FormField } from '../api/formSchemasWrite';
import './SchemaPreview.css';

export interface SchemaPreviewProps {
  sectionTitle: string;
  sectionDescription: string | null;
  /** The in-flight field list, exactly as the editor holds it. */
  fields: readonly FormField[];
}

/**
 * The Form Schema Editor's live preview: the schema as the kinfolk filling it in
 * sees it, rendered from the in-flight editor state.
 *
 * WHY THIS IS NOT `MergePreview`. The mockups tag both panes
 * `SUGGESTION: live preview pane`, but they preview different things. A
 * template preview is an email with merge fields in it; a schema preview is a
 * FORM. They share the sticky right-hand column and nothing else, so forcing
 * one component to be both would mean a component with two disjoint halves and
 * a mode flag.
 *
 * WHAT IT IS FAITHFUL TO, and the honest limit of that. `page-specs/27-formschema-editor.md`
 * says: "Do not approximate with a hand-built mock layout, reuse the real
 * renderer or the preview lies." The real renderer is `SchemaFieldInput` in
 * `mytribe/web/src/screens/TribeProfile.tsx`, the Kinfolk portal's own form,
 * and it lives in a DIFFERENT application that this bundle cannot import. So
 * this mirrors it deliberately and field-for-field: the same nine types map to
 * the same controls, required renders as the same trailing ` *`, `helperText`
 * renders as the same hint line, and `options` populate the same `<select>`.
 * It is a mirror with a named source, not an invention, and the type mapping is
 * pinned by `SchemaPreview.test.tsx` so a drift shows up as a failing test
 * rather than as a preview that quietly stops matching the portal.
 *
 * ANDROID GOT HERE FIRST, and this closes the gap in that direction.
 * `android/.../formschemas/FormSchemaEditorScreen.kt#LivePreviewPanel` has had a
 * working pane for a while, built on the real `DynamicFormFields`. React had
 * none. The two are not identical and the difference is deliberate: Android's
 * seeds throwaway sample values through `FormSchemaPreviewMapper` and lets the
 * operator type into them, this one renders empty and disabled. Android can
 * reuse its runtime renderer directly, so letting it behave like the real form
 * costs nothing and lies about nothing; here the renderer is a mirror, and a
 * mirror that accepts typing invites an operator to fill in a form that goes
 * nowhere. If the two are ever unified, unify on Android's, because Android's is
 * the one calling the real code.
 *
 * Every control is therefore DISABLED. This is a picture of a form, not a form.
 *
 * The portal's masked `SecretField` treatment for gate code / key location /
 * wifi password is deliberately NOT mirrored: masking is about who may read a
 * stored value, and there is no stored value here. Showing an ordinary empty
 * box is the accurate picture of the control's shape.
 */
export function SchemaPreview({ sectionTitle, sectionDescription, fields }: SchemaPreviewProps) {
  return (
    <section className="schema-preview" aria-label="Live preview">
      <span className="schema-preview__label">Live preview</span>

      <div className="schema-preview__card">
        <h4 className="schema-preview__section-title">{sectionTitle}</h4>
        {sectionDescription ? (
          <p className="schema-preview__section-description">{sectionDescription}</p>
        ) : null}

        {fields.length === 0 ? (
          <p className="schema-preview__empty">
            No fields yet. Each one you add appears here the way a kinfolk sees it.
          </p>
        ) : (
          <div className="schema-preview__fields">
            {fields.map((field, idx) => (
              <PreviewField key={idx} field={field} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** The nine `FIELD_TYPES` mapped to the control the portal renders for each. */
const INPUT_TYPE: Record<string, string> = {
  text: 'text',
  date: 'date',
  number: 'number',
  phone: 'tel',
  email: 'email',
};

function PreviewField({ field }: { field: FormField }) {
  const id = useId();
  // An unlabelled field still gets a name: the key is what the editor row is
  // keyed on and what the kinfolk-facing form would fall back to, and a control
  // with no accessible name at all is worse than an ugly one.
  const name = field.label.trim() || field.key.trim() || 'Untitled field';
  const label = field.required ? `${name} *` : name;
  const placeholder = field.placeholder ?? undefined;

  return (
    <div className="schema-preview__field">
      <label className="schema-preview__field-label" htmlFor={id}>
        {label}
      </label>

      {field.type === 'textarea' ? (
        <textarea id={id} className="schema-preview__control" rows={3} placeholder={placeholder} disabled />
      ) : field.type === 'checkbox' ? (
        <input id={id} type="checkbox" className="schema-preview__checkbox" disabled />
      ) : field.type === 'select' || field.type === 'multiselect' ? (
        <select
          id={id}
          className="schema-preview__control"
          disabled
          multiple={field.type === 'multiselect'}
        >
          {field.type === 'select' ? <option value="">{placeholder ?? 'Choose…'}</option> : null}
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={INPUT_TYPE[field.type] ?? 'text'}
          className="schema-preview__control"
          placeholder={placeholder}
          disabled
        />
      )}

      {field.helperText ? <span className="schema-preview__hint">{field.helperText}</span> : null}
    </div>
  );
}
