import { type CollectionSpec } from '../lib/firestore';
import type { Timestamp } from 'firebase/firestore';

/**
 * Directory API layer, ported from the wasm `DirectoryScreen.kt` /
 * `DirectoryViewModel.kt` / `util/Households.kt` / `util/SortOption.kt`. Two
 * live Firestore collections back this screen:
 *
 *   kinfolk   top-level, one doc per household (rules: web/firestore.rules:153,
 *             `allow read: if isAuntie() || ...` — an admin gets an unfiltered
 *             collection read, same shape as NOTIFICATIONS_QUERY).
 *   kin       top-level FLAT MIRROR of `families/{kinfolkId}/kin/{kinId}`,
 *             written by the `onFamilyKinWrite` trigger (MyTribe
 *             functions/src/triggers/onFamilyKinWrite.ts). Rules
 *             (web/firestore.rules:163) also give an admin an unfiltered read.
 *
 * Only the fields this screen actually renders are modeled here (not the full
 * ~30-field Kinfolk / Kin shapes in the wasm FirestoreClient.kt), matching the
 * NotificationEntry precedent: a subset type, not a blind mirror.
 */

// ── Kinfolk (household) ──────────────────────────────────────────────────────

export interface Kinfolk {
  _id: string;
  firstName: string;
  lastName: string;
  phoneNumber: string;
  email: string;
  profilePictureUrl: string;
  status: string; // active | inactive | archived
  /**
   * Admin-entered ISO date, "Admin & Relationship" section. The ONLY recency
   * signal the `kinfolk` collection carries — no `createdAt`/`updatedAt` field
   * exists anywhere in the wasm Kinfolk model, and no MyTribe function was
   * found writing either onto the top-level `kinfolk/{kinfolkId}` doc (checked
   * every writer under functions/src for `.collection('kinfolk')`/`doc(kinfolk/`
   * — none stamp a create/update timestamp on it; `onKinfolkCreate.ts` only
   * timestamps the SEPARATE `families/{id}` portal envelope). `joinDate` is
   * what `DirectoryUiState.filteredSorted` already sorts both recency axes by
   * (see the wasm comment: "Kinfolk has no createdAt/updatedAt yet; joinDate is
   * the only recency signal on hand. Used for both recency axes until the
   * schema grows real timestamps."). Ported verbatim rather than improved on,
   * since it is real operator-entered data, not a fabricated fallback.
   */
  joinDate: string;
}

/** Mirrors the Kotlin `Kinfolk.displayName` getter exactly. */
export function kinfolkDisplayName(kf: Pick<Kinfolk, 'firstName' | 'lastName'>): string {
  const full = `${kf.firstName} ${kf.lastName}`.trim();
  return full === '' ? 'Unnamed Kinfolk' : full;
}

/**
 * Household display label from a surname, e.g. "the Halbrooks". Ports
 * `util/Households.kt#householdLabel` verbatim, sibilant pluralization
 * included ("Brooks" -> "the Brookses", not "the Brookss").
 */
export function householdLabel(lastName: string): string {
  const name = lastName.trim();
  if (name === '') return '';
  const lower = name.toLowerCase();
  const plural = /(s|x|z|ch|sh)$/.test(lower) ? `${name}es` : `${name}s`;
  return `the ${plural}`;
}

/**
 * Surname-primary sort key: "A to Z" orders by LAST name (directory
 * convention) with a first-name tiebreak, falling back to the display name
 * when the last name is blank. Ports `util/SortOption.kt#kinfolkSurnameSortKey`.
 */
export function kinfolkSurnameSortKey(kf: Pick<Kinfolk, 'firstName' | 'lastName'>): string {
  const dn = kinfolkDisplayName(kf);
  const key = kf.lastName.trim() !== '' ? `${kf.lastName} ${kf.firstName}` : dn;
  return key.trim().toLowerCase();
}

/** Digits only, so a bare-digit query ("1234") matches a formatted number ("(512) 555-1234"). */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * Ports `DirectoryViewModel.kt`'s private `Kinfolk.matches`: name/email
 * substring match OR a digits-only phone match (never a naive substring
 * against the formatted phone string, which would miss "(512) 555-1234"
 * against a "1234" query).
 */
export function matchesKinfolk(kf: Kinfolk, needle: string): boolean {
  if (needle.trim() === '') return true;
  const n = needle.trim().toLowerCase();
  const byText =
    kinfolkDisplayName(kf).toLowerCase().includes(n) || kf.email.toLowerCase().includes(n);
  const digits = digitsOnly(needle);
  const byPhone = digits !== '' && digitsOnly(kf.phoneNumber).includes(digits);
  return byText || byPhone;
}

/**
 * Bounded, server-ordered kinfolk listener. Ordered by `lastName` ascending —
 * a directory-conventional alphabetical order and, per the note on `joinDate`
 * above, the only string field guaranteed to exist on every doc (there is no
 * timestamp to order by). Capped at 500: generous for a single business's
 * household roster; a business large enough to need pagination is out of
 * scope for this port. No `where` filter is combined with this `orderBy`, so
 * this query needs NO composite Firestore index (single-field orderBy is
 * always covered by Firestore's automatic single-field index) — same
 * reasoning NOTIFICATIONS_QUERY documents.
 *
 * KNOWN TRADEOFF: Firestore `orderBy` excludes any doc MISSING the sort field,
 * so a kinfolk with no `lastName` (or, for KIN_QUERY, a `kin` predating the
 * `updatedAt` mirror stamp) silently drops from the list, chips, and count.
 * Acceptable only if those fields are always present in prod; flagged for
 * operator prod-verification. If a legacy doc lacks the field, BACKFILL it —
 * do not weaken the sort to a nullable field, which would just move the drop.
 */
export const KINFOLK_QUERY: CollectionSpec = {
  path: 'kinfolk',
  order: ['lastName', 'asc'],
  max: 500,
};

// ── Kin (pet) ────────────────────────────────────────────────────────────────

export interface Kin {
  _id: string;
  kinfolkId: string;
  name: string;
  species: string;
  breed: string;
  age: string;
  sex: string;
  status: string; // active | inactive | archived
  profilePictureUrl: string;
  /**
   * Firestore Timestamp, stamped `FieldValue.serverTimestamp()` on EVERY write
   * to the flat mirror doc (create, update, and the archive-transition write —
   * verified against MyTribe functions/src/triggers/onFamilyKinWrite.ts:88,
   * 132, 157). Real and always-present once the doc has been written at least
   * once; `null` covers the brief local-pending window before a
   * serverTimestamp() write round-trips, same as NotificationEntry.createdAt.
   *
   * There is deliberately NO `createdAt` field here. The wasm comment on this
   * screen (AO-26) claims "the BACKEND already writes kin createdAt/updatedAt"
   * — true only for the NESTED `families/{kinfolkId}/kin/{kinId}` doc
   * (functions/src/portal/kinWrites.ts:71-72 addKin). The FLAT `kin/{docId}`
   * collection this admin reads is a mirror built by onFamilyKinWrite.ts,
   * which stamps `updatedAt` on every branch (create/archive/update, lines 88,
   * 108, 132) but NEVER writes `createdAt` on any branch. So "recently
   * created" has no real backing field on the data this screen can see — see
   * KIN_SORT_OPTIONS below, which omits it rather than shipping a no-op.
   */
  updatedAt?: Timestamp | null;
}

/** ISO sort key for `updatedAt`, or '' (sorts last, never fabricated as "now"). */
function kinUpdatedSortKey(kin: Pick<Kin, 'updatedAt'>): string {
  if (!kin.updatedAt) return '';
  return kin.updatedAt.toDate().toISOString();
}

/** Ports the Kin tab's `matchKin` in DirectoryScreen.kt: name/species/breed substring. */
export function matchesKin(kin: Kin, needle: string): boolean {
  if (needle.trim() === '') return true;
  const n = needle.trim().toLowerCase();
  return (
    kin.name.toLowerCase().includes(n) ||
    kin.species.toLowerCase().includes(n) ||
    kin.breed.toLowerCase().includes(n)
  );
}

/**
 * Bounded, server-ordered kin listener (the flat mirror collection). Ordered
 * by `updatedAt` descending — the one real timestamp field on this collection
 * (see the Kin.updatedAt doc above). Capped at 500. No `where` filter is
 * combined with this `orderBy` (archived kin are excluded CLIENT-side via
 * `activeKinByKinfolk` / the Kin-tab filter below, mirroring the wasm's own
 * client-side `it.status != "archived"` filter), so this query needs NO
 * composite Firestore index.
 */
export const KIN_QUERY: CollectionSpec = {
  path: 'kin',
  order: ['updatedAt', 'desc'],
  max: 500,
};

/**
 * Groups ACTIVE (non-archived) kin by kinfolkId, ports
 * `allKin.filter { it.status != "archived" }.groupBy { it.kinfolkId }` from
 * DirectoryListScreen.kt. A `Map`, not a `Record`, so a kinfolkId with no kin
 * genuinely has no entry (`noUncheckedIndexedAccess`-safe via `.get`).
 */
export function activeKinByKinfolk(allKin: Kin[]): Map<string, Kin[]> {
  const map = new Map<string, Kin[]>();
  for (const k of allKin) {
    if (k.status === 'archived') continue;
    const existing = map.get(k.kinfolkId);
    if (existing) existing.push(k);
    else map.set(k.kinfolkId, [k]);
  }
  return map;
}

/** "Biscuit, Gravy & 1 more". Ports `kinSummaryOf` in DirectoryScreen.kt exactly. */
export function kinSummaryOf(activeKin: Kin[]): string {
  if (activeKin.length === 0) return '';
  if (activeKin.length === 1) return activeKin[0]?.name ?? '';
  const firstTwo = activeKin
    .slice(0, 2)
    .map((k) => k.name)
    .join(', ');
  return activeKin.length > 2 ? `${firstTwo} & ${activeKin.length - 2} more` : firstTwo;
}

/**
 * The household card subtitle: household label when a last name is on file,
 * else a summary of the kin ("Biscuit, Gravy & 1 more"). Ports the
 * `KinfolkCard` subtitle branch in DirectoryScreen.kt.
 */
export function householdSubtitle(kf: Pick<Kinfolk, 'lastName'>, kin: Kin[]): string {
  const label = householdLabel(kf.lastName);
  return label !== '' ? label : kinSummaryOf(kin);
}

/** Ports the Kotlin `initials(name)` helper: "John Smith" -> "JS", "Cher" -> "CH", blank -> "?". */
export function initialsOf(name: string): string {
  const parts = name.split(' ').filter((p) => p.trim() !== '');
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

// ── Sort ─────────────────────────────────────────────────────────────────────

/**
 * Ports `util/SortOption.kt` verbatim: same four keys, same default. Shared
 * across both tabs (the wasm ViewModel holds a single `sort` in its UI state,
 * reused by the Kin tab), which is why both `sortKinfolk` and `sortKin` take
 * the same `SortOption` union rather than two incompatible enums.
 */
export type SortOption = 'alpha_asc' | 'alpha_desc' | 'recently_created' | 'recently_updated';

export const SORT_OPTION_DEFAULT: SortOption = 'alpha_asc';

interface SortOptionMeta {
  value: SortOption;
  label: string;
}

/** All four, for the Kinfolk tab — `joinDate` gives both recency axes a real (if shared) backing field. */
export const KINFOLK_SORT_OPTIONS: readonly SortOptionMeta[] = [
  { value: 'alpha_asc', label: 'A → Z' },
  { value: 'alpha_desc', label: 'Z → A' },
  { value: 'recently_created', label: 'Recently Created' },
  { value: 'recently_updated', label: 'Recently Updated' },
];

/**
 * Only THREE for the Kin tab. "Recently Created" is deliberately absent: per
 * the Kin.updatedAt doc above, the flat `kin` collection has no `createdAt`
 * field anywhere, on any branch, so a "Recently Created" option here would be
 * a decorative no-op (every key equal, order simply left as the underlying
 * server order) rather than a real sort — the "no fake sort" rule this port
 * follows. "Recently Updated" IS wired for real, backed by the collection's
 * one genuine timestamp field.
 */
export const KIN_SORT_OPTIONS: readonly SortOptionMeta[] = [
  { value: 'alpha_asc', label: 'A → Z' },
  { value: 'alpha_desc', label: 'Z → A' },
  { value: 'recently_updated', label: 'Recently Updated' },
];

/** Plain code-unit comparison (not `localeCompare`), matching Kotlin's default String ordering. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortByOption<T>(
  rows: T[],
  option: SortOption,
  name: (row: T) => string,
  createdAt: (row: T) => string,
  updatedAt: (row: T) => string,
): T[] {
  const copy = [...rows];
  switch (option) {
    case 'alpha_asc':
      return copy.sort((a, b) => cmp(name(a).toLowerCase(), name(b).toLowerCase()));
    case 'alpha_desc':
      return copy.sort((a, b) => cmp(name(b).toLowerCase(), name(a).toLowerCase()));
    case 'recently_created':
      return copy.sort((a, b) => cmp(createdAt(b), createdAt(a)));
    case 'recently_updated':
      return copy.sort((a, b) => cmp(updatedAt(b), updatedAt(a)));
  }
}

/** Search-filter then sort Kinfolk, ports `DirectoryUiState.filteredSorted`. */
export function filterSortKinfolk(rows: Kinfolk[], query: string, sort: SortOption): Kinfolk[] {
  const filtered = rows.filter((kf) => matchesKinfolk(kf, query));
  return sortByOption(
    filtered,
    sort,
    (kf) => kinfolkSurnameSortKey(kf),
    (kf) => kf.joinDate,
    (kf) => kf.joinDate,
  );
}

/**
 * Search-filter (excluding archived) then sort Kin, ports the Kin-tab branch
 * of DirectoryScreen.kt's `when (activeTab)`. `createdAt` always resolves to
 * ''  no Kin doc has one  so `recently_created` on Kin is a stable no-op
 * (see KIN_SORT_OPTIONS, which does not expose it as a choice).
 */
export function filterSortKin(rows: Kin[], query: string, sort: SortOption): Kin[] {
  const filtered = rows.filter((k) => k.status !== 'archived' && matchesKin(k, query));
  return sortByOption(
    filtered,
    sort,
    (k) => k.name,
    () => '',
    (k) => kinUpdatedSortKey(k),
  );
}
