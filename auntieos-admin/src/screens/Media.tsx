import { useMemo, useState } from 'react';
import { mediaTargetQuery, type MediaFile } from '../api/media';
import {
  isBlankTargetId,
  targetTypeLabel,
  withMediaDefaults,
  type MediaTargetType,
} from '../lib/mediaScopeFormat';
import {
  mediaKindOf,
  mediaKindHasPreview,
  mediaPreviewUrl,
  mediaCaption,
  mediaMetaLine,
  mediaDurationLabel,
  galleryFileTypes,
  type MediaKind,
} from '../lib/mediaFormat';
import { useCollection } from '../lib/firestore';
import { deleteMediaFile, setMediaProfilePhoto, mediaWriteErrorMessage } from '../api/mediaWrite';
import { type UploadEntityType } from '../api/mediaUpload';
import { str } from '../lib/coerce';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { Banner } from '../components/Banner';
import { Dialog } from '../components/Dialog';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import { MediaUploadDialog } from '../components/MediaUploadDialog';
import { MediaViewerDialog } from '../components/MediaViewerDialog';
import './Media.css';

/**
 * Media, the CONTEXTUAL single-entity gallery, ported from the wasm
 * `MediaGalleryScreen.kt` (reached via `#/media/{type}/{id}`, `Route.kt`'s
 * `MediaGallery` destination).
 *
 * This began as a READ/GRID-ONLY port. Issue #397 S1/S2 closed the three gaps
 * that left, all of which Android's `MediaGalleryScreen.kt` had shipped for
 * as long as the screen has existed:
 *
 *   UPLOAD          the mock's `＋ Upload Media` action, opening the shared
 *                   `MediaUploadDialog` with the target FIXED from the route.
 *                   Android's own upload dialog does not ask which entity
 *                   either: it is handed `entityId`/`entityType` by the screen.
 *   DELETE          the mock's per-tile top-end X plus its confirm dialog,
 *                   whose copy ("Delete Media" / "Are you sure you want to
 *                   delete this {fileType lowercased}?" / Delete / Cancel) is
 *                   the mock's, verbatim. Goes through the `deleteMediaFile`
 *                   callable, not a client `deleteDoc`, see
 *                   `api/mediaWrite.ts` for the profile-photo invariant that
 *                   forces it server-side.
 *   SET AS PROFILE  Android's per-tile action at the same anchor as the profile
 *                   badge, through the `setMediaProfilePhoto` callable.
 *
 * CAPTION EDITING (#397 S3) is real now too, but it lives in the shared
 * `MediaViewerDialog` a tile opens, not on the tile: see that component.
 *
 * STILL OUT OF SCOPE, flagged rather than silently dropped:
 *   - A household filter row. `Gallery.tsx`'s grid offers one because it spans
 *     every household; this screen is already scoped to exactly one
 *     kin/household, so a second household axis would be meaningless here.
 *
 * EVERY CALLABLE ARGUMENT COMES OFF THE ROW, never off the route. Both media
 * callables cross-check the caller's entity against the stored document and
 * refuse a mismatch, and the route's `{type}` segment is `household` where the
 * document says `KINFOLK` (see `api/media.ts`'s header on the casing in the
 * wild). The route decides only where an UPLOAD goes, because for an upload
 * there is no stored document to ask yet.
 */
export interface MediaProps {
  /**
   * The route's `{type}` segment (`#/media/{type}/{id}`). Used for heading copy
   * only today (`targetTypeLabel`): see `api/media.ts`'s file header for why
   * this value is not applied as a second server-side/client-side filter.
   */
  targetType: MediaTargetType;
  /**
   * The route's `{id}` segment: the kin or household's document id. A route
   * that resolves with no id (or a blank one) must show the state below, never
   * a crash and never every row in `media_files` (see `mediaTargetQuery`'s
   * sentinel).
   */
  targetId: string;
}

export function Media({ targetType, targetId }: MediaProps) {
  const hasTarget = !isBlankTargetId(targetId);
  const label = targetTypeLabel(targetType);
  const spec = useMemo(() => mediaTargetQuery(targetId), [targetId]);
  // Always subscribed (hooks run unconditionally), but `mediaTargetQuery`'s own
  // sentinel keeps a blank/missing id from ever matching a real document, and
  // the render below never reads `mediaState` unless `hasTarget` is true.
  const mediaState = useCollection<MediaFile>(spec);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // The fullscreen viewer a tile opens (#388). See Gallery.tsx's identical
  // state for why this holds the row itself, not just an id.
  const [viewerMedia, setViewerMedia] = useState<MediaFile | null>(null);

  // #397 S1/S2.
  const [uploadOpen, setUploadOpen] = useState(false);
  /** The row whose delete confirm is open. Holds the ROW, so the dialog can name its file type the way the mock's body copy does. */
  const [pendingDelete, setPendingDelete] = useState<MediaFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The row whose "set as profile" call is in flight, so exactly that tile shows the busy state. */
  const [promotingId, setPromotingId] = useState<string | null>(null);
  /**
   * A failed delete or promote, shown as a banner above the grid.
   *
   * Not folded into `mediaState`'s error: that state describes the LISTENER,
   * and blanking a working grid because one action was refused would hide the
   * very rows the operator needs to see to understand what happened.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * Where an upload from this screen goes. The route's `{type}` segment is the
   * ONLY input, because an upload has no stored document to read an entity off
   * yet, which is exactly why this mapping is written out rather than inferred:
   * `household` is the route's word for what the upload pipeline calls KINFOLK.
   */
  const uploadEntityType: UploadEntityType = targetType === 'household' ? 'KINFOLK' : 'KIN';

  async function confirmDelete() {
    if (pendingDelete === null || deleting) return;
    const target = pendingDelete;
    setDeleting(true);
    setActionError(null);
    try {
      // The row's own entityId, as the scope cross-check. `targetId` is the same
      // value for every row this query returned, but the ROW is what the server
      // compares against, so the row is what gets sent.
      await deleteMediaFile(target._id, str(target.entityId));
      // No optimistic splice: the `media_files` listener removes the tile
      // because the DOCUMENT went, not because this screen edited a local copy.
      // A delete that half-succeeded therefore looks like what it is.
      setPendingDelete(null);
      if (viewerMedia?._id === target._id) setViewerMedia(null);
    } catch (err) {
      setActionError(mediaWriteErrorMessage(err, 'Deleting this file'));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function promoteToProfile(media: MediaFile) {
    if (promotingId !== null) return;
    setPromotingId(media._id);
    setActionError(null);
    try {
      await setMediaProfilePhoto(media._id, str(media.entityType), str(media.entityId));
    } catch (err) {
      setActionError(mediaWriteErrorMessage(err, 'Setting the profile photo'));
    } finally {
      setPromotingId(null);
    }
  }

  /**
   * The mock's top-bar count chip. Rendered ONLY from a resolved read: while the
   * stream is loading, after it failed, or before a target is chosen there is no
   * number anyone has actually read, and the chip stays away rather than
   * printing a confident 0 (the same refusal `DenScreenKit`'s StatCard encodes
   * after the 2026-07-15 "Open bookings: 0" incident). It counts the whole
   * stream, never the filtered slice: the filter is a view over the total.
   */
  const total = hasTarget && mediaState.status === 'ready' ? mediaState.data.length : null;

  const headingProps = {
    kicker: 'The Den · Media',
    title: label,
    accentTail: 'media.',
    ...(hasTarget
      ? { subtitle: `Photos, videos, and files uploaded for this ${label.toLowerCase()}.` }
      : {}),
    ...(total !== null && total > 0 ? { trailing: <MediaCountChip total={total} /> } : {}),
  };

  return (
    <div className="screen">
      <DenScreenHeading {...headingProps} />

      {!hasTarget ? (
        <p className="media__hint" role="status">
          No {label.toLowerCase()} selected. Open Media from a {label.toLowerCase()} record to see
          its files here.
        </p>
      ) : (
        <>
          {/* The mock's `＋ Upload Media` top-bar action. Placed in its own row
              rather than the heading's `trailing` slot, which the count chip
              already holds, the same actions-row shape Gallery.tsx uses. */}
          <div className="media__actions">
            <PrimaryButton label="Upload media" onClick={() => setUploadOpen(true)} />
          </div>

          {actionError !== null && (
            <Banner tone="error" title="That didn&rsquo;t go through">
              {actionError}
            </Banner>
          )}

          <AsyncRegion
            state={mediaState}
            what="media"
            isEmpty={(rows) => rows.length === 0}
            loading={<p className="media__hint">Loading media…</p>}
            empty={
              <p className="media__hint">
                No media on file for this {label.toLowerCase()} yet. Upload photos and videos to see
                them here.
              </p>
            }
          >
            {(rows) => (
              <MediaGrid
                rows={rows}
                typeFilter={typeFilter}
                onTypeFilterChange={setTypeFilter}
                onOpen={setViewerMedia}
                onDelete={setPendingDelete}
                onSetProfile={(m) => void promoteToProfile(m)}
                promotingId={promotingId}
              />
            )}
          </AsyncRegion>
        </>
      )}

      {viewerMedia && <MediaViewerDialog media={viewerMedia} onClose={() => setViewerMedia(null)} />}

      {uploadOpen && (
        <MediaUploadDialog
          fixedTarget={{ entityType: uploadEntityType, entityId: targetId, label }}
          onClose={() => setUploadOpen(false)}
          // Closing is the whole job: the grid's own `media_files` listener
          // delivers the new row, so the tile appears because the DOCUMENT
          // landed, not because this screen guessed that it did.
          onUploaded={() => setUploadOpen(false)}
        />
      )}

      {pendingDelete && (
        <Dialog
          // Copy below is the mock's, verbatim (auntieos-media-gallery-*.html:
          // "Delete Media" / "Are you sure you want to delete this {fileType
          // lowercased}?" / Delete / Cancel), which is also Android's
          // AlertDialog copy. Two clients and one mock already agree; this is
          // not the place to invent a third wording.
          title="Delete Media"
          onClose={() => {
            if (!deleting) setPendingDelete(null);
          }}
          footer={
            <>
              <GhostButton label="Cancel" onClick={() => setPendingDelete(null)} disabled={deleting} />
              <PrimaryButton
                label={deleting ? 'Deleting…' : 'Delete'}
                onClick={() => void confirmDelete()}
                disabled={deleting}
                busy={deleting}
              />
            </>
          }
        >
          <p className="media__dialog-body">
            Are you sure you want to delete this {deleteKindWord(pendingDelete)}?
          </p>
          {/* Said plainly, because it is true and because an operator who
              expects a recycle bin will not find one. The Cloudinary original
              is a separate question the app deliberately does not answer here
              (see functions/src/admin/deleteMediaFile.ts). */}
          <p className="media__dialog-hint">This removes it from the gallery and cannot be undone.</p>
          {pendingDelete.isProfilePhoto && (
            <p className="media__dialog-hint">
              This is the current profile photo. Deleting it leaves this {label.toLowerCase()}{' '}
              without one until another is chosen.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

/**
 * "image" / "video" / "file" for the confirm dialog's body, mirroring the
 * mock's `{fileType lowercased}` and Android's identical
 * `mediaFile.fileType.name.lowercase()`.
 *
 * Goes through `mediaKindOf` rather than lower-casing the raw string: a row
 * whose `fileType` is missing or unrecognised would otherwise produce "delete
 * this ?", and this dialog's whole job is to say clearly what is about to be
 * destroyed.
 */
function deleteKindWord(media: MediaFile): string {
  const kind = mediaKindOf(str(media.fileType));
  switch (kind) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio file';
    case 'document':
      return 'document';
    case 'other':
      return 'file';
  }
}

/**
 * The mono count chip beside the title (the mock's `.count`). Purely a
 * presentation of a number the caller already proved it read: this component
 * has no fallback of its own, because the only safe fallback is not rendering.
 */
function MediaCountChip({ total }: { total: number }) {
  return (
    <span className="media__count-chip">
      {/* A <span>, not the mock's <em>: the number is accent-coloured, but it is
          not emphasis, and a screen reader should not stress it. */}
      <span className="media__count-chip-n">{total}</span> {total === 1 ? 'file' : 'files'}
    </span>
  );
}

interface MediaGridProps {
  rows: MediaFile[];
  typeFilter: string | null;
  onTypeFilterChange: (next: string | null) => void;
  onOpen: (media: MediaFile) => void;
  onDelete: (media: MediaFile) => void;
  onSetProfile: (media: MediaFile) => void;
  /** The row whose profile-photo call is in flight, or null. */
  promotingId: string | null;
}

function MediaGrid({
  rows,
  typeFilter,
  onTypeFilterChange,
  onOpen,
  onDelete,
  onSetProfile,
  promotingId,
}: MediaGridProps) {
  const safeRows = useMemo(() => rows.map(withMediaDefaults), [rows]);
  const types = useMemo(() => galleryFileTypes(safeRows), [safeRows]);
  const visible = useMemo(
    () =>
      typeFilter === null
        ? safeRows
        : safeRows.filter((m) => (m.fileType ?? '').trim().toUpperCase() === typeFilter),
    [safeRows, typeFilter],
  );

  /**
   * Per-type counts for the pills, the way the mock draws them ("Images 5") and
   * the way the Compose (`MediaTypeFilters`) and Android (`MediaTypeFilter`)
   * pills already carry them. Derived from the FULL streamed set, never from
   * `visible`: narrowing to Videos must not restate Images as 0. Keyed on the
   * same trimmed `fileType` string `galleryFileTypes` returns, so a count can
   * never drift from the pill it sits on.
   */
  const countByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of safeRows) {
      const t = (m.fileType ?? '').trim();
      if (t !== '') counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  }, [safeRows]);

  return (
    <>
      {types.length > 0 && (
        <div className="media__filter-row" role="group" aria-label="Filter by type">
          <Chip
            label="All"
            count={safeRows.length}
            active={typeFilter === null}
            onClick={() => onTypeFilterChange(null)}
          />
          {types.map((t) => (
            <Chip
              key={t}
              label={titleCase(t)}
              // `?? 0` would be a fabricated count anywhere else. Here `t` comes
              // from `galleryFileTypes(safeRows)`, i.e. it is present in the very
              // rows `countByType` was built from, so the branch is unreachable
              // rather than a silent zero: types and counts share one source.
              count={countByType.get(t) ?? 0}
              active={typeFilter === t}
              onClick={() => onTypeFilterChange(typeFilter === t ? null : t)}
            />
          ))}
        </div>
      )}

      <p className="media__count">
        {visible.length} of {safeRows.length}
      </p>

      {visible.length === 0 ? (
        <p className="media__hint">No media matches this filter.</p>
      ) : (
        <ul className="media__grid">
          {visible.map((m) => (
            <MediaTile
              key={m._id}
              media={m}
              onOpen={onOpen}
              onDelete={onDelete}
              onSetProfile={onSetProfile}
              promoting={promotingId === m._id}
              actionsLocked={promotingId !== null && promotingId !== m._id}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** "IMAGE" -> "Image". Ports the same title-casing `Gallery.tsx` uses for its type chips. */
function titleCase(s: string): string {
  if (s === '') return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="media__chip" data-active={active} aria-pressed={active} onClick={onClick}>
      {label} <span className="media__chip-count">{count}</span>
    </button>
  );
}

/**
 * The tile's fixed edge, in px. Same literal `Gallery.tsx`'s `TILE_SIZE` uses
 * (a direct port of `AuntieMediaCell`'s `Modifier.width(132.dp)` call site),
 * kept identical so a Media tile and a Gallery tile read as the same component
 * at a glance.
 */
const TILE_SIZE = 132;

interface MediaTileProps {
  media: MediaFile;
  /** Opens the fullscreen viewer for this tile's media (#388). */
  onOpen: (media: MediaFile) => void;
  /** Asks for the confirm dialog. The tile never deletes anything itself (#397 S2). */
  onDelete: (media: MediaFile) => void;
  onSetProfile: (media: MediaFile) => void;
  /** This tile's own set-profile call is in flight. */
  promoting: boolean;
  /** ANOTHER tile's call is in flight, so this one's actions wait rather than queue behind it. */
  actionsLocked: boolean;
}

/**
 * One grid cell. A genuine control (#388, the DEAD-CONTROL this comment used
 * to describe): a real `<button>`, opening the shared `MediaViewerDialog` on
 * click or Enter/Space, same as `Gallery.tsx`'s tile. No household line:
 * unlike `Gallery.tsx`'s tile, every row here already belongs to the one
 * scoped entity, so repeating its name on every tile would be noise, not
 * information.
 *
 * THE ACTION BUTTONS ARE SIBLINGS OF THE OPEN BUTTON, NOT CHILDREN OF IT
 * (#397 S2). The whole tile was one `<button>`; dropping a delete X inside it
 * would nest interactive content, which is invalid HTML, gives the inner
 * control undefined activation behaviour across browsers, and is silently
 * accepted by React and by jsdom, so a test would go green over a control the
 * operator cannot reliably press. The cell is the positioning context instead,
 * and both actions are absolutely positioned over the thumbnail.
 */
function MediaTile({ media, onOpen, onDelete, onSetProfile, promoting, actionsLocked }: MediaTileProps) {
  // `?? ''`: MediaFile's document fields are optional because the interface is a
  // cast over raw Firestore data, not a validation of it (see api/gallery.ts).
  // Every row reaching a tile has already been through `withMediaDefaults`, so
  // these defaults are belt-and-braces rather than the primary guard — but the
  // type is the only thing standing between an un-defaulted row and a `.trim()`
  // on undefined, which blanks the whole grid via the error boundary.
  const kind = mediaKindOf(media.fileType ?? '');
  const previewUrl = mediaPreviewUrl(media);
  const caption = mediaCaption(media);
  const meta = mediaMetaLine(media.uploadedAt ?? '', media.uploadedBy ?? '');
  const duration = kind === 'video' ? mediaDurationLabel(media.durationSeconds) : undefined;
  const accessibleLabel = caption !== '' ? caption : 'Media';

  /**
   * "Set as profile" is offered only where it can actually work, and each
   * condition is a real refusal rather than a styling choice:
   *
   *   - already the profile photo: the badge says so; a button that re-sets it
   *     would be a no-op dressed as an action.
   *   - not an image: a video or a PDF cannot be an avatar. Android's own tile
   *     gates on the same thing.
   *   - no `entityId`/`entityType` on the row: the callable cross-checks both
   *     against the stored document and would refuse. The route's segments are
   *     NOT a stand-in (see this file's header), so the honest response to a
   *     row with no entity is to not offer the action.
   */
  const canSetProfile =
    !media.isProfilePhoto &&
    kind === 'image' &&
    str(media.entityId) !== '' &&
    str(media.entityType) !== '';

  return (
    <li className="media__cell">
      <button type="button" className="media__tile" onClick={() => onOpen(media)} aria-label={`Open ${accessibleLabel}`}>
        <div className="media__tile-media">
          <Avatar
            label={accessibleLabel}
            imageUrl={mediaKindHasPreview(kind) ? previewUrl : undefined}
            glyph={<TypeGlyph kind={kind} />}
            gradientSeed={media._id !== '' ? media._id : accessibleLabel}
            shape="rounded"
            ring={false}
            size={TILE_SIZE}
            className="media__tile-avatar"
          />
          {kind === 'video' && (
            <span className="media__tile-play" aria-hidden="true">
              <PlayGlyph />
            </span>
          )}
          {duration !== undefined && <span className="media__tile-duration">{duration}</span>}
          {media.isProfilePhoto && <span className="media__tile-profile-badge">Profile</span>}

          {/*
            The mock's `.cap` strip: a gradient-to-dark caption over the bottom
            of the thumbnail carrying the description and the "{date} · {uploader}"
            meta. It is a pointer-hover convenience ONLY, and deliberately not the
            only way to reach any of it: the same three values stay always visible
            in `.media__tile-body` below, which is what a touch device, a keyboard
            user, and the Android gallery all see. The CSS gates it behind
            `@media (hover: hover)` so a touch browser never has an invisible
            strip it cannot summon.

            `aria-hidden`: this is a duplicate of the body block below, and a
            screen reader should read each caption once, not twice.

            Rendered only when there is something real to put in it, so a row with
            neither a description nor a readable uploadedAt/uploadedBy gets no
            orphan gradient.
          */}
          {(caption !== '' || meta !== '') && (
            <span className="media__tile-caption-strip" aria-hidden="true">
              {caption !== '' && <span className="media__tile-strip-caption">{caption}</span>}
              {meta !== '' && <span className="media__tile-strip-meta">{meta}</span>}
            </span>
          )}
        </div>

        <div className="media__tile-body">
          {caption !== '' && <span className="media__tile-caption">{caption}</span>}
          {meta !== '' && <span className="media__tile-meta">{meta}</span>}
        </div>
      </button>

      {/* Siblings of the open button, never children, see this component's
          header for why nesting them would be a control the operator cannot
          reliably press. */}
      <div className="media__tile-actions">
        {canSetProfile && (
          <IconButton
            icon={<StarGlyph />}
            label={`Set ${accessibleLabel} as the profile photo`}
            size={26}
            disabled={promoting || actionsLocked}
            onClick={() => onSetProfile(media)}
          />
        )}
        <IconButton
          icon={<CloseGlyph />}
          label={`Delete ${accessibleLabel}`}
          destructive
          size={26}
          disabled={promoting || actionsLocked}
          onClick={() => onDelete(media)}
        />
      </div>

      {/* Announced, not just spun: a set-profile call is a network round trip
          on a tile that otherwise looks unchanged until the listener catches
          up, and a silent one reads as a click that did nothing. */}
      {promoting && (
        <span className="media__tile-busy" role="status">
          Setting profile photo…
        </span>
      )}
    </li>
  );
}

/** The mock's per-tile delete X (`Lucide.X`, tinted error), and Android's identical top-end icon. */
function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M18 6 6 18" strokeLinecap="round" />
      <path d="m6 6 12 12" strokeLinecap="round" />
    </svg>
  );
}

/** "Set as profile photo". A star, matching the badge this action earns the tile. */
function StarGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path
        d="m12 3.6 2.6 5.3 5.8.85-4.2 4.1 1 5.75L12 16.9l-5.2 2.7 1-5.75-4.2-4.1 5.8-.85z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Type-specific fallback glyph. Ports the same selection `Gallery.tsx`'s `TypeGlyph` uses. */
function TypeGlyph({ kind }: { kind: MediaKind }) {
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
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function DocumentGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v5h5" />
      <path d="M8 13h8M8 17h8" strokeLinecap="round" />
    </svg>
  );
}

function AudioGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M9 17V5l11-2v12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="17.5" r="2.5" />
      <circle cx="17.5" cy="15.5" r="2.5" />
    </svg>
  );
}

function BrokenImageGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none" />
      <path d="M4 17l5-5 4 4 3-3 4 4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 21 21 3" strokeLinecap="round" />
    </svg>
  );
}
