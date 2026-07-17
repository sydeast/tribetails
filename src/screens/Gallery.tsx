import { useMemo, useState, type ReactNode } from 'react';
import { GALLERY_QUERY, type MediaFile } from '../api/gallery';
import { KINFOLK_QUERY, kinfolkDisplayName, type Kinfolk } from '../api/directory';
import {
  mediaKindOf,
  mediaKindHasPreview,
  mediaPreviewUrl,
  mediaCaption,
  mediaMetaLine,
  mediaDurationLabel,
  filterGalleryMedia,
  galleryMonths,
  galleryKinfolkIds,
  galleryFileTypes,
  GALLERY_FILTER_DEFAULT,
  type GalleryFilter,
  type MediaKind,
} from '../lib/mediaFormat';
import { useCollection } from '../lib/firestore';
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import './Gallery.css';

/**
 * Admin Gallery ("The Den · Gallery"), ported from the wasm `GalleryScreen.kt` /
 * `GalleryFilters.kt` (#13 global Gallery). LIST/GRID ONLY, per the port brief:
 *
 *   IN SCOPE   the bounded `media_files` stream, household/type/month filters
 *              (GalleryFilters.kt ported verbatim to lib/mediaFormat.ts), and a
 *              read-only grid tile: thumbnail (with graceful broken-image
 *              fallback), caption, household, uploaded-date/uploader, and the
 *              profile-photo / video-duration badges the wasm cell already shows.
 *
 *   OUT OF SCOPE, flagged rather than silently dropped:
 *     - Upload (GalleryScreen.kt's "Upload media" button + household picker
 *       dialog + pickAndUploadMedia). No upload affordance renders here at all.
 *     - The tag-kin lightbox overlay (TagKinOverlay, opened by tapping a tile):
 *       there is no `onSelect`/detail prop on this screen because no detail
 *       surface is planned in this port yet, unlike Directory/Invoices'
 *       placeholder onSelect props for routes that ARE coming.
 *     - Caption editing. The caption shown is READ-ONLY (`description` falling
 *       back to `originalFileName`, via `lib/mediaFormat.ts#mediaCaption`); there
 *       is no write path from this screen.
 *
 * Two streams back the grid: `media_files` (GALLERY_QUERY, this screen's own
 * data) and `kinfolk` (KINFOLK_QUERY, reused verbatim from api/directory.ts,
 * the same household roster Directory.tsx already streams) purely to resolve a
 * tile's `kinfolkId` to a display name. A broken kinfolk read degrades to
 * "Household unavailable" rather than blocking the grid, disclosed via the banner below (the
 * same non-blocking-secondary-stream pattern as Directory's Kin banner).
 */
export function Gallery() {
  const mediaState = useCollection<MediaFile>(GALLERY_QUERY);
  const kinfolkState = useCollection<Kinfolk>(KINFOLK_QUERY);
  const [filter, setFilter] = useState<GalleryFilter>(GALLERY_FILTER_DEFAULT);

  const kinfolkLabel = useMemo(() => {
    if (kinfolkState.status !== 'ready') return new Map<string, string>();
    return new Map(kinfolkState.data.map((kf) => [kf._id, kinfolkDisplayName(kf)]));
  }, [kinfolkState]);

  return (
    <div className="screen">
      <DenScreenHeading
        kicker="The Den · Gallery"
        title="Every"
        accentTail="moment."
        subtitle="All media from every KinTale, tagged to its household."
      />

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
          />
        )}
      </AsyncRegion>
    </div>
  );
}

interface GalleryGridProps {
  rows: MediaFile[];
  filter: GalleryFilter;
  onFilterChange: (updater: (f: GalleryFilter) => GalleryFilter) => void;
  kinfolkLabel: Map<string, string>;
}

/** Toggles a chip: selecting the already-active value clears it back to "All". Ports GalleryScreen.kt's `if (filter.X == id) null else id`. */
function toggleValue<T>(current: T | null, candidate: T): T | null {
  return current === candidate ? null : candidate;
}

function GalleryGrid({ rows, filter, onFilterChange, kinfolkLabel }: GalleryGridProps) {
  const months = useMemo(() => galleryMonths(rows), [rows]);
  const types = useMemo(() => galleryFileTypes(rows), [rows]);
  const kinfolkIds = useMemo(() => galleryKinfolkIds(rows), [rows]);
  const visible = useMemo(() => filterGalleryMedia(rows, filter), [rows, filter]);

  return (
    <>
      <div className="gallery__filters">
        {kinfolkIds.length > 0 && (
          <FilterRow label="Household">
            <Chip label="All" active={filter.kinfolkId === null} onClick={() => onFilterChange((f) => ({ ...f, kinfolkId: null }))} />
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
            <GalleryTile key={m._id} media={m} householdName={m.kinfolkId !== '' ? kinfolkLabel.get(m.kinfolkId) ?? '' : ''} />
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
}

/**
 * The tile's fixed edge, in px. A direct port of `AuntieMediaCell`'s
 * `Modifier.width(132.dp)` call site in GalleryScreen.kt: a literal design
 * constant from the source, same convention as Buttons.tsx's
 * `DEFAULT_ICON_SIZE = 38`, not a value the shared token scale defines.
 */
const TILE_SIZE = 132;

/**
 * One grid cell. Read-only: no click handler at all (see the file header: the
 * tag-kin lightbox this would have opened is out of scope, not stubbed).
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

function GalleryTile({ media, householdName }: GalleryTileProps) {
  const kind = mediaKindOf(media.fileType);
  const previewUrl = mediaPreviewUrl(media);
  const caption = mediaCaption(media);
  const meta = mediaMetaLine(media.uploadedAt, media.uploadedBy);
  const duration = kind === 'video' ? mediaDurationLabel(media.durationSeconds) : undefined;
  const accessibleLabel = caption !== '' ? caption : 'Media';

  return (
    <li className="gallery__cell">
      <div className="gallery__tile">
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
        </div>

        <div className="gallery__tile-body">
          {caption !== '' && <span className="gallery__tile-caption">{caption}</span>}
          <span className="gallery__tile-household">
            {householdText(media.kinfolkId, householdName)}
          </span>
          {meta !== '' && <span className="gallery__tile-meta">{meta}</span>}
        </div>
      </div>
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
