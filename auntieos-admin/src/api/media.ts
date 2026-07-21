import { type CollectionSpec } from '../lib/firestore';
import { type MediaFile } from './gallery';

export type { MediaFile };

/**
 * Media API layer for the CONTEXTUAL, single-entity media grid: the wasm
 * `MediaGalleryScreen.kt` / `MediaGalleryViewModel.kt` reached via
 * `#/media/{type}/{id}` (`Route.kt`'s `MediaGallery` destination). Distinct from
 * `gallery.ts`'s `GALLERY_QUERY`, which streams EVERY business's media across
 * every entity: this scopes the SAME `media_files` collection down to the ONE
 * kin or household passed in as `targetId` (see `screens/Media.tsx`'s
 * `targetType`/`targetId` props).
 *
 * WHAT THE WASM ACTUALLY DOES (verified against
 * `composeApp/src/wasmJsMain/.../FirestoreInterop.wasmJs.kt`'s
 * `platformMediaStream`, `composeApp/.../App.kt`, and `Route.kt`/`RouteTest.kt`
 * in web/, not assumed from the field names alone):
 *
 *   1. The route's `{id}` segment becomes `MediaGalleryViewModel`'s `entityId`,
 *      and is the ONLY server-side scoping key: `platformMediaStream` opens a
 *      single Firestore `where('entityId','==',entityId)` listener, no
 *      `orderBy` at all.
 *   2. The route's `{type}` segment becomes `entityType`, and is filtered
 *      CLIENT-SIDE, in a `.map { it.filter { it.entityType == entityType } }`
 *      AFTER the docs already came back over the wire. It is never a second
 *      Firestore `where` clause.
 *   3. `media_files` docs do NOT carry `kinfolkId`/`kinId` scoping fields for
 *      this screen (those exist on the doc, see `MediaModels.kt`, but they
 *      are the Stage 0I test-admin-sandbox convention `gallery.ts`'s
 *      `GALLERY_QUERY` reads, a DIFFERENT write path). The field this screen
 *      actually filters on is `entityId`/`entityType`.
 *
 * A live production sample (`media_files`, project `auntieos-ttpc`, read via the
 * Firebase MCP `firestore_list_documents` tool while building this port) backs
 * point 3 up directly: a kinfolk-scoped row has `entityId: "demo-family-001"`
 * AND `kinfolkId: "demo-family-001"` (the same value on both fields), on a doc
 * that ALSO carries `entityType: "kinfolk"` (lower-case), while a business-logo
 * row alongside it carries `entityType: "BUSINESS"` (upper-case). Neither literal
 * "kin" nor "household" (the route's own type segment, per `RouteTest.kt`'s
 * `#/media/kin/kin_7`) was observed anywhere in the web source or in that
 * sample. So: casing is NOT consistent in the wild today, and the route's type
 * segment has never been proven to equal the value actually written to
 * `entityType` for a real kin/household upload.
 *
 * CONSEQUENCE FOR THIS QUERY: this file scopes ONLY by `entityId` (empirically
 * the reliable, collision-safe key: Firestore doc ids are unique regardless of
 * collection or writer). It deliberately does NOT add a second server-side
 * `where('entityType', ...)` clause using the raw route segment: doing so, given
 * the casing ambiguity above, could silently return an empty grid for a target
 * that genuinely has media, which is the exact false-empty class this project's
 * CLAUDE.md rules out. `lib/mediaScopeFormat.ts`'s `matchesTargetType` exists,
 * unit-tested, as an OPT-IN cross-check once the real convention is confirmed
 * operator-side; `screens/Media.tsx` does not apply it today. See that file's
 * doc comment and the port report for the exact VERIFY item.
 *
 * COMPOSITE INDEX, flagged for the operator: `CollectionSpec.order` is
 * mandatory (see `lib/firestore.ts`), so this query pairs the `entityId`
 * equality filter with `orderBy('uploadedAt', 'desc')` for a newest-first grid
 * (the wasm has no equivalent order at all; this is a deliberate improvement,
 * matching the `GALLERY_QUERY` / `KINFOLK_QUERY` convention of a bounded,
 * SERVER-ordered listener rather than the wasm's unordered stream). Per
 * `lib/firestore.ts`'s own note ("combining a filters predicate on one field
 * with order on another REQUIRES a composite Firestore index") and the
 * `invoices` collection's own precedent in MyTribe/firestore.indexes.json
 * (`kinfolkId` ASC + `amountDue`/`dueDate`), this query needs a composite
 * index:
 *
 *     collectionGroup: media_files
 *     fields: entityId ASC, uploadedAt DESC
 *
 * DEPLOYED. That index, plus the sandbox variant below, are live on
 * `auntieos-ttpc` and declared in `mytribe/firestore.indexes.json` (verified
 * 2026-07-21, 19 composite indexes live). The earlier revision of this comment
 * said none existed; that was true on 2026-07-20 and is stale now.
 *
 * The operator (unscoped) shape uses the 2-field index above. When a TEST ADMIN
 * is signed in, `applyTestScope` adds `kinfolkId == testTribeId` on top of the
 * `entityId` equality, so that shape needs a THIRD index and it does not reuse
 * the 2-field one:
 *
 *     collectionGroup: media_files
 *     fields: entityId ASC, kinfolkId ASC, uploadedAt DESC
 *
 * Both must stay. If either is ever dropped, the matching shape fails at runtime
 * with `failed-precondition`, which surfaces a console link through
 * `AsyncRegion`'s error banner (fail-loud, never a silent empty grid).
 */

/**
 * Never a real `entityId`. Real values look like Firestore document ids
 * ("demo-family-001", a session id, a kin id): short, opaque, never this exact
 * literal. A blank `targetId` (no target selected/passed) resolves to this
 * sentinel rather than either an empty-string equality (a doc COULD in theory
 * carry `entityId: ""`, per `MediaModels.kt`'s own default) or, worse, omitting
 * the filter and streaming the WHOLE `media_files` collection: the AO-29 class
 * of bug (`GALLERY_QUERY`'s own header) this scoped screen must never
 * reintroduce by accident.
 */
export const NO_TARGET_ENTITY_ID_SENTINEL = '__media-no-target-selected__';

/**
 * The bounded, server-ordered listener for ONE entity's media. `targetId` is
 * trimmed defensively (a route param can arrive with stray whitespace); blank
 * resolves to {@link NO_TARGET_ENTITY_ID_SENTINEL} so the query is always
 * well-formed and never matches a real document. Capped at 500 like
 * `GALLERY_QUERY`: generous for a single entity's uploads (Android's own
 * `MAX_FILES_PER_TALE` cap is 75 for a single KinTale), so raising it is not
 * expected to be a near-term follow-up the way `GALLERY_QUERY`'s cap might be.
 */
export function mediaTargetQuery(targetId: string): CollectionSpec {
  const id = targetId.trim();
  return {
    path: 'media_files',
    filters: [['entityId', '==', id === '' ? NO_TARGET_ENTITY_ID_SENTINEL : id]],
    order: ['uploadedAt', 'desc'],
    max: 500,
  };
}
