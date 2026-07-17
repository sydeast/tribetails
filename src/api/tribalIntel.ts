import { type CollectionSpec } from '../lib/firestore';
import type { Timestamp } from 'firebase/firestore';

/**
 * One Cloudinary attachment on a `training_documents` doc. Mirrors the wasm
 * `TrainingDocAttachment` data class (`FirestoreClient.kt:2642`) and the
 * backend's `AttachmentSchema` (`createTrainingDocument.ts`) field-for-field.
 */
export interface TribalIntelAttachment {
  storageUrl: string;
  cloudinaryPublicId: string;
  fileType: string;
  mimeType: string;
  fileName: string;
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
 *    admin callables below (out of scope for this list-only port).
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
 */
export interface TribalIntelEntry {
  _id: string;
  title: string;
  content: string;
  notes: string;
  communicationType: string;
  kinfolkRef: string;
  targetType: string;
  targetKinfolkId: string;
  targetKinId: string;
  attachments: TribalIntelAttachment[];
  reconcileStatus: string;
  reconcileNotes: string;
  /** Free-text ISO instant, client-stamped at creation only: see `lib/tribalIntelFormat.ts#tribalIntelWhen`. */
  uploadedAt: string;
  /** Real Firestore Timestamp (`FieldValue.serverTimestamp()`), stamped ONCE at creation (an edit re-stamps updatedAt only, never this): the query's sort key, so ordering is stable creation order. */
  createdAt: Timestamp | null;
}

/**
 * The bounded, server-ordered `training_documents` listener. Ordered by
 * `createdAt` descending, capped at 200 (the KinTales/Invoices convention:
 * this is a similarly-scaled flat collection, and `createdAt` is a real
 * `FieldValue.serverTimestamp()` stamped ONCE at create (an edit re-stamps
 * updatedAt only, never createdAt), so ordering by it is stable creation order:
 * an edited row keeps its place rather than jumping to the top.
 *
 * KNOWN TRADEOFF: Firestore `orderBy('createdAt')` DROPS any doc missing the
 * field, so a pre-createdAt legacy doc would silently vanish from this list.
 * Flagged for operator prod-verification; backfill rather than weaken the sort.
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
  order: ['createdAt', 'desc'],
  max: 200,
};
