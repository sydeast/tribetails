import { isoDatePrefixOrNull } from './invoiceFormat';
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
  switch (fileType.trim().toUpperCase()) {
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
  const thumb = media.thumbnailUrl.trim();
  if (thumb !== '') return thumb;
  const storage = media.storageUrl.trim();
  return storage !== '' ? storage : undefined;
}

/** Read-only display caption: `description`, falling back to `originalFileName`. Ports the wasm's `media.description.ifBlank { media.originalFileName }`. Caption EDITING is a separate, not-yet-built surface: this only reads what's stored. */
export function mediaCaption(media: Pick<MediaFile, 'description' | 'originalFileName'>): string {
  const d = media.description.trim();
  if (d !== '') return d;
  return media.originalFileName.trim();
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
export function mediaMetaLine(uploadedAt: string, uploadedBy: string): string {
  const date = isoDatePrefixOrNull(uploadedAt) ?? '';
  const author = uploadedBy.trim();
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
      (filter.kinfolkId === null || m.kinfolkId === filter.kinfolkId) &&
      (filter.fileType === null || m.fileType.toUpperCase() === filter.fileType.toUpperCase()) &&
      (filter.monthPrefix === null || m.uploadedAt.startsWith(filter.monthPrefix)),
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
    const prefix = m.uploadedAt.slice(0, 7);
    if (prefix.length === 7 && prefix[4] === '-') set.add(prefix);
  }
  return [...set].sort((a, b) => cmp(b, a));
}

/** Distinct kinfolkIds present (blank dropped), in first-seen order. Ports `galleryKinfolkIds`. */
export function galleryKinfolkIds(all: GalleryRow[]): string[] {
  const seen = new Set<string>();
  for (const m of all) {
    const id = m.kinfolkId.trim();
    if (id !== '') seen.add(id);
  }
  return [...seen];
}

/** Distinct fileTypes present, alphabetical. Ports `galleryFileTypes`. */
export function galleryFileTypes(all: GalleryRow[]): string[] {
  const set = new Set<string>();
  for (const m of all) {
    const t = m.fileType.trim();
    if (t !== '') set.add(t);
  }
  return [...set].sort(cmp);
}
