import { useCallback, useId, useState } from 'react';
import { uploadMediaFile, BUSINESS_ENTITY_ID, type UploadEntityType, type UploadStage } from '../api/mediaUpload';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import './MediaUploadDialog.css';

export interface KinfolkOption {
  id: string;
  label: string;
}

interface MediaUploadDialogProps {
  /** The household roster, for the KINFOLK target's picker (already streamed by Gallery.tsx; no separate fetch here). */
  kinfolkOptions: KinfolkOption[];
  onClose: () => void;
  /** Called once the doc actually lands in `media_files`. Gallery's own `useCollection` listener picks up the new row live; this only closes the dialog. */
  onUploaded: () => void;
}

/** "Requesting upload permission…" etc, one line per real pipeline stage, never a fabricated byte-progress percentage the app has no way to track honestly. */
function stageLabel(stage: UploadStage): string {
  switch (stage) {
    case 'signing':
      return 'Requesting upload permission…';
    case 'uploading':
      return 'Uploading to Cloudinary…';
    case 'saving':
      return 'Saving to the gallery…';
  }
}

/**
 * The Gallery's Upload affordance (out of scope in Gallery.tsx's original
 * LIST/GRID-only port, see that file's header). Opened as a Dialog from a new
 * "Upload media" button, same "editor lives in a modal over the read screen"
 * shape `EditProfileDialog`/`FormSchemas`' delete-confirm already use.
 *
 * Targets one of three entities (`api/mediaUpload.ts#UploadEntityType`):
 *   KINFOLK   picked from the already-streamed household roster (a real
 *             picker, never free-text, since the whole roster is on hand).
 *   KIN       free-text kin document id: Gallery.tsx does not stream the
 *             `kin` collection (its own header explicitly scopes out a
 *             household filter's *sibling* concept), so there is no roster
 *             here to pick from yet. Disclosed via a hint under the field,
 *             not silently narrowed to KINFOLK-only.
 *   BUSINESS  labeled "Company (no household)": the fixed `business_settings`
 *             id (Android's own `AdminSettingsViewModel#uploadLogo`
 *             constant), shown read-only since there is nothing to pick. This
 *             is the operator's way to upload media that isn't about any one
 *             household (operator ruling 2026-07-31: Kinfolk do not "own"
 *             media). `writeMediaFileDoc` omits `kinfolkId` entirely for this
 *             target, never stamps it blank.
 *
 * Fail-loud + disabled-while-busy: the fieldset locks during the upload, the
 * Dialog cannot be dismissed mid-upload, and a rejected upload at ANY of the
 * three pipeline stages (sign / Cloudinary / Firestore write) replaces
 * nothing, it surfaces the failing stage's message and leaves the form
 * exactly as the operator left it, mirroring `EditProfileDialog`'s
 * `saveError` convention.
 */
export function MediaUploadDialog({ kinfolkOptions, onClose, onUploaded }: MediaUploadDialogProps) {
  const [entityType, setEntityType] = useState<UploadEntityType>('KINFOLK');
  const [kinfolkId, setKinfolkId] = useState(kinfolkOptions[0]?.id ?? '');
  const [kinId, setKinId] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const [stage, setStage] = useState<UploadStage | null>(null);
  const [touched, setTouched] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const busy = stage !== null;

  const entityId =
    entityType === 'KINFOLK' ? kinfolkId.trim() : entityType === 'KIN' ? kinId.trim() : BUSINESS_ENTITY_ID;

  const entityIdError = touched && entityId === '' ? 'Choose a target before uploading.' : null;
  const fileError = touched && file === null ? 'Choose a photo or video to upload.' : null;

  const fileInputId = useId();
  const entityTypeId = useId();
  const kinfolkSelectId = useId();
  const kinIdInputId = useId();
  const businessIdInputId = useId();

  const closeUnlessBusy = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);

  async function handleUpload() {
    setTouched(true);
    if (file === null || entityId === '' || busy) return;
    setUploadError(null);
    setStage('signing');
    try {
      await uploadMediaFile({ file, entityType, entityId, onStage: setStage });
      setStage(null);
      onUploaded();
    } catch (err) {
      setUploadError(`Upload failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setStage(null);
    }
  }

  return (
    <Dialog
      title="Upload media"
      onClose={closeUnlessBusy}
      footer={
        <>
          <GhostButton label="Cancel" onClick={onClose} disabled={busy} />
          <PrimaryButton
            label={busy ? stageLabel(stage) : 'Upload'}
            onClick={() => void handleUpload()}
            disabled={busy}
            busy={busy}
          />
        </>
      }
    >
      <fieldset className="media-upload__fields" disabled={busy}>
        <legend className="media-upload__legend">Upload target</legend>

        <div className="media-upload__field">
          <label className="media-upload__label" htmlFor={entityTypeId}>
            Target type
          </label>
          <select
            id={entityTypeId}
            className="media-upload__select"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as UploadEntityType)}
          >
            <option value="KINFOLK">Household (Kinfolk)</option>
            <option value="KIN">Kin (pet)</option>
            <option value="BUSINESS">Company (no household)</option>
          </select>
        </div>

        {entityType === 'KINFOLK' && (
          <div className="media-upload__field">
            <label className="media-upload__label" htmlFor={kinfolkSelectId}>
              Household
            </label>
            {kinfolkOptions.length === 0 ? (
              <p className="media-upload__hint" role="alert">
                No households on file yet. Add one in Directory first.
              </p>
            ) : (
              <select
                id={kinfolkSelectId}
                className="media-upload__select"
                value={kinfolkId}
                onChange={(e) => setKinfolkId(e.target.value)}
                aria-invalid={entityIdError !== null}
              >
                {kinfolkOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {entityType === 'KIN' && (
          <div className="media-upload__field">
            <label className="media-upload__label" htmlFor={kinIdInputId}>
              Kin ID
            </label>
            <input
              id={kinIdInputId}
              type="text"
              className="media-upload__input"
              value={kinId}
              onChange={(e) => setKinId(e.target.value)}
              aria-invalid={entityIdError !== null}
              placeholder="e.g. pet_abc123"
            />
            <p className="media-upload__hint">Enter the kin&rsquo;s document ID (no picker for Kin yet).</p>
          </div>
        )}

        {entityType === 'BUSINESS' && (
          <div className="media-upload__field">
            <label className="media-upload__label" htmlFor={businessIdInputId}>
              Target ID
            </label>
            <input
              id={businessIdInputId}
              type="text"
              className="media-upload__input"
              value={BUSINESS_ENTITY_ID}
              readOnly
              disabled
            />
            <p className="media-upload__hint">Company media, not tied to any household.</p>
          </div>
        )}

        {entityIdError !== null && (
          <span className="media-upload__error" role="alert">
            {entityIdError}
          </span>
        )}

        <div className="media-upload__field">
          <label className="media-upload__label" htmlFor={fileInputId}>
            Photo or video
          </label>
          <input
            id={fileInputId}
            type="file"
            className="media-upload__input"
            accept="image/*,video/*"
            aria-invalid={fileError !== null}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file !== null && <p className="media-upload__hint">{file.name}</p>}
          {fileError !== null && (
            <span className="media-upload__error" role="alert">
              {fileError}
            </span>
          )}
        </div>
      </fieldset>

      {busy && (
        <p className="media-upload__stage" aria-live="polite">
          {stageLabel(stage)}
        </p>
      )}

      {uploadError !== null && (
        <p className="media-upload__banner" role="alert">
          {uploadError}
        </p>
      )}
    </Dialog>
  );
}
