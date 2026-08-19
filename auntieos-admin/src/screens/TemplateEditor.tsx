import { useCallback, useId, useState } from 'react';
import { saveTemplate, deleteTemplate, isLiveNotificationKeyWarning } from '../api/templatesWrite';
import type { TemplateSummary } from '../api/templates';
import {
  blankFormFields,
  blankSection,
  buildSaveTemplatePayload,
  templateFormError,
  templateToFormFields,
  type TemplateFormFields,
} from '../lib/templateFormat';
import { Dialog } from '../components/Dialog';
import { MergePreview } from '../components/MergePreview';
import { ENRICHABLE_SAMPLE } from '../lib/mergeFields';
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
  /**
   * Called once `deleteTemplate` resolves, with the deleted templateId.
   * Optional and edit-mode-only: omitting it (or being in create mode) simply
   * renders no Delete action, the same "no handler, no interactive control"
   * convention `components/Buttons.tsx` documents for every button in this
   * repo, rather than wiring a destructive action to a no-op. Mirrors
   * `onSaved` above: this component does not close itself on success, the
   * caller owns closing the editor and reloading the list.
   */
  onDeleted?: (templateId: string) => void;
}

type View = 'edit' | 'confirm-delete';

function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
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
 * Delete (edit mode only, gated on `onDeleted` being supplied): a "Delete"
 * action in the footer opens a SECOND, separate Dialog asking for
 * confirmation, then calls `deleteTemplate`. This swaps which single Dialog
 * is rendered based on a `view` state rather than stacking two `<Dialog>`s at
 * once, the same one-dialog-at-a-time convention `BookingActions.tsx` uses
 * for its own confirm/reschedule modes (two mounted focus-traps would fight
 * over Escape and Tab). Backdrop-click/Escape from the confirm dialog fully
 * closes the editor (same as the edit dialog), matching `BookingActions.tsx`;
 * only the confirm dialog's own "Back" button returns to the edit view.
 *
 * The backend (`deleteTemplate.ts`) rejects with `failed-precondition` in two
 * cases, so a rejection here is often a real, expected outcome rather than a
 * network error, and the two cases end differently:
 *
 *  - A BINDING still points a notification catalog key at this template. That
 *    is a wall with a one-tap remedy on the other side of it (unassign), so it
 *    surfaces as an error banner and the delete does not proceed.
 *  - The template id IS a live notification key (#381). Routing is by name, so
 *    deleting it leaves that notification throwing at send time. The operator is
 *    allowed to want that (they retired `account.welcome.business` on purpose),
 *    so this one is a WARNING, not a refusal. The server's sentence appears in
 *    the confirm dialog with the button relabelled "Delete anyway", and pressing
 *    it re-calls with `acknowledgeLiveKey: true`.
 *
 * The warning is never pre-fetched: the first, unacknowledged call is what asks
 * the server, so the server stays the single authority on which keys are live
 * and a stray API call still cannot delete a live template without being told
 * first. `isLiveNotificationKeyWarning` reads the machine-readable `details` off
 * the rejection rather than pattern-matching the sentence.
 */
export function TemplateEditor({ template, categories, onClose, onSaved, onDeleted }: TemplateEditorProps) {
  const isCreate = template === null;
  const [fields, setFields] = useState<TemplateFormFields>(() =>
    template ? templateToFormFields(template) : blankFormFields(),
  );
  const [view, setView] = useState<View>('edit');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The server's live-notification-key sentence, once it has said it. Non-null
  // means the next press is the acknowledged retry.
  const [liveKeyWarning, setLiveKeyWarning] = useState<string | null>(null);
  const categoryListId = useId();

  function setField<K extends keyof TemplateFormFields>(key: K, value: TemplateFormFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  // Section-row editors (I9). A copy-on-write over the sections array so form
  // state is never mutated in place, matching FormSchemaEditor's field-row
  // handlers. A titleless row is dropped at save time (buildSaveTemplatePayload),
  // so an empty added row is harmless until filled.
  function addSection() {
    setFields((prev) => ({ ...prev, sections: [...prev.sections, blankSection()] }));
  }
  function updateSection(idx: number, patch: Partial<TemplateFormFields['sections'][number]>) {
    setFields((prev) => ({
      ...prev,
      sections: prev.sections.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    }));
  }
  function removeSection(idx: number) {
    setFields((prev) => ({ ...prev, sections: prev.sections.filter((_, i) => i !== idx) }));
  }

  // useCallback, not a plain function: Dialog's own focus-management effect
  // re-runs (and re-focuses the panel) whenever the `onClose` reference it
  // receives changes, so a fresh function identity on every keystroke-driven
  // re-render would steal focus back to the dialog panel after each
  // character typed, one letter at a time. Stable across renders except when
  // `saving` or the outer `onClose` prop actually changes.
  const requestClose = useCallback(() => {
    // Never close out from under an in-flight save OR delete: the same guard
    // FormSchemas.tsx's pendingDelete dialog uses for its Escape/backdrop path.
    if (!saving && !deleting) onClose();
  }, [saving, deleting, onClose]);

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

  function openConfirmDelete() {
    if (isCreate || saving) return;
    setError(null);
    setLiveKeyWarning(null);
    setView('confirm-delete');
  }

  // "Back", not requestClose: returning to the edit view is a narrower action
  // than dismissing the whole editor, the same distinction BookingActions.tsx
  // draws between its confirm mode's "Back" button and Escape/backdrop (which
  // fully exits). Guarded on `deleting` the same way requestClose is.
  function backToEdit() {
    if (deleting) return;
    setError(null);
    setLiveKeyWarning(null);
    setView('edit');
  }

  async function handleDelete() {
    if (isCreate || deleting) return;
    // Second press: the server has already named the notification this breaks
    // and the operator pressed anyway, so the acknowledgement rides along.
    const acknowledgeLiveKey = liveKeyWarning !== null;
    setDeleting(true);
    setError(null);
    try {
      const { templateId } = await deleteTemplate(fields.templateId, { acknowledgeLiveKey });
      setDeleting(false);
      onDeleted?.(templateId);
    } catch (err) {
      setDeleting(false);
      // A live-key rejection is a warning to read, not a failure to report. It
      // keeps the confirm dialog open and turns the button into "Delete anyway".
      if (isLiveNotificationKeyWarning(err)) {
        setLiveKeyWarning(err instanceof Error ? err.message : 'This template is still in use.');
        return;
      }
      setError(`deleteTemplate failed: ${err instanceof Error ? err.message : 'Delete failed'}`);
    }
  }

  if (view === 'confirm-delete' && !isCreate) {
    return (
      <Dialog
        title="Delete this template?"
        onClose={requestClose}
        footer={
          <>
            <GhostButton label="Back" onClick={backToEdit} disabled={deleting} />
            <PrimaryButton
              label={
                deleting
                  ? 'Deleting…'
                  : liveKeyWarning
                    ? 'Delete anyway'
                    : 'Delete template'
              }
              onClick={() => void handleDelete()}
              disabled={deleting}
              busy={deleting}
              leading={<TrashGlyph />}
            />
          </>
        }
      >
        {error ? (
          <Banner tone="error" title="Couldn&rsquo;t delete" className="template-editor__error">
            {error}
          </Banner>
        ) : null}
        {liveKeyWarning ? (
          <Banner
            tone="warning"
            title="A notification still sends this"
            className="template-editor__error"
          >
            {liveKeyWarning}
          </Banner>
        ) : null}
        <p className="template-editor__hint">
          {fields.title || fields.templateId}. This cannot be undone.
          {liveKeyWarning
            ? ' Press Delete anyway to go ahead, or Back to leave it alone.'
            : ' If a notification catalog key is still assigned to this template, the delete is refused until it is unassigned.'}
        </p>
        <code className="template-editor__id-static">{fields.templateId}</code>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={isCreate ? 'New template' : 'Edit template'}
      onClose={requestClose}
      size="wide"
      footer={
        <>
          <GhostButton label="Cancel" onClick={requestClose} disabled={saving} />
          {!isCreate && onDeleted ? (
            <GhostButton label="Delete" onClick={openConfirmDelete} disabled={saving} leading={<TrashGlyph />} />
          ) : null}
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

      <div className="template-editor__grid">
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

        <div className="template-editor__field">
          <label className="template-editor__label" htmlFor="template-editor-usage">
            Usage instructions (optional)
          </label>
          <textarea
            id="template-editor-usage"
            className="template-editor__textarea"
            value={fields.usageInstructions}
            onChange={(e) => setField('usageInstructions', e.target.value)}
            placeholder="When and how to use this template"
            rows={3}
            maxLength={2000}
          />
        </div>

        <div className="template-editor__field">
          <span className="template-editor__label">Sections (optional)</span>
          <p className="template-editor__hint">
            Describe the parts of this template for other admins. A section needs a title to be
            saved; blank ones are dropped.
          </p>
          {fields.sections.length > 0 ? (
            <ul className="template-editor__sections">
              {fields.sections.map((section, idx) => (
                <li key={idx} className="template-editor__section">
                  <div className="template-editor__section-fields">
                    <input
                      type="text"
                      className="template-editor__input"
                      aria-label={`Section ${idx + 1} title`}
                      value={section.title}
                      onChange={(e) => updateSection(idx, { title: e.target.value })}
                      placeholder="Section title"
                      maxLength={200}
                    />
                    <textarea
                      className="template-editor__textarea"
                      aria-label={`Section ${idx + 1} description`}
                      value={section.description}
                      onChange={(e) => updateSection(idx, { description: e.target.value })}
                      placeholder="What this section covers"
                      rows={2}
                      maxLength={1000}
                    />
                  </div>
                  <GhostButton label="Remove" onClick={() => removeSection(idx)} />
                </li>
              ))}
            </ul>
          ) : null}
          <GhostButton label="Add section" onClick={addSection} />
        </div>
      </fieldset>

        {/*
          The live preview column. `ENRICHABLE_SAMPLE` is the right sample here
          and only here: this editor authors NOTIFICATION templates, which are
          dispatched through `enrichTemplateData.ts`, so the twelve tokens that
          module hydrates really will be filled in and everything else is a
          promise the emitting function has to keep. The preview names the
          second group; the footnote does not pretend they are the first.
        */}
        <div className="template-editor__preview">
          <MergePreview
            subject={fields.subject}
            body={fields.body}
            html={fields.html}
            sample={ENRICHABLE_SAMPLE}
            footnote="Sample values. Dispatch fills these in at send"
          />
        </div>
      </div>
    </Dialog>
  );
}
