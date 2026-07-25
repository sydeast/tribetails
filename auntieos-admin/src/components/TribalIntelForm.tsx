import { useId, useMemo, useRef, useState } from 'react';
import type { Kin, Kinfolk } from '../api/directory';
import { kinfolkDisplayName } from '../api/directory';
import type { TribalIntelEntry } from '../api/tribalIntel';
import {
  createTrainingDocument,
  updateTrainingDocument,
  uploadTribalIntelAttachment,
} from '../api/tribalIntelWrite';
import {
  blankTribalIntelDraft,
  tribalIntelCallableArgs,
  validateTribalIntelDraft,
  type TribalIntelDraft,
  type TribalIntelDraftErrors,
  type TribalIntelTargetType,
} from '../lib/tribalIntelDraftSchema';
import { str } from '../lib/coerce';
import { Banner } from './Banner';
import { GhostButton, PrimaryButton } from './Buttons';
import { GlassSurface } from './GlassSurface';
import './TribalIntelForm.css';

interface TribalIntelFormProps {
  /** The entry being edited, or `null` to create a new one. */
  editing: TribalIntelEntry | null;
  /** Every household on the roster, for the target picker. */
  kinfolk: Kinfolk[];
  /** Every pet on the roster. Narrowed to the chosen household in here. */
  kin: Kin[];
  onCancel: () => void;
  /** Fired only after the callable actually resolved. */
  onSaved: () => void;
}

/**
 * Create / edit panel for one Tribal Intel entry: the manual feed for
 * everything the reconcile pipeline cannot auto-grab (in-person conversations,
 * photos of a scribbled note, what an owner said at pickup).
 *
 * Ports the archive's `AddDocumentForm`
 * (`.../screens/trainingdocs/TrainingDocumentsScreen.kt`) and Android's live
 * equivalent, field for field: title, intel, notes, a KINFOLK/KIN target with
 * dependent household and pet pickers, and Cloudinary attachments.
 *
 * TWO HONESTY RULES THIS PANEL EXISTS TO KEEP:
 *  1. Saving does NOT update a dossier. It queues the entry
 *     (`reconcileStatus: 'pending'`) for the nightly reconcile pass. The blurb
 *     at the top says so before the operator types, and the screen's
 *     confirmation says so again after the save.
 *  2. Attachments are provenance only. The reconcile summarizer cites their
 *     URLs; it cannot read image bytes. Promising otherwise would have the
 *     operator photograph a vet note and expect it to be read.
 *
 * Validation mirrors the deployed callable's zod rules through
 * `lib/tribalIntelDraftSchema.ts`, so both server refinements are reported
 * beside their field instead of arriving as `invalid-argument` after a round
 * trip. The server still enforces everything; this is never the only check.
 */
export function TribalIntelForm({ editing, kinfolk, kin, onCancel, onSaved }: TribalIntelFormProps) {
  const [draft, setDraft] = useState<TribalIntelDraft>(() => draftFrom(editing));
  const [errors, setErrors] = useState<TribalIntelDraftErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const titleId = useId();
  const contentId = useId();
  const notesId = useId();
  const kinfolkId = useId();
  const kinId = useId();
  const fileId = useId();

  // Pets are scoped to the chosen household. Archived pets stay out: the
  // picker offers what an operator can meaningfully write intel about today.
  const petsForHousehold = useMemo(
    () =>
      kin.filter(
        (k) => str(k.kinfolkId) === draft.targetKinfolkId && str(k.status).trim().toLowerCase() !== 'archived',
      ),
    [kin, draft.targetKinfolkId],
  );

  function patch(next: Partial<TribalIntelDraft>) {
    setDraft((cur) => ({ ...cur, ...next }));
    setErrors({});
    setFailure(null);
  }

  function chooseHousehold(id: string) {
    // Changing household invalidates the pet: a pet id from the previous
    // household would target a pet the new one does not own.
    patch({ targetKinfolkId: id, targetKinId: '' });
  }

  function chooseTargetType(targetType: TribalIntelTargetType) {
    patch(targetType === 'KINFOLK' ? { targetType, targetKinId: '' } : { targetType });
  }

  async function attach(file: File) {
    setUploading(true);
    setFailure(null);
    try {
      const attachment = await uploadTribalIntelAttachment(file);
      setDraft((cur) => ({ ...cur, attachments: [...cur.attachments, attachment] }));
    } catch (err) {
      // Fail loud. A failed upload must never leave a half-built attachment on
      // the draft that would then be saved as a broken provenance URL.
      setFailure(`Attachment upload failed. ${messageOf(err)}`);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function save() {
    const found = validateTribalIntelDraft(draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      return;
    }

    setSaving(true);
    setFailure(null);
    try {
      const args = tribalIntelCallableArgs(draft);
      if (editing === null) await createTrainingDocument(args);
      else await updateTrainingDocument(editing._id, args);
      onSaved();
    } catch (err) {
      setFailure(messageOf(err));
    } finally {
      setSaving(false);
    }
  }

  const busy = saving || uploading;

  return (
    <GlassSurface className="tribal-form">
      <h3 className="tribal-form__title">{editing === null ? 'New Tribal Intel' : 'Edit Tribal Intel'}</h3>
      <p className="tribal-form__blurb">
        Saved intel is queued for the next reconcile pass, then folded into the household dossier and the pet
        411. Attachments are cited as provenance only. The summarizer reads their file names and links, never
        the contents of an image.
      </p>

      {failure !== null && (
        <Banner tone="error" title="Could not save" className="tribal-form__banner">
          {failure}
        </Banner>
      )}

      <div className="tribal-form__field">
        <label className="tribal-form__label" htmlFor={titleId}>
          Title
        </label>
        <input
          id={titleId}
          className="tribal-form__input"
          type="text"
          value={draft.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder="Short label"
          aria-invalid={errors.title !== undefined}
          aria-errormessage={errors.title !== undefined ? `${titleId}-err` : undefined}
        />
        {errors.title !== undefined && (
          <p id={`${titleId}-err`} className="tribal-form__error">
            {errors.title}
          </p>
        )}
      </div>

      <div className="tribal-form__field">
        <label className="tribal-form__label" htmlFor={contentId}>
          Intel
        </label>
        <textarea
          id={contentId}
          className="tribal-form__textarea"
          rows={5}
          value={draft.content}
          onChange={(e) => patch({ content: e.target.value })}
          placeholder="What should Auntie know about this household or pet?"
          aria-invalid={errors.content !== undefined}
          aria-errormessage={errors.content !== undefined ? `${contentId}-err` : undefined}
        />
        {errors.content !== undefined && (
          <p id={`${contentId}-err`} className="tribal-form__error">
            {errors.content}
          </p>
        )}
      </div>

      <div className="tribal-form__field">
        <label className="tribal-form__label" htmlFor={notesId}>
          Notes
        </label>
        <input
          id={notesId}
          className="tribal-form__input"
          type="text"
          value={draft.notes}
          onChange={(e) => patch({ notes: e.target.value })}
          placeholder="Optional internal note"
          aria-invalid={errors.notes !== undefined}
        />
        {errors.notes !== undefined && <p className="tribal-form__error">{errors.notes}</p>}
      </div>

      {/* ── target ─────────────────────────────────────────────────────── */}

      <p className="tribal-form__section">Target</p>

      <div className="tribal-form__chips">
        <button
          type="button"
          className={chipClass(draft.targetType === 'KINFOLK')}
          aria-pressed={draft.targetType === 'KINFOLK'}
          onClick={() => chooseTargetType('KINFOLK')}
        >
          Whole household
        </button>
        <button
          type="button"
          className={chipClass(draft.targetType === 'KIN')}
          aria-pressed={draft.targetType === 'KIN'}
          onClick={() => chooseTargetType('KIN')}
        >
          Single pet
        </button>
      </div>

      <div className="tribal-form__field">
        <label className="tribal-form__label" htmlFor={kinfolkId}>
          Household
        </label>
        <select
          id={kinfolkId}
          className="tribal-form__select"
          value={draft.targetKinfolkId}
          onChange={(e) => chooseHousehold(e.target.value)}
          aria-invalid={errors.targetKinfolkId !== undefined}
        >
          <option value="">Select a household...</option>
          {kinfolk.map((kf) => (
            <option key={kf._id} value={kf._id}>
              {kinfolkDisplayName(kf)}
            </option>
          ))}
        </select>
        {errors.targetKinfolkId !== undefined && (
          <p className="tribal-form__error">{errors.targetKinfolkId}</p>
        )}
      </div>

      {draft.targetType === 'KIN' && (
        <div className="tribal-form__field">
          <label className="tribal-form__label" htmlFor={kinId}>
            Pet
          </label>
          <select
            id={kinId}
            className="tribal-form__select"
            value={draft.targetKinId}
            onChange={(e) => patch({ targetKinId: e.target.value })}
            disabled={draft.targetKinfolkId === ''}
            aria-invalid={errors.targetKinId !== undefined}
          >
            <option value="">
              {draft.targetKinfolkId === '' ? 'Pick a household first...' : 'Select a pet...'}
            </option>
            {petsForHousehold.map((k) => (
              <option key={k._id} value={k._id}>
                {str(k.name).trim() === '' ? k._id : str(k.name)}
              </option>
            ))}
          </select>
          {draft.targetKinfolkId !== '' && petsForHousehold.length === 0 && (
            <p className="tribal-form__hint">
              This household has no active pets on file. Target the whole household instead.
            </p>
          )}
          {errors.targetKinId !== undefined && <p className="tribal-form__error">{errors.targetKinId}</p>}
        </div>
      )}

      {/* ── attachments ────────────────────────────────────────────────── */}

      <p className="tribal-form__section">Attachments</p>

      <div className="tribal-form__field">
        <label className="tribal-form__label" htmlFor={fileId}>
          Attach a file
        </label>
        <input
          id={fileId}
          ref={fileRef}
          className="tribal-form__file"
          type="file"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void attach(file);
          }}
        />
        {uploading && <p className="tribal-form__hint">Uploading...</p>}
        {errors.attachments !== undefined && <p className="tribal-form__error">{errors.attachments}</p>}
      </div>

      {draft.attachments.length > 0 && (
        <ul className="tribal-form__attachments">
          {draft.attachments.map((a) => (
            <li key={a.cloudinaryPublicId} className="tribal-form__attachment">
              <span className="tribal-form__attachment-name">
                {a.fileName.trim() === '' ? a.cloudinaryPublicId : a.fileName}
              </span>
              <GhostButton
                label="Remove"
                onClick={() =>
                  setDraft((cur) => ({
                    ...cur,
                    attachments: cur.attachments.filter(
                      (x) => x.cloudinaryPublicId !== a.cloudinaryPublicId,
                    ),
                  }))
                }
              />
            </li>
          ))}
        </ul>
      )}

      <div className="tribal-form__actions">
        <GhostButton label="Cancel" onClick={onCancel} disabled={saving} />
        <PrimaryButton label="Save intel" onClick={() => void save()} disabled={busy} busy={saving} />
      </div>
    </GlassSurface>
  );
}

function chipClass(active: boolean): string {
  return active ? 'tribal-form__chip tribal-form__chip--active' : 'tribal-form__chip';
}

/**
 * Seeds the draft from an existing entry.
 *
 * `targetKinfolkId` falls back to the legacy free-text `kinfolkRef` exactly as
 * the archive's `startEdit` does: pre-spec-23 rows (the NDJSON migration
 * import) carry `kinfolkRef` and no `targetKinfolkId`, and dropping that would
 * silently blank the household on every legacy row the operator opens.
 */
function draftFrom(entry: TribalIntelEntry | null): TribalIntelDraft {
  if (entry === null) return blankTribalIntelDraft();
  const targetType: TribalIntelTargetType = str(entry.targetType).trim().toUpperCase() === 'KIN' ? 'KIN' : 'KINFOLK';
  return {
    title: str(entry.title),
    content: str(entry.content),
    notes: str(entry.notes),
    communicationType: str(entry.communicationType).trim() === '' ? 'note' : str(entry.communicationType),
    targetType,
    targetKinfolkId: str(entry.targetKinfolkId).trim() === '' ? str(entry.kinfolkRef) : str(entry.targetKinfolkId),
    targetKinId: str(entry.targetKinId),
    attachments: (entry.attachments ?? []).map((a) => ({
      storageUrl: str(a.storageUrl),
      cloudinaryPublicId: str(a.cloudinaryPublicId),
      fileType: str(a.fileType),
      mimeType: str(a.mimeType),
      fileName: str(a.fileName),
    })),
  };
}

/** Never surfaces a blank error: an unknown throw still names itself. */
export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== '') return err.message;
  if (typeof err === 'string' && err.trim() !== '') return err;
  return 'The write failed and reported no reason. Try again, then check the function logs.';
}
