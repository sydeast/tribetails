import { useState } from 'react';
import { Dialog } from './Dialog';
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
 * LEFT OUT, deliberately, not silently: Android Gallery's "Tag kin" hand-off
 * (`GalleryScreen.kt`'s `MediaViewerDialog` -> `TagKinDialog` -> `saveTags`).
 * There is no kin-tagging feature anywhere on web: no tag dialog, no
 * `taggedKinIds` on this admin's `MediaFile` (`api/gallery.ts`), no `saveTags`
 * callable wired to it. Building kin-tagging is a separate feature, not part of
 * restoring the missing click target (#388); this wires the viewer that
 * genuinely exists on both platforms today and reports the gap rather than
 * faking a "Tag kin" button with nothing behind it.
 *
 * Escape-to-close, backdrop-click-to-close, the Tab focus trap, and focus
 * restore to the tile that opened it are ALL `Dialog`'s job (components/
 * Dialog.tsx): this component supplies only the title and body, the same
 * division every other confirm/detail modal in this admin already uses.
 */
export function MediaViewerDialog({ media, onClose }: MediaViewerDialogProps) {
  const kind = mediaKindOf(str(media.fileType));
  const caption = mediaCaption(media);
  const meta = mediaMetaLine(str(media.uploadedAt), str(media.uploadedBy));
  const duration = kind === 'video' ? mediaDurationLabel(media.durationSeconds) : undefined;
  const title = caption !== '' ? caption : 'Media';

  return (
    <Dialog title={title} onClose={onClose} size="wide">
      <div className="media-viewer">
        <ViewerStage kind={kind} url={mediaKindHasPreview(kind) ? mediaViewerUrl(media) : undefined} label={title} />
        {kind === 'video' && (
          <p className="media-viewer__hint">Video preview only. Open the original to play it.</p>
        )}
        {(meta !== '' || duration !== undefined) && (
          <p className="media-viewer__meta">
            {[meta, duration !== undefined ? `Duration ${duration}` : ''].filter((s) => s !== '').join(' · ')}
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
 * Document/audio, and the degenerate row this port must not crash on (a
 * `media_files` doc with no `fileType`, no caption, and no preview URL at
 * all — see #388), all resolve to `url === undefined` here, which renders the
 * glyph fallback below rather than an empty `<img>`.
 */
function ViewerStage({ kind, url, label }: { kind: MediaKind; url: string | undefined; label: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = url !== undefined && failedUrl !== url;

  return (
    <div className="media-viewer__stage">
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
