import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { type CollectionSpec } from '../lib/firestore';

/**
 * Gallery API layer, ported from the wasm `GalleryScreen.kt` / `GalleryFilters.kt`
 * (#13 global Gallery: every piece of business media across all KinTales/entities
 * in one place). Backs the LIST/GRID plus the fullscreen viewer a tile opens
 * (`components/MediaViewerDialog.tsx`, #388) and the "Tag kin" hand-off that
 * viewer offers (`components/TagKinDialog.tsx` -> the `saveMediaTags` callable,
 * #447). Caption editing remains a separate, not-yet-built surface (see
 * Gallery.tsx).
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
 * convention. Dropped: fileName/mimeType/fileSizeBytes/width/height/
 * cloudinaryPublicId (storage bookkeeping, not rendered), and `tags` (a
 * separate free-text tag list nothing on this screen reads).
 *
 * `entityId`/`entityType` ARE modeled now (#397 S2). They were dropped while
 * this was a read-only grid, because nothing on screen shows them. The moment a
 * grid can delete a file or promote it to a profile photo, they stop being
 * bookkeeping: both `deleteMediaFile` and `setMediaProfilePhoto` cross-check the
 * caller's entity against the STORED one and refuse a mismatch, so the row is
 * the only correct source for those arguments. The route's `{type}`/`{id}`
 * segments are not: `#/media/household/fam1` carries `household` where the
 * document carries `KINFOLK` (or lower-case `kinfolk` on older rows).
 *
 * `taggedKinIds` IS modeled now (#447): the Gallery tags kin in a photo and
 * shows who is tagged, mirroring Android's `GalleryScreen.kt`. Writes go
 * through the `saveMediaTags` callable (`api/mediaTags.ts`), never a direct
 * document write -- `firestore.rules` refuses a client update touching the key.
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
  /** The document this file hangs off: a kin id, a household id, or `business_settings`. The scoping key `api/media.ts`'s query filters on, and the only correct `entityId` to hand a media callable. */
  entityId?: string | undefined;
  /** "KINFOLK" | "KIN" | "BUSINESS" | ..., CASING VARIES IN THE WILD ("kinfolk" and "BUSINESS" live side by side; see api/media.ts's header). Pass it through verbatim; never compare it to the route's `{type}` segment. */
  entityType?: string | undefined;
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
  /**
   * Kin document ids tagged in this file (#447). ABSENT on every doc written
   * before tagging existed, and on every doc the upload pipeline creates, which
   * is why it is optional like the rest: read it through
   * `lib/mediaFormat.ts#mediaTaggedKinIds`, which coerces a missing field, a
   * `null`, or the wrong type to `[]` rather than letting `.map` throw and take
   * the whole grid down with it (the AO-12 lesson this file's header spells
   * out). Written ONLY by the `saveMediaTags` callable.
   */
  taggedKinIds?: string[] | undefined;
  /**
   * #593. Where this video is in the asynchronous location-metadata strip:
   * "PENDING" | "STRIPPED" | "FAILED". ABSENT on every image (an image is
   * stripped before Cloudinary stores it, #583, so it has no async state) and
   * absent on every video uploaded before #593 — historical assets are out of
   * scope and are not backfilled. Read it through
   * `lib/mediaFormat.ts#mediaGpsStripState`, which coerces an absent field, a
   * `null` or an unrecognized string to `unknown` rather than letting the grid
   * assert something it cannot know.
   */
  gpsStripStatus?: string | undefined;
  /** #593. How many times the strip has been attempted. Absent means none. */
  gpsStripAttempts?: number | undefined;
  /** #593. The last failure message, bounded to 500 chars. Blank on success. */
  gpsStripError?: string | undefined;
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
/**
 * One-shot read of specific `media_files` docs by id, preserving the order of
 * `ids` and DROPPING any that no longer exist.
 *
 * Used by the KinTale composer's photo strip. It reads by id rather than
 * querying `entityId == sessionId` deliberately:
 *
 *  - a report's attached photos are exactly its `mediaFileIds`, so the ids are
 *    the precise question, while the session query would also return media
 *    uploaded to that visit but attached to a different tale;
 *  - `getDoc` needs no composite index. A filtered, ordered `useCollection` on
 *    `media_files` would, and a missing index is a runtime failure no jsdom test
 *    can see;
 *  - attach ORDER is the operator's, and Android preserves it
 *    (`KinTaleReportViewModel.kt:654` appends). The desktop's session stream
 *    overwrites `mediaFileIds` with `uploadedAt`-descending order
 *    (`KinTaleComposeScreen.kt:243-251`), silently rearranging a list the
 *    operator built; reading by id cannot do that.
 *
 * A DELETED doc is skipped rather than throwing, unlike `api/kinView.ts#getKin`.
 * A kin is only ever opened from a Directory card, so a missing one is a real
 * error; a media id, by contrast, is a reference held on another document and
 * the file behind it can legitimately have been deleted from the gallery since.
 * Losing one thumbnail must not blank the composer.
 *
 * A rejected READ still propagates: that is a permissions or connectivity fact
 * the screen has to surface, not a missing row.
 */
export async function getMediaFilesByIds(ids: readonly string[]): Promise<MediaFile[]> {
  const wanted = ids.filter((id) => id.trim() !== '');
  if (wanted.length === 0) return [];
  const snaps = await Promise.all(wanted.map((id) => getDoc(doc(db, 'media_files', id))));
  const out: MediaFile[] = [];
  snaps.forEach((snap) => {
    if (!snap.exists()) return;
    const raw = snap.data() as Record<string, unknown>;
    out.push({
      ...(raw as Omit<MediaFile, '_id' | 'isProfilePhoto' | 'durationSeconds'>),
      _id: snap.id,
      // The two non-optional fields on `MediaFile`, defaulted here for the same
      // reason the interface leaves everything else optional: this is a cast
      // over raw document data, and a doc written before either field existed
      // would otherwise hand a screen an `undefined` it was promised could not
      // happen.
      isProfilePhoto: raw['isProfilePhoto'] === true,
      durationSeconds:
        typeof raw['durationSeconds'] === 'number' && Number.isFinite(raw['durationSeconds'])
          ? raw['durationSeconds']
          : 0,
    });
  });
  return out;
}
