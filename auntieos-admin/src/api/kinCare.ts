import { type CollectionSpec } from '../lib/firestore';

/**
 * AO-37 Care Flags' own typed read of the flat `kin` mirror collection.
 *
 * The Directory's `api/directory.ts#Kin` models only the LIST fields (name,
 * species, status, ...). The Care Flags widget needs the three CARE fields the
 * pet doc also carries (see `api/kinView.ts#KinDetail`, which reads the same
 * fields one-shot for the detail view): `reactive`, `medicationHealthNotes` and
 * `feedingBrand`. Rather than widen the Directory's list type, this is the
 * widget's own subset read of the same collection (the "subset type, not a
 * blind mirror" convention), streamed bounded via `useCollection`.
 *
 * `useCollection` casts each doc's raw data straight through (it does not run a
 * defensive merge), so every consumer here must treat a legacy/partial doc's
 * missing fields as absent: `lib/dashboardInsights.ts#careFlags` reads
 * `reactive` as `=== true` and the two note fields with a blank fallback,
 * never trusting them to be present.
 *
 * Which is why EVERY document field below is optional. This interface is a CAST
 * over raw Firestore data, not a validation of it (contrast `api/kinView.ts`,
 * which runs `mergeKinDetail` and so can honestly promise non-optional fields).
 * Declaring `name: string` for a `kin` doc that has no `name` is a lie tsc will
 * happily typecheck, and the first `.trim()` on it throws inside render, which
 * React's error boundary turns into a BLANK PAGE over one legacy row. Marking
 * them optional forces each read to default at the point of use (`lib/coerce.ts`).
 * `_id` stays required: `useCollection` always sets it from the doc id.
 */
export interface KinCareRow {
  _id: string;
  /** Owning household doc id. May be absent on a legacy/partial mirror doc. */
  kinfolkId?: string | undefined;
  /** The pet's name. May be absent; consumers fall back to a blank name. */
  name?: string | undefined;
  /** True when the pet is flagged reactive. May be absent on a legacy doc. */
  reactive?: boolean | undefined;
  /** Free-text health/medication notes. May be absent/blank. */
  medicationHealthNotes?: string | undefined;
  /** Free-text feeding brand. May be absent/blank. */
  feedingBrand?: string | undefined;
}

/**
 * Bounded, server-ordered `kin` listener for the Care Flags join. Same path,
 * order and cap as `api/directory.ts#KIN_QUERY` (ordered by DOCUMENT ID
 * ascending, capped at 500), just typed to the care fields this widget reads.
 * No `where` filter, so no composite index is needed; the "today only"
 * narrowing happens client-side over the sessions join, not on this stream.
 *
 * The order MUST stay identical to KIN_QUERY's, and the full reasoning lives on
 * that constant: Firestore `orderBy` silently drops every doc missing the sort
 * field, no field is written by every `kin` writer, and a document id is the
 * only key guaranteed on every document. This stream previously ordered by
 * `updatedAt` desc, which the 2026-07-20 model audit measured on 23 of 24 live
 * `kin` docs.
 *
 * That one dropped row matters MORE here than in the Directory list.
 * `careFlags` (lib/dashboardInsights.ts) joins today's visits against this
 * roster and skips any kin it cannot resolve (`if (!info) continue`), so a Kin
 * missing the old sort field produced NO reactive, medication or feeding flag
 * for a pet on today's schedule. The widget renders that as "No special care
 * notes for today's roster", a confident all-clear over data the query never
 * returned. Ordering by document id is what makes the roster complete, so a
 * missing flag can only ever mean a genuinely unflagged pet.
 *
 * Order is irrelevant to this widget's output either way: the page is folded
 * into a `Map` keyed by `_id` before `careFlags` ever reads it.
 */
export const KIN_CARE_QUERY: CollectionSpec = {
  path: 'kin',
  order: ['__name__', 'asc'],
  max: 500,
};
