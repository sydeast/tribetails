import type { Timestamp } from 'firebase/firestore';
import { dayKey, type FsTime } from './time';
import { str } from './coerce';
import type { MediaFile } from '../api/gallery';

/**
 * Pure Gallery classification + display + filter helpers, kept out of the screen
 * so the mapping logic has direct vitest coverage (the invoiceFormat.ts /
 * sessionFormat.ts convention). Ports `AuntieMediaCell.kt`'s `mediaKindOf` /
 * `mediaMetaLine` and `GalleryFilters.kt` in full: the wasm's Gallery-specific
 * pure logic, none of which touches Compose.
 */

// ── type classification (positive enumeration, no negation) ────────────────

/**
 * Every kind this module will ever return. Mirrors `AuntieMediaCell.kt`'s
 * private `MediaKind` enum: IMAGE / VIDEO get a thumbnail preview; DOCUMENT /
 * AUDIO get a tinted glyph + filename (no visual frame to preview); `other` is
 * the one kind no writer produces today, kept honest rather than silently
 * folded into `document` (the AO-12 lesson: a positive match against the
 * literal text, never "not one of the others, so must be Y").
 */
export type MediaKind = 'image' | 'video' | 'document' | 'audio' | 'other';

/** Classifies a `MediaFile.fileType` free-text field, case-insensitively (mirrors the wasm's own `.uppercase()` compare). */
export function mediaKindOf(fileType: string): MediaKind {
  // Guarded at the boundary: callers pass a RAW Firestore field, which the
  // `string` annotation cannot actually guarantee.
  switch (str(fileType).trim().toUpperCase()) {
    case 'IMAGE':
      return 'image';
    case 'VIDEO':
      return 'video';
    case 'DOCUMENT':
      return 'document';
    case 'AUDIO':
      return 'audio';
    default:
      return 'other';
  }
}

/** True for the two kinds a grid tile can show a visual preview for (image/video thumbnail). */
export function mediaKindHasPreview(kind: MediaKind): boolean {
  return kind === 'image' || kind === 'video';
}

// ── preview / caption / meta ────────────────────────────────────────────────

/**
 * The URL a tile should try first: `thumbnailUrl`, falling back to `storageUrl`
 * (the full asset) when no thumbnail was generated, or `undefined` when neither
 * is set. Ports the wasm's `media.thumbnailUrl.ifBlank { media.storageUrl }
 * .takeIf { it.isNotBlank() }` exactly. A caller passes this into `Avatar`'s
 * `imageUrl`, which already owns the "track the failed url, fall back rather
 * than leaving a blank hole" behavior: this function does not re-solve that.
 */
export function mediaPreviewUrl(media: Pick<MediaFile, 'thumbnailUrl' | 'storageUrl'>): string | undefined {
  // str(): a real media_files doc can lack these entirely. MediaFile is a cast
  // over raw Firestore data, and reading one blind blanked the whole Gallery
  // page through the error boundary (2026-07-20).
  const thumb = str(media.thumbnailUrl).trim();
  if (thumb !== '') return thumb;
  const storage = str(media.storageUrl).trim();
  return storage !== '' ? storage : undefined;
}

/**
 * The URL the fullscreen viewer should try first: the reverse preference from
 * {@link mediaPreviewUrl}. A grid tile wants the small, fast `thumbnailUrl`;
 * the viewer a tap on that tile opens wants the full-resolution original, so it
 * tries `storageUrl` first and falls back to `thumbnailUrl` only when no
 * original was ever recorded. Ports Android's `FullscreenMediaViewer`
 * (`MediaGalleryScreen.kt`) and `GalleryScreen.kt`'s `MediaViewerDialog`, both
 * of which read `media.storageUrl.ifBlank { media.thumbnailUrl }`.
 */
export function mediaViewerUrl(media: Pick<MediaFile, 'thumbnailUrl' | 'storageUrl'>): string | undefined {
  const storage = str(media.storageUrl).trim();
  if (storage !== '') return storage;
  const thumb = str(media.thumbnailUrl).trim();
  return thumb !== '' ? thumb : undefined;
}

/** Read-only display caption: `description`, falling back to `originalFileName`. Ports the wasm's `media.description.ifBlank { media.originalFileName }`. Caption EDITING is a separate, not-yet-built surface: this only reads what's stored. */
export function mediaCaption(media: Pick<MediaFile, 'description' | 'originalFileName'>): string {
  const d = str(media.description).trim();
  if (d !== '') return d;
  return str(media.originalFileName).trim();
}

/**
 * "{uploadedAt date} · {uploadedBy}", dropping any part that is blank or
 * fabricated. Ports `AuntieMediaCell.kt`'s internal `mediaMetaLine` exactly: the
 * ISO `uploadedAt` is reduced to its `YYYY-MM-DD` prefix (never fabricated when
 * unparseable: reuses `isoDatePrefixOrNull`, the same guard InvoiceEntry's free-
 * text date fields use), and a blank or placeholder "auntie" `uploadedBy` is
 * omitted rather than shown as a real author. Returns `''` when nothing real
 * remains: the caller must not print an empty meta line.
 */
/**
 * Wraps the free-text ISO `uploadedAt` instant as a Timestamp so it flows through
 * lib/time's LOCAL day/month keys: the AO-18 fix. `uploadedAt` is a full UTC
 * instant (see api/gallery.ts), so a raw `.slice(0, 10)` / `.slice(0, 7)` would
 * bucket a 7pm-CDT upload under TOMORROW's date and next month. Mirrors
 * sessionFormat.sessionTimeOf / kinTaleFormat.kinTaleTimeOf.
 */
function mediaTimeOf(uploadedAt: string): FsTime {
  const trimmed = str(uploadedAt).trim();
  if (trimmed === '') return null;
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return null;
  return { toDate: () => d } as unknown as Timestamp;
}

/** LOCAL `YYYY-MM-DD` for an upload instant, or '' when blank/unparseable (AO-18). */
export function mediaLocalDay(uploadedAt: string): string {
  const key = dayKey(mediaTimeOf(uploadedAt));
  return key === 'Undated' ? '' : key;
}

/** LOCAL `YYYY-MM` for an upload instant, or null when blank/unparseable (AO-18). */
export function mediaLocalMonth(uploadedAt: string): string | null {
  const day = mediaLocalDay(uploadedAt);
  return day === '' ? null : day.slice(0, 7);
}

export function mediaMetaLine(uploadedAt: string, uploadedBy: string): string {
  const date = mediaLocalDay(uploadedAt);
  const author = str(uploadedBy).trim();
  const realAuthor = author !== '' && author.toLowerCase() !== 'auntie' ? author : '';
  return [date, realAuthor].filter((s) => s !== '').join(' · ');
}

/**
 * "m:ss" / "h:mm:ss" for a video duration, or `undefined` for anything <= 0 or
 * non-finite: never fabricates "0:00" for a photo or an unset duration. Ports
 * `AuntieMediaCell.kt`'s private `formatDuration`.
 */
export function mediaDurationLabel(totalSeconds: number): string | undefined {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return undefined;
  const total = Math.floor(totalSeconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ── filtering (household / type / month) ────────────────────────────────────

/**
 * The Gallery filter state. Ports `GalleryFilters.kt`'s `GalleryFilter` data
 * class verbatim: `null` means "all" on every axis, matching the wasm's own
 * three independent chip rows (Household / Type / Month).
 */
export interface GalleryFilter {
  kinfolkId: string | null;
  fileType: string | null;
  /** "YYYY-MM"; null = all months. */
  monthPrefix: string | null;
}

export const GALLERY_FILTER_DEFAULT: GalleryFilter = {
  kinfolkId: null,
  fileType: null,
  monthPrefix: null,
};

/** A subset of MediaFile these pure helpers actually read: a `Pick`, not a re-import of the full shape, so a test can pass a minimal fixture. */
export type GalleryRow = Pick<MediaFile, 'kinfolkId' | 'fileType' | 'uploadedAt'>;

/**
 * Applies the active filters. Does NOT re-sort: `GALLERY_QUERY` already streams
 * rows `uploadedAt` descending, so filtering here preserves that order rather
 * than re-deriving it (the wasm's `filterGalleryMedia` re-sorts because its
 * source stream is unbounded/unordered: see GALLERY_QUERY's header for why
 * that gap doesn't exist here).
 */
export function filterGalleryMedia<T extends GalleryRow>(all: T[], filter: GalleryFilter): T[] {
  return all.filter(
    (m) =>
      (filter.kinfolkId === null || str(m.kinfolkId).trim() === filter.kinfolkId.trim()) &&
      (filter.fileType === null ||
        str(m.fileType).trim().toUpperCase() === filter.fileType.trim().toUpperCase()) &&
      // str(): `uploadedAt` is optional on MediaFile because a real doc can omit
      // it (see api/gallery.ts). An absent instant reads as blank, which
      // `mediaLocalMonth` already maps to null, so the row simply matches no
      // month bucket rather than throwing partway through the filter.
      (filter.monthPrefix === null || mediaLocalMonth(str(m.uploadedAt)) === filter.monthPrefix),
  );
}

/** Plain code-unit comparison (not `localeCompare`), matching the directory.ts/invoiceFormat.ts convention. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Distinct `YYYY-MM` buckets present, newest first. Ports `galleryMonths`. */
export function galleryMonths(all: GalleryRow[]): string[] {
  const set = new Set<string>();
  for (const m of all) {
    const prefix = mediaLocalMonth(str(m.uploadedAt));
    if (prefix) set.add(prefix);
  }
  return [...set].sort((a, b) => cmp(b, a));
}

/** Distinct kinfolkIds present (blank dropped), in first-seen order. Ports `galleryKinfolkIds`. */
export function galleryKinfolkIds(all: GalleryRow[]): string[] {
  const seen = new Set<string>();
  for (const m of all) {
    const id = str(m.kinfolkId).trim();
    if (id !== '') seen.add(id);
  }
  return [...seen];
}

/**
 * The `GalleryFilter.kinfolkId` value for the "Company / no household" facet:
 * media genuinely unrelated to any kinfolk (operator ruling 2026-07-31).
 * Deliberately NOT a new sentinel: `''` is already the value `str()` reduces
 * both a missing `kinfolkId` field and an explicitly blank one to (see
 * `api/gallery.ts`'s `MediaFile` comment), so filtering on it is exact, not an
 * approximation. Distinguishable from "All" (`null`) by TYPE alone.
 */
export const UNATTACHED_KINFOLK_ID = '';

/**
 * True when at least one row has no resolvable kinfolkId. Gates the "Company /
 * no household" chip in `Gallery.tsx`: it should appear exactly when it would
 * match something, the same "only offer a facet with real rows behind it"
 * discipline `galleryKinfolkIds`/`galleryFileTypes` already apply to their own
 * chips.
 */
export function galleryHasUnattachedMedia(all: GalleryRow[]): boolean {
  return all.some((m) => str(m.kinfolkId).trim() === '');
}

/** Distinct fileTypes present, alphabetical. Ports `galleryFileTypes`. */
export function galleryFileTypes(all: GalleryRow[]): string[] {
  const set = new Set<string>();
  for (const m of all) {
    const t = str(m.fileType).trim();
    if (t !== '') set.add(t);
  }
  return [...set].sort(cmp);
}

// ── kin tagging (#447) ─────────────────────────────────────────────────────

/**
 * The subset of `Kin` (api/directory.ts) the tagging helpers read. A `Pick`-shaped
 * structural type rather than an import of the full interface, matching
 * `GalleryRow` above: a test fixture should not have to invent an `updatedAt`
 * Timestamp to exercise a name lookup.
 */
export interface TaggableKin {
  _id: string;
  kinfolkId?: string | undefined;
  name?: string | undefined;
  status?: string | undefined;
}

/**
 * The normalisation point for `MediaFile.taggedKinIds`.
 *
 * The field is ABSENT on every doc written before #447 and on every doc the
 * upload pipeline creates, and `useCollection` casts raw Firestore data without
 * validating it, so the declared `string[] | undefined` is a promise TypeScript
 * cannot keep. A stray non-array (or an array carrying a number, which nothing
 * writes today but nothing prevents either) must read as "no tags", never throw
 * inside a `.map` and take the whole grid down with it. Same discipline as
 * `str()`/`arr()` in lib/coerce.ts, plus the blank/dupe squeeze the callable
 * applies server-side, so what the screen shows and what the server stored are
 * the same list.
 */
export function mediaTaggedKinIds(media: Pick<MediaFile, 'taggedKinIds'>): string[] {
  const raw: unknown = media.taggedKinIds;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const id = str(v).trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * #593. What the asynchronous video location strip has managed so far.
 *
 *   'pending'  queued, not processed yet. The stored original still holds
 *              whatever coordinates the camera wrote. This is the exposure
 *              window the operator ruling accepted, normally seconds.
 *   'stripped' verified clean: the bytes Cloudinary serves were read back and
 *              checked, not merely assumed.
 *   'failed'   tried and did not succeed. The video still carries its
 *              coordinates and needs a human. THIS is the state the UI has to
 *              show; the other two are ordinary progress.
 *   'unknown'  no state on the doc. Every image (stripped before storage, so
 *              there is no async step to report), and every video that
 *              predates #593. Deliberately NOT reported as clean: we do not
 *              know, and a badge claiming otherwise would be a lie.
 *
 * Mirrors Android's `mediaGpsStripState` in MediaFormat.kt. Coerces an absent
 * field, a null, or an unrecognized string rather than throwing: this runs per
 * tile in the gallery grid.
 */
export type MediaGpsStripState = 'pending' | 'stripped' | 'failed' | 'unknown';

export function mediaGpsStripState(media: Pick<MediaFile, 'gpsStripStatus'>): MediaGpsStripState {
  switch (str(media.gpsStripStatus).trim().toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'STRIPPED':
      return 'stripped';
    case 'FAILED':
      return 'failed';
    default:
      return 'unknown';
  }
}

/**
 * Resolves a file's tagged kin ids to display names. Ports Android's
 * `taggedKinNames` (domain/GalleryFilters.kt) verbatim, including the part that
 * looks like a bug and is not: an id with no matching kin, or a kin with a blank
 * name, is DROPPED rather than rendered as "Unknown". A tag chip exists to say
 * who is in the photo; a chip that says "Unknown" answers nothing and takes up
 * the space that a real name would.
 */
export function taggedKinNames(
  media: Pick<MediaFile, 'taggedKinIds'>,
  kinById: Map<string, TaggableKin>,
): string[] {
  return mediaTaggedKinIds(media)
    .map((id) => str(kinById.get(id)?.name).trim())
    .filter((name) => name !== '');
}

/**
 * Which kin the tag picker may offer for one file. Ports Android's `taggableKin`
 * (domain/GalleryFilters.kt): scoped to the file's own household when it has
 * one, otherwise the whole roster, because media genuinely unrelated to any
 * household (company uploads, operator ruling 2026-07-31) still shows animals.
 *
 * The SERVER enforces this same rule in `saveMediaTags`, which is what makes it
 * a rule rather than a picker convenience: narrowing the list here only means
 * the operator is never offered a choice the callable would reject.
 */
export function taggableKin<T extends TaggableKin>(
  media: Pick<MediaFile, 'kinfolkId'>,
  allKin: T[],
): T[] {
  const kinfolkId = str(media.kinfolkId).trim();
  if (kinfolkId === '') return allKin;
  return allKin.filter((k) => str(k.kinfolkId).trim() === kinfolkId);
}
