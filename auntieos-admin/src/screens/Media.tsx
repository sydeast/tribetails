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
import { DenScreenHeading } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Avatar } from '../components/Avatar';
import { MediaViewerDialog } from '../components/MediaViewerDialog';
import './Media.css';

/**
 * Media, the CONTEXTUAL single-entity gallery, ported from the wasm
 * `MediaGalleryScreen.kt` (reached via `#/media/{type}/{id}`, `Route.kt`'s
 * `MediaGallery` destination). READ/GRID ONLY, per the port brief:
 *
 *   IN SCOPE   the entity-scoped `media_files` listener (`api/media.ts`'s
 *              `mediaTargetQuery`), a fileType filter row (mirrors the wasm's
 *              own `MediaTypeFilters`), a grid tile reusing `Gallery.tsx`'s
 *              Avatar-based thumbnail / glyph / duration / profile-badge
 *              treatment verbatim (same pure helpers, from
 *              `lib/mediaFormat.ts`), and tapping (or Enter/Space-activating)
 *              a tile opens the fullscreen viewer
 *              (`components/MediaViewerDialog.tsx`), porting
 *              `MediaGalleryScreen.kt`'s `FullscreenMediaViewer` (`:441`) —
 *              closes #388.
 *
 *   OUT OF SCOPE, flagged rather than silently dropped:
 *     - Upload (`MediaGalleryScreen.kt`'s Upload button + `pickAndUploadMedia`).
 *       No upload affordance renders here at all.
 *     - Delete and "set profile photo" (the wasm's per-tile hover actions and
 *       `AuntieDialog` confirmation). This grid has no destructive or mutating
 *       control anywhere.
 *     - Caption editing. The caption shown is READ-ONLY (`description` falling
 *       back to `originalFileName`, via `mediaCaption`).
 *     - A household filter row. `Gallery.tsx`'s grid offers one because it
 *       spans every household; this screen is already scoped to exactly one
 *       kin/household, so a second household axis would be meaningless here.
 *
 * Tiles ARE interactive now (#388 fixed the DEAD-CONTROL this comment used to
 * describe): a real `<button>` per cell, mirroring `Gallery.tsx`'s
 * `GalleryTile` exactly, opening the same shared `MediaViewerDialog`. The
 * type-filter chips were always interactive: a client-side VIEW filter over
 * already-streamed rows, not a write path, the same distinction
 * `Gallery.tsx`'s own filter chips make.
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
        <AsyncRegion
          state={mediaState}
          what="media"
          isEmpty={(rows) => rows.length === 0}
          loading={<p className="media__hint">Loading media…</p>}
          empty={<p className="media__hint">No media on file for this {label.toLowerCase()} yet.</p>}
        >
          {(rows) => (
            <MediaGrid
              rows={rows}
              typeFilter={typeFilter}
              onTypeFilterChange={setTypeFilter}
              onOpen={setViewerMedia}
            />
          )}
        </AsyncRegion>
      )}

      {viewerMedia && <MediaViewerDialog media={viewerMedia} onClose={() => setViewerMedia(null)} />}
    </div>
  );
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
}

function MediaGrid({ rows, typeFilter, onTypeFilterChange, onOpen }: MediaGridProps) {
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
            <MediaTile key={m._id} media={m} onOpen={onOpen} />
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
}

/**
 * One grid cell. A genuine control (#388, the DEAD-CONTROL this comment used
 * to describe): a real `<button>`, opening the shared `MediaViewerDialog` on
 * click or Enter/Space, same as `Gallery.tsx`'s tile. No household line:
 * unlike `Gallery.tsx`'s tile, every row here already belongs to the one
 * scoped entity, so repeating its name on every tile would be noise, not
 * information.
 */
function MediaTile({ media, onOpen }: MediaTileProps) {
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
    </li>
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
