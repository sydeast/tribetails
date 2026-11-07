import { useCallback, useId, useMemo, useState } from 'react';
import { uploadMediaFile, BUSINESS_ENTITY_ID, type UploadEntityType, type UploadStage } from '../api/mediaUpload';
import { uploadFileError, MAX_UPLOAD_BYTES, formatMegabytes } from '../lib/mediaUploadLimits';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import './MediaUploadDialog.css';

export interface KinfolkOption {
  id: string;
  label: string;
}
/**
 * One pet the KIN target can attach a file to (#1588). `kinfolkId` is its
 * household, which does two jobs: it narrows the kin picker to the household
 * chosen above it, and it is stamped on the saved `media_files` row so the
 * tag dialog later scopes to that household instead of the whole roster.
 */
export interface KinOption {
  id: string;
  label: string;
  kinfolkId: string;
}

/**
 * A target the CALLER already knows, so the dialog does not ask (#397 S1).
 *
 * `screens/Media.tsx` is opened at `#/media/{type}/{id}`: the entity is the
 * whole reason that screen exists, and asking "which household?" on a screen
 * already titled with one is a question with exactly one right answer and
 * several wrong ones an operator can pick by accident. The global Gallery spans
 * every entity and has no such answer, so it keeps the picker.
 *
 * `entityType` is the UPLOAD enum (`KIN` / `KINFOLK`), which the caller derives
 * from its route. It is neither the route's own `{type}` segment (`kin` /
 * `household`) nor a stored row's `entityType`.
 */
export interface FixedUploadTarget {
  entityType: UploadEntityType;
  entityId: string;
  /** What to call this target on screen, e.g. "Kin" or "Household". */
  label: string;
}

interface MediaUploadDialogProps {
  /**
   * The household roster, for the KINFOLK target's picker (already streamed by
   * Gallery.tsx; no separate fetch here). Safely omitted when `fixedTarget` is
   * set: there is nothing left to pick.
   */
  kinfolkOptions?: KinfolkOption[];
  /**
   * The kin roster, for the KIN target's second picker (#1588). Narrowed to the
   * household picked above it, here, so the rule lives in one place.
   */
  kinOptions?: KinOption[];
  /** True while the kin stream is still resolving: an empty list then is "not loaded yet", not "no kin". */
  kinLoading?: boolean;
  /** Non-null when the kin stream FAILED, so an empty list is unknown rather than "this household has no kin". */
  kinError?: string | null;
  /** Uploads straight to this entity, with no target picker at all. See {@link FixedUploadTarget}. */
  fixedTarget?: FixedUploadTarget;
  onClose: () => void;
  /**
   * Called once the doc actually lands in `media_files`, with its new document
   * id.
   *
   * The gallery callers ignore the argument, because their own `useCollection`
   * listener picks the row up live and this callback only closes the dialog.
   * The KinTale composer cannot: a photo is attached to a tale by pushing its
   * id onto `kin_care_reports.mediaFileIds`, so it needs the id the write
   * produced. Passing it costs the existing callers nothing, a zero-argument
   * handler being assignable to this type.
   */
  onUploaded: (mediaFileId: string) => void;
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
 * shape `AddKinfolkDialog`/`FormSchemas`' delete-confirm already use.
 *
 * Targets one of three entities (`api/mediaUpload.ts#UploadEntityType`):
 *   KINFOLK   picked from the already-streamed household roster (a real
 *             picker, never free-text, since the whole roster is on hand).
 *   KIN       a household picker, then a picker of THAT household's kin
 *             (#1588). The kin document id was a typed box until then, and no
 *             screen showed an id to type. The household starts unchosen on
 *             purpose, so a pet cannot be filed under the wrong family by
 *             accepting a default. The saved row carries the household's id
 *             as `kinfolkId`, which is what scopes Tag kin later.
 *   BUSINESS  labeled "Company (no household)": the fixed `business_settings`
 *             id (Android's own `AdminSettingsViewModel#uploadLogo`
 *             constant), shown read-only since there is nothing to pick. This
 *             is the operator's way to upload media that isn't about any one
 *             household (operator ruling 2026-07-31: Kinfolk do not "own"
 *             media). `writeMediaFileDoc` omits `kinfolkId` entirely for this
 *             target, never stamps it blank.
 *
 * With a `fixedTarget` (#397 S1, `screens/Media.tsx`) none of those three
 * choices is offered: the entity comes from the route and the dialog states it
 * instead of asking. The picker branches above stay for the global Gallery,
 * which genuinely has a choice to make.
 *
 * FILE VALIDATION happens at PICK time (`lib/mediaUploadLimits.ts`), matching
 * the caps Android has enforced all along: image/* or video/*, non-empty, at
 * most 50MB. A refused file is not held at all, so "Upload" cannot send it.
 *
 * Fail-loud + disabled-while-busy: the fieldset locks during the upload, the
 * Dialog cannot be dismissed mid-upload, and a rejected upload at ANY of the
 * three pipeline stages (sign / Cloudinary / Firestore write) replaces
 * nothing, it surfaces the failing stage's message and leaves the form
 * exactly as the operator left it, mirroring `AddKinfolkDialog`'s
 * `saveError` convention.
 */
export function MediaUploadDialog({
  kinfolkOptions = [],
  kinOptions = [],
  kinLoading = false,
  kinError = null,
  fixedTarget,
  onClose,
  onUploaded,
}: MediaUploadDialogProps) {
  const [pickedType, setPickedType] = useState<UploadEntityType>('KINFOLK');
  const [kinfolkId, setKinfolkId] = useState(kinfolkOptions[0]?.id ?? '');
  const [kinHouseholdId, setKinHouseholdId] = useState('');
  const [kinId, setKinId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  /**
   * Why the rejected file's own message is kept in state rather than recomputed
   * from `file`: a refused file is NOT held (`file` stays null, so no accidental
   * upload of it is possible), and without this the operator would see the
   * generic "Choose a photo or video" hint and no explanation of what was wrong
   * with the one they just chose.
   */
  const [rejectedFileError, setRejectedFileError] = useState<string | null>(null);

  const [stage, setStage] = useState<UploadStage | null>(null);
  const [touched, setTouched] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const busy = stage !== null;

  const entityType = fixedTarget?.entityType ?? pickedType;
  const entityId = fixedTarget
    ? fixedTarget.entityId.trim()
    : entityType === 'KINFOLK'
      ? kinfolkId.trim()
      : entityType === 'KIN'
        ? kinId.trim()
        : BUSINESS_ENTITY_ID;

  const householdKin = useMemo(
    () => (kinHouseholdId === '' ? [] : kinOptions.filter((k) => k.kinfolkId === kinHouseholdId)),
    [kinOptions, kinHouseholdId],
  );
  const entityIdError =
    touched && entityId === ''
      ? entityType === 'KIN'
        ? kinHouseholdId === ''
          ? 'Choose a household, then a kin.'
          : 'Choose a kin before uploading.'
        : 'Choose a target before uploading.'
      : null;
  const fileError =
    rejectedFileError ?? (touched && file === null ? 'Choose a photo or video to upload.' : null);

  /**
   * Validates at PICK time, not at upload time, so a 400MB file is refused
   * instantly instead of after a sign round-trip and however long the browser
   * spends pushing it at Cloudinary. `accept` on the input is only a picker
   * hint, "All files" and drag-and-drop both walk straight past it, so this
   * is the real gate. See `lib/mediaUploadLimits.ts` for the Android limits it
   * mirrors.
   */
  function chooseFile(next: File | null) {
    setUploadError(null);
    if (next === null) {
      setFile(null);
      setRejectedFileError(null);
      return;
    }
    const problem = uploadFileError(next);
    if (problem !== null) {
      setFile(null);
      setRejectedFileError(problem);
      return;
    }
    setFile(next);
    setRejectedFileError(null);
  }

  const fileInputId = useId();
  const entityTypeId = useId();
  const kinfolkSelectId = useId();
  const kinHouseholdSelectId = useId();
  const kinSelectId = useId();
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
      const mediaFileId = await uploadMediaFile({
        file,
        entityType,
        entityId,
        ...(entityType === 'KIN' ? { kinfolkId: kinHouseholdId } : {}),
        onStage: setStage,
      });
      setStage(null);
      onUploaded(mediaFileId);
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

        {fixedTarget !== undefined ? (
          /*
            The target is settled by the route, so it is STATED, not asked. Kept
            visible rather than dropped entirely: an operator about to send a
            file somewhere should be able to read where it is going, and a
            silently-assumed destination is how media ends up on the wrong
            household with nothing on screen to have caught it.
          */
          <p className="media-upload__fixed-target">
            Uploading to <strong>{fixedTarget.label}</strong>
          </p>
        ) : (
          <div className="media-upload__field">
            <label className="media-upload__label" htmlFor={entityTypeId}>
              Target type
            </label>
            <select
              id={entityTypeId}
              className="media-upload__select"
              value={entityType}
              onChange={(e) => {
                setPickedType(e.target.value as UploadEntityType);
                // The "Choose a target" message belongs to the type that was
                // showing when Upload was pressed; carrying it over to a new
                // type said the operator had picked nothing when they just had.
                setTouched(false);
              }}
            >
              <option value="KINFOLK">Household (Kinfolk)</option>
              <option value="KIN">Kin (pet)</option>
              <option value="BUSINESS">Company (no household)</option>
            </select>
          </div>
        )}

        {fixedTarget === undefined && entityType === 'KINFOLK' && (
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

        {fixedTarget === undefined && entityType === 'KIN' && (
          <>
            <div className="media-upload__field">
              <label className="media-upload__label" htmlFor={kinHouseholdSelectId}>
                Kin&rsquo;s household
              </label>
              {kinfolkOptions.length === 0 ? (
                <p className="media-upload__hint" role="alert">
                  No households on file yet. Add one in Directory first.
                </p>
              ) : (
                <select
                  id={kinHouseholdSelectId}
                  className="media-upload__select"
                  value={kinHouseholdId}
                  onChange={(e) => {
                    setKinHouseholdId(e.target.value);
                    setKinId('');
                  }}
                  aria-invalid={entityIdError !== null && kinHouseholdId === ''}
                >
                  <option value="">Choose a household</option>
                  {kinfolkOptions.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="media-upload__field">
              <label className="media-upload__label" htmlFor={kinSelectId}>
                Kin
              </label>
              {kinLoading ? (
                <p className="media-upload__hint" aria-live="polite">
                  Loading kin…
                </p>
              ) : kinError !== null ? (
                <p className="media-upload__error" role="alert">
                  Couldn&rsquo;t load the kin roster: {kinError}
                </p>
              ) : kinHouseholdId !== '' && householdKin.length === 0 ? (
                <p className="media-upload__hint">No kin on this household yet.</p>
              ) : (
                <select
                  id={kinSelectId}
                  className="media-upload__select"
                  value={kinId}
                  disabled={kinHouseholdId === ''}
                  onChange={(e) => setKinId(e.target.value)}
                  aria-invalid={entityIdError !== null && kinHouseholdId !== ''}
                >
                  <option value="">{kinHouseholdId === '' ? 'Choose a household first' : 'Choose a kin'}</option>
                  {householdKin.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </>
        )}
        {fixedTarget === undefined && entityType === 'BUSINESS' && (
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
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
          />
          <p className="media-upload__hint">
            Photos and videos up to {formatMegabytes(MAX_UPLOAD_BYTES)}.
          </p>
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
