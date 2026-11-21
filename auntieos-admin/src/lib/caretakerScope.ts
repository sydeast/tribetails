import { type CollectionSpec, type Filter } from './firestore';

/**
 * What an Auntie's collection queries must carry, applied in one place.
 *
 * Rules do not filter a list, they allow or refuse it whole. So where an
 * Auntie reads only part of a collection, her query has to say which part it
 * wants or the whole read is refused. This module adds those predicates, for
 * the two collections they apply to:
 *
 *   generated_drafts   the KinTale drafts she made: the docs whose type is
 *                      exactly `visit_report` and whose `createdBy` stamp is
 *                      exactly her uid (#2443 ruling, 2026-11-20). Every other
 *                      draft there (email, text, push and the rest, and any
 *                      KinTale draft the owner or another Auntie made) is not
 *                      hers.
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
 * DRAFTS. The type field is `communication_type`, the spelling the generator
 * writes and the one the rule reads for a list. A migrated draft that carries
 * only the older `communicationType` spelling is not in her list; the owner
 * still sees it. The maker field is `createdBy`, stamped on the server by every
 * path that creates a draft (the generator and `writeDraft` in
 * `web/functions`). A draft with no stamp is the owner's and is not in her list.
 * The query sorts on `createdOn`, so the predicates need the composite index
 * `generated_drafts (communication_type ASC, createdBy ASC, createdOn DESC)`.
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

/** The field every draft creator stamps with the maker's uid (#2443). */
export const DRAFT_CREATOR_FIELD = 'createdBy';

/** The type predicate on an Auntie's drafts list. */
export const KINTALE_DRAFT_FILTER: Filter = ['communication_type', '==', 'visit_report'];

/** Module-level for the reason `lib/testScope.ts` gives: the hooks have no route context. */
let caretakerSession = false;
let caretakerUid = '';

/**
 * Set by `resolveAccess`, the one place access is decided. `uid` is the
 * signed-in Auntie's, and names the drafts that are hers.
 */
export function setCaretakerScope(isCaretaker: boolean, uid: string | null = null): void {
  caretakerSession = isCaretaker;
  caretakerUid = isCaretaker ? (uid ?? '').trim() : '';
}

export function isCaretakerScope(): boolean {
  return caretakerSession;
}

/**
 * The predicates an Auntie's list of `path` must carry, or none for a
 * collection she reads whole (or not at all).
 *
 * An Auntie session with no uid gets a maker predicate no draft can satisfy
 * (`createdBy == ''`), so the drafts list comes back refused rather than
 * widened: the rules allow her list only when it names her own uid.
 */
export function caretakerFiltersFor(path: string): Filter[] {
  if (path === 'generated_drafts') return [KINTALE_DRAFT_FILTER, [DRAFT_CREATOR_FIELD, '==', caretakerUid]];
  if (path === 'media_files') return [['entityType', 'in', CARETAKER_MEDIA_TYPES]];
  return [];
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
 * re-derives the spec and must not stack the predicates.
 */
export function applyCaretakerScope(spec: CollectionSpec): CollectionSpec {
  if (!caretakerSession) return spec;
  const wanted = caretakerFiltersFor(spec.path);
  if (wanted.length === 0) return spec;
  const existing = spec.filters ?? [];
  const missing = wanted.filter((f) => !existing.some((e) => sameFilter(e, f)));
  if (missing.length === 0) return spec;
  return { ...spec, filters: [...existing, ...missing] };
}
