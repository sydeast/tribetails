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
 */
export interface KinCareRow {
  _id: string;
  kinfolkId: string;
  name: string;
  /** True when the pet is flagged reactive. May be absent on a legacy doc. */
  reactive?: boolean;
  /** Free-text health/medication notes. May be absent/blank. */
  medicationHealthNotes?: string;
  /** Free-text feeding brand. May be absent/blank. */
  feedingBrand?: string;
}

/**
 * Bounded, server-ordered `kin` listener for the Care Flags join. Same path,
 * order and cap as `api/directory.ts#KIN_QUERY` (ordered by `updatedAt` desc,
 * the one real timestamp field on this collection; capped at 500), just typed
 * to the care fields this widget reads. No `where` filter, so no composite
 * index is needed; the "today only" narrowing happens client-side over the
 * sessions join, not on this stream.
 */
export const KIN_CARE_QUERY: CollectionSpec = {
  path: 'kin',
  order: ['updatedAt', 'desc'],
  max: 500,
};
