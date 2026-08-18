import { type CollectionSpec } from '../lib/firestore';
import type { Timestamp } from 'firebase/firestore';

/**
 * One Cloudinary attachment on a `training_documents` doc. Mirrors the wasm
 * `TrainingDocAttachment` data class (`FirestoreClient.kt:2642`) and the
 * backend's `AttachmentSchema` (`createTrainingDocument.ts`) field-for-field.
 *
 * Optional for the same reason as `TribalIntelEntry` below: these are raw
 * map entries off the document, cast rather than validated. A half-written
 * attachment must not be able to throw on read.
 */
export interface TribalIntelAttachment {
  storageUrl?: string | undefined;
  cloudinaryPublicId?: string | undefined;
  fileType?: string | undefined;
  mimeType?: string | undefined;
  fileName?: string | undefined;
}

/**
 * One `training_documents` row ("Tribal Intel": a free-text note an Auntie
 * writes about a household or a single pet, queued for the nightly reconcile
 * pipeline that folds it into the client's Dossier / pet Kin411). Mirrors the
 * wasm `TrainingDocument` data class
 * (composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:2622),
 * the flat top-level collection `TrainingDocumentsScreen.kt` (the admin list
 * this screen ports) reads, and MyTribe's create/update/delete callables all
 * write.
 *
 * COLLECTION + FIELD SHAPES CONFIRMED, not assumed from the Kotlin model
 * alone, against:
 *  - `MyTribe/firestore.rules:616`, `match /training_documents/{id}`
 *    (`allow read: if isAuntie(); allow write: if false;`): an admin gets an
 *    unfiltered collection read (same shape as KINTALES_QUERY/
 *    INVOICES_QUERY), but every write is server-bound through the three
 *    admin callables described below (create, update, delete ship in the UI).
 *  - `MyTribe/functions/src/admin/createTrainingDocument.ts`: the real
 *    creation path. Stamps `createdAt: FieldValue.serverTimestamp()` (a REAL
 *    Firestore Timestamp: unlike `kin_care_reports.createdAt`, which is a
 *    client-computed ISO string, per `api/kinTales.ts`'s own doc comment) and
 *    a client-computed `uploadedAt: new Date().toISOString()` (opaque
 *    free-text, same caveat as `invoices.date`/`dueDate` in
 *    `api/invoices.ts`). `reconcileStatus` starts `'pending'`.
 *  - `MyTribe/functions/src/admin/updateTrainingDocument.ts`: confirms an
 *    edit re-stamps `updatedAt`/`updatedBy` and re-queues
 *    `reconcileStatus: 'pending'`, but does NOT touch `uploadedAt`: it stays
 *    the original creation instant for the life of the doc.
 *  - `MyTribe/functions/src/admin/deleteTrainingDocument.ts`: hard-deletes
 *    the doc; explicitly does NOT unmerge any text a prior reconcile pass
 *    already folded into a Dossier/Kin411.
 *
 * `title`/`content`/`notes`/`communicationType`/`targetType`/`kinfolkRef`/
 * `targetKinfolkId`/`targetKinId`/`reconcileStatus`/`reconcileNotes` are all
 * free-text on the source doc (the backend's zod schema is
 * `z.string().default('')` throughout): never read directly for a status
 * decision in a screen; `communicationType` narrowing goes through
 * `lib/tribalIntelFormat.ts#distinctCommTypes`/`filterByCommType`, and
 * `reconcileStatus` through `lib/tribalIntelFormat.ts#reconcileState` (the
 * AO-12-style positive enumeration, never negation).
 *
 * `targetType`/`targetKinfolkId`/`targetKinId` are the spec-23 write-tool
 * targeting fields (`KINFOLK` | `KIN` + the resolved id(s)). This list-only
 * port does not render or edit them: they belong to the not-yet-built
 * create/edit form (`AddDocumentForm` in the wasm reference), but they are
 * modeled here for completeness against the real doc shape, matching the
 * `directory.ts` "type mirrors the doc, screen renders a subset" convention.
 *
 * EVERY DOCUMENT FIELD BELOW IS OPTIONAL. This interface is a CAST over raw
 * `doc.data()`, not a validation of it: `useCollection` never checks that a
 * field is present, so declaring `reconcileStatus: string` for a doc that has
 * no such key hands the screen an `undefined` that `.trim()` throws on, and
 * React's error boundary blanks the whole page over that one row. The
 * backend's zod schema defaults these to `''`, but only for docs written
 * THROUGH the callables: pre-spec-23 and seeded rows predate that guarantee.
 * `_id` stays required because `useCollection` always sets it itself.
 */
export interface TribalIntelEntry {
  _id: string;
  title?: string | undefined;
  content?: string | undefined;
  notes?: string | undefined;
  communicationType?: string | undefined;
  kinfolkRef?: string | undefined;
  targetType?: string | undefined;
  targetKinfolkId?: string | undefined;
  targetKinId?: string | undefined;
  attachments?: TribalIntelAttachment[] | undefined;
  reconcileStatus?: string | undefined;
  reconcileNotes?: string | undefined;
  /**
   * Free-text ISO instant, client-stamped at creation only: see
   * `lib/tribalIntelFormat.ts#tribalIntelWhen`. THE QUERY'S SORT KEY, because
   * it is the one time field EVERY writer of this collection sets (see
   * `TRIBAL_INTEL_QUERY` below for the writer-by-writer evidence), and it is
   * also the field the row itself displays, so the list order matches the
   * dates the operator can actually see.
   */
  uploadedAt?: string | undefined;
  /**
   * Real Firestore Timestamp (`FieldValue.serverTimestamp()`), stamped ONCE at
   * creation (an edit re-stamps updatedAt only, never this). Modeled because
   * `createTrainingDocument.ts` writes it, but NOT the sort key: it is absent
   * entirely on every doc written by any other writer. Kept optional-and-
   * nullable for the same reason as `invoices.createdAt`: a serverTimestamp()
   * reads back null on the local echo before the write round-trips.
   */
  createdAt?: Timestamp | null | undefined;
}

/**
 * The bounded, server-ordered `training_documents` listener. Ordered by
 * `uploadedAt` descending, capped at 200 (the KinTales/Invoices cap convention
 * for a similarly-scaled flat collection; the SORT FIELD deliberately follows
 * `GALLERY_QUERY`/`MEDIA_QUERY` instead, which order `media_files` by the same
 * client-ISO `uploadedAt` string for the same reason).
 *
 * SORT KEY CHANGED FROM `createdAt` TO `uploadedAt`, and that is a data-loss
 * fix, not a preference. Firestore `orderBy(f)` DROPS every doc missing `f`
 * outright, so the sort field silently defines which rows exist. Auditing every
 * writer of this collection, in both trees:
 *  - `MyTribe/functions/src/admin/createTrainingDocument.ts` (the spec-23
 *    server-bound create, and the ONLY production creator): stamps BOTH
 *    `uploadedAt: new Date().toISOString()` and
 *    `createdAt: FieldValue.serverTimestamp()`. Visible under either sort.
 *  - `AuntieOS/android/migration/scripts/import_to_firestore.py` (the historical
 *    NDJSON bulk import that created the pre-spec-23 rows): writes each record's
 *    `data` verbatim. The real exported payload
 *    (`android/migration/data/training_documents.ndjson`, corroborated by
 *    `migration/scripts/inventory_report.json`, which reports
 *    `training_documents` total 2) carries the keys `title`, `content`,
 *    `communicationType`, `kinfolkRef`, `notes`, `uploadedAt` and NO `createdAt`
 *    at all. Under the old sort those rows could never appear.
 *  - `AuntieOS/web/visual/seed-emulator.mjs:142,146` (the Playwright/visual
 *    harness seed): stamps `uploadedAt` only, no `createdAt`, so the old sort
 *    rendered this screen empty in the harness too.
 *  - `MyTribe/functions/src/admin/updateTrainingDocument.ts` and the nightly
 *    `AuntieOS/web/functions-python/reconcile_comms.py`: MERGE writes that touch
 *    `updatedAt`/`reconcileStatus` only. Neither adds nor removes either sort
 *    field, so neither can rescue a doc that lacks one.
 *  - Android's `AuntieRepository.createTrainingDocument`/`updateTrainingDocument`
 *    (:1760/:1789) both route through the callables above rather than writing
 *    the Kotlin model, so the model's missing `createdAt` (`Models.kt:398`
 *    declares `uploadedAt` and no `createdAt`) never strips the field off a doc.
 * So: every writer stamps `uploadedAt`; only the newest one stamps `createdAt`.
 * The old sort hid every pre-spec-23 row. Same shape as the invoices defect that
 * returned 0 of 18 live docs.
 *
 * This is the SAFEST option available without querying live Firestore, which
 * this port cannot do. The exact live count of pre-spec-23 rows is therefore
 * unknown (the migration inventory says 2 at import time, and nothing since can
 * have removed `createdAt` from a doc that had it). But the direction is not in
 * doubt: `uploadedAt` is a superset of `createdAt` across every writer, so this
 * sort drops strictly fewer rows and can drop none that the old one showed. No
 * backfill is written here and no live data is touched.
 *
 * KNOWN TRADEOFFS (accepted and documented, the `SESSIONS_QUERY` convention,
 * never silently swallowed):
 *  - Lexical string sort, not an instant comparison. Unlike `kin_care_sessions`
 *    this field has no mixed-offset problem: the callable always writes
 *    `toISOString()`, which is always UTC `...Z`. The emulator seed writes
 *    date-only text ("2026-05-10"), which sorts as that day's midnight (a
 *    shorter string sorts before any longer one sharing its prefix), so it
 *    never reorders across days. A detail view should still parse to instants
 *    before ordering.
 *  - `orderBy('uploadedAt')` DROPS a doc missing `uploadedAt` just as surely.
 *    No known writer omits it, and the migrated rows carry the key explicitly
 *    (Firestore treats a present-but-null field as present, sorting nulls
 *    lowest, so they land at the tail of this desc page rather than vanishing).
 *    Flagged for operator prod-verification; backfill rather than weaken the sort.
 *  - Ordering by upload instant rather than server-observed create instant. Both
 *    are stamped once and never re-stamped on edit, so ordering stays stable
 *    either way: an edited row keeps its place instead of jumping to the top.
 *
 * DELIBERATE IMPROVEMENT over the wasm reference, not a faithfully-ported
 * behavior: `FirestoreInterop.*.kt`'s `platformTrainingDocsStream()` is a
 * plain `collectionStream("training_documents")`: an unbounded whole-
 * collection listen with no orderBy/limit at all, the exact AO-29 pattern
 * `useCollection` exists to close off by construction. This spec is what
 * makes that fix apply here too.
 *
 * NO `filters`: a single-field orderBy needs no composite index (same note
 * as KINTALES_QUERY/INVOICES_QUERY). All search/comm.-type filtering in the
 * screen happens client-side over the already-streamed page, same as the
 * wasm's own `filter()`/dynamic chip narrowing in
 * `TrainingDocumentsViewModel.kt`/`TrainingDocumentsScreen.kt`.
 */
export const TRIBAL_INTEL_QUERY: CollectionSpec = {
  path: 'training_documents',
  order: ['uploadedAt', 'desc'],
  max: 200,
};
