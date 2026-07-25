import { type CollectionSpec } from '../lib/firestore';
import type { PagedCollectionSpec } from '../lib/usePagedCollection';
import type { Timestamp } from 'firebase/firestore';

/**
 * One `invoices` row. Mirrors the wasm `Invoice` data class in FirestoreClient.kt
 * (commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:2181),
 * the same flat top-level collection the admin, the kinfolk portal
 * (getMyInvoices.ts), and the Stripe webhook all read/write, confirmed against
 * createInvoice.ts, postInvoiceEvent.ts, and onInvoicesWrite.ts.
 *
 * `status` is free-text on the source doc, NOT a validated enum: createInvoice.ts's
 * zod schema is `status: z.string().default('')`, and the wasm's own
 * InvoiceFilters.kt comment says so explicitly ("Invoice.status is free-text in
 * the source of truth"). Never switch on it directly in a screen, go through
 * `lib/invoiceFormat.ts`'s `invoiceState`, which is where the AO-12 enumeration
 * (as opposed to negation) logic lives.
 *
 * `date` / `dueDate` are opaque free-text strings too (same zod schema), not
 * Firestore Timestamps and not guaranteed ISO, `lib/invoiceFormat.ts` handles
 * the fallback. `createdAt` IS a real server Timestamp (`FieldValue.serverTimestamp()`
 * in createInvoice.ts / createQuote.ts), which is why it is the query's sort key
 * below rather than the free-text `date`.
 *
 * `creditTarget` / `creditRedeemedAt` are stamped by redeemCredit.ts's
 * transaction (`FieldValue.serverTimestamp()` for the latter), present only on
 * a credit invoice that has been redeemed. Absent, never blank/null, so both are
 * optional here rather than defaulted (same convention as NotificationEntry.readAt).
 */
export interface InvoiceEntry {
  _id: string;
  kinfolkId: string;
  kinfolkName: string;
  client: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  total: number;
  amountDue: number;
  status: string;
  sessionIds: string[];
  creditTarget?: 'accountBalance' | 'originalPaymentMethod';
  creditRedeemedAt?: Timestamp;
  createdAt: Timestamp | null;
  /**
   * Stamped by Task 5.1's `archiveInvoice` callable, cleared by `unarchiveInvoice`.
   *
   * ABSENT ON EVERY INVOICE THAT EXISTS TODAY: nothing writes it yet. That is
   * precisely why `isArchivedInvoice` below is a PRESENCE check applied to rows
   * already loaded, and not a `where('archivedAt', '==', null)` predicate.
   * Firestore's equality-to-null matches only documents that HAVE the field set
   * to null, so a server-side exclusion today would return zero invoices, and it
   * would do it silently. The deployed `invoices (archivedAt ASC, date DESC)`
   * index is waiting for 5.1 to start writing the field; until it does, the
   * presence check is the honest reading of the same rule.
   */
  archivedAt?: Timestamp;
}

/**
 * Has this invoice been archived?
 *
 * Presence, not truthiness: an archived invoice carries a Timestamp, an active
 * one carries nothing at all. `null` is accepted as "not archived" so that an
 * unarchive implemented as `archivedAt: null` (rather than a field delete) reads
 * the same way here.
 */
export function isArchivedInvoice(row: Pick<InvoiceEntry, 'archivedAt'>): boolean {
  return row.archivedAt !== undefined && row.archivedAt !== null;
}

/**
 * Fill the fields this interface CLAIMS are always present but Firestore does
 * not guarantee. The interface is a cast over raw document data, not a
 * validation of it, so a legacy or seeded doc missing a key crashes any
 * consumer that calls a method on it.
 *
 * Both failures below were found by driving the LIVE app on 2026-07-20, and
 * both blanked the ENTIRE invoices page via the error boundary rather than
 * degrading one row:
 *   - the 4 seeded sandbox invoices had no `status`  -> `.trim()` of undefined
 *   - `test-kinfolk-001-invoice-1` has no `sessionIds` -> `.length` of undefined
 *
 * Normalize here, once, so no screen has to remember. Money fields are left
 * exactly as they arrive: coercing an absent `total` to 0 would invent a
 * financial fact, and `invoiceState` already treats a non-finite number as "no
 * evidence" rather than as a real zero.
 */
export function normalizeInvoice(row: InvoiceEntry): InvoiceEntry {
  return {
    ...row,
    client: row.client ?? '',
    kinfolkName: row.kinfolkName ?? '',
    invoiceNumber: row.invoiceNumber ?? '',
    date: row.date ?? '',
    dueDate: row.dueDate ?? '',
    status: row.status ?? '',
    sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds : [],
  };
}

/**
 * The bounded, server-ordered invoices listener. Ordered by `createdAt`
 * descending, capped at 200 (the ActivityLog/Notifications convention).
 *
 * DELIBERATE IMPROVEMENT over the wasm reference, not a faithfully-ported
 * behavior: `FirestoreInterop.*.kt`'s `platformInvoicesStream()` is a plain
 * `collectionStream("invoices")`, an unbounded whole-collection listen, the
 * exact AO-29 pattern `useCollection` exists to close off by construction. This
 * spec is what makes that fix apply here too.
 *
 * Sorted by `createdAt` rather than the wasm's client-side sort on the
 * free-text `date`/`dueDate` fields: those two are unvalidated strings (a
 * draft can easily have neither set yet), where `createdAt` is a real
 * `FieldValue.serverTimestamp()` stamped by both real creation paths
 * (createInvoice.ts, createQuote.ts), so ordering by it can't silently drop or
 * misplace an undated draft the way sorting by `date` could.
 *
 * NO `filters`, a single-field orderBy needs no composite index (same note as
 * NOTIFICATIONS_QUERY). All status/date filtering in the screen happens
 * client-side over the already-streamed page, same as the wasm's own
 * `matchesFilter`.
 */
export const INVOICES_QUERY: CollectionSpec = {
  path: 'invoices',
  order: ['createdAt', 'desc'],
  max: 200,
};

/** Rows per "Load more" on the Invoices list. Same reasoning as `KINTALES_PAGE_SIZE`. */
export const INVOICES_PAGE_SIZE = 25;

export interface InvoicesPageOptions {
  /**
   * Lower bound on the invoice `date`, as a `YYYY-MM-DD` DAY (not a full ISO
   * instant), or null for "All (archive)". Null adds NO predicate at all.
   */
  startDay: string | null;
  /** The household facet. Blank/undefined means every household. */
  kinfolkId?: string | undefined;
}

/**
 * The LIST screen's own paged query. `INVOICES_QUERY` above stays as it is:
 * `InvoiceDetail` is handed a row by value from whatever the list loaded, and
 * nothing else pages this collection.
 *
 * WHY THE WINDOW MOVED OFF `createdAt` ONTO `date`, which is the one substantive
 * change here and is not a preference:
 *
 *  - `createdAt` is a real Firestore Timestamp (`FieldValue.serverTimestamp()`
 *    in createInvoice.ts / createQuote.ts). `ListToolbar.rangeStartIso` produces
 *    an ISO STRING, and Firestore sorts every timestamp before every string, so
 *    `where('createdAt', '>=', '2026-07-18T...')` matches NOTHING. It does not
 *    throw; it returns an empty list. A window that silently empties the screen
 *    is the exact failure class this codebase is built to refuse.
 *  - Passing a real Timestamp instead is not available either: the paged hook
 *    keys and rebuilds its spec through `JSON.stringify`/`JSON.parse` (see
 *    `usePagedCollection`), which turns a Timestamp into a plain object the SDK
 *    rejects.
 *  - `date` is free text on the doc but it is what the row already displays and
 *    what the operator means by "an invoice from last week", and it is the field
 *    Phase 4's deployed indexes were built for: `invoices (kinfolkId ASC, date
 *    DESC)` and `invoices (archivedAt ASC, date DESC)`.
 *
 * THE COST, stated rather than hidden: `orderBy('date')` drops any invoice whose
 * `date` is missing, and a `date >= <day>` window also excludes an invoice whose
 * `date` is the empty string that `createInvoice`'s schema defaults to. Such an
 * invoice is reachable only under "All (archive)", where there is no predicate
 * and blank sorts last. `Invoices.tsx` says so on screen whenever a dated window
 * is selected, rather than letting an undated draft simply disappear.
 *
 * INDEXES. Range and order share `date`, so the plain window needs no composite
 * index. With the household facet, or a sandbox admin's automatic `kinfolkId ==`
 * scope, `invoices (kinfolkId ASC, date DESC)` covers it.
 */
export function invoicesPageQuery({ startDay, kinfolkId }: InvoicesPageOptions): PagedCollectionSpec {
  const filters: CollectionSpec['filters'] = [];
  if (kinfolkId !== undefined && kinfolkId !== '') filters.push(['kinfolkId', '==', kinfolkId]);
  if (startDay !== null) filters.push(['date', '>=', startDay]);

  return {
    path: 'invoices',
    order: ['date', 'desc'],
    pageSize: INVOICES_PAGE_SIZE,
    ...(filters.length > 0 ? { filters } : {}),
  };
}

/**
 * Does this invoice match the operator's search text?
 *
 * Client-side over the loaded rows, same contract and same disclosure as
 * `kinTaleMatchesSearch`. Number, household and client are each tested on their
 * own: an invoice is found by who it is for or by the number written on it, and
 * those are the two things the row shows.
 */
export function invoiceMatchesSearch(
  row: Pick<InvoiceEntry, 'invoiceNumber' | 'kinfolkName' | 'client'>,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return [row.invoiceNumber ?? '', row.kinfolkName ?? '', row.client ?? ''].some((field) =>
    field.toLowerCase().includes(needle),
  );
}
