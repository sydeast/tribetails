import { type CollectionSpec } from '../lib/firestore';

/**
 * The `generated_drafts` collection, read by Home's "KinTales pending" panel,
 * by the stat row's "KinTales to review" count, and (since the 2026-08-04
 * ruling below) by the KinTales list screen's Drafts bucket.
 *
 * ── WHAT THESE DOCS ARE, PER THE OPERATOR, 2026-08-04 ───────────────────────
 * Verbatim: "generated drafts are just drafts of the kintales, when i generate
 * a copy from the text generator, the copy it makes is what generated-drafts
 * was". So a `generated_drafts` doc is not a separate entity from a KinTale.
 * It is a KinTale that has not been sent yet.
 *
 * That overturns the previous note here, which said the two "are not the same
 * thing" and treated the distinction as load-bearing. It was load-bearing in
 * ONE direction only, and that half stands: Home's panel is a sign-off queue,
 * so pointing it at `kin_care_reports` would put finished, sent recaps in a
 * "waiting for your sign-off" card, which is a false claim about every row. The
 * other direction was the bug. The KinTales LIST screen has a Drafts bucket of
 * its own and read only `kin_care_reports`, so it reported "Drafts 0" while
 * Home, on the same session, listed drafts. One entity, two collections, one
 * screen showing half of it. See `lib/kinTaleList.ts` for the join.
 *
 * The write side already lives here: `api/communicateGenerate.ts` creates these
 * docs through the generator callable and `api/communicateApprove.ts` flips one
 * to approved with a direct `updateDoc` on `generated_drafts/{id}`. This is the
 * matching bounded read.
 */

/**
 * One `generated_drafts` doc.
 *
 * SNAKE_CASE ON `kinfolk_id`, and that is the document's real field name, not a
 * transcription slip: these docs are written by `web/functions/generate.js`,
 * which predates the camelCase convention the rest of the admin collections
 * follow. `mytribe/firestore.rules`' sandbox branch keys off that exact
 * spelling, so the test-admin scope in `lib/testScope.ts` has to as well.
 *
 * EVERY DOCUMENT FIELD IS OPTIONAL, the same cast-not-validation rule
 * `api/sessions.ts` documents at length: this interface is a cast over whatever
 * `useCollection` hands back, so a legacy row missing `status` must cost that
 * one field and not the page. Read them through `lib/coerce.ts`. `_id` stays
 * required, `useCollection` always sets it from the doc id.
 */
export interface GeneratedDraftRow {
  _id: string;
  /** Owning household, snake_case on this collection only. See above. */
  kinfolk_id?: string | undefined;
  kinfolkName?: string | undefined;
  /** e.g. `visit_report`. Rendered as the row's title with `_` spaced out. */
  communicationType?: string | undefined;
  /** The generated copy. A draft with none is a shell and is dropped. */
  generatedCopy?: string | undefined;
  /** Free-text; `pending` is the value the review count matches on. */
  status?: string | undefined;
  /** Free-text ISO instant, the sort key. Same opaque-string caveat as sessions. */
  createdOn?: string | undefined;

  // ── THE SECOND WRITER'S SPELLINGS ────────────────────────────────────────
  // Not aliases anybody chose: this ONE collection has two writers that never
  // converged. The camelCase fields above are what the n8n-era and migrated
  // docs carry (and what android's `Draft` data class binds, Models.kt:939).
  // `web/functions/generate.js:482` writes the same collection in snake_case
  // with `status: 'generated'`, and android's own model comment says so at
  // length ("those docs read blank here", Models.kt:929-938, with a standing
  // TODO to converge in generate.js). Reading only one spelling is how a real
  // draft renders as a blank row, so every helper in `lib/kinTaleList.ts`
  // reads BOTH and takes the first non-blank. Declared optional for the same
  // cast-not-validation reason as everything above.
  /** camelCase household FK, on migrated docs. `kinfolk_id` is generate.js's spelling. */
  kinfolkId?: string | undefined;
  /** snake_case household name, generate.js. */
  kinfolk_name?: string | undefined;
  /** snake_case type, generate.js. */
  communication_type?: string | undefined;
  /** snake_case body, generate.js. */
  generated_copy?: string | undefined;
  /** The generator's own title, when `want_title` was set. Both spellings exist. */
  generatedTitle?: string | undefined;
  generated_title?: string | undefined;
  /**
   * generate.js's creation stamp. NOT `createdOn`, which is why a
   * generate.js-written draft is dropped by `GENERATED_DRAFTS_QUERY`'s
   * `orderBy('createdOn')` before any of this code sees it. Read here so that a
   * doc carrying both (or one backfilled later) still dates correctly.
   */
  generated_at?: string | undefined;
}

/**
 * The bounded, server-ordered `generated_drafts` listener: newest first, capped
 * at 50.
 *
 * `createdOn` is the sort key because it is what `generate.js` stamps on every
 * draft it writes and what android orders the same collection by. The standing
 * `orderBy` caveat applies here as everywhere: Firestore drops a doc missing
 * the sort field, so a draft written without `createdOn` never reaches this
 * page. Backfill rather than weaken the sort.
 *
 * 50 rather than the 200 `KINTALES_QUERY` carries: the panel shows four rows
 * and the count beside it is a review queue, not an archive. A queue that has
 * genuinely grown past 50 pending drafts is a different problem from a
 * dashboard card.
 *
 * THE KINTALES LIST SCREEN SHARES THIS EXACT OBJECT rather than declaring a
 * windowed spec of its own, and that is deliberate for the reason
 * `screens/widgets/homeData.ts` spells out: `useCollection` keys its
 * subscription on the spec's JSON and the Firestore SDK keys its Watch target
 * on the query, so N readers of one identical spec cost ONE target. It also
 * means the drafts KinTales counts and the drafts Home counts can never come
 * from two different reads of the same collection. The consequences the list
 * screen has to state on screen instead of hiding: the cap is 50, and the
 * window is applied client-side (see `lib/kinTaleList.ts#draftsInWindow`).
 */
export const GENERATED_DRAFTS_MAX = 50;

export const GENERATED_DRAFTS_QUERY: CollectionSpec = {
  path: 'generated_drafts',
  order: ['createdOn', 'desc'],
  max: GENERATED_DRAFTS_MAX,
};
