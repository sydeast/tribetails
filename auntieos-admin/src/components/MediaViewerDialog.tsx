import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Dialog } from './Dialog';
import { PrimaryButton, GhostButton } from './Buttons';
import { updateMediaCaption, mediaWriteErrorMessage, MAX_CAPTION_LENGTH } from '../api/mediaWrite';
import {
  mediaKindOf,
  mediaKindHasPreview,
  mediaViewerUrl,
  mediaCaption,
  mediaMetaLine,
  mediaDurationLabel,
  type MediaKind,
} from '../lib/mediaFormat';
import { str } from '../lib/coerce';
import { type MediaFile } from '../api/gallery';
import './MediaViewerDialog.css';

export interface MediaViewerDialogProps {
  media: MediaFile;
  onClose: () => void;
  /**
   * Display names of the kin tagged in this file, already resolved by the
   * caller (the screen that holds the kin roster). `[]` means nobody is
   * tagged, and the line simply does not render.
   */
  taggedNames?: string[];
  /**
   * Hands off to the tag dialog (#447). OPTIONAL, and its absence is the whole
   * point: Android offers "Tag kin" from the GLOBAL Gallery's viewer
   * (`GalleryScreen.kt`) and not from the entity-scoped one
   * (`MediaGalleryScreen.kt`'s `FullscreenMediaViewer`), so `Gallery.tsx`
   * passes this and `Media.tsx` deliberately does not. A prop rather than a
   * hardcoded button is what keeps that difference exact, instead of inventing
   * a tagging affordance on a screen Android never gave one.
   */
  onTagKin?: () => void;
}

/**
 * The fullscreen/lightbox viewer a Gallery or Media grid tile opens, closing
 * #388 ("tapping a photo does nothing, on web only"). Ports Android's two
 * click-to-open viewers: `MediaGalleryScreen.kt`'s `FullscreenMediaViewer`
 * (`:441`, reached from `Media.tsx`'s entity-scoped grid) and
 * `GalleryScreen.kt`'s `MediaViewerDialog` (`:305`, reached from `Gallery.tsx`'s
 * global grid). Both Android viewers show the same thing for image/video
 * (the full-resolution `storageUrl`, falling back to `thumbnailUrl`, via
 * `mediaViewerUrl`) and a type glyph plus filename for document/audio, so one
 * shared component serves both web screens rather than two near-duplicates.
 *
 * KIN TAGGING (#447) now exists on web too, and this viewer is where Android
 * hands off to it. `#388` shipped without it because there was nothing behind
 * the button -- no `taggedKinIds` on this admin's `MediaFile`, no dialog, and no
 * callable anywhere for ANY client (Android wrote the field straight to
 * Firestore). All three exist now, so the hand-off is real: `onTagKin` closes
 * this viewer and opens `TagKinDialog`, exactly as `GalleryScreen.kt` does.
 *
 * CAPTION EDITING (#397 S3) lives here, and deliberately not on the tile. It is
 * the one surface both grids share, so putting it here closes the gap on the
 * global Gallery and the entity-scoped Media screen in one place; it is also
 * where the operator can actually SEE the photo they are describing, which a
 * 132px thumbnail is not. Neither web nor Android could fix a caption before
 * this: every client wrote `description` once, at upload, and never again.
 * `api/mediaWrite.ts#updateMediaCaption` is a direct single-key `updateDoc`,
 * which is what `firestore.rules` already allows, see that file for why this
 * one is not a callable when its two neighbours are.
 *
 * NO MOCK COVERS THIS. `auntieos-admin/ui-ideas/auntieos-media-gallery-*.html`
 * draws the grid, the delete X and its confirm dialog, and a read-only hover
 * caption strip; it has no caption-editing control anywhere. The editor below
 * follows the shared `Dialog` + form-field conventions the rest of this admin
 * already uses rather than inventing a shape the mock never proposed.
 *
 * Escape-to-close, backdrop-click-to-close, the Tab focus trap, and focus
 * restore to the tile that opened it are ALL `Dialog`'s job (components/
 * Dialog.tsx): this component supplies only the title and body, the same
 * division every other confirm/detail modal in this admin already uses.
 */
export function MediaViewerDialog({
  media,
  onClose,
  taggedNames = [],
  onTagKin,
}: MediaViewerDialogProps) {
  const kind = mediaKindOf(str(media.fileType));
  /**
   * #397 S3. The description as it stands RIGHT NOW, which is the prop until
   * this dialog itself changes it.
   *
   * Why local state rather than reading the prop back: the grids hold the
   * opened row as a value (`useState<MediaFile | null>`), so the copy this
   * dialog was handed does not update when the Firestore listener delivers the
   * edited document. The tile behind the dialog DOES update, live. Without this
   * the operator would save a caption, watch the grid change, and see the open
   * viewer still showing the old words, which reads as a failed save.
   */
  const [savedDescription, setSavedDescription] = useState<string | null>(null);
  const shown: MediaFile =
    savedDescription === null ? media : { ...media, description: savedDescription };

  const caption = mediaCaption(shown);
  const meta = mediaMetaLine(str(media.uploadedAt), str(media.uploadedBy));
  const duration = kind === 'video' ? mediaDurationLabel(media.durationSeconds) : undefined;
  const title = caption !== '' ? caption : 'Media';

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const captionInputId = useId();

  /**
   * #691, "cannot view the entire photo". The stage no longer caps itself at
   * 512px, and these two states are the rest of the answer: the Fullscreen API
   * when the browser has it, and a near-viewport modal when it does not.
   *
   * `expanded` is the fallback, and it is deliberately a SECOND state rather
   * than a value derived from `nativeFullscreen`: a browser that refuses the
   * request (an iframe with no `allow="fullscreen"`, a permission policy, iOS
   * Safari, which has never implemented `Element.requestFullscreen`) must still
   * get a bigger picture out of the button, not a control that does nothing.
   */
  const stageRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);

  // The browser owns this state, so it is read back from the browser rather than
  // assumed on click: Escape and the browser's own exit affordance both leave
  // fullscreen without telling this component, and a label that then still said
  // "Exit fullscreen" would be lying about where the user is.
  useEffect(() => {
    function sync() {
      setNativeFullscreen(
        stageRef.current !== null && document.fullscreenElement === stageRef.current,
      );
    }
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  function toggleFullscreen() {
    const el = stageRef.current;
    if (nativeFullscreen) {
      // Ignoring the rejection is the right thing: the only failure mode is
      // "already not fullscreen", which is the state the caller asked for.
      if (typeof document.exitFullscreen === 'function') {
        void document.exitFullscreen().catch(() => undefined);
      }
      return;
    }
    if (el !== null && typeof el.requestFullscreen === 'function') {
      void el.requestFullscreen().then(
        () => undefined,
        // Refused. Fall back rather than leaving the operator with a button
        // that swallowed their click.
        () => setExpanded(true),
      );
      return;
    }
    setExpanded((wasExpanded) => !wasExpanded);
  }

  const bigger = nativeFullscreen || expanded;
  /**
   * The full-resolution file itself, for the "Open original" link. Only ever
   * offered for a kind that HAS a frame to open: a document or audio row has no
   * viewer URL, and a link labelled "Open original" that led nowhere would be
   * worse than no link.
   */
  const originalUrl = mediaKindHasPreview(kind) ? mediaViewerUrl(shown) : undefined;

  function startEditing() {
    // Seeds from the stored `description`, NOT from `mediaCaption`: the caption
    // shown falls back to the original filename, and pre-filling the editor with
    // "IMG_4821.jpg" would turn a fallback the operator never typed into a real
    // stored caption the first time they hit Save.
    setDraft(str(shown.description));
    setSaveError(null);
    setEditing(true);
  }

  async function saveCaption() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateMediaCaption(media._id, draft);
      setSavedDescription(draft.trim());
      setEditing(false);
    } catch (err) {
      // The draft is kept exactly as typed: a failed save must not eat the words.
      setSaveError(mediaWriteErrorMessage(err, 'Saving the caption'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      size={bigger ? 'full' : 'wide'}
      footer={
        <>
          {!editing && <GhostButton label="Edit caption" onClick={startEditing} />}
          {onTagKin && <PrimaryButton label="Tag kin" onClick={onTagKin} />}
        </>
      }
    >
      <div className="media-viewer" data-expanded={bigger}>
        <ViewerStage
          kind={kind}
          url={originalUrl}
          label={title}
          stageRef={stageRef}
          fullscreen={bigger}
          onToggleFullscreen={toggleFullscreen}
        />
        <div className="media-viewer__stage-footer">
          {kind === 'video' && (
            <p className="media-viewer__hint">Video preview only. Open the original to play it.</p>
          )}
          {/*
            #691. The stage shows the whole frame, letterboxed, at whatever size
            the viewport allows; this is the way out to the file itself, at its
            own resolution, in a tab the browser can zoom and save. Videos have
            been pointed at "the original" in prose since this viewer shipped
            with nothing to point AT, so the link serves both kinds.
          */}
          {originalUrl !== undefined && (
            <a
              className="media-viewer__original"
              href={originalUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open original
            </a>
          )}
        </div>

        {editing && (
          <div className="media-viewer__caption-editor">
            <label className="media-viewer__caption-label" htmlFor={captionInputId}>
              Caption
            </label>
            <textarea
              id={captionInputId}
              className="media-viewer__caption-input"
              value={draft}
              maxLength={MAX_CAPTION_LENGTH}
              rows={3}
              disabled={saving}
              onChange={(e) => setDraft(e.target.value)}
            />
            <p className="media-viewer__caption-hint">
              Leave it empty to go back to showing the file name.
            </p>
            <div className="media-viewer__caption-actions">
              <GhostButton label="Cancel" onClick={() => setEditing(false)} disabled={saving} />
              <PrimaryButton
                label={saving ? 'Saving…' : 'Save caption'}
                onClick={() => void saveCaption()}
                disabled={saving}
                busy={saving}
              />
            </div>
            {saveError !== null && (
              <p className="media-viewer__caption-error" role="alert">
                {saveError}
              </p>
            )}
          </div>
        )}
        {(meta !== '' || duration !== undefined) && (
          <p className="media-viewer__meta">
            {[meta, duration !== undefined ? `Duration ${duration}` : ''].filter((s) => s !== '').join(' · ')}
          </p>
        )}
        {/*
          Who is in the photo, spelled out. Android's viewer shows the same
          line under the frame. Rendered only when there IS someone: an empty
          "Tagged kin:" label would read as a failed lookup rather than as
          nobody having been tagged yet, and the "Tag kin" button below already
          says the affordance exists.
        */}
        {taggedNames.length > 0 && (
          <p className="media-viewer__tags">
            <span className="media-viewer__tags-label">Tagged kin</span> {taggedNames.join(', ')}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The image stage. Deliberately its own small state machine rather than a
 * reuse of `components/Avatar.tsx`: the grid tile's Avatar crops to a square
 * (`object-fit: cover`, right for a thumbnail), while a fullscreen viewer must
 * show the WHOLE frame letterboxed (`object-fit: contain`), matching Android's
 * `FullscreenMediaViewer`'s `ContentScale.Fit` exactly (its own doc comment:
 * "so tall portraits and wide landscapes show end-to-end... rather than being
 * cropped"). Tracks which url failed (not a bare boolean) for the same reason
 * Avatar does: a changed media prop must get its own load attempt.
 *
 * #691. The stage used to be `height: min(60vh, 32rem)`, which boxed a 1080px
 * photo into about 512px on a laptop and offered no way out of it. It now takes
 * the viewport height less the dialog's own chrome, and carries the fullscreen
 * toggle below, so "cannot view the entire photo" has three answers: a bigger
 * stage, a real fullscreen element, and the "Open original" link beneath it.
 *
 * Document/audio, and the degenerate row this port must not crash on (a
 * `media_files` doc with no `fileType`, no caption, and no preview URL at
 * all — see #388), all resolve to `url === undefined` here, which renders the
 * glyph fallback below rather than an empty `<img>`.
 */
function ViewerStage({
  kind,
  url,
  label,
  stageRef,
  fullscreen,
  onToggleFullscreen,
}: {
  kind: MediaKind;
  url: string | undefined;
  label: string;
  stageRef: RefObject<HTMLDivElement | null>;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = url !== undefined && failedUrl !== url;

  return (
    <div className="media-viewer__stage" ref={stageRef}>
      {/*
        #691. INSIDE the stage, not in the dialog footer, and that is the whole
        reason it is positioned rather than laid out: when the Fullscreen API
        promotes this element, nothing outside it is painted, so a toggle in the
        footer would vanish at the exact moment it started working, leaving no
        way back but Escape.
      */}
      <button
        type="button"
        className="media-viewer__fullscreen-toggle"
        aria-pressed={fullscreen}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      </button>
      {showImage && url !== undefined ? (
        <img
          className="media-viewer__image"
          src={url}
          alt={label}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <span className="media-viewer__fallback" role="img" aria-label={label}>
          <ViewerGlyph kind={kind} />
        </span>
      )}
      {kind === 'video' && showImage && (
        <span className="media-viewer__play" aria-hidden="true">
          <PlayGlyph />
        </span>
      )}
    </div>
  );
}

/**
 * The viewer's own type-glyph selection. Not imported from Gallery.tsx/
 * Media.tsx (each already duplicates its own copy of the same five glyphs, the
 * pre-existing convention this file follows rather than changes): a document
 * or audio row gets its OWN icon so a failed image and a genuinely
 * non-visual file type stay visually distinct, same discipline as those
 * screens' own `TypeGlyph`.
 */
function ViewerGlyph({ kind }: { kind: MediaKind }) {
  switch (kind) {
    case 'video':
      return <PlayGlyph />;
    case 'document':
      return <DocumentGlyph />;
    case 'audio':
      return <AudioGlyph />;
    case 'image':
    case 'other':
      return <BrokenImageGlyph />;
  }
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function DocumentGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
      <path d="M8 13h8M8 17h8" strokeLinecap="round" />
    </svg>
  );
}

function AudioGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" fill="currentColor" aria-hidden="true">
      <path d="M9 17V5l11-2v12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="15.5" r="2.5" />
    </svg>
  );
}

function BrokenImageGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none" />
      <path d="M4 17l5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 21 21 3" strokeLinecap="round" />
    </svg>
  );
}
