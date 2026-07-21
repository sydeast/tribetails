import { type CollectionSpec } from '../lib/firestore';

/**
 * Gallery API layer, ported from the wasm `GalleryScreen.kt` / `GalleryFilters.kt`
 * (#13 global Gallery: every piece of business media across all KinTales/entities
 * in one place). Backs the LIST/GRID only: upload, the tag-kin lightbox overlay,
 * and caption editing are separate, not-yet-built surfaces (see Gallery.tsx).
 *
 * ONE live Firestore collection backs this screen:
 *
 *   media_files   top-level, one doc per uploaded photo/video, written CLIENT-SIDE
 *                 direct to Firestore (both the wasm's FirestoreInterop.wasmJs.kt
 *                 `jsAddDoc("media_files", ...)` and Android's
 *                 AuntieRepository.kt#saveMediaFile: no Cloud Function creates
 *                 these docs; MyTribe functions/src only PATCHES existing docs,
 *                 e.g. admin/setMediaProfilePhoto.ts). Rules
 *                 (web/firestore.rules:598-603) gate read to
 *                 `isAuntie() || testOwnsExisting()`, the same admin-catch-all
 *                 shape as kinfolk/kin/invoices.
 *
 * Only the fields this screen actually renders are modeled here (not the full
 * ~20-field MediaFile shape in MediaModels.kt): the Kinfolk/InvoiceEntry subset
 * convention. Dropped: entityId/entityType (which KinTale/session it belongs to,
 * not shown in the grid), fileName/mimeType/fileSizeBytes/width/height/
 * cloudinaryPublicId (storage bookkeeping, not rendered), tags/taggedKinIds (the
 * free-text tag list and the kin-tagging feature: tagging is the not-yet-built
 * lightbox overlay, out of scope for a LIST/GRID port).
 */

/**
 * WHY EVERY DOCUMENT FIELD IS OPTIONAL: this interface is a CAST over raw
 * Firestore data (`useCollection`'s `{ ...d.data(), _id: d.id } as T`), not a
 * validation of it. Declaring `fileType: string` does not make the key exist;
 * `media_files` is written client-side with no schema enforcement, and a live
 * sandbox doc sampled 2026-07-20 (`test-kinfolk-001-media-1`) carries only
 * `_id`/`kinfolkId`/`kinId`/`storageUrl`/`uploadedAt`/`isProfilePhoto` — no
 * `fileType`, `description`, `originalFileName`, `thumbnailUrl` or `uploadedBy`
 * at all. Reading one of those blind and calling `.trim()` throws, and React's
 * error boundary turns that single row into a BLANK GALLERY PAGE. Optional here
 * forces every reader to default at the point of use (`?? ''`, or `str()` from
 * `lib/coerce`). `_id` stays required: `useCollection` always sets it.
 * `durationSeconds` stays a required number on purpose — see its comment below.
 */
export interface MediaFile {
  _id: string;
  /** Household this media belongs to. Blank on a doc predating the association, or on operator-scoped media (see MediaModels.kt's kinfolkId comment). */
  kinfolkId?: string | undefined;
  /** "IMAGE" | "VIDEO" | "DOCUMENT" | "AUDIO" free text: go through `lib/mediaFormat.ts`'s `mediaKindOf`, never switch on this directly (same discipline as InvoiceEntry.status). */
  fileType?: string | undefined;
  /** Cloudinary delivery URL for the original asset. */
  storageUrl?: string | undefined;
  /** Cloudinary thumbnail URL (a still frame for video). Preferred preview source when present. */
  thumbnailUrl?: string | undefined;
  /** Client-set ISO-8601 instant string, NOT a Firestore Timestamp: confirmed against both writers (`java.time.Instant.now().toString()` on Android, `nowIso` on wasm). No real server timestamp exists on this collection to fall back on. */
  uploadedAt?: string | undefined;
  /** Free-text uploader label. A placeholder "auntie" value is dropped by `mediaMetaLine`, never shown as a real author (mirrors the wasm's own `mediaMetaLine`). */
  uploadedBy?: string | undefined;
  /** Operator-entered caption. Falls back to `originalFileName` when blank: never left empty (see `mediaCaption`). */
  description?: string | undefined;
  originalFileName?: string | undefined;
  /** True for the household's designated profile photo (spec 28 item 2). */
  isProfilePhoto: boolean;
  /** Video-only. 0/absent on every other type: `mediaDurationLabel` treats <=0 as "no duration to show", never fabricating "0:00". */
  durationSeconds: number;
}

/**
 * The bounded, server-ordered media listener. Ordered by `uploadedAt` descending
 * (newest first, matching the wasm's own `sortedByDescending { it.uploadedAt }`).
 * Firestore `orderBy` on this string field sorts lexically; every writer stamps a
 * same-format ISO-8601 UTC instant, so lexical order matches chronological order
 * for BOUNDING the page. That ordering is UTC on the raw string; the screen's
 * DISPLAY day/month come from `mediaFormat.mediaLocalDay`/`mediaLocalMonth`, which
 * re-key each instant to the operator's LOCAL zone (AO-18), never a raw UTC slice.
 * And `orderBy('uploadedAt')` silently DROPS any doc missing the field (client-SDK
 * writes are allowed by rules): flagged for operator prod-verification. Capped at 500, the same generous single-business cap
 * KINFOLK_QUERY/KIN_QUERY use: closes AO-29 (the wasm's `platformAllMediaStream()`
 * is an UNBOUNDED whole-collection listen with no orderBy/limit at all).
 *
 * KNOWN TRADEOFF, same shape as KINFOLK_QUERY's: a business with more than 500
 * media docs will not see the oldest ones in this list. Flagged for operator
 * prod-verification, not silently accepted; raising the cap or adding real
 * pagination is a follow-up, not a reason to ship the AO-29 unbounded read back.
 *
 * NO `filters`: household/type/month filtering happens client-side over the
 * already-streamed page (`lib/mediaFormat.ts`'s `filterGalleryMedia`, mirroring
 * the wasm's own client-side `GalleryFilter`), so this query needs NO composite
 * Firestore index (single-field orderBy is always covered by the automatic
 * single-field index).
 */
export const GALLERY_QUERY: CollectionSpec = {
  path: 'media_files',
  order: ['uploadedAt', 'desc'],
  max: 500,
};
