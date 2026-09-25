import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  saveTemplate,
  deleteTemplate,
  isLiveNotificationKeyWarning,
  isTemplateKeyTakenError,
} from '../api/templatesWrite';
import type { TemplateSummary } from '../api/templates';
import {
  blankFormFields,
  blankSection,
  buildSaveTemplatePayload,
  formatTagsInput,
  parseTagsInput,
  templateFormError,
  templateToFormFields,
  type TemplateFormFields,
  buildVisualSavePayload,
  fieldsForTemplate,
  templateEditorMode,
  visualFormError,
} from '../lib/templateFormat';
import { getNotificationMatrix, type NotificationCatalogEntry } from '../api/myNotifications';
import { EmailContentEditor } from '../components/emailEditor/EmailContentEditor';
import { EmailPreviewPane } from '../components/emailEditor/EmailPreviewPane';
import { useEmailPreview } from '../lib/useEmailPreview';
import { tokensIn } from '../lib/emailContent';
import { editorCanRoundTrip, loopGuardError } from '../lib/emailRoundTrip';
import { Dialog } from '../components/Dialog';
import { MergePreview } from '../components/MergePreview';
import { ENRICHABLE_SAMPLE } from '../lib/mergeFields';
import { PrimaryButton, GhostButton } from '../components/Buttons';
import { Banner } from '../components/Banner';
import { DenPanel, DenScreenHeading, StatusPill } from '../components/DenScreenKit';
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
  /**
   * Leaves the editor without saving. The "Template bank" crumb and the
   * Cancel button both call it; Templates.tsx answers by showing the bank
   * again.
   */
  onClose: () => void;
  /**
   * Called once `saveTemplate` resolves, with the saved templateId. The
   * caller (Templates.tsx) owns closing the editor and reloading the list:
   * this component does not close itself on success, matching
   * FormSchemas.tsx's confirmDelete()/load() split (save vs. re-render is the
   * caller's call, not the view's).
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

/**
 * The keys the merge-field chips offer, and the legend lists. These are the
 * twelve `enrichTemplateData.ts` hydrates on every notification send, so a
 * chip here is a token the pipeline will fill. The mock draws illustrative
 * tokens (`{{kinfolk_name}}`, `{{invoice_no}}`); those are not names the
 * enricher knows, and a chip that inserts one would be flagged by the preview
 * the moment it lands. The real catalog is the honest chip set.
 */
const MERGE_FIELD_KEYS = Object.keys(ENRICHABLE_SAMPLE);

function TrashGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" />
    </svg>
  );
}

function SaveGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  );
}

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}

/**
 * The Template Bank editor (create + edit), the write surface Templates.tsx's
 * row activation and "New template" action open. One component for both
 * modes, distinguished by whether `template` is `null`, matching how the
 * Android `TemplateEditorScreen` is one composable that branches on
 * `creating`.
 *
 * It is a PAGE, not a modal, since the #755 sweep: the email creation mock
 * (`ui-ideas/auntieos-email-creation-2026-05-27.html`) draws it as a screen
 * of its own with a "Template bank / Edit template" crumb trail, the form in
 * a panel on the left and the preview and the resolved sample values in two
 * panels on the right. Templates.tsx shows it in place of the bank, the same
 * sibling-view treatment its assignments and import views get, and the first
 * crumb is the way back. Only the delete confirmation is still a Dialog.
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
 * action in the heading opens a confirmation Dialog over the page, then calls
 * `deleteTemplate`. Backdrop-click/Escape from the confirm dialog fully closes
 * the editor, matching `BookingActions.tsx`; only the confirm dialog's own
 * "Back" button returns to the page.
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
  // The tag being typed in the row's add box, before Enter or a comma commits
  // it. Kept apart from `fields.tagsInput`, which stays the saved list.
  const [tagDraft, setTagDraft] = useState('');
  const categoryListId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  // Where the caret should land once React has painted a body that had a
  // merge field dropped into it. Null when no insertion is pending.
  const pendingCaret = useRef<number | null>(null);

  // #953: which editor this template gets. New templates are visual; a stored
  // template is visual only when it says so, old when it has no format, and
  // read-only when its format is one this admin does not know (Ruling C13).
  // Task 10 flips old to visual on Convert.
  const [mode] = useState(() => templateEditorMode(template));
  const readOnly = mode === 'readonly';
  // What the content editor mounts with. `key` changes only when the content
  // is replaced wholesale (Convert), which remounts the editor.
  const [seed] = useState(() => ({ key: 0, content: template?.content ?? '' }));
  // Ruling C5(a): stored content the editor cannot write back as it found it
  // opens with the body locked, and Save sends the stored content untouched.
  // Checked once, at open, because it runs a headless editor.
  const [bodyLocked] = useState(
    () => mode === 'visual' && template !== null && !editorCanRoundTrip(template.content ?? ''),
  );
  const [catalog, setCatalog] = useState<
    { status: 'loading' } | { status: 'ready'; entries: NotificationCatalogEntry[] } | { status: 'error' }
  >({ status: 'loading' });

  // Loaded once, in every mode: visual editing needs the fields, and the
  // Convert view (Task 10) needs the catalog key before the mode flips.
  useEffect(() => {
    let live = true;
    getNotificationMatrix().then(
      (matrix) => {
        if (live) setCatalog({ status: 'ready', entries: matrix.catalog });
      },
      () => {
        if (live) setCatalog({ status: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const alreadyUsed = template
    ? tokensIn(template.subject, template.body, template.html ?? '', template.content ?? '')
    : [];
  // Until the catalog answers (or if it never does), the fields the template
  // already uses, minus loop-local names, are the honest list.
  const fieldSet = fieldsForTemplate(
    catalog.status === 'ready' ? catalog.entries : [],
    fields.templateId,
    alreadyUsed,
  );
  const fieldsNote =
    catalog.status === 'ready' && fieldSet.source === 'template'
      ? 'No notification sends this template, so these are the fields it already uses.'
      : undefined;

  const previewReq =
    mode === 'visual' && (fields.headline.trim() !== '' || fields.content !== '')
      ? {
          subject: fields.subject,
          headline: fields.headline,
          content: fields.content,
          ...(fieldSet.catalogKey ? { catalogKey: fieldSet.catalogKey } : {}),
        }
      : null;
  const preview = useEmailPreview(previewReq);

  function setField<K extends keyof TemplateFormFields>(key: K, value: TemplateFormFields[K]) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  // The mock's chips: "click to drop the token at the cursor". The caret is
  // read off the textarea at click time, the token spliced in over the
  // selection, and the caret parked after it once the new value has rendered.
  // A chip clicked with the textarea never focused appends to the end.
  function insertMergeField(key: string) {
    const token = `{{${key}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? fields.body.length;
    const end = el?.selectionEnd ?? start;
    pendingCaret.current = start + token.length;
    setFields((prev) => ({ ...prev, body: prev.body.slice(0, start) + token + prev.body.slice(end) }));
  }
  useEffect(() => {
    const caret = pendingCaret.current;
    const el = bodyRef.current;
    if (caret === null || el === null) return;
    pendingCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [fields.body]);

  const tags = parseTagsInput(fields.tagsInput);
  function commitTagDraft() {
    const next = tagDraft.trim();
    setTagDraft('');
    if (next === '' || tags.includes(next)) return;
    setField('tagsInput', formatTagsInput([...tags, next]));
  }
  function removeTag(tag: string) {
    setField('tagsInput', formatTagsInput(tags.filter((t) => t !== tag)));
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

  // useCallback so the confirm Dialog's focus-management effect, which reads
  // `onClose` through a ref, sees one identity across re-renders. Stable
  // except when `saving`, `deleting` or the outer `onClose` prop changes.
  const requestClose = useCallback(() => {
    // Never close out from under an in-flight save OR delete: the same guard
    // FormSchemas.tsx's pendingDelete dialog uses for its Escape/backdrop path.
    if (!saving && !deleting) onClose();
  }, [saving, deleting, onClose]);

  async function handleSave() {
    if (saving || readOnly) return;
    // A tag still sitting in the add box is a tag the operator meant to keep.
    const draft = tagDraft.trim();
    const withTag: TemplateFormFields =
      draft !== '' && !tags.includes(draft)
        ? { ...fields, tagsInput: formatTagsInput([...tags, draft]) }
        : fields;
    if (withTag !== fields) {
      setFields(withTag);
      setTagDraft('');
    }
    // A locked body is never the editor's to write: the stored content goes
    // back exactly as it came.
    const stored = template?.content ?? '';
    const effective: TemplateFormFields = bodyLocked ? { ...withTag, content: stored } : withTag;
    // The loop check is the last backstop behind the editor's own guards: a
    // different number of {{#each}} openers or closers than the stored content
    // means a repeating list was lost, split or closed early.
    const validationError =
      mode === 'visual'
        ? (visualFormError(effective, { isCreate }) ?? loopGuardError(stored, effective.content))
        : templateFormError(effective, { isCreate });
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload =
        mode === 'visual'
          ? buildVisualSavePayload(effective, { isCreate })
          : buildSaveTemplatePayload(effective, { isCreate });
      const result = await saveTemplate(payload);
      setSaving(false);
      onSaved(result.templateId);
    } catch (err) {
      setSaving(false);
      // A taken key is the one save failure with an obvious next move, so it
      // gets its own sentence rather than the generic prefix. The server is the
      // only place that knows: this editor holds one page of templates, and the
      // key it is about to claim may be on another.
      if (isTemplateKeyTakenError(err)) {
        setError(
          `The key ${effective.templateId.trim()} is already in use. Pick a different key, ` +
            `or close this and edit the existing template.`,
        );
        return;
      }
      setError(`saveTemplate failed: ${err instanceof Error ? err.message : 'Save failed'}`);
    }
  }

  function openConfirmDelete() {
    if (isCreate || saving) return;
    setError(null);
    setLiveKeyWarning(null);
    setView('confirm-delete');
  }

  // "Back", not requestClose: returning to the page is a narrower action than
  // leaving the editor, the same distinction BookingActions.tsx draws between
  // its confirm mode's "Back" button and Escape/backdrop (which fully exits).
  // Guarded on `deleting` the same way requestClose is.
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

  const confirming = view === 'confirm-delete' && !isCreate;
  // The page's own error banner. While the confirm dialog is up the error
  // belongs to the delete and shows inside the dialog instead.
  const pageError = confirming ? null : error;

  return (
    <div className="screen template-editor">
      <DenScreenHeading
        crumbs={[
          { label: 'Template bank', onSelect: requestClose },
          { label: isCreate ? 'New template' : 'Edit template' },
        ]}
        title="Email"
        accentTail="template"
        subtitle={
          mode === 'old'
            ? 'Subject and body render with Handlebars. Merge fields resolve to each recipient at send time.'
            : 'Merge fields fill in for each person when the email is sent.'
        }
        trailing={
          <>
            <GhostButton label="Cancel" onClick={requestClose} disabled={saving} />
            {!isCreate && onDeleted ? (
              <GhostButton label="Delete" onClick={openConfirmDelete} disabled={saving} leading={<TrashGlyph />} />
            ) : null}
            <PrimaryButton
              label={saving ? 'Saving…' : 'Save template'}
              onClick={() => void handleSave()}
              disabled={saving || readOnly}
              busy={saving}
              leading={<SaveGlyph />}
            />
          </>
        }
      />

      {pageError ? (
        <Banner tone="error" title="Couldn&rsquo;t save" className="template-editor__error">
          {pageError}
        </Banner>
      ) : null}
      {readOnly ? (
        <Banner tone="warning" title="Read only" className="template-editor__error">
          This email is saved in a format that can&rsquo;t be edited here yet.
        </Banner>
      ) : null}

      <div className="template-editor__cols">
        {/* The mock's left panel carries no title of its own: the page heading
            names the screen and the mono caps name each field. */}
        <DenPanel title="" className="template-editor__panel d1">
          <fieldset className="template-editor__fields" disabled={saving || readOnly}>
            <legend className="template-editor__sr-legend">Template details</legend>

            {/* The mock's `.idrow`: key and display name side by side. */}
            <div className="template-editor__row2">
              <div className="template-editor__field">
                <span className="template-editor__labelrow">
                  <label className="template-editor__label" htmlFor="template-editor-id">
                    Template key
                  </label>
                  {isCreate ? <RequiredMark /> : null}
                </span>
                {isCreate ? (
                  <input
                    id="template-editor-id"
                    type="text"
                    className="template-editor__input template-editor__input--mono"
                    value={fields.templateId}
                    onChange={(e) => setField('templateId', e.target.value)}
                    placeholder="invoice.sent"
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
                {/* No required mark, unlike the mock: a blank name saves as the
                    key (templateFormat.ts), so it is not something the operator
                    has to fill. */}
                <label className="template-editor__label" htmlFor="template-editor-title">
                  Display name
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
            </div>

            {/* The mock's channel strip. Only the email bank exists, so the
                strip states the channel and nothing else: the mock's Push and
                SMS switch positions are disabled there and would be dead here,
                and its "Active binding" toggle belongs to a TemplateBinding
                this editor does not hold (see Manage assignments). */}
            <div className="template-editor__strip">
              <span className="template-editor__channel">
                <MailGlyph />
                <StatusPill tone="teal" label="Channel · Email" />
              </span>
            </div>

            <div className="template-editor__field">
              <span className="template-editor__labelrow">
                <label className="template-editor__label" htmlFor="template-editor-subject">
                  Subject
                </label>
                <RequiredMark />
              </span>
              <input
                id="template-editor-subject"
                type="text"
                className="template-editor__input template-editor__input--mono"
                value={fields.subject}
                onChange={(e) => setField('subject', e.target.value)}
                placeholder="Your booking is confirmed"
                maxLength={500}
              />
            </div>

            {mode !== 'old' ? (
              <div className="template-editor__field">
                <span className="template-editor__labelrow">
                  <label className="template-editor__label" htmlFor="template-editor-headline">
                    Headline
                  </label>
                  <RequiredMark />
                </span>
                <input
                  id="template-editor-headline"
                  type="text"
                  className="template-editor__input"
                  value={fields.headline}
                  onChange={(e) => setField('headline', e.target.value)}
                  placeholder="Reset your password"
                  maxLength={300}
                />
              </div>
            ) : null}

            {mode === 'visual' ? (
              <div className="template-editor__field">
                <span className="template-editor__labelrow">
                  <span className="template-editor__label" id="template-editor-content-label">
                    Content
                  </span>
                  <RequiredMark />
                </span>
                {bodyLocked ? (
                  <Banner tone="warning" title="Body locked" className="template-editor__locked">
                    {"This email has a structure the editor can't edit yet. Edit its subject and headline here."}
                  </Banner>
                ) : null}
                <EmailContentEditor
                  key={seed.key}
                  initialContent={seed.content}
                  onChange={(content) => setField('content', content)}
                  fields={fieldSet.fields}
                  fieldsState={catalog.status}
                  fieldsNote={fieldsNote}
                  disabled={saving || bodyLocked}
                />
              </div>
            ) : null}

            {/* Old-format templates keep today's editing until converted:
                the merge chips, the Body and (below) the HTML field. */}
            {mode === 'old' ? (
              <>
                <div className="template-editor__field">
                  <span className="template-editor__labelrow">
                    <span className="template-editor__label" id="template-editor-mergefields">
                      Insert merge field
                    </span>
                    <span className="template-editor__mfhint">click to drop the token at the cursor</span>
                  </span>
                  <div className="template-editor__chips" role="group" aria-labelledby="template-editor-mergefields">
                    {MERGE_FIELD_KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        className="template-editor__chip"
                        // The mock swallows mousedown so the textarea keeps focus
                        // and its caret through the click; the same here.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => insertMergeField(key)}
                      >
                        <span className="template-editor__chip-plus" aria-hidden="true">
                          +
                        </span>
                        {`{{${key}}}`}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="template-editor__field">
                  <span className="template-editor__labelrow">
                    <label className="template-editor__label" htmlFor="template-editor-body">
                      Body
                    </label>
                    <RequiredMark />
                    <span className="template-editor__hbs">Handlebars supported</span>
                  </span>
                  <textarea
                    id="template-editor-body"
                    ref={bodyRef}
                    className="template-editor__textarea template-editor__textarea--mono template-editor__textarea--body"
                    value={fields.body}
                    onChange={(e) => setField('body', e.target.value)}
                    placeholder="Hi {{kinfolkName}}, ..."
                    rows={8}
                    maxLength={20000}
                  />
                  <div className="template-editor__edmeta">
                    <span className="template-editor__hbsbadge">{'{{ }}'} handlebars</span>
                    <span>{fields.body.length} chars</span>
                    <span>· tokens left as-is, never sent literally</span>
                  </div>
                </div>
              </>
            ) : null}

            <hr className="template-editor__rule" />

            <div className="template-editor__field">
              <span className="template-editor__labelrow">
                <label className="template-editor__label" htmlFor="template-editor-description">
                  Internal description
                </label>
                <span className="template-editor__opt">admin-only note</span>
              </span>
              <textarea
                id="template-editor-description"
                className="template-editor__textarea"
                value={fields.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="What is this template for? Who receives it?"
                rows={2}
                maxLength={1000}
              />
            </div>

            {/* The mock's second `.idrow`: category and tags side by side. */}
            <div className="template-editor__row2">
              <div className="template-editor__field">
                <label className="template-editor__label" htmlFor="template-editor-category">
                  Category
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
                <span className="template-editor__label" id="template-editor-tags-label">
                  Tags
                </span>
                {/* The mock's `.tagrow`: one orange capsule per tag with its
                    own remove, then the dashed add box. Enter or a comma
                    commits what is typed; so does Save, so a tag left in the
                    box is never silently dropped. */}
                <div className="template-editor__tagrow" role="group" aria-labelledby="template-editor-tags-label">
                  {tags.map((tag) => (
                    <span key={tag} className="template-editor__tag">
                      {tag}
                      <button
                        type="button"
                        className="template-editor__tag-x"
                        aria-label={`Remove tag ${tag}`}
                        onClick={() => removeTag(tag)}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    className="template-editor__tagadd"
                    aria-label="Add a tag"
                    placeholder="+ tag"
                    value={tagDraft}
                    onChange={(e) => setTagDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        commitTagDraft();
                      }
                    }}
                    onBlur={commitTagDraft}
                    maxLength={60}
                  />
                </div>
              </div>
            </div>

            <hr className="template-editor__rule" />

            {/* Below the mock's fields: the three persisted fields it does not
                draw. They stay editable here because a field the bank stores
                and the editor cannot change is a defect, not a simplification. */}
            {mode === 'old' ? (
              <div className="template-editor__field">
                <span className="template-editor__labelrow">
                  <label className="template-editor__label" htmlFor="template-editor-html">
                    HTML
                  </label>
                  <span className="template-editor__opt">optional</span>
                </span>
                <textarea
                  id="template-editor-html"
                  className="template-editor__textarea template-editor__textarea--mono"
                  value={fields.html}
                  onChange={(e) => setField('html', e.target.value)}
                  placeholder="<p>Hi {{kinfolkName}}, ...</p>"
                  rows={6}
                  maxLength={50000}
                />
              </div>
            ) : null}

            <div className="template-editor__field">
              <span className="template-editor__labelrow">
                <label className="template-editor__label" htmlFor="template-editor-usage">
                  Usage instructions
                </label>
                <span className="template-editor__opt">optional</span>
              </span>
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
              <span className="template-editor__labelrow">
                <span className="template-editor__label">Sections</span>
                <span className="template-editor__opt">optional</span>
              </span>
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
        </DenPanel>

        <div className="template-editor__aside">
          {mode === 'visual' ? (
            <DenPanel title="" className="template-editor__panel d2">
              <EmailPreviewPane state={preview.state} onRetry={preview.retry} />
            </DenPanel>
          ) : null}
          {mode === 'old' ? (
            <>
              {/*
                The live preview. `ENRICHABLE_SAMPLE` is the right sample here and
                only here: this editor authors NOTIFICATION templates, which are
                dispatched through `enrichTemplateData.ts`, so the twelve tokens that
                module hydrates really will be filled in and everything else is a
                promise the emitting function has to keep. The preview names the
                second group; the footnote does not pretend they are the first.
              */}
              <DenPanel title="" className="template-editor__panel d2">
                <MergePreview
                  subject={fields.subject}
                  body={fields.body}
                  html={fields.html}
                  sample={ENRICHABLE_SAMPLE}
                  footnote="Sample values. Dispatch fills these in at send"
                />
              </DenPanel>

              {/* The mock's second right-hand panel: the sample every token above
                  resolved to, so the author can read the preview back to the
                  token that produced each value. */}
              <DenPanel title="" className="template-editor__panel d3">
                <span className="template-editor__label" id="template-editor-legend-label">
                  Resolved with sample values
                </span>
                <dl className="template-editor__legend" aria-labelledby="template-editor-legend-label">
                  {MERGE_FIELD_KEYS.map((key) => (
                    <div key={key} className="template-editor__legend-row">
                      <dt>
                        <code>{`{{${key}}}`}</code>
                      </dt>
                      <span className="template-editor__legend-arrow" aria-hidden="true">
                        →
                      </span>
                      <dd>{ENRICHABLE_SAMPLE[key]}</dd>
                    </div>
                  ))}
                </dl>
              </DenPanel>
            </>
          ) : null}
        </div>
      </div>

      {confirming ? (
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
            <Banner tone="error" title="Couldn&rsquo;t delete" className="template-editor__dialog-error">
              {error}
            </Banner>
          ) : null}
          {liveKeyWarning ? (
            <Banner
              tone="warning"
              title="A notification still sends this"
              className="template-editor__dialog-error"
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
      ) : null}
    </div>
  );
}

/** The mock's coral asterisk after a required field's caps label. */
function RequiredMark() {
  return (
    <span className="template-editor__req" aria-hidden="true">
      *
    </span>
  );
}
