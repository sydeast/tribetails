import { useCallback, useId, useState } from 'react';
import { saveTemplate } from '../api/templatesWrite';
import type { TemplateSummary } from '../api/templates';
import {
  blankFormFields,
  buildSaveTemplatePayload,
  templateFormError,
  templateToFormFields,
  type TemplateFormFields,
} from '../lib/templateFormat';
import { Dialog } from '../components/Dialog';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import './TemplateEditor.css';

export interface TemplateEditorProps {
  /**
   * `null` = create mode: a blank, brand-new `emailTemplates` doc. Non-null =
   * edit mode, pre-filled from this row (already the FULL template, not a
   * summary missing fields: `listTemplates` returns every field this editor
   * needs, see `api/templates.ts#TemplateSummary`, so opening the editor
   * never requires a second fetch).
   */
  template: TemplateSummary | null;
  /**
   * Known category names for the datalist suggestion. Optional: a
   * `listTemplateCategories` failure upstream (Templates.tsx already
   * surfaces that as its own secondary banner) must not block the editor
   * from opening; the category field still works as plain free text.
   */
  categories?: string[];
  onClose: () => void;
  /**
   * Called once `saveTemplate` resolves, with the saved templateId. The
   * caller (Templates.tsx) owns closing the editor and reloading the list:
   * this component does not close itself on success, matching
   * FormSchemas.tsx's confirmDelete()/load() split (save vs. re-render is the
   * caller's call, not the modal's).
   */
  onSaved: (templateId: string) => void;
}

/**
 * The Template Bank editor (create + edit), the write surface
 * Templates.tsx's `onSelect` placeholder and "New template" action defer to.
 * Ports `TemplateEditorOverlay` from the wasm (see Templates.tsx's "NOT
 * ported here" doc comment): one component for both modes, distinguished by
 * whether `template` is `null`, matching how the wasm overlay itself is one
 * composable that branches on a nullable `existing` template.
 *
 * Single write callable for both modes (`saveTemplate`, see
 * `api/templatesWrite.ts`'s doc comment on why there is no separate
 * create/update pair): this editor's Save button always calls the same
 * function, and the backend decides create-vs-update from whether the doc
 * already existed.
 *
 * templateId is the Firestore doc path segment (`emailTemplates/{templateId}`),
 * so it is editable ONLY in create mode; editing it in edit mode would not
 * rename the existing doc, it would silently create a second one under the
 * new id and leave the original behind. Edit mode renders it as read-only
 * `<code>`, the same non-interactive convention Templates.tsx's row `<code>`
 * uses for the same field.
 *
 * No delete affordance: confirmed against the backend, `emailTemplates` has
 * no delete callable (see templatesWrite.ts). This editor is create + update
 * only, and does not fabricate a delete action the server cannot honor.
 */
export function TemplateEditor({ template, categories, onClose, onSaved }: TemplateEditorProps) {
  const isCreate = template === null;
  const [fields, setFields] = useState<TemplateFormFields>(() =>
    template ? templateToFormFields(template) : blankFormFields(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const categoryListId = useId();

  function setField<K extends keyof TemplateFormFields>(key: K, value: TemplateFormFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  // useCallback, not a plain function: Dialog's own focus-management effect
  // re-runs (and re-focuses the panel) whenever the `onClose` reference it
  // receives changes, so a fresh function identity on every keystroke-driven
  // re-render would steal focus back to the dialog panel after each
  // character typed, one letter at a time. Stable across renders except when
  // `saving` or the outer `onClose` prop actually changes.
  const requestClose = useCallback(() => {
    // Never close out from under an in-flight save: the same guard
    // FormSchemas.tsx's pendingDelete dialog uses for its Escape/backdrop path.
    if (!saving) onClose();
  }, [saving, onClose]);

  async function handleSave() {
    if (saving) return;
    const validationError = templateFormError(fields, { isCreate });
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = buildSaveTemplatePayload(fields);
      const result = await saveTemplate(payload);
      setSaving(false);
      onSaved(result.templateId);
    } catch (err) {
      setSaving(false);
      setError(`saveTemplate failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    }
  }

  return (
    <Dialog
      title={isCreate ? 'New template' : 'Edit template'}
      onClose={requestClose}
      footer={
        <>
          <GhostButton label="Cancel" onClick={requestClose} disabled={saving} />
          <PrimaryButton
            label={saving ? 'Saving…' : 'Save template'}
            onClick={() => void handleSave()}
            disabled={saving}
            busy={saving}
          />
        </>
      }
    >
      {error ? (
        <Banner tone="error" title="Couldn&rsquo;t save" className="template-editor__error">
          {error}
        </Banner>
      ) : null}

      <fieldset className="template-editor__fields" disabled={saving}>
        <legend className="template-editor__sr-legend">Template details</legend>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-id">
            Template key
          </label>
          {isCreate ? (
            <input
              id="template-editor-id"
              type="text"
              className="template-editor__input"
              value={fields.templateId}
              onChange={(e) => setField('templateId', e.target.value)}
              placeholder="booking.confirmed"
              maxLength={120}
              autoFocus
            />
          ) : (
            <code id="template-editor-id" className="template-editor__id-static">
              {fields.templateId}
            </code>
          )}
          {isCreate ? (
            <p className="template-editor__hint">
              Letters, numbers, underscore, period, and hyphen only. This becomes the document id and
              cannot be changed later.
            </p>
          ) : (
            <p className="template-editor__hint">The template key cannot be changed after creation.</p>
          )}
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-title">
            Title
          </label>
          <input
            id="template-editor-title"
            type="text"
            className="template-editor__input"
            value={fields.title}
            onChange={(e) => setField('title', e.target.value)}
            placeholder="Defaults to the template key"
            maxLength={200}
          />
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-subject">
            Subject
          </label>
          <input
            id="template-editor-subject"
            type="text"
            className="template-editor__input"
            value={fields.subject}
            onChange={(e) => setField('subject', e.target.value)}
            placeholder="Your booking is confirmed"
            maxLength={500}
          />
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-body">
            Body
          </label>
          <textarea
            id="template-editor-body"
            className="template-editor__textarea"
            value={fields.body}
            onChange={(e) => setField('body', e.target.value)}
            placeholder="Hi {{kinfolk_name}}, ..."
            rows={8}
            maxLength={20000}
          />
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-html">
            HTML (optional)
          </label>
          <textarea
            id="template-editor-html"
            className="template-editor__textarea template-editor__textarea--mono"
            value={fields.html}
            onChange={(e) => setField('html', e.target.value)}
            placeholder="<p>Hi {{kinfolk_name}}, ...</p>"
            rows={6}
            maxLength={50000}
          />
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-description">
            Description (optional)
          </label>
          <textarea
            id="template-editor-description"
            className="template-editor__textarea"
            value={fields.description}
            onChange={(e) => setField('description', e.target.value)}
            placeholder="What this template is for, for other admins"
            rows={2}
            maxLength={1000}
          />
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-category">
            Category (optional)
          </label>
          <input
            id="template-editor-category"
            type="text"
            className="template-editor__input"
            value={fields.category}
            onChange={(e) => setField('category', e.target.value)}
            placeholder="Booking"
            maxLength={60}
            {...(categories && categories.length > 0 ? { list: categoryListId } : {})}
          />
          {categories && categories.length > 0 ? (
            <datalist id={categoryListId}>
              {categories.map((cat) => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          ) : null}
        </div>

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-tags">
            Tags (optional, comma separated)
          </label>
          <input
            id="template-editor-tags"
            type="text"
            className="template-editor__input"
            value={fields.tagsInput}
            onChange={(e) => setField('tagsInput', e.target.value)}
            placeholder="booking, confirmation"
          />
        </div>
      </fieldset>
    </Dialog>
  );
}
