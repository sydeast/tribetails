import { useMemo, useState } from 'react';
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
import { DenScreenHeading, StatusPill, EmptyHint } from '../components/DenScreenKit';
import { AsyncRegion } from '../components/AsyncRegion';
import { Banner } from '../components/Banner';
import { Avatar } from '../components/Avatar';
import { LoadingRow } from '../components/LoadingRow';
import { PrimaryButton, GhostButton, IconButton } from '../components/Buttons';
import { Dialog } from '../components/Dialog';
import { deleteMediaFile, mediaWriteErrorMessage } from '../api/mediaWrite';
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
 *   LAYOUT (#692) is now the mock's, not the port's first pass:
 *   `ui-ideas/auntieos-media-gallery-2026-05-27.html`. A fluid `auto-fill` grid
 *   of square tiles across the full content width, ONE pill row carrying the
 *   per-type counts, household and month as compact selects beside it, the count
 *   chip and the upload action in the heading row, tile text folded into a hover
 *   caption strip, and the mock's top-end delete X on every tile. The three
 *   facets themselves are unchanged: `GalleryFilters.kt` still defines them and
 *   `filterGalleryMedia` still applies them. Only the controls changed shape.
 *   The mock's back arrow has no counterpart here, and that is not a gap: the
 *   mock mirrors the entity-scoped Android screen, and this Gallery is a
 *   top-level nav destination with nowhere to go back to.
 *
 *   SKIN (#755, the glass sweep) is the mock's too, on the navy ground the kit
 *   paints since #759. The 2026-09-10 pass matched structure; this one matched
 *   what the tile is painted with: the mock's play badge (navy glass, primary
 *   glyph), the duration badge at the bottom start, the profile marker as the
 *   kit's compact teal `StatusPill`, a document or audio file drawn as the
 *   mock's file cell (glyph and file name, in the tile, at rest) instead of a
 *   bare glyph, the hover strip and the tag chip tinted from the brand navy
 *   token instead of black, the tile lifting on hover through the shared `lift`
 *   utility, and the mock's empty block with its own two lines of copy. The
 *   heading takes the mock's `<scope> Media` shape: the accent word is
 *   "media", the scope of this screen being every household.
 *
 *   DELETE (#692) goes through the `deleteMediaFile` callable, the same path
 *   `Media.tsx` uses, with the mock's confirm copy verbatim. It passes NO
 *   `entityId` scope: this grid spans every household, so it has no scope to
 *   assert (see `api/mediaWrite.ts`).
 *
 *   OUT OF SCOPE, flagged rather than silently dropped:
 *     - A "tagged kin" FILTER. Android's `GalleryFilter` has three facets
 *       (household / type / month) and no fourth; inventing one here would put
 *       the two clients back out of step in the opposite direction.
 *     - "Set as profile photo" on a tile. `Media.tsx` offers it because every
 *       row there belongs to the one entity the route names; a global row's
 *       entity comes off the ROW and many rows have none, so the action would be
 *       absent from most tiles. The mock does not draw it either.
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
  /**
   * #692. The row whose delete confirm is open. Holds the ROW, not an id, so
   * the dialog can name the file type the way the mock's body copy does.
   */
  const [pendingDelete, setPendingDelete] = useState<MediaFile | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * A refused delete, shown as a banner above the grid. Not folded into
   * `mediaState`'s error: that state describes the LISTENER, and blanking a
   * working grid because one action was refused would hide the very rows the
   * operator needs to see to understand what happened. Same split Media.tsx
   * already makes.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  async function confirmDelete() {
    if (pendingDelete === null || deleting) return;
    const target = pendingDelete;
    setDeleting(true);
    setActionError(null);
    try {
      // No `entityId` scope argument. This grid spans every household, so it has
      // no scope to assert; the entity-scoped Media screen passes its row's own
      // entityId and this one deliberately does not (api/mediaWrite.ts).
      await deleteMediaFile(target._id);
      // No optimistic splice: the `media_files` listener removes the tile
      // because the DOCUMENT went, not because this screen edited a local copy.
      setPendingDelete(null);
      if (viewerMedia?._id === target._id) setViewerMedia(null);
    } catch (err) {
      setActionError(mediaWriteErrorMessage(err, 'Deleting this file'));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

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

  /**
   * The count behind the chip beside the title (#692, the mock's `.count`).
   * Rendered ONLY from a resolved read: while the stream is loading or after it
   * failed there is no number anyone has actually read, and the chip stays away
   * rather than printing a confident 0. Counts the whole stream, never the
   * filtered slice: a filter is a view over the total, and the "N of M" line
   * above the grid is what reports the narrowing.
   */
  const total = mediaState.status === 'ready' ? mediaState.data.length : null;

  return (
    <div className="screen">
      {/* Upload and the count chip both ride in the heading's trailing slot, as
          the mock puts them in its top bar, rather than on a row of their own
          below the subtitle. The mock's back arrow has no counterpart here: it
          is entity-scoped and this Gallery is a top-level nav screen.

          The kicker names the nav destination, the way every list screen's
          does (Directory, Invites); the mock's "The Den · Media" belongs to the
          entity-scoped screen it mirrors. The title takes the mock's shape,
          "<scope> Media" with the last word accented: this screen's scope is
          every household, so the scope word is "All". */}
      <DenScreenHeading
        kicker="The Den · Gallery"
        title="All"
        accentTail="media"
        subtitle="All media from every KinTale, tagged to its household."
        trailing={
          <div className="gallery__header-actions">
            {total !== null && total > 0 && <GalleryCountChip total={total} />}
            <PrimaryButton label="Upload media" onClick={() => setUploadOpen(true)} />
          </div>
        }
      />

      {actionError !== null && (
        <Banner tone="error" title="That didn&rsquo;t go through">
          {actionError}
        </Banner>
      )}

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
        loading={<LoadingRow label="Loading media…" className="den-hint" />}
        empty={<GalleryEmpty />}
      >
        {(rows) => (
          <GalleryGrid
            rows={rows}
            filter={filter}
            onFilterChange={setFilter}
            kinfolkLabel={kinfolkLabel}
            kinById={kinById}
            onOpen={setViewerMedia}
            onDelete={setPendingDelete}
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

      {pendingDelete && (
        <Dialog
          // Copy below is the mock's, verbatim (auntieos-media-gallery-*.html:
          // "Delete Media" / "Are you sure you want to delete this {fileType
          // lowercased}?" / Delete / Cancel), which is also Android's
          // AlertDialog copy and what Media.tsx already shows. Three surfaces
          // agree; this is not the place to invent a fourth wording.
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
          <p className="gallery__dialog-body">
            Are you sure you want to delete this {deleteKindWord(pendingDelete)}?
          </p>
          <p className="gallery__dialog-hint">This removes it from the gallery and cannot be undone.</p>
          {/* "its owner", not "that household": a row in this global grid can be
              a KIN's profile photo as easily as a household's, and the entity it
              belongs to is on the row rather than on the route. */}
          {pendingDelete.isProfilePhoto && (
            <p className="gallery__dialog-hint">
              This is a profile photo. Deleting it leaves its owner without one until another is
              chosen.
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}

/**
 * "image" / "video" / "file" for the confirm dialog's body, mirroring the mock's
 * `{fileType lowercased}` and Android's identical
 * `mediaFile.fileType.name.lowercase()`. Goes through `mediaKindOf` rather than
 * lower-casing the raw string: a row whose `fileType` is missing or
 * unrecognised would otherwise produce "delete this ?", and this dialog's whole
 * job is to say clearly what is about to be destroyed.
 */
function deleteKindWord(media: MediaFile): string {
  switch (mediaKindOf(str(media.fileType))) {
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
 * Same shape Media.tsx's chip uses, so the two gallery screens read alike.
 */
function GalleryCountChip({ total }: { total: number }) {
  return (
    <span className="gallery__count-chip">
      {/* A <span>, not the mock's <em>: the number is accent-coloured, but it is
          not emphasis, and a screen reader should not stress it. */}
      <span className="gallery__count-chip-n">{total}</span> {total === 1 ? 'file' : 'files'}
    </span>
  );
}

/**
 * The mock's `.empty` block (#755): a dashed hairline frame on a faint hero
 * wash, the image glyph at half strength, a serif title and one dim line under
 * it, with the mock's own two lines of copy verbatim ("No media files found" /
 * "Upload photos and videos to see them here"). The kit's `EmptyHint` is the
 * quiet one-line hint for a panel; the mock draws this screen's proven-empty
 * state as a block of its own, so the block is local. Rendered only from a
 * resolved, genuinely empty read: `AsyncRegion` never shows `empty` on a
 * failure.
 */
function GalleryEmpty() {
  return (
    <div className="gallery__empty">
      <ImageGlyph className="gallery__empty-glyph" />
      <p className="gallery__empty-title">No media files found</p>
      <p className="gallery__empty-sub">Upload photos and videos to see them here</p>
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
  /** Asks for the confirm dialog (#692). No tile ever deletes anything itself. */
  onDelete: (media: MediaFile) => void;
}

/**
 * The two option values the household select needs that are not a document id.
 * `''` is a REAL filter value (`UNATTACHED_KINFOLK_ID`, media with no household
 * at all), so "no filter" cannot also be the empty string: a select's value is
 * always a string and the two states would collapse into one.
 */
const HOUSEHOLD_ANY = ' any';
const HOUSEHOLD_NONE = ' none';
const MONTH_ANY = ' any';

function GalleryGrid({
  rows,
  filter,
  onFilterChange,
  kinfolkLabel,
  kinById,
  onOpen,
  onDelete,
}: GalleryGridProps) {
  const months = useMemo(() => galleryMonths(rows), [rows]);
  const types = useMemo(() => galleryFileTypes(rows), [rows]);
  const kinfolkIds = useMemo(() => galleryKinfolkIds(rows), [rows]);
  const hasUnattached = useMemo(() => galleryHasUnattachedMedia(rows), [rows]);
  const visible = useMemo(() => filterGalleryMedia(rows, filter), [rows, filter]);

  /**
   * Per-type counts for the pills, the way the mock draws them ("Images 5") and
   * the way Media.tsx's row and Android's `MediaTypeFilter` already carry them.
   * Derived from the FULL streamed set, never from `visible`: narrowing to
   * Videos must not restate Images as 0. Keyed on the same trimmed `fileType`
   * string `galleryFileTypes` returns, so a count can never drift from the pill
   * it sits on.
   */
  const countByType = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of rows) {
      const t = str(m.fileType).trim();
      if (t !== '') counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const householdValue =
    filter.kinfolkId === null
      ? HOUSEHOLD_ANY
      : filter.kinfolkId === UNATTACHED_KINFOLK_ID
        ? HOUSEHOLD_NONE
        : filter.kinfolkId;

  return (
    <>
      {/*
        ONE control row, the way the mock draws it: the type pills across the
        leading edge with their counts, and the two facets the mock's
        entity-scoped screen never had (household, month) as compact selects on
        the trailing edge. They were three labelled chip rows, which pushed the
        grid a third of the way down the page and grew a chip per household as
        the customer list grew.
      */}
      <div className="gallery__controls">
        {types.length > 0 && (
          <div className="gallery__pills" role="group" aria-label="Filter by type">
            <Pill
              label="All"
              count={rows.length}
              active={filter.fileType === null}
              onClick={() => onFilterChange((f) => ({ ...f, fileType: null }))}
            />
            {types.map((t) => (
              <Pill
                key={t}
                label={typePillLabel(t)}
                // `?? 0` would be a fabricated count anywhere else. Here `t` came
                // out of `galleryFileTypes(rows)`, i.e. it is present in the very
                // rows `countByType` was built from, so the branch is unreachable
                // rather than a silent zero: pills and counts share one source.
                count={countByType.get(t) ?? 0}
                active={filter.fileType === t}
                onClick={() =>
                  onFilterChange((f) => ({ ...f, fileType: f.fileType === t ? null : t }))
                }
              />
            ))}
          </div>
        )}

        <div className="gallery__selects">
          {(kinfolkIds.length > 0 || hasUnattached) && (
            <select
              className="gallery__select"
              aria-label="Household"
              value={householdValue}
              onChange={(e) => {
                const next = e.target.value;
                onFilterChange((f) => ({
                  ...f,
                  kinfolkId:
                    next === HOUSEHOLD_ANY
                      ? null
                      : next === HOUSEHOLD_NONE
                        ? UNATTACHED_KINFOLK_ID
                        : next,
                }));
              }}
            >
              <option value={HOUSEHOLD_ANY}>All households</option>
              {hasUnattached && <option value={HOUSEHOLD_NONE}>No household</option>}
              {kinfolkIds.map((id) => (
                <option key={id} value={id}>
                  {kinfolkLabel.get(id) ?? 'Unknown household'}
                </option>
              ))}
            </select>
          )}

          {months.length > 0 && (
            <select
              className="gallery__select"
              aria-label="Month"
              value={filter.monthPrefix ?? MONTH_ANY}
              onChange={(e) => {
                const next = e.target.value;
                onFilterChange((f) => ({
                  ...f,
                  monthPrefix: next === MONTH_ANY ? null : next,
                }));
              }}
            >
              <option value={MONTH_ANY}>All months</option>
              {months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <p className="gallery__count">
        {visible.length} of {rows.length}
      </p>

      {visible.length === 0 ? (
        <EmptyHint>No media matches these filters.</EmptyHint>
      ) : (
        <ul className="gallery__grid">
          {visible.map((m) => (
            <GalleryTile
              key={m._id}
              media={m}
              householdName={str(m.kinfolkId) !== '' ? kinfolkLabel.get(str(m.kinfolkId)) ?? '' : ''}
              taggedNames={taggedKinNames(m, kinById)}
              onOpen={onOpen}
              onDelete={onDelete}
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

/**
 * The pill's label, plural, as the mock writes them (All / Images / Videos /
 * Documents / Audio). Resolved through `mediaKindOf` rather than by pluralising
 * the raw string, so `IMAGE` and a future `image` land on the same word; an
 * unrecognised `fileType` keeps its own title-cased spelling instead of being
 * folded into a bucket the operator cannot see the name of.
 */
function typePillLabel(fileType: string): string {
  switch (mediaKindOf(fileType)) {
    case 'image':
      return 'Images';
    case 'video':
      return 'Videos';
    case 'document':
      return 'Documents';
    case 'audio':
      return 'Audio';
    case 'other':
      return titleCase(fileType);
  }
}

function Pill({
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
    <button type="button" className="gallery__pill" data-active={active} aria-pressed={active} onClick={onClick}>
      {label} <span className="gallery__pill-count">{count}</span>
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
  /** Asks for the delete confirm dialog (#692). The tile never deletes anything itself. */
  onDelete: (media: MediaFile) => void;
}

/**
 * The glyph-scaling seed handed to `Avatar`, in px.
 *
 * It is NO LONGER the tile's edge (#692). The tile is a square cell in a fluid
 * `auto-fill` grid now, sized by the column it lands in, because the mock's grid
 * fills the content width and a fixed 132px tile left two thirds of a 1258px
 * screen empty. `Avatar` still scales its fallback glyph off the `size` it is
 * given, so this stays as the number that scaling is done against, near the
 * `minmax()` floor in Gallery.css. The box itself is overridden to 100%/100%
 * there.
 */
const TILE_GLYPH_SCALE = 132;

/**
 * One grid cell. A genuine control (#388): a real `<button>`, so it is reachable
 * by Tab and activates on Enter/Space for free, with an explicit `aria-label`
 * naming what it opens rather than leaving screen readers to assemble one from
 * the caption/household/meta text inside it. Clicking or keyboard-activating it
 * opens `MediaViewerDialog`, which owns Escape-to-close, backdrop-click, the
 * focus trap, and returning focus to this button on close (all `Dialog`'s job;
 * see that component).
 *
 * #692. NOTHING IS PRINTED UNDER THE TILE AT REST. The caption, household and
 * meta line moved into the strip over the bottom of the thumbnail, which the
 * mock reveals on hover; three lines of grey text under every cell was what
 * turned the grid into a list.
 *
 * The strip is opacity-faded rather than `display: none`, and it is NOT
 * `aria-hidden` (Media.tsx's strip is, because an always-visible block there
 * repeats it word for word; nothing repeats this one). So the change is
 * visual only: exactly the same nodes sit inside the same labelled button as
 * before. `:focus-visible` on the tile reveals it as well as `:hover`, so a
 * keyboard user is not left with a photo and no context, and a touch device,
 * which has no hover at all, reaches every one of those values by tapping the
 * tile: the viewer shows the caption, the meta line and the tagged kin.
 *
 * THE DELETE CONTROL IS A SIBLING OF THIS BUTTON, NOT A CHILD OF IT. Nesting
 * one interactive element inside another is invalid HTML, gives the inner
 * control undefined activation behaviour across browsers, and is silently
 * accepted by React and jsdom, so a test would go green over a control the
 * operator cannot reliably press. The cell is the positioning context instead.
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

function GalleryTile({ media, householdName, taggedNames, onOpen, onDelete }: GalleryTileProps) {
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
  /**
   * The mock's `.filecell` (#755): a DOCUMENT or AUDIO file has no frame to
   * preview, so the mock draws its glyph and its `originalFileName` in the
   * tile itself, at rest, two lines at most. That is the one text the mock
   * prints on a tile without hover, and it is the file name, never the caption:
   * the caption (`description`) stays in the hover strip like every other
   * tile's. When the two are the same string (no description, so `mediaCaption`
   * fell back to the file name) the strip drops its caption line rather than
   * reading the name out twice.
   */
  const fileCell = kind === 'document' || kind === 'audio';
  const fileName = str(media.originalFileName).trim() !== '' ? str(media.originalFileName).trim() : caption;
  const stripCaption = caption !== '' && !(fileCell && caption === fileName);

  return (
    <li className="gallery__cell">
      <button type="button" className="gallery__tile lift" onClick={() => onOpen(media)} aria-label={`Open ${accessibleLabel}`}>
        <div className="gallery__tile-media">
          {fileCell ? (
            <span className="gallery__tile-file">
              <span className="gallery__tile-file-glyph" aria-hidden="true">
                <TypeGlyph kind={kind} />
              </span>
              {fileName !== '' && <span className="gallery__tile-file-name">{fileName}</span>}
            </span>
          ) : (
            <Avatar
              label={accessibleLabel}
              // Only image/video kinds ever try a thumbnail: a row of another
              // kind with a stray thumbnailUrl set would still not get an image
              // preview, matching the wasm's `canShowImage` gate exactly.
              imageUrl={mediaKindHasPreview(kind) ? previewUrl : undefined}
              glyph={<TypeGlyph kind={kind} />}
              gradientSeed={media._id !== '' ? media._id : accessibleLabel}
              shape="rounded"
              ring={false}
              size={TILE_GLYPH_SCALE}
              className="gallery__tile-avatar"
            />
          )}
          {kind === 'video' && (
            <span className="gallery__tile-play" aria-hidden="true">
              <PlayGlyph />
            </span>
          )}
          {duration !== undefined && <span className="gallery__tile-duration">{duration}</span>}
          {/* The mock's `.pf` marker: a small uppercase mono capsule tinted
              teal, which is the kit's compact StatusPill in its default tone. */}
          {media.isProfilePhoto && (
            <span className="gallery__tile-profile-badge">
              <StatusPill label="Profile" tone="teal" size="compact" />
            </span>
          )}
          {stripFailed && (
            <span className="gallery__tile-strip-badge" title="Location metadata could not be removed from this video.">
              Location not removed
            </span>
          )}

          {/*
            The mock's `.cap` strip, and now the tile's ONLY carrier for this
            text. The household line is the one thing the mock's strip has no
            counterpart for, because that mock is scoped to a single entity and
            this Gallery spans every household: dropping it would leave the
            global grid unable to say whose photo a tile is.
          */}
          <span className="gallery__tile-caption-strip">
            {stripCaption && <span className="gallery__tile-caption">{caption}</span>}
            <span className="gallery__tile-household">
              {householdText(str(media.kinfolkId), householdName)}
            </span>
            {meta !== '' && <span className="gallery__tile-meta">{meta}</span>}
            {/*
              Who is tagged, so the grid answers "which photos have Waddles in
              them" without opening every one. Android's `GalleryThumb` puts the
              same thing on its cell, collapsing to a count past one name because
              three names on a tile would just be an ellipsis.
            */}
            {taggedNames.length > 0 && (
              <span className="gallery__tile-tags">
                {taggedNames.length === 1 ? taggedNames[0] : `${taggedNames.length} kin`}
              </span>
            )}
          </span>
        </div>
      </button>

      {/* The mock's top-end delete X. A sibling of the open button, never a
          child, see this component's header for why nesting it would be a
          control the operator cannot reliably press. Always painted rather than
          hover-only: a touch device has no hover, and an action nobody can
          summon is the same as an action that is not there. */}
      <div className="gallery__tile-actions">
        <IconButton
          icon={<CloseGlyph />}
          label={`Delete ${accessibleLabel}`}
          destructive
          size={26}
          onClick={() => onDelete(media)}
        />
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

/** The mock's delete X (#692). Same glyph Media.tsx's tile action already uses. */
function CloseGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
      <path d="M18 6 6 18" strokeLinecap="round" />
      <path d="m6 6 12 12" strokeLinecap="round" />
    </svg>
  );
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

/** The mock's empty-state image glyph (a frame, a sun, a hill), drawn at half strength over the block. */
function ImageGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className={className} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.6" />
      <path d="m21 15-5-5L5 21" />
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
