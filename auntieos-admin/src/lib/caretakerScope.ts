import { type CollectionSpec, type Filter } from './firestore';

/**
 * What an Auntie's collection queries must carry, applied in one place.
 *
 * Firestore rules let an Auntie read KinTale drafts only: the
 * `generated_drafts` docs whose type is exactly `visit_report`. Every other
 * draft there (email, text, push and the rest) is the owner's Communicate work.
 * Rules do not filter a list, they allow or refuse it whole, so her query has
 * to say which drafts it wants or the whole read is refused. This module adds
 * that predicate.
 *
 * It is applied centrally in `useCollection` and `usePagedCollection`, beside
 * the sandbox scope in `lib/testScope.ts` and for the same reason: Home's
 * "KinTales pending" panel and the KinTales list share one drafts spec
 * (`api/drafts.ts`), and a screen added later cannot forget the predicate.
 *
 * The field is `communication_type`, the spelling the generator writes and the
 * one the rule reads for a list. A migrated draft that carries only the older
 * `communicationType` spelling is not in her list; the owner still sees it.
 *
 * The query sorts on `createdOn`, so the predicate needs the composite index
 * `generated_drafts (communication_type ASC, createdOn DESC)` in
 * `mytribe/firestore.indexes.json`.
 */

/** Collections an Auntie reads only part of, and the predicate that names her part. */
export const CARETAKER_FILTERS: ReadonlyMap<string, Filter> = new Map<string, Filter>([
  ['generated_drafts', ['communication_type', '==', 'visit_report']],
]);

/** Module-level for the reason `lib/testScope.ts` gives: the hooks have no route context. */
let caretakerSession = false;

/** Set by `resolveAccess`, the one place access is decided. */
export function setCaretakerScope(isCaretaker: boolean): void {
  caretakerSession = isCaretaker;
}

export function isCaretakerScope(): boolean {
  return caretakerSession;
}

/**
 * Return `spec` narrowed to what an Auntie may list when one is signed in,
 * otherwise `spec` unchanged. Idempotent, like `applyTestScope`: a re-render
 * re-derives the spec and must not stack the predicate.
 */
export function applyCaretakerScope(spec: CollectionSpec): CollectionSpec {
  if (!caretakerSession) return spec;
  const filter = CARETAKER_FILTERS.get(spec.path);
  if (!filter) return spec;
  const existing = spec.filters ?? [];
  if (existing.some((f) => f[0] === filter[0] && f[1] === filter[1] && f[2] === filter[2])) return spec;
  return { ...spec, filters: [...existing, filter] };
}
