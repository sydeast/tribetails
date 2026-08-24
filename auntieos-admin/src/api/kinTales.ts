import { type CollectionSpec } from '../lib/firestore';
import type { PagedCollectionSpec } from '../lib/usePagedCollection';

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
 *
 * EVERY FIELD BELOW IS OPTIONAL, and that is the honest shape, not defensive
 * padding. This interface is a CAST over raw Firestore document data, not a
 * validation of it: nothing between the document and this type checks that a
 * key exists. Declaring `title: string` for the 89 of 92 live
 * `kin_care_reports` that carry no `title` at all is a lie TypeScript then
 * lets a screen act on, and `.trim()` on the undefined it actually gets throws
 * through React's error boundary and BLANKS THE PAGE over one legacy row.
 * Read these through `?? ''` / `?? []` or `lib/coerce.ts`'s `str`/`arr`.
 * `_id` stays required, `useCollection` always sets it.
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
  sessionId?: string | undefined;
  kinfolkId?: string | undefined;
  kinfolkName?: string | undefined;
  authorDisplayName?: string | undefined;
  /** Pets this recap covers. Only its length is shown at the list level, resolving these to real kin names/species would need a `kin` collection join, which belongs to the not-yet-built detail screen (same "no fabricated names" boundary `sessionHousehold`/`kinfolkDisplayName` already draw). */
  kinIds?: string[] | undefined;
  serviceType?: string | undefined;
  /** Free-text ISO instant string, not a Timestamp, see `lib/kinTaleFormat.ts#kinTaleWhen`. */
  visitDate?: string | undefined;
  /** Same caveat as `visitDate`. */
  arrivedAt?: string | undefined;
  title?: string | undefined;
  /** Provenance of `title`: written by Auntie's generator rather than typed. */
  titleGeneratedByAi?: boolean | undefined;
  bodyCopy?: string | undefined;
  mediaFileIds?: string[] | undefined;
  /** Free-text; defaults `'DRAFT'` on the source doc, see `lib/kinTaleFormat.ts#kinTaleState`. */
  status?: string | undefined;
  /** Same caveat as `visitDate`; blank until sent. */
  sentAt?: string | undefined;
  /** Free-text send channel, or a `legacy_*` backfill marker, see `lib/kinTaleFormat.ts#sentViaLabel`. */
  sentVia?: string | undefined;
  /**
   * WHEN THIS RECAP CAME INTO EXISTENCE. Same free-text ISO caveat as
   * `visitDate`, and stamped on every real write (create AND update).
   *
   * For a report imported from the previous system this is the previous
   * system's own creation instant, NOT the day it was imported (operator's
   * ruling, 2026-08-04). Read `createdAtSource` before treating it as a fact
   * about the record; on some imported rows it is the import date, because
   * nothing recoverable said otherwise.
   */
  createdAt?: string | undefined;
  /**
   * Which instant `createdAt` above actually is: `'live'` (this system stamped
   * it), `'original'` (recovered from the previous system), or `'import'` (the
   * original was unrecoverable, so `createdAt` is the day the row was
   * imported and is NOT a creation date).
   *
   * ABSENT ON EVERY ROW THIS SYSTEM CREATED, and that is the honest shape
   * rather than a gap: only the migration writes it. Read it through
   * `lib/createdAtProvenance.ts#readCreatedAtSource`, which resolves absence to
   * `'live'` and says why that is sound.
   */
  createdAtSource?: string | undefined;
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
 *
 * STILL `createdAt` AFTER THE 2026-08-04 PROVENANCE RULING, and that is a
 * decision rather than an oversight. The ruling moved imported rows' `createdAt`
 * onto their ORIGINAL creation instant; it did not add a second date field for
 * this query to choose between. It could not have: Firestore has no COALESCE,
 * no `orderBy` spans two fields, and this query is server-ordered, capped, and
 * paged with a `startAfter` cursor. Splitting the truth across
 * `createdAt` + `originalCreatedAt` would leave only a denormalized third sort
 * field (which is `createdAt` under another name, plus something new that can
 * drift) or an unbounded read sorted in memory (the AO-29 pattern the cap above
 * exists to make unavailable). One field carries the truth, `_migratedAt` keeps
 * the ingest instant, and `createdAtSource` says which is which.
 */
export const KINTALES_QUERY: CollectionSpec = {
  path: 'kin_care_reports',
  order: ['createdAt', 'desc'],
  max: 200,
};
/** The cap on the household profile's KinTales read; `feedCountMeta` needs it by name. */
export const KINTALES_PROFILE_MAX = 200;
/**
 * Every KinTale for ONE household, newest first, for the household profile's
 * "Recent KinTales" card.
 *
 * A separate spec rather than `KINTALES_QUERY` filtered in memory: the profile
 * must not stream 200 rows of every household's recaps to show three of one
 * household's. Covered by the deployed `kin_care_reports (kinfolkId ASC,
 * createdAt DESC)` index, the same pair `kinTalesPageQuery` relies on.
 *
 * The `orderBy('createdAt')` caveat this whole collection carries still applies:
 * a doc missing `createdAt` is dropped by the sort. Every real write path stamps
 * it, so that is a legacy-row risk, not a routine one.
 */
export function kinTalesForKinfolkQuery(kinfolkId: string): CollectionSpec {
  return {
    path: 'kin_care_reports',
    order: ['createdAt', 'desc'],
    max: KINTALES_PROFILE_MAX,
    filters: [['kinfolkId', '==', kinfolkId]],
  };
}

/**
 * Rows per "Load more" on the KinTales LIST screen (Phase 4).
 *
 * Not a cap on the collection the way `KINTALES_QUERY.max` is: the list grows by
 * this much each time the operator asks for more. 25 because a KinTale row is
 * four lines tall, so a page is roughly two screens of scroll, which is the
 * point at which "there is more below" stops being obvious on its own.
 */
export const KINTALES_PAGE_SIZE = 25;

export interface KinTalesPageOptions {
  /**
   * Lower bound on `createdAt`, from `ListToolbar`'s `rangeStartIso`, or null
   * for "All (archive)". Null adds NO predicate rather than one that matches
   * everything: see `rangeStartIso`'s own doc for why the two differ.
   */
  startIso: string | null;
  /** The kinfolk facet. Blank/undefined means every household. */
  kinfolkId?: string | undefined;
}

/**
 * The LIST screen's own paged query. `KINTALES_QUERY` above stays exactly as it
 * is: `KinTaleCompose` and `KinTaleDetail` both read this collection wanting the
 * latest rows rather than a date window, and neither pages.
 *
 * WHY `createdAt` CARRIES BOTH THE ORDER AND THE WINDOW. It is an ISO STRING on
 * every doc (see `KinTaleEntry.createdAt`), so it compares correctly against the
 * ISO string `rangeStartIso` produces. That is not a small detail: a Firestore
 * Timestamp field compared against a string matches NOTHING at all, because
 * Firestore orders every timestamp before every string, and the failure is a
 * silent empty list rather than an error. `invoices.createdAt` IS a Timestamp,
 * which is exactly why `invoicesPageQuery` windows on a different field.
 *
 * INDEXES. Range and order on the same field needs no composite index. With the
 * kinfolk facet, or with a sandbox admin's automatic `kinfolkId ==` scope, the
 * pair is covered by the deployed `kin_care_reports (kinfolkId ASC, createdAt
 * DESC)` index.
 *
 * The `orderBy('createdAt')` caveat every query on this collection carries still
 * applies: a doc missing `createdAt` is dropped by the sort. Every real write
 * path stamps it (create AND update), so that is a legacy-row risk, not a
 * routine one.
 */
export function kinTalesPageQuery({ startIso, kinfolkId }: KinTalesPageOptions): PagedCollectionSpec {
  const filters: CollectionSpec['filters'] = [];
  if (kinfolkId !== undefined && kinfolkId !== '') filters.push(['kinfolkId', '==', kinfolkId]);
  if (startIso !== null) filters.push(['createdAt', '>=', startIso]);

  return {
    path: 'kin_care_reports',
    order: ['createdAt', 'desc'],
    pageSize: KINTALES_PAGE_SIZE,
    ...(filters.length > 0 ? { filters } : {}),
  };
}

/**
 * Does this row match the operator's search text?
 *
 * CLIENT-SIDE, over the rows already loaded, and the screen SAYS so. Firestore
 * has no substring search, so the honest choices were this or a search callable,
 * and the archive's own KinTale search was client-side over an unbounded stream.
 * What changes here is only that the scope is now stated on screen instead of
 * being implied by a cap nobody could see.
 *
 * Household and title, per Phase 4's spec, and each field is tested on its own
 * rather than against one joined haystack: joining lets "whitfields a great"
 * match a row where those words are in different fields, which is a result the
 * operator cannot explain from what is on screen.
 */
export function kinTaleMatchesSearch(
  entry: Pick<KinTaleEntry, 'kinfolkName' | 'title'>,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return [entry.kinfolkName ?? '', entry.title ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
