import { useMemo, useState, type ReactNode } from 'react';
import { GALLERY_QUERY, type MediaFile } from '../api/gallery';
import { KINFOLK_QUERY, KIN_QUERY, kinfolkDisplayName, type Kinfolk, type Kin } from '../api/directory';
import {
  mediaKindOf,
  mediaKindHasPreview,
  mediaPreviewUrl,
  mediaCaption,
  mediaMetaLine,
  mediaDurationLabel,
  mediaGpsStripState,
  filterGalleryMedia,
  galleryMonths,
  galleryKinfolkIds,
  galleryFileTypes,
  galleryHasUnattachedMedia,
  taggedKinNames,
  UNATTACHED_KINFOLK_ID,
  GALLERY_FILTER_DEFAULT,
  type GalleryFilter,
  type MediaKind,
} from '../lib/mediaFormat';
import { useCollection } from '../lib/firestore';
import { str } from '../lib/coerce';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { PrimaryButton } from '../components/Buttons';
import { MediaUploadDialog, type KinfolkOption } from '../components/MediaUploadDialog';
import { MediaViewerDialog } from '../components/MediaViewerDialog';
import { TagKinDialog } from '../components/TagKinDialog';
import './Gallery.css';

/**
 * Admin Gallery ("The Den · Gallery"), ported from the wasm `GalleryScreen.kt` /
 * `GalleryFilters.kt` (#13 global Gallery). Originally LIST/GRID ONLY; Upload
 * has since been added (`api/mediaUpload.ts` + `MediaUploadDialog`), and
 * tapping a tile now opens the fullscreen viewer (#388), per the port brief:
 *
 *   IN SCOPE   the bounded `media_files` stream, household/type/month filters
 *              (GalleryFilters.kt ported verbatim to lib/mediaFormat.ts), a
 *              grid tile that is a genuine control (thumbnail with graceful
 *              broken-image fallback, caption, household, uploaded-date/
 *              uploader, and the profile-photo / video-duration badges the
 *              wasm cell already shows); an "Upload media" action
 *              (GalleryScreen.kt's upload button + household picker dialog +
 *              pickAndUploadMedia, ported: sign -> Cloudinary -> `media_files`
 *              write, see `MediaUploadDialog`/`api/mediaUpload.ts`); AND
 *              tapping (or Enter/Space-activating) a tile opens the fullscreen
 *              viewer (`components/MediaViewerDialog.tsx`), porting
 *              `GalleryScreen.kt`'s `MediaViewerDialog` (`:305`).
 *
 *              KIN TAGGING (#447) is now in scope too: the viewer's "Tag kin"
 *              button hands off to `components/TagKinDialog.tsx`, which writes
 *              through the `saveMediaTags` callable (`api/mediaTags.ts`).
 *              Android's `GalleryScreen.kt` has had exactly this flow the whole
 *              time; the web half was the missing part.
 *
 *   CAPTION EDITING (#397 S3) is real too, but it lives in the shared
 *   `MediaViewerDialog` a tile opens (see that component), not on the tile
 *   itself: the caption text shown on the grid tile (`description` falling
 *   back to `originalFileName`, via `lib/mediaFormat.ts#mediaCaption`) stays
 *   read-only display copy.
 *
 *   OUT OF SCOPE, flagged rather than silently dropped:
 *     - A "tagged kin" FILTER. Android's `GalleryFilter` has three facets
 *       (household / type / month) and no fourth; inventing one here would put
 *       the two clients back out of step in the opposite direction.
 *
 * Three streams back the grid: `media_files` (GALLERY_QUERY, this screen's own
 * data), `kinfolk` (KINFOLK_QUERY, reused verbatim from api/directory.ts,
 * the same household roster Directory.tsx already streams) purely to resolve a
 * tile's `kinfolkId` to a display name, and `kin` (KIN_QUERY, the same roster
 * Directory's Kin tab reads) for tagging: the picker's options and the names on
 * the tag chips both come out of it, one stream serving both.
 *
 * A broken kinfolk read degrades to "Household unavailable" rather than
 * blocking the grid, disclosed via the banner below (the
 * same non-blocking-secondary-stream pattern as Directory's Kin banner). The
 * SAME roster also backs the Upload dialog's household picker (`kinfolkOptions`
 * below): one stream, two consumers, no second fetch.
 */
export function Gallery() {
  const mediaState = useCollection<MediaFile>(GALLERY_QUERY);
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const kinState = useCollection<Kin>(KIN_QUERY);
  const [filter, setFilter] = useState<GalleryFilter>(GALLERY_FILTER_DEFAULT);
  const [uploadOpen, setUploadOpen] = useState(false);
  // The fullscreen viewer a tile opens (#388). The MediaFile itself, not just
  // an id: the tile already has the full row in hand, and re-finding it by id
  // in `rows` would fail silently the instant a filter narrows it out of view
  // while the viewer is still open.
  const [viewerMedia, setViewerMedia] = useState<MediaFile | null>(null);
  // The tag dialog (#447). SEPARATE state from `viewerMedia`, and only ever
  // one of the two is set: Android dismisses its viewer when it hands off to
  // the tag dialog (`onTag = { selected = media; pendingView = null }`), and
  // two stacked `Dialog`s would both answer a single Escape keypress anyway
  // (see TagKinDialog's header).
  const [tagMedia, setTagMedia] = useState<MediaFile | null>(null);

  const kinfolkLabel = useMemo(() => {
    if (kinfolkState.status !== 'ready') return new Map<string, string>();
    return new Map(kinfolkState.data.map((kf) => [kf._id, kinfolkDisplayName(kf)]));
  }, [kinfolkState]);

  // The kin roster in the two shapes this screen needs: a flat list for the
  // tag picker's options, and an id lookup for resolving a file's tags to
  // names. Empty (never fabricated) until the stream resolves.
  const allKin = useMemo(() => (kinState.status === 'ready' ? kinState.data : []), [kinState]);
  const kinById = useMemo(() => new Map(allKin.map((k) => [k._id, k])), [allKin]);

  // The Upload dialog's household picker reuses this same already-streamed
  // roster (no second fetch): an {id, label} pair per household, in stream
  // order, empty (never fabricated) while kinfolkState hasn't resolved yet.
  const kinfolkOptions = useMemo<KinfolkOption[]>(() => {
    if (kinfolkState.status !== 'ready') return [];
    return kinfolkState.data.map((kf) => ({ id: kf._id, label: kinfolkDisplayName(kf) }));
  }, [kinfolkState]);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Gallery"
        title="Every"
        accentTail="moment."
        subtitle="All media from every KinTale, tagged to its household."
      />

      <div className="gallery__actions">
        <PrimaryButton label="Upload media" onClick={() => setUploadOpen(true)} />
      </div>

      {/*
        A broken kinfolk read must not silently read as "no household on file"
        for every tile (the false-empty-on-error class this port refuses to
        ship). The grid itself still renders: the failure is disclosed, not
        blocking, same as Directory's Kin banner.
      */}
      {kinfolkState.status === 'error' && (
        <Banner tone="error" title="Couldn&rsquo;t load households">
          Tiles below may show "Household unavailable" instead of a name: {kinfolkState.message}
        </Banner>
      )}

      <AsyncRegion
        state={mediaState}
        what="media"
        isEmpty={(rows) => rows.length === 0}
        loading={<p className="gallery__hint">Loading media…</p>}
        empty={
          <p className="gallery__hint">No media uploaded yet. Photos and videos from KinTales show up here.</p>
        }
      >
        {(rows) => (
          <GalleryGrid
            rows={rows}
            filter={filter}
            onFilterChange={setFilter}
            kinfolkLabel={kinfolkLabel}
            kinById={kinById}
            onOpen={setViewerMedia}
          />
        )}
      </AsyncRegion>

      {uploadOpen && (
        <MediaUploadDialog
          kinfolkOptions={kinfolkOptions}
          onClose={() => setUploadOpen(false)}
          onUploaded={() => setUploadOpen(false)}
        />
      )}

      {viewerMedia && (
        <MediaViewerDialog
          media={viewerMedia}
          taggedNames={taggedKinNames(viewerMedia, kinById)}
          onTagKin={() => {
            setTagMedia(viewerMedia);
            setViewerMedia(null);
          }}
          onClose={() => setViewerMedia(null)}
        />
      )}

      {tagMedia && (
        <TagKinDialog
          media={tagMedia}
          allKin={allKin}
          kinLoading={kinState.status === 'loading'}
          kinError={kinState.status === 'error' ? kinState.message : null}
          onClose={() => setTagMedia(null)}
          // Closing is all this has to do. The grid's own `media_files`
          // listener re-delivers the row the callable just wrote, so the
          // tiles and a re-opened viewer show the saved tags because the ROW
          // changed, not because this screen patched a copy of it. Same
          // hand-off as Android's `saveTags(...) { ok -> if (ok) selected = null }`.
          onSaved={() => setTagMedia(null)}
        />
      )}
    </div>
  );
}

interface GalleryGridProps {
  rows: MediaFile[];
  filter: GalleryFilter;
  onFilterChange: (updater: (f: GalleryFilter) => GalleryFilter) => void;
  kinfolkLabel: Map<string, string>;
  /** Kin by id, for resolving a tile's `taggedKinIds` to names (#447). Empty until the roster stream resolves. */
  kinById: Map<string, Kin>;
  onOpen: (media: MediaFile) => void;
}

/** Toggles a chip: selecting the already-active value clears it back to "All". Ports GalleryScreen.kt's `if (filter.X == id) null else id`. */
function toggleValue<T>(current: T | null, candidate: T): T | null {
  return current === candidate ? null : candidate;
}

function GalleryGrid({
  rows,
  filter,
  onFilterChange,
  kinfolkLabel,
  kinById,
  onOpen,
}: GalleryGridProps) {
  const months = useMemo(() => galleryMonths(rows), [rows]);
  const types = useMemo(() => galleryFileTypes(rows), [rows]);
  const kinfolkIds = useMemo(() => galleryKinfolkIds(rows), [rows]);
  const hasUnattached = useMemo(() => galleryHasUnattachedMedia(rows), [rows]);
  const visible = useMemo(() => filterGalleryMedia(rows, filter), [rows, filter]);

  return (
    <>
      <div className="gallery__filters">
        {(kinfolkIds.length > 0 || hasUnattached) && (
          <FilterRow label="Household">
            <Chip label="All" active={filter.kinfolkId === null} onClick={() => onFilterChange((f) => ({ ...f, kinfolkId: null }))} />
            {hasUnattached && (
              <Chip
                label="No household"
                active={filter.kinfolkId === UNATTACHED_KINFOLK_ID}
                onClick={() => onFilterChange((f) => ({ ...f, kinfolkId: toggleValue(f.kinfolkId, UNATTACHED_KINFOLK_ID) }))}
              />
            )}
            {kinfolkIds.map((id) => (
              <Chip
                key={id}
                label={kinfolkLabel.get(id) ?? 'Unknown household'}
                active={filter.kinfolkId === id}
                onClick={() => onFilterChange((f) => ({ ...f, kinfolkId: toggleValue(f.kinfolkId, id) }))}
              />
            ))}
          </FilterRow>
        )}

        {types.length > 0 && (
          <FilterRow label="Type">
            <Chip label="All" active={filter.fileType === null} onClick={() => onFilterChange((f) => ({ ...f, fileType: null }))} />
            {types.map((t) => (
              <Chip
                key={t}
                label={titleCase(t)}
                active={filter.fileType === t}
                onClick={() => onFilterChange((f) => ({ ...f, fileType: toggleValue(f.fileType, t) }))}
              />
            ))}
          </FilterRow>
        )}

        {months.length > 0 && (
          <FilterRow label="Month">
            <Chip label="All" active={filter.monthPrefix === null} onClick={() => onFilterChange((f) => ({ ...f, monthPrefix: null }))} />
            {months.map((m) => (
              <Chip
                key={m}
                label={m}
                active={filter.monthPrefix === m}
                onClick={() => onFilterChange((f) => ({ ...f, monthPrefix: toggleValue(f.monthPrefix, m) }))}
              />
            ))}
          </FilterRow>
        )}
      </div>

      <p className="gallery__count">
        {visible.length} of {rows.length}
      </p>

      {visible.length === 0 ? (
        <p className="gallery__hint">No media matches these filters.</p>
      ) : (
        <ul className="gallery__grid">
          {visible.map((m) => (
            <GalleryTile
              key={m._id}
              media={m}
              householdName={str(m.kinfolkId) !== '' ? kinfolkLabel.get(str(m.kinfolkId)) ?? '' : ''}
              taggedNames={taggedKinNames(m, kinById)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/** "IMAGE" -> "Image". Ports GalleryScreen.kt's `t.lowercase().replaceFirstChar { it.uppercase() }`. */
function titleCase(s: string): string {
  if (s === '') return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function FilterRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gallery__filter-row">
      <span className="gallery__filter-label">{label}</span>
      <div className="gallery__filter-chips" role="group" aria-label={`Filter by ${label.toLowerCase()}`}>
        {children}
      </div>
    </div>
  );
}

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className="gallery__chip" data-active={active} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  );
}

interface GalleryTileProps {
  media: MediaFile;
  /** Resolved household name, or '' when unresolved OR absent. The tile tells the two apart via `media.kinfolkId` (see householdText). */
  householdName: string;
  /** Names of the kin tagged in this file (#447). Empty means nobody tagged, or the roster has not resolved: either way no badge. */
  taggedNames: string[];
  /** Opens the fullscreen viewer for this tile's media (#388). */
  onOpen: (media: MediaFile) => void;
}

/**
 * The tile's fixed edge, in px. A direct port of `AuntieMediaCell`'s
 * `Modifier.width(132.dp)` call site in GalleryScreen.kt: a literal design
 * constant from the source, same convention as Buttons.tsx's
 * `DEFAULT_ICON_SIZE = 38`, not a value the shared token scale defines.
 */
const TILE_SIZE = 132;

/**
 * One grid cell. A genuine control (#388): a real `<button>`, so it is reachable
 * by Tab and activates on Enter/Space for free, with an explicit `aria-label`
 * naming what it opens rather than leaving screen readers to assemble one from
 * the caption/household/meta text stacked inside it. Clicking or
 * keyboard-activating it opens `MediaViewerDialog`, which owns Escape-to-close,
 * backdrop-click, the focus trap, and returning focus to this button on close
 * (all `Dialog`'s job; see that component).
 *
 * The thumbnail reuses `Avatar` rather than re-solving "show an image, fall
 * back gracefully on a missing or broken URL, never leave a blank hole" a
 * second time: that is exactly what `Avatar`'s `imageUrl`/`glyph` resolution
 * order already guarantees (components/Avatar.tsx). A type-specific glyph
 * (play / document / audio / broken) is the fallback caller-supplied via
 * `glyph`, so a document or audio file (no thumbnail to preview, same as the
 * wasm's `GlyphBody`) or a failed image/video thumbnail both resolve to an
 * on-brand tile with a real accessible name, never an empty box.
 */
/**
 * A media doc with NO kinfolkId genuinely has no household. One WITH a kinfolkId
 * that the roster did not resolve is "Household unavailable" (unresolved is not
 * absent: never collapse the two into a single "no household" claim).
 */
function householdText(kinfolkId: string, householdName: string): string {
  if (kinfolkId.trim() === '') return 'No household on file';
  return householdName !== '' ? householdName : 'Household unavailable';
}

function GalleryTile({ media, householdName, taggedNames, onOpen }: GalleryTileProps) {
  const kind = mediaKindOf(str(media.fileType));
  const previewUrl = mediaPreviewUrl(media);
  const caption = mediaCaption(media);
  const meta = mediaMetaLine(str(media.uploadedAt), str(media.uploadedBy));
  const duration = kind === 'video' ? mediaDurationLabel(media.durationSeconds) : undefined;
  // #593. Only the FAILED state gets a badge. Pending is ordinary progress
  // measured in seconds and badging it would put a scary label on every video
  // for a moment; stripped is the expected outcome and needs no decoration.
  // Failed means the video still carries the coordinates it was recorded with
  // and no further retry is coming, which is the one thing an operator has to
  // be able to see without opening a log.
  const stripFailed = mediaGpsStripState(media) === 'failed';
  const accessibleLabel = caption !== '' ? caption : 'Media';

  return (
    <li className="gallery__cell">
      <button type="button" className="gallery__tile" onClick={() => onOpen(media)} aria-label={`Open ${accessibleLabel}`}>
        <div className="gallery__tile-media">
          <Avatar
            label={accessibleLabel}
            // Only image/video kinds ever try a thumbnail: a document/audio row
            // with a stray thumbnailUrl set would still not get an image preview,
            // matching the wasm's `canShowImage` gate exactly.
            imageUrl={mediaKindHasPreview(kind) ? previewUrl : undefined}
            glyph={<TypeGlyph kind={kind} />}
            gradientSeed={media._id !== '' ? media._id : accessibleLabel}
            shape="rounded"
            ring={false}
            size={TILE_SIZE}
            className="gallery__tile-avatar"
          />
          {kind === 'video' && (
            <span className="gallery__tile-play" aria-hidden="true">
              <PlayGlyph />
            </span>
          )}
          {duration !== undefined && <span className="gallery__tile-duration">{duration}</span>}
          {media.isProfilePhoto && <span className="gallery__tile-profile-badge">Profile</span>}
          {stripFailed && (
            <span className="gallery__tile-strip-badge" title="Location metadata could not be removed from this video.">
              Location not removed
            </span>
          )}
        </div>

        <div className="gallery__tile-body">
          {caption !== '' && <span className="gallery__tile-caption">{caption}</span>}
          <span className="gallery__tile-household">
            {householdText(str(media.kinfolkId), householdName)}
          </span>
          {meta !== '' && <span className="gallery__tile-meta">{meta}</span>}
          {/*
            Who is tagged, on the tile itself, so the grid answers "which
            photos have Waddles in them" without opening every one. Android's
            `GalleryThumb` puts the same thing on its cell, collapsing to a
            count past one name because a tile is 132px wide and three names
            would just be an ellipsis.
          */}
          {taggedNames.length > 0 && (
            <span className="gallery__tile-tags">
              {taggedNames.length === 1 ? taggedNames[0] : `${taggedNames.length} kin`}
            </span>
          )}
        </div>
      </button>
    </li>
  );
}

/** Type-specific fallback glyph, ports `AuntieMediaCell.kt`'s glyph selection: document/audio get their own icon, image/video (once broken) get the generic "broken" glyph: never a shared default that hides which kind failed. */
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

/** No icon package is installed here (see Directory.tsx's PawGlyph / Buttons.tsx precedent). */
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

/** A slashed image glyph: the "preview unavailable" state, never a blank tile. */
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
