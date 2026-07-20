import { type CollectionSpec } from '../lib/firestore';

/**
 * One `kin_care_reports` row, a KinTale, the recap that goes home to a
 * Kinfolk after a visit. Mirrors the wasm `KinCareReport` data class
 * (composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:1998),
 * the flat top-level collection `KinTaleLogsScreen.kt` (the admin list this
 * screen ports), `KinTaleReportScreen.kt` (the not-yet-built single-report
 * detail), and MyTribe's `getMyKinTales.ts` (the kinfolk portal's read-only
 * feed) all read.
 *
 * COLLECTION + FIELD SHAPES CONFIRMED, not assumed from the Kotlin model
 * alone, against:
 *  - `firestore.rules:181`, `match /kin_care_reports/{reportId}`, `allow
 *    read: if isAuntie() || ...`, an admin gets an unfiltered collection
 *    read, same shape as SESSIONS_QUERY/INVOICES_QUERY.
 *  - `FirestoreInterop.wasmJs.kt#platformCreateKinTaleReport`, the real
 *    creation path (AuntieOS writes `kin_care_reports` directly via the
 *    client SDK; `getMyKinTales.ts`'s own doc comment says so: "AuntieOS
 *    writes directly. READ-ONLY [portal]."). It stamps `createdAt`/`updatedAt`
 *    via a client-computed `nowIsoUtc()` STRING, never
 *    `FieldValue.serverTimestamp()`, so, same caveat as
 *    `kin_care_sessions.startTime` in `api/sessions.ts`, this is opaque ISO
 *    text, not a Firestore Timestamp, on every doc.
 *  - `MyTribe/functions/src/portal/getMyKinTales.ts`, confirms the
 *    collection name and that `sentAt` is the same free-text ISO shape
 *    (`new Date(sentAtRaw).getTime()` after a string-type guard).
 *
 * `status`/`visitDate`/`arrivedAt`/`sentAt`/`createdAt` are all free-text
 * strings on the source doc (same "not a validated enum, not a parsed Date"
 * caveat `sessionFormat.ts`/`invoiceFormat.ts` document for their own
 * collections), never read directly in a screen; go through
 * `lib/kinTaleFormat.ts`'s `kinTaleState`/`kinTaleWhen` family, which is where
 * the AO-18 (local time) and AO-12-style (positive enumeration, no negation)
 * fixes live.
 *
 * Only the fields this LIST screen renders are modeled here (the
 * `directory.ts` "subset type, not a blind mirror" convention), 
 * `fieldResponses`/`petMoodSelections`/`formValues`/`gpsRoute`/`gpsSummary`/
 * the orphan-triage fields (`triageStatus`/`triagedAt`/`triagedBy`/
 * `duplicateOfReportId`/`archiveReason`) belong to the not-yet-built
 * detail/triage screens, not this list.
 */
export interface KinTaleEntry {
  _id: string;
  /**
   * FK to the `kin_care_sessions` doc this recap belongs to (`KinCareReport.sessionId`,
   * `FirestoreClient.kt:2001`). The list itself never reads it; it exists here for the
   * not-yet-built compose/edit surface (`KinTaleCompose.tsx`), which needs it to route the
   * send transition's atomic session-side batch update (`markKinTaleReportSent` touches
   * BOTH `kin_care_reports/{id}` and `kin_care_sessions/{sessionId}`, see
   * `api/kinTalesWrite.ts`).
   */
  sessionId: string;
  kinfolkId: string;
  kinfolkName: string;
  authorDisplayName: string;
  /** Pets this recap covers. Only its length is shown at the list level, resolving these to real kin names/species would need a `kin` collection join, which belongs to the not-yet-built detail screen (same "no fabricated names" boundary `sessionHousehold`/`kinfolkDisplayName` already draw). */
  kinIds: string[];
  serviceType: string;
  /** Free-text ISO instant string, not a Timestamp, see `lib/kinTaleFormat.ts#kinTaleWhen`. */
  visitDate: string;
  /** Same caveat as `visitDate`. */
  arrivedAt: string;
  title: string;
  bodyCopy: string;
  mediaFileIds: string[];
  /** Free-text; defaults `'DRAFT'` on the source doc, see `lib/kinTaleFormat.ts#kinTaleState`. */
  status: string;
  /** Same caveat as `visitDate`; blank until sent. */
  sentAt: string;
  /** Free-text send channel, or a `legacy_*` backfill marker, see `lib/kinTaleFormat.ts#sentViaLabel`. */
  sentVia: string;
  /** Same caveat as `visitDate`; stamped on every real write (create AND update). */
  createdAt: string;
}

/**
 * The bounded, server-ordered `kin_care_reports` listener. Ordered by
 * `createdAt` descending, capped at 200 (the Invoices convention: this is a
 * similarly-scaled flat collection, and `createdAt` is stamped on every real
 * write path the way `invoices.createdAt`'s `FieldValue.serverTimestamp()`
 * is, unlike `kin_care_sessions.startTime`, which needed the sort key to be
 * whatever a real writer always sets rather than the freshest field).
 *
 * DELIBERATE IMPROVEMENT over the wasm reference, not a faithfully-ported
 * behavior: `FirestoreInterop.*.kt`'s `platformReportsStream()` is a plain
 * `collectionStream("kin_care_reports")`, an unbounded whole-collection
 * listen with no orderBy/limit at all, the exact AO-29 pattern `useCollection`
 * exists to close off by construction. This spec is what makes that fix apply
 * here too.
 *
 * `createdAt` (not `sentAt`) is the sort key on purpose, even though
 * `getMyKinTales.ts` (the kinfolk portal) orders by `sentAt`, that callable
 * filters to `sentAt > ''` first, so every row it sorts already has one. This
 * admin list must also show DRAFT and FAILED rows, whose `sentAt` is blank;
 * sorting by it would scatter every unsent report to one end regardless of
 * how recently it was created. `createdAt` is stamped on every real write
 * (create AND update, see `KinTaleEntry.createdAt`), so it orders every
 * status honestly.
 *
 * NO `filters`, a single-field orderBy needs no composite index (same note
 * as SESSIONS_QUERY/INVOICES_QUERY). Any "Drafts only" / "Sent only" /
 * "Failed only" narrowing happens client-side over the already-streamed page
 * (the filter tabs in `KinTales.tsx`), same as the wasm's own client-side
 * `bucketFor` grouping, just bounded now instead of run over an unbounded
 * stream.
 */
export const KINTALES_QUERY: CollectionSpec = {
  path: 'kin_care_reports',
  order: ['createdAt', 'desc'],
  max: 200,
};
