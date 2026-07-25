import { type CollectionSpec } from '../lib/firestore';
import { sessionsWindowBounds } from '../lib/sessionFormat';

/**
 * One `kin_care_sessions` row (the "Auntie Time" collection, the rail label
 * is "Auntie Time"; the slug/dest is `sessions`, see `lib/nav.ts`). Mirrors the
 * wasm `KinCareSession` data class
 * (composeApp/src/commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:1928),
 * the flat top-level collection both `KinCareSessionsScreen.kt` (the admin) and
 * MyTribe's `getMyVisits.ts` (the kinfolk portal's read-only visit-replay feed)
 * read.
 *
 * COLLECTION + FIELD SHAPES CONFIRMED, not assumed, against three independent
 * sources so this isn't a guess from the Kotlin model alone:
 *  - `firestore.rules:203`, `match /kin_care_sessions/{sessionId}`, `allow
 *    read: if isAuntie() || ...`, an admin gets an unfiltered collection read,
 *    same shape as INVOICES_QUERY/KINFOLK_QUERY.
 *  - `MyTribe/functions/src/admin/createKinCareSession.ts`, the ad-hoc
 *    "schedule a visit" callable's zod schema: `startTime`/`endTime` are
 *    `z.string()`, NOT Firestore Timestamps. This callable does NOT set
 *    `kinfolkName` on the doc it creates.
 *  - `MyTribe/functions/src/admin/approveBookingSeriesCore.ts`, the REAL
 *    production writer (booking-approval flow). Its `toIso()` helper stamps
 *    `startTime`/`endTime` via `FieldValue.serverTimestamp().toDate().toISOString()`
 *, a UTC-suffixed ("...Z") instant string, confirming these two fields are
 *    genuinely opaque ISO text, not Timestamps, on every doc. It DOES set
 *    `kinfolkName` (with an id fallback), which is why `sessionHousehold` in
 *    `lib/sessionFormat.ts` still needs its own "Unnamed Kinfolk" fallback for
 *    the ad-hoc path above.
 *
 * `status`/`startTime`/`endTime`/`completedAt` are all free-text strings on the
 * source doc (same "not a validated enum, not a parsed Date" caveat
 * `invoiceFormat.ts` documents for invoice `status`/`date`/`dueDate`), never
 * read directly in a screen; go through `lib/sessionFormat.ts`'s
 * `sessionState`/`sessionTimeOf` family, which is where the AO-18 (local day)
 * and AO-12-style (positive enumeration, no negation) fixes live.
 *
 * Only the fields this LIST screen renders are modeled here (the Directory.ts
 * "subset type, not a blind mirror" convention), `kinIds`/`gpsSummary`/
 * `formValues`/etc. belong to the not-yet-built detail/edit screen, not this
 * list.
 *
 * EVERY DOCUMENT FIELD IS OPTIONAL, and that is not pessimism, it is the shape
 * of the data. This interface is a CAST over whatever `useCollection` hands back
 * from Firestore, never a validation of it: nothing checks a doc against it at
 * runtime, so declaring `status: string` only promises a key the document may
 * simply not have. Verified live on 2026-07-20: `serviceType` is absent on 76 of
 * 99 `kin_care_sessions` docs. Under the old non-optional types tsc raised no
 * objection to `entry.status.trim()`, which then threw on those rows and let
 * React's error boundary blank the ENTIRE screen over one legacy doc. Optional
 * here forces every read site to state its fallback, so a missing field costs
 * that one field, not the page. `_id` stays required: `useCollection` always
 * sets it from the doc id, so it is the one field not read off the document.
 */
export interface SessionEntry {
  _id: string;
  kinfolkId?: string | undefined;
  kinfolkName?: string | undefined;
  /**
   * Pets/kin this visit covers (`KinCareSession.kinIds`, `FirestoreClient.kt:1932`).
   * The list itself never reads it; it exists here for the not-yet-built compose
   * screen (`KinTaleCompose.tsx`), which needs it to scaffold a new KinTale draft's
   * own `kinIds`, mirroring the wasm's `scaffoldReport(session, template)`.
   */
  kinIds?: string[] | undefined;
  serviceType?: string | undefined;
  /** Free-text ISO instant string, not a Timestamp, see `lib/sessionFormat.ts#sessionTimeOf`. */
  startTime?: string | undefined;
  /**
   * Free-text ISO instant, same caveat as `startTime`. Needed by the not-yet-built
   * compose screen (`KinTaleCompose.tsx`) to seed a new KinTale draft's `arrivedAt`,
   * mirroring the wasm's `scaffoldReport`. Blank until the visit is ARRIVED.
   */
  arrivedAt?: string | undefined;
  /** Same caveat as `startTime`. */
  endTime?: string | undefined;
  /** Free-text; SCHEDULED/ON_MY_WAY/ARRIVED/DEPARTED/COMPLETED/CANCELLED are the only codes any writer sets, see `lib/sessionFormat.ts#sessionState`. */
  status?: string | undefined;
  /** '' until COMPLETED; stamped by the admin's `patchKinCare` write. Same free-text caveat as `startTime`. */
  completedAt?: string | undefined;
  notes?: string | undefined;
}

/**
 * The bounded, server-ordered `kin_care_sessions` listener. Ordered by
 * `startTime` descending, capped at 300.
 *
 * DELIBERATE IMPROVEMENT over the wasm reference, not a faithfully-ported
 * behavior: the wasm's `client.sessionsStream()` (via `platformSessionsStream()`)
 * is a plain unbounded whole-collection listen, the exact AO-29 pattern
 * `useCollection` exists to close off by construction. This spec is what makes
 * that fix apply here too.
 *
 * Sorted by `startTime` rather than a real Firestore Timestamp field (unlike
 * `INVOICES_QUERY`'s `createdAt`): `kin_care_sessions` genuinely has no
 * Timestamp-typed sort key on every doc the way `invoices.createdAt` does, but
 * `startTime` IS the one MyTribe's own `getMyVisits.ts` already orders the same
 * collection by (`.orderBy('startTime', 'desc')`), which confirms the real
 * writers populate it and Firestore can sort it as a plain string field.
 *
 * KNOWN TRADEOFFS (accepted, documented rather than silently swallowed):
 *  - Lexical string sort is only chronological when the offsets match. This
 *    collection has BOTH `...Z` UTC writes (approveBookingSeriesCore) and local
 *    no-offset writes (bookingFormat.ts:99); a mixed batch can drift by up to the
 *    zone offset right at the 300-row boundary. Acceptable for a bounded admin
 *    list; a detail/report view should parse to instants before ordering.
 *  - `orderBy('startTime')` DROPS any doc missing `startTime` (direct client-SDK
 *    writes are allowed by rules), it never reaches the 'Undated' group. Flagged
 *    for operator prod-verification; backfill rather than weaken the sort.
 *  - `desc` keeps the most-FUTURE 300: a large approved recurring series could
 *    push today off the page and undercount the Today/Wrapped stats. If that
 *    surfaces, add an upper-bound horizon filter or raise the cap.
 *
 * The STREAM's own `desc` order is only what bounds the 300-row page, it is
 * NOT the order the screen displays. `lib/sessionFormat.ts#groupSessionsByDay`
 * re-derives the screen's actual chronological, day-grouped display order from
 * whatever page comes back, the same way `Invoices.tsx` re-derives its own
 * filter-tab views from `INVOICES_QUERY`'s bounded page rather than trusting
 * the raw stream order to already be what the screen wants to show.
 *
 * NO `filters`, a single-field orderBy needs no composite index (same note as
 * `INVOICES_QUERY`/`NOTIFICATIONS_QUERY`). Any "today only" / "active only"
 * narrowing happens client-side over the already-streamed page (the filter tabs
 * in `Sessions.tsx`), same as the wasm's own client-side `visible`/`grouped`
 * filtering, just bounded now instead of run over an unbounded stream.
 */
export const SESSIONS_QUERY: CollectionSpec = {
  path: 'kin_care_sessions',
  order: ['startTime', 'desc'],
  max: 300,
};

/**
 * THE AUNTIE TIME LIST'S OWN QUERY (operator issue #17).
 *
 * `SESSIONS_QUERY` above stays exactly as it is: `KinTaleCompose`,
 * `SafeboxWidget` and `CareFlagsWidget` all read this collection for their own
 * reasons and want the latest rows, not a day-of window. Only the LIST screen
 * needs its data to match its sub-header, so only the list screen gets a date
 * range.
 *
 * Bounded on both axes: a server-side `startTime` range plus the same 300 cap.
 * The range and the `orderBy` are the SAME field, so this needs no composite
 * index of its own; and the order stays `desc` because a test admin's spec picks
 * up a `kinfolkId ==` predicate from `lib/testScope`, and the index deployed for
 * that pair (`mytribe/firestore.indexes.json`) is `(kinfolkId ASC, startTime
 * DESC)`. Flipping to asc here would need an index that is not deployed, for no
 * gain: `groupSessionsByPhase` re-derives the display order from whatever page
 * comes back, exactly as `groupSessionsByDay` always did.
 *
 * The bounds come from `sessionsWindowBounds`, which is deliberately WIDER than
 * the displayed window; that function's doc explains both margins. Comparing a
 * `YYYY-MM-DD` bound against a full ISO instant string works because every
 * writer stamps an ISO-8601 value, so the date is a plain lexical prefix, and
 * the day-boundary slop that leaves is exactly what the wider fetch absorbs.
 *
 * The `orderBy('startTime')` caveat from `SESSIONS_QUERY` still applies: a doc
 * missing `startTime` is dropped by the sort and never reaches the 'Undated'
 * group. Backfill rather than weaken the sort.
 */
export function sessionsWindowQuery(todayIso: string): CollectionSpec {
  const { from, to } = sessionsWindowBounds(todayIso);
  return sessionsArchiveQuery(from, to);
}

/**
 * Older history, behind the Archive affordance: the same bounded shape over an
 * operator-chosen `YYYY-MM-DD` range.
 *
 * SEAM FOR TASK 4.1. This is a fixed range-and-cap, not pagination: 300 rows is
 * the whole page, and a range holding more is silently truncated at the far end
 * of the sort. Task 4.1 introduces the shared cursor-based pagination hook;
 * when it lands, this becomes its first caller and the cap becomes a page size.
 * Until then the Archive UI keeps the range narrow enough that the cap is not
 * reached in practice, and says what range it is showing.
 */
export function sessionsArchiveQuery(fromDay: string, toDay: string): CollectionSpec {
  return {
    path: 'kin_care_sessions',
    order: ['startTime', 'desc'],
    max: 300,
    filters: [
      ['startTime', '>=', fromDay],
      ['startTime', '<=', toDay],
    ],
  };
}
