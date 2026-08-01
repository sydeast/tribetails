import { type CollectionSpec } from '../lib/firestore';

/**
 * The `generated_drafts` collection, read by Home's "KinTales pending" panel
 * and by the stat row's "KinTales to review" count.
 *
 * THIS IS NOT `kin_care_reports`, and the difference is not cosmetic. A
 * KinTale REPORT (`api/kinTales.ts`) is a finished recap attached to a visit;
 * a generated DRAFT is copy Auntie's generator wrote and nobody has approved
 * yet. Home is the sign-off queue, so it reads the drafts, exactly as android's
 * `HomeViewModel` does (`AuntieRepository.getRecentDrafts` /
 * `getPendingDraftCount`, both over `generated_drafts`). Pointing this panel at
 * `kin_care_reports` would put sent reports in a "waiting for your sign-off"
 * card, which is the wrong claim about every row in it.
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
 */
export const GENERATED_DRAFTS_QUERY: CollectionSpec = {
  path: 'generated_drafts',
  order: ['createdOn', 'desc'],
  max: 50,
};
