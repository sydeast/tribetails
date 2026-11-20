import { type CollectionSpec, type Filter } from './firestore';

/**
 * What an Auntie's collection queries must carry, applied in one place.
 *
 * Rules do not filter a list, they allow or refuse it whole. So where an
 * Auntie reads only part of a collection, her query has to say which part it
 * wants or the whole read is refused. This module adds that predicate, for the
 * two collections it applies to:
 *
 *   generated_drafts   KinTale drafts only: the docs whose type is exactly
 *                      `visit_report`. Every other draft there (email, text,
 *                      push and the rest) is the owner's Communicate work.
 *   media_files        the files of her own work: a visit's KinTale photos, a
 *                      Kin's photos and a household's photos. Every other file
 *                      there is the owner's.
 *
 * It is applied centrally in `useCollection` and `usePagedCollection`, beside
 * the sandbox scope in `lib/testScope.ts` and for the same reason: Home's
 * "KinTales pending" panel and the KinTales list share one drafts spec
 * (`api/drafts.ts`), the Gallery and a household's or Kin's Media screen both
 * list `media_files`, and a screen added later cannot forget the predicate.
 *
 * DRAFTS. The field is `communication_type`, the spelling the generator writes
 * and the one the rule reads for a list. A migrated draft that carries only
 * the older `communicationType` spelling is not in her list; the owner still
 * sees it. The query sorts on `createdOn`, so the predicate needs the
 * composite index `generated_drafts (communication_type ASC, createdOn DESC)`.
 *
 * MEDIA. The field is `entityType`, compared as stored: the list carries both
 * spellings the uploaders write (`KIN` and `kin`, `KINFOLK` and `kinfolk`).
 * A file with no `entityType` is not in her list; the owner still sees it.
 * Both media queries sort on `uploadedAt`, so the predicate needs two
 * composite indexes: `media_files (entityType ASC, uploadedAt DESC)` for the
 * Gallery, and `media_files (entityId ASC, entityType ASC, uploadedAt DESC)`
 * for one household's or Kin's Media screen.
 *
 * All three indexes are in `mytribe/firestore.indexes.json`.
 */

/**
 * The `media_files` types an Auntie reads. The same five values, in the same
 * spellings, as the `media_files` rule in `mytribe/firestore.rules`: the rule
 * refuses a list that names anything outside them.
 */
export const CARETAKER_MEDIA_TYPES: readonly string[] = ['VISIT_LOG', 'KIN', 'kin', 'KINFOLK', 'kinfolk'];

/** Collections an Auntie reads only part of, and the predicate that names her part. */
export const CARETAKER_FILTERS: ReadonlyMap<string, Filter> = new Map<string, Filter>([
  ['generated_drafts', ['communication_type', '==', 'visit_report']],
  ['media_files', ['entityType', 'in', CARETAKER_MEDIA_TYPES]],
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
 * Is this the same predicate? Values are compared by content, not identity:
 * the media predicate's value is a list, and `usePagedCollection` rebuilds its
 * spec from a JSON key, so the list a second pass sees is a copy.
 */
function sameFilter(a: Filter, b: Filter): boolean {
  return a[0] === b[0] && a[1] === b[1] && JSON.stringify(a[2]) === JSON.stringify(b[2]);
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
  if (existing.some((f) => sameFilter(f, filter))) return spec;
  return { ...spec, filters: [...existing, filter] };
}
