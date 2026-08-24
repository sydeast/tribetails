import type { MediaFile } from '../api/gallery';

/**
 * Pure helpers for the contextual, single-entity `Media` screen (see
 * `screens/Media.tsx` and `api/media.ts`'s query). Kept out of the screen so
 * the "no target" / defensive-read / type-label decisions have direct vitest
 * coverage, matching the `mediaFormat.ts` convention.
 */

// ── target scope ─────────────────────────────────────────────────────────────

/**
 * The route's `{type}` segment (`#/media/{type}/{id}`, `Route.kt`'s
 * `MediaGallery` destination). Matches the task's route contract; see
 * `api/media.ts`'s file header for why this value is NOT proven to equal any
 * `entityType` string actually written to Firestore today.
 */
export type MediaTargetType = 'kin' | 'household';

/** True for a blank or whitespace-only target id: "no target selected", not a real id. */
export function isBlankTargetId(targetId: string): boolean {
  return targetId.trim() === '';
}

/** Title-case noun for headings/copy: "Kin" or "Household". */
export function targetTypeLabel(targetType: MediaTargetType): string {
  return targetType === 'household' ? 'Household' : 'Kin';
}

/**
 * Cross-checks a row's stored `entityType` against the scope's `targetType`,
 * mirroring the wasm's own `it.entityType == entityType`
 * (`FirestoreInterop.wasmJs.kt`'s `platformMediaStream`): exact, case-sensitive,
 * no normalization.
 *
 * NOT applied by `screens/Media.tsx` today. A live `media_files` sample (read
 * via the Firebase MCP tools while building this port) has `entityType` values
 * "kinfolk" (lower-case) and "BUSINESS" (upper-case) side by side, and neither
 * literal "kin" nor "household" was ever observed written by any platform.
 * Applying this filter with the route's literal segment would show a confident
 * empty grid for real media until that casing question is settled operator-
 * side, which is exactly the false-empty class this project's CLAUDE.md
 * forbids. Exported and unit-tested so a caller can opt in once the real
 * write-side convention is confirmed; see `api/media.ts`'s header for the full
 * VERIFY note.
 */
export function matchesTargetType(entityType: string, targetType: MediaTargetType): boolean {
  return entityType === targetType;
}

// ── defensive reads ──────────────────────────────────────────────────────────

/**
 * Fills in every field `api/gallery.ts`'s `MediaFile` renders with its schema
 * default (mirrors that interface's own field comments / `MediaModels.kt`'s
 * defaults), so a doc missing a field reads as "not set", not `undefined`.
 *
 * This matters concretely, not hypothetically: a live `media_files` doc sampled
 * while building this port (`test-kinfolk-001-media-1`, the Stage 0I sandbox
 * shape) has ONLY `_id`, `kinfolkId`, `kinId`, `storageUrl`, `uploadedAt`,
 * `isProfilePhoto`, `isTestData` set. It carries no `fileType`, `description`,
 * `originalFileName`, `thumbnailUrl`, or `uploadedBy` at all. `useCollection`'s
 * `{ ...d.data(), _id: d.id } as T` cast does not fill in the rest: those keys
 * are genuinely absent (`undefined`) at runtime despite the `MediaFile` type
 * saying `string`. `mediaFormat.ts`'s helpers (`mediaCaption`, `mediaPreviewUrl`,
 * `mediaMetaLine`, ...) all call `.trim()` on those fields and assume a real
 * string, so calling them on a raw doc with a missing field throws instead of
 * degrading gracefully. Running every row through this function before it
 * reaches `mediaFormat.ts` (or `Avatar`) closes that gap.
 */
export function withMediaDefaults(row: Partial<MediaFile> & { _id: string }): MediaFile {
  return {
    _id: row._id,
    kinfolkId: row.kinfolkId ?? '',
    // #397 S2: the media callables cross-check these against the stored doc and
    // refuse a mismatch, so a blank default is the honest value for a row that
    // genuinely carries neither. A caller must treat blank as "this file has no
    // entity", never substitute the route's own segments (see api/gallery.ts).
    entityId: row.entityId ?? '',
    entityType: row.entityType ?? '',
    fileType: row.fileType ?? 'IMAGE',
    storageUrl: row.storageUrl ?? '',
    thumbnailUrl: row.thumbnailUrl ?? '',
    uploadedAt: row.uploadedAt ?? '',
    uploadedBy: row.uploadedBy ?? '',
    description: row.description ?? '',
    originalFileName: row.originalFileName ?? '',
    isProfilePhoto: row.isProfilePhoto ?? false,
    durationSeconds: row.durationSeconds ?? 0,
  };
}
