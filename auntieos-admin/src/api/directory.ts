import { type CollectionSpec } from '../lib/firestore';
import { str } from '../lib/coerce';
import { createdAtIsImportDate } from '../lib/createdAtProvenance';
import { DEFAULT_BUSINESS_TIME_ZONE } from '../lib/businessOperations';
import { businessWallClockToMs } from '../lib/businessZoneTime';
import type { Timestamp } from 'firebase/firestore';

/**
 * Directory API layer, ported from the wasm `DirectoryScreen.kt` /
 * `DirectoryViewModel.kt` / `util/Households.kt` / `util/SortOption.kt`. Two
 * live Firestore collections back this screen:
 *
 *   kinfolk   top-level, one doc per household (rules: web/firestore.rules:153,
 *             `allow read: if isAuntie() || ...`, an admin gets an unfiltered
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

/**
 * Every field below is optional because this interface is a CAST over raw
 * Firestore document data, not a validation of it: `useCollection` hands back
 * whatever the doc happens to hold, and a legacy or seeded `kinfolk` doc is
 * free to omit any of these keys. Declaring them non-optional made TypeScript
 * promise a `string` that isn't there, and the first `.trim()`/`.toLowerCase()`
 * threw, which React's error boundary turns into a BLANK SCREEN over one row
 * (see lib/coerce.ts for the live 2026-07-20 cases). `_id` stays required,
 * useCollection always sets it itself.
 */
export interface Kinfolk {
  _id: string;
  firstName?: string | undefined;
  lastName?: string | undefined;
  phoneNumber?: string | undefined;
  email?: string | undefined;
  profilePictureUrl?: string | undefined;
  status?: string | undefined; // active | inactive | archived
  /**
   * The household's linked MyTribe login, when it has one (#1587). Blank or
   * absent until the household signs up. Marketing blasts address accounts, so
   * this is what lets the screen offer households by name and send to their uid.
   */
  uid?: string | undefined;
  /**
   * Where the Kin Care actually happens. Written by `KinfolkEdit.tsx` through
   * `updateKinfolk` and read back by the profile; modeled on this flat-list type
   * as of #703, because the Auntie Time board needs an address PER CARD and one
   * `KINFOLK_QUERY` join is the read that costs nothing extra (Android's own
   * Auntie Time screen takes it off the same document, via
   * `kinfolk?.serviceAddress`).
   *
   * Blank on a household that has never been given one, which is a real state:
   * the card then shows no address line at all rather than an empty chip.
   */
  serviceAddress?: string | undefined;
  /**
   * Admin-entered date, "Admin & Relationship" section: the day the household
   * joined, `YYYY-MM-DD` (older docs hold a full ISO instant or free text, see
   * lib/joinDate.ts). Add Kinfolk writes it blank. "Recently Created" reads
   * it only for a household with no usable [createdAt] (#1953, #2171).
   */
  joinDate?: string | undefined;
  /**
   * When the household came into existence. For a household made in auntieOS,
   * server time stamped by the `createKinfolk` callable (the only way a staff
   * client can create one, #909), `createdAtSource: 'live'`. For a migrated
   * household, the OLD system's creation instant, `createdAtSource: 'original'`
   * (the field contract is in mytribe/scripts/createdAtProvenance.ts). Typed
   * `unknown`: a Firestore Timestamp or an ISO string, read through
   * {@link kinfolkCreatedMillis}, which also takes a `{seconds}` object and
   * never throws.
   */
  createdAt?: unknown;
  /**
   * Where [createdAt] came from (mytribe/scripts/createdAtProvenance.ts):
   * absent or `live` means this system created the row, `original` is a source
   * system's own creation instant, `import` means [createdAt] is only the day
   * the row was imported. An import date is never a creation date.
   */
  createdAtSource?: string | undefined;
  /**
   * The household's last change. Stamped `serverTimestamp()` by web
   * (`kinfolkProfileWrite.ts`, `directoryWrite.ts`), Android
   * (`updateKinfolkFields`) and the server writes to the household doc; the
   * desktop console stamps its own clock as a UTC instant
   * (`withKinfolkUpdatedAt`). Older docs hold an ISO string. Typed
   * `unknown` and read through {@link kinfolkUpdatedMillis} only (#2155).
   */
  updatedAt?: unknown;
  /**
   * Assigned household tag NAMES, written by `updateKinfolkTags` from the
   * profile's Tags panel. Typed `unknown` for the same cast-not-validation
   * reason as every field above: a legacy or seeded doc can hold nothing, a
   * string, or an array with a stray number in it. Read it through
   * `tagNamesOf`, never directly.
   */
  tags?: unknown;
  /** #829. Read through `hasEmergencyContact`; typed unknown like `tags`. */
  emergencyContacts?: unknown;
  /** Legacy flat fields, read only as a fallback until the migration is verified. */
  emergencyContactName?: unknown;
  emergencyContactPhone?: unknown;
}

/** Mirrors the Kotlin `Kinfolk.displayName` getter exactly. */
export function kinfolkDisplayName(kf: Pick<Kinfolk, 'firstName' | 'lastName'>): string {
  // str() on both halves so a doc missing one name never interpolates the
  // literal "undefined" into the card heading.
  const full = `${str(kf.firstName)} ${str(kf.lastName)}`.trim();
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
  const lastName = str(kf.lastName);
  const key = lastName.trim() !== '' ? `${lastName} ${str(kf.firstName)}` : dn;
  return key.trim().toLowerCase();
}

/**
 * A to Z roster order for the pickers and the Directory's default view: the
 * surname-primary key, then the document id so two households with the same
 * name keep a stable order between snapshots. Returns a new array. A record
 * with no last name (or no name at all) sorts by whatever name it has; it is
 * never dropped.
 */
export function sortKinfolkRoster<T extends Pick<Kinfolk, 'firstName' | 'lastName'> & { _id?: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const ka = kinfolkSurnameSortKey(a);
    const kb = kinfolkSurnameSortKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ia = a._id ?? '';
    const ib = b._id ?? '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}
/** Digits only, so a bare-digit query ("1234") matches a formatted number ("(512) 555-1234"). */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/**
 * The fewest digits a search must hold before it is compared with phones
 * (#1952). Three covers an area code; the "last 4 of a phone number" the empty
 * state suggests clears it. One or two digits would match most of the roster.
 */
export const MIN_PHONE_SEARCH_DIGITS = 3;

/** Only digits and the marks people type in a phone number: space ( ) + - . */
const PHONE_SHAPED = /^[\d\s()+.-]+$/;

/** A US number with its leading country code 1 reads as the ten digits after it. */
function withoutCountryCode(digits: string): string {
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * The digits to compare against phones, or null when the search is not a phone
 * search. #1952: the digits used to be pulled out of ANY text, so "zzzz8"
 * listed every household with an 8 in its phone. Now the text has to read as a
 * phone number (digits and phone marks only, no letters, no @) and hold at
 * least [MIN_PHONE_SEARCH_DIGITS] digits.
 */
export function phoneSearchDigits(needle: string): string | null {
  const trimmed = needle.trim();
  if (!PHONE_SHAPED.test(trimmed)) return null;
  const digits = withoutCountryCode(digitsOnly(trimmed));
  return digits.length >= MIN_PHONE_SEARCH_DIGITS ? digits : null;
}

/**
 * Name/email substring match OR, for a phone-shaped search, a digits-only
 * phone match. Digits to digits, so "805-555-0188", "(805) 555-0188" and
 * "+1 805 555 0188" all find a number stored as "(805) 555-0188". Android's
 * `matchesKinfolkSearch` and desktop's `Kinfolk.matches` follow the same rule.
 */
export function matchesKinfolk(kf: Kinfolk, needle: string): boolean {
  if (needle.trim() === '') return true;
  const n = needle.trim().toLowerCase();
  const byText =
    kinfolkDisplayName(kf).toLowerCase().includes(n) || str(kf.email).toLowerCase().includes(n);
  if (byText) return true;
  const digits = phoneSearchDigits(needle);
  return digits !== null && withoutCountryCode(digitsOnly(str(kf.phoneNumber))).includes(digits);
}

/**
 * Bounded kinfolk listener, paged by DOCUMENT ID (#1565).
 *
 * This query used to be ordered by `lastName`. Firestore's `orderBy` silently
 * EXCLUDES every document missing the sort field, so a kinfolk record with no
 * last name (the "No Lead" test household) vanished from Directory, the chips,
 * the count and every household picker with no error and no empty state. The
 * same shape `KIN_QUERY` below documents for `updatedAt`.
 *
 * A document id exists on every document, so this order cannot hide a row no
 * matter which writer created it. It carries no meaning, and no caller needs it
 * to: every consumer reads the stream through `useKinfolkRoster`
 * (`lib/useKinfolkRoster.ts`), which re-derives the A to Z order on the client
 * with {@link sortKinfolkRoster}. Directory's own sort controls
 * (`filterSortKinfolk`) re-sort again on top of that.
 *
 * Capped at 500: generous for a single business's household roster; a
 * business large enough to need pagination is out of scope. No `where` filter
 * is combined with this `orderBy`, so this query needs NO composite Firestore
 * index (the sandbox scope in `lib/testScope.ts` adds an equality filter on the
 * document id sentinel, which the automatic single-field index also covers).
 * If the roster ever nears the cap, paginate it; do not reintroduce a sort key
 * a writer can omit.
 */
export const KINFOLK_QUERY: CollectionSpec = {
  path: 'kinfolk',
  order: ['__name__', 'asc'],
  max: 500,
};

// ── Kin (pet) ────────────────────────────────────────────────────────────────

/**
 * Same cast-not-validation rule as `Kinfolk` above: the flat `kin` mirror is
 * written by a trigger over portal-entered data, so `breed`, `age` and `sex`
 * in particular are routinely absent on real docs. Optional here so the
 * compiler forces a default at each read instead of promising a `string` the
 * document never carried. `_id` stays required (useCollection sets it).
 */
/**
 * A pet that counts as "in care": anything not marked inactive or archived. A
 * blank status counts, because no `kin` writer sets the field on every doc
 * (see KIN_QUERY). Home's "Kin in care" card and the Directory's Kin tab "In
 * care" filter both call this, so the card's number is the list's length.
 */
export function isKinInCare(kin: { status?: string | undefined }): boolean {
  const s = (kin.status ?? '').trim().toLowerCase();
  return s !== 'inactive' && s !== 'archived';
}

/** An archived Kin, any spelling: the one status the Kin tab hides unless asked. */
export function isKinArchived(kin: { status?: string | undefined }): boolean {
  return (kin.status ?? '').trim().toLowerCase() === 'archived';
}

/**
 * #1902: what the Kin tab's Show picker lists. "All kin" is every Kin that is
 * not archived, "In care" narrows that to `isKinInCare`, and "Archived" lists
 * only the archived ones, which is the one way back to a Kin's Restore.
 */
export type KinShow = 'all' | 'inCare' | 'archived';

export const KIN_SHOW_OPTIONS: readonly { value: KinShow; label: string }[] = [
  { value: 'all', label: 'All kin' },
  { value: 'inCare', label: 'In care' },
  { value: 'archived', label: 'Archived' },
];

export function kinMatchesShow(kin: { status?: string | undefined }, show: KinShow): boolean {
  if (show === 'archived') return isKinArchived(kin);
  if (show === 'inCare') return isKinInCare(kin);
  return !isKinArchived(kin);
}
export interface Kin {
  _id: string;
  kinfolkId?: string | undefined;
  name?: string | undefined;
  species?: string | undefined;
  breed?: string | undefined;
  age?: string | undefined;
  sex?: string | undefined;
  status?: string | undefined; // active | inactive | archived
  profilePictureUrl?: string | undefined;
  /**
   * Firestore Timestamp, stamped `FieldValue.serverTimestamp()` on EVERY write
   * to the flat mirror doc (create, update, and the archive-transition write, 
   * verified against MyTribe functions/src/triggers/onFamilyKinWrite.ts:88,
   * 132, 157). Real and always-present once the doc has been written at least
   * once; `null` covers the brief local-pending window before a
   * serverTimestamp() write round-trips, same as NotificationEntry.createdAt.
   *
   * There is deliberately NO `createdAt` field here. The wasm comment on this
   * screen (AO-26) claims "the BACKEND already writes kin createdAt/updatedAt"
   *, true only for the NESTED `families/{kinfolkId}/kin/{kinId}` doc
   * (functions/src/portal/kinWrites.ts:71-72 addKin). The FLAT `kin/{docId}`
   * collection this admin reads is a mirror built by onFamilyKinWrite.ts,
   * which stamps `updatedAt` on every branch (create/archive/update, lines 88,
   * 108, 132) but NEVER writes `createdAt` on any branch. So "recently
   * created" has no real backing field on the data this screen can see, see
   * KIN_SORT_OPTIONS below, which omits it rather than shipping a no-op.
   */
  updatedAt?: Timestamp | null;
  /** Assigned Kin tag NAMES. Same `unknown` treatment as `Kinfolk.tags`; read via `tagNamesOf`. */
  tags?: unknown;
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
    str(kin.name).toLowerCase().includes(n) ||
    str(kin.species).toLowerCase().includes(n) ||
    str(kin.breed).toLowerCase().includes(n)
  );
}

/**
 * Bounded, server-ordered kin listener (the flat mirror collection). Ordered by
 * DOCUMENT ID ascending, capped at 500. No `where` filter is combined with this
 * `orderBy` (archived kin are excluded CLIENT-side via `activeKinByKinfolk` /
 * the Kin-tab filter below, mirroring the wasm's own client-side
 * `it.status != "archived"` filter), so this query needs NO composite index.
 *
 * WHY DOCUMENT ID AND NOT `updatedAt`. Firestore's `orderBy` silently EXCLUDES
 * every document missing the sort field, so a sort key doubles as an invisible
 * `where <field> exists`. This query previously ordered by `updatedAt` desc, and
 * the 2026-07-20 live model audit measured `updatedAt` on 23 of 24 real `kin`
 * docs. One live Kin therefore rendered nowhere, not in Directory's Kin tab and
 * not in the Care Flags join, with no error and no empty state. Same shape that
 * returned 0 of 18 invoices and 23 of 99 sessions.
 *
 * A backfill would clear today's 24th doc without closing the defect: it holds
 * only until the next writer omits the field, and the writers do not agree on
 * one. Every writer of a flat `kin` doc, traced across both trees:
 *
 *   - MyTribe `triggers/onFamilyKinWrite.ts`, the family -> flat mirror: stamps
 *     BOTH `updatedAt` and `familyKinPath` on all three branches (create :95,
 *     archive :128, update :156).
 *   - MyTribe `triggers/onFlatKinWrite.ts`: writes the FAMILY doc, never a flat
 *     one. Not a writer of this collection.
 *   - MyTribe `admin/setMediaProfilePhoto.ts:104`: `updatedAt` only.
 *   - This repo's `api/directoryWrite.ts` (createKin, updateKin, setKinArchived,
 *     updateKinTags): `updatedAt` only, never `familyKinPath`.
 *   - android `AuntieRepository.updateKin`: whole-object `.set()` with
 *     `updatedAt` explicitly stamped.
 *   - android `AuntieRepository.createKin`: whole-object `.add(kin)`, so
 *     `updatedAt` is only ever the Kotlin model default (`Any? = null`); the
 *     follow-up `stampFamilyKinPath` merge writes the link fields, not a
 *     timestamp.
 *
 * So `familyKinPath` (24 of 24 live today) is NOT the safer key it looks like:
 * this admin's own `createKin` never writes it, and ordering by it would drop
 * every React-created pet instead. No field is set by every writer.
 *
 * A document id is the one key Firestore guarantees on every document, so this
 * order cannot hide a row no matter which writer created it. The cost is that
 * the order carries no meaning, and neither caller needs it to: `filterSortKin`
 * below re-derives the Kin tab's displayed order (A to Z, Recently Updated) from
 * whatever page comes back, and `CareFlagsWidget` keys the page into a Map by
 * `_id`. The stream's order is a PAGING BOUND, not the display order, exactly
 * as `api/sessions.ts#SESSIONS_QUERY` documents for its own stream. `'__name__'`
 * is the same document-id sentinel `lib/testScope.ts#DOC_ID_FIELD` uses; the
 * Firestore SDK resolves it in `orderBy` to the identical field path
 * `documentId()` produces, so no `lib/firestore.ts` change is needed.
 *
 * KNOWN TRADEOFF, accepted rather than hidden: the 500 cap now truncates by
 * document id instead of keeping the 500 most recently touched. At 24 live kin
 * that boundary is far off, and an arbitrary cut at 500 is strictly better than
 * the certain, silent loss of a row at 24. If the roster ever nears the cap,
 * paginate it, do not reintroduce a sort key a writer can omit. Ascending is
 * deliberate: an equality filter plus `orderBy` on the document id ascending is
 * covered by Firestore's automatic single-field index, which keeps the sandbox
 * scope (`lib/testScope.ts` adds `where('kinfolkId', '==', tribe)` on this path)
 * composite-index-free. The old `updatedAt` desc ordering did not have that
 * property.
 */
/**
 * The cap every `kin` listener carries. Named rather than left as a literal
 * because a caller has to be able to SAY it: a page that comes back at exactly
 * this many rows may be a truncated read, and a screen that cannot tell has no
 * way to disclose it.
 */
export const KIN_ROSTER_MAX = 500;

export const KIN_QUERY: CollectionSpec = {
  path: 'kin',
  order: ['__name__', 'asc'],
  max: KIN_ROSTER_MAX,
};

/**
 * The kin roster for ONE household.
 *
 * The booking wizard used to read the WHOLE `kin` collection through
 * `KIN_QUERY` and group it client-side, which put every household behind one
 * shared cap ordered by document id: a household whose kin sort past that
 * boundary read back empty, and the wizard said "No Kin on this household yet"
 * with total confidence. That is the silent-truncation failure class the
 * `KIN_QUERY` note above spends a page warning about, arriving through a
 * different door. Android never had it, because its wizard asks for one
 * household's kin (`AuntieRepository.getKin(kinfolkId)`); this is that read.
 *
 * An equality filter plus `orderBy` on the document id ascending is covered by
 * Firestore's automatic single-field index, so this needs no composite index --
 * the same property `KIN_QUERY` documents above for the sandbox scope.
 *
 * The cap stays, because an unbounded listener is not an option here (AO-29). A
 * read that comes back AT the cap is DISCLOSED by the caller rather than quietly
 * trusted. A blank `kinfolkId` is a real state (no household picked yet) and
 * matches nothing, which is exactly right: no household, no roster.
 */
export function kinForHouseholdQuery(kinfolkId: string): CollectionSpec {
  return {
    path: 'kin',
    order: ['__name__', 'asc'],
    max: KIN_ROSTER_MAX,
    filters: [['kinfolkId', '==', kinfolkId]],
  };
}

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
    // An orphaned kin (no kinfolkId on the doc) groups under '', which no
    // household _id can equal, so it stays out of every card rather than
    // attaching itself to an arbitrary household.
    const key = str(k.kinfolkId);
    const existing = map.get(key);
    if (existing) existing.push(k);
    else map.set(key, [k]);
  }
  return map;
}

/** "Biscuit, Gravy & 1 more". Ports `kinSummaryOf` in DirectoryScreen.kt exactly. */
export function kinSummaryOf(activeKin: Kin[]): string {
  if (activeKin.length === 0) return '';
  if (activeKin.length === 1) return str(activeKin[0]?.name);
  const firstTwo = activeKin
    .slice(0, 2)
    .map((k) => str(k.name))
    .join(', ');
  return activeKin.length > 2 ? `${firstTwo} & ${activeKin.length - 2} more` : firstTwo;
}

/**
 * The household card subtitle: household label when a last name is on file,
 * else a summary of the kin ("Biscuit, Gravy & 1 more"). Ports the
 * `KinfolkCard` subtitle branch in DirectoryScreen.kt.
 */
export function householdSubtitle(kf: Pick<Kinfolk, 'lastName'>, kin: Kin[]): string {
  const label = householdLabel(str(kf.lastName));
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

/** All four, for the Kinfolk tab: see {@link kinfolkCreatedMillis} (Recently Created) and {@link kinfolkUpdatedMillis} (Recently Updated). */
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
 * server order) rather than a real sort, the "no fake sort" rule this port
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

// ── Tag filtering (#713) ─────────────────────────────────────────────────────
//
// The operator's second complaint on this issue: "tags are just labels and not
// actual tags which act like a filter." Tags drove Communicate audiences and
// KinTale rules and nothing else; the Directory could not narrow by one. These
// three helpers are that filter, and they are PURE and CLIENT-SIDE on purpose.
// Both tabs already hold their whole collection in memory (KINFOLK_QUERY /
// KIN_QUERY), so narrowing by tag costs no read, needs no composite index, and
// cannot silently truncate the way a re-queried `array-contains` would.

/** The special value meaning "do not narrow by tag". Not a real tag name. */
export const TAG_FILTER_ALL = '';

/** Keep only the string entries of a `tags` field. A malformed value reads as no tags. */
export function tagNamesOf(row: { tags?: unknown }): string[] {
  if (!Array.isArray(row.tags)) return [];
  return row.tags.filter((t): t is string => typeof t === 'string');
}

/** The comparison key for a tag name, matching `normalizeTagName` + lowercase in lib/tags/model.ts. */
function tagKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Every distinct tag carried by these rows, in alphabetical order, for the
 * filter's option list.
 *
 * Built from the ROWS rather than from the `business_settings` vocabulary, and
 * that is the whole point: the list then only ever offers a tag that would
 * actually narrow something, and it needs no second read on a screen that has
 * no reason to load business settings. A free-form name a profile assigned
 * without promoting it to the vocabulary is a real filter here too.
 *
 * Names that differ only by case or spacing collapse to one option, keeping the
 * first casing seen, so "vip" and "VIP" do not both appear.
 */
export function tagFilterOptions(rows: Array<{ tags?: unknown }>): string[] {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const name of tagNamesOf(row)) {
      const key = tagKey(name);
      if (key !== '' && !seen.has(key)) seen.set(key, name.trim());
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** True when the row carries this tag. A blank `tag` matches everything (no filter applied). */
export function matchesTag(row: { tags?: unknown }, tag: string): boolean {
  const key = tagKey(tag);
  if (key === '') return true;
  return tagNamesOf(row).some((t) => tagKey(t) === key);
}

// ── Recently Created / Recently Updated (#1953, #2171, #2155) ────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Epoch millis of an ISO instant, or of an ISO day read as midnight on the
 * business's clock (America/Chicago, the server's default), else null. A join
 * date of 12 Nov must sort above a household made at 11:30 PM on 11 Nov in
 * Chicago, which UTC midnight would not do (#2171 review). Android and the
 * desktop console read a day the same way. Free text is never guessed at.
 */
function isoMillis(raw: string): number | null {
  const s = raw.trim();
  if (ISO_DAY.test(s)) return businessWallClockToMs(s, '00:00', DEFAULT_BUSINESS_TIME_ZONE);
  if (!ISO_INSTANT.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch millis of a stored timestamp: a Firestore Timestamp, a `{seconds}` object, or an ISO string. */
function storedMillis(v: unknown): number | null {
  if (typeof v === 'string') return isoMillis(v);
  if (v === null || typeof v !== 'object') return null;
  const o = v as { toMillis?: unknown; toDate?: unknown; seconds?: unknown; nanoseconds?: unknown };
  try {
    if (typeof o.toMillis === 'function') {
      const ms = (o.toMillis as () => number).call(v);
      return Number.isFinite(ms) ? ms : null;
    }
    if (typeof o.toDate === 'function') {
      const ms = (o.toDate as () => Date).call(v).getTime();
      return Number.isFinite(ms) ? ms : null;
    }
  } catch {
    return null;
  }
  if (typeof o.seconds === 'number' && Number.isFinite(o.seconds)) {
    const nanos = typeof o.nanoseconds === 'number' && Number.isFinite(o.nanoseconds) ? o.nanoseconds : 0;
    return o.seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return null;
}

/**
 * The date that places a household under "Recently Created", in epoch millis,
 * or null when it has none (#1953, #2171). ONE timeline, whichever of these
 * the household has first:
 *
 *  1. [Kinfolk.createdAt]: the auntieOS creation stamp (`createdAtSource`
 *     `live` or absent) or, for a migrated household, the old system's own
 *     creation date (`original`). A `createdAtSource` of `import` means the
 *     original was lost and the value is only the day of the import, so it is
 *     skipped.
 *  2. The join date, when it reads as a date.
 *  3. Nothing: null. The household sorts last, never given a made-up date.
 *
 * The Firestore document create time is never used: after the reload of the
 * data it is the import date. Android `kinfolkCreatedMillis` and the desktop
 * console's `kinfolkCreatedMillis` apply the same rule.
 */
export function kinfolkCreatedMillis(
  kf: Pick<Kinfolk, 'createdAt' | 'createdAtSource' | 'joinDate'>,
): number | null {
  if (!createdAtIsImportDate(kf.createdAtSource)) {
    const created = storedMillis(kf.createdAt);
    if (created !== null) return created;
  }
  return isoMillis(str(kf.joinDate));
}

/**
 * The date that places a household under "Recently Updated", in epoch millis,
 * or null (#2155): its last change, [Kinfolk.updatedAt]. A household never
 * changed since it was made was last changed when it was made, so with no
 * readable `updatedAt` it falls back to {@link kinfolkCreatedMillis}.
 */
export function kinfolkUpdatedMillis(
  kf: Pick<Kinfolk, 'updatedAt' | 'createdAt' | 'createdAtSource' | 'joinDate'>,
): number | null {
  return storedMillis(kf.updatedAt) ?? kinfolkCreatedMillis(kf);
}

/** Newest first; equal dates A to Z by surname; households with no date last, A to Z. */
function sortKinfolkByDate(rows: Kinfolk[], dateOf: (kf: Kinfolk) => number | null): Kinfolk[] {
  return rows
    .map((kf) => ({ kf, at: dateOf(kf), name: kinfolkSurnameSortKey(kf) }))
    .sort((a, b) => {
      if (a.at !== null && b.at !== null && a.at !== b.at) return b.at - a.at;
      if (a.at === null && b.at !== null) return 1;
      if (a.at !== null && b.at === null) return -1;
      return cmp(a.name, b.name);
    })
    .map((r) => r.kf);
}

/** Search-filter (and tag-filter) then sort Kinfolk, ports `DirectoryUiState.filteredSorted`. */
export function filterSortKinfolk(
  rows: Kinfolk[],
  query: string,
  sort: SortOption,
  tag: string = TAG_FILTER_ALL,
): Kinfolk[] {
  const filtered = rows.filter((kf) => matchesKinfolk(kf, query) && matchesTag(kf, tag));
  if (sort === 'recently_created') return sortKinfolkByDate(filtered, kinfolkCreatedMillis);
  if (sort === 'recently_updated') return sortKinfolkByDate(filtered, kinfolkUpdatedMillis);
  return sortByOption(
    filtered,
    sort,
    (kf) => kinfolkSurnameSortKey(kf),
    () => '',
    () => '',
  );
}

/**
 * Show-filter, search-filter and tag-filter then sort Kin, ports the Kin-tab branch
 * of DirectoryScreen.kt's `when (activeTab)`. `show` defaults to "All kin",
 * which leaves archived Kin out; "Archived" lists only them (#1902).
 * `createdAt` always resolves to ''  no Kin doc has one  so
 * `recently_created` on Kin is a stable no-op (see KIN_SORT_OPTIONS, which
 * does not expose it as a choice).
 */
export function filterSortKin(
  rows: Kin[],
  query: string,
  sort: SortOption,
  tag: string = TAG_FILTER_ALL,
  show: KinShow = 'all',
): Kin[] {
  const filtered = rows.filter(
    (k) => kinMatchesShow(k, show) && matchesKin(k, query) && matchesTag(k, tag),
  );
  return sortByOption(
    filtered,
    sort,
    (k) => str(k.name),
    () => '',
    (k) => kinUpdatedSortKey(k),
  );
}
