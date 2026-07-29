import { type CollectionSpec } from '../lib/firestore';
import type { PagedCollectionSpec } from '../lib/usePagedCollection';
import type { Timestamp } from 'firebase/firestore';
import type {
  CreateInvoiceArgsLineItem,
  LinkInvoiceSessionsResult,
} from '../contracts/invoiceContracts.generated';

/**
 * One `invoices` row. Mirrors the wasm `Invoice` data class in FirestoreClient.kt
 * (commonMain/kotlin/com/tribetails/auntieos/web/data/FirestoreClient.kt:2181),
 * the same flat top-level collection the admin, the kinfolk portal
 * (getMyInvoices.ts), and the Stripe webhook all read/write, confirmed against
 * createInvoice.ts, postInvoiceEvent.ts, and onInvoicesWrite.ts.
 *
 * `status` and `editScope` are the Invoice State Classifier STAMP (ADR-0002):
 * every server-side invoice writer persists the classifier's output onto the
 * doc in the same write, a backfill stamped the pre-existing docs, and
 * firestore.rules denies all client invoice writes. Clients render the
 * persisted state and never classify — read them through `invoiceStamp` below,
 * never by re-deriving state from the money fields.
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

/**
 * The Invoice State Classifier's two halves, TAKEN FROM THE CONTRACTS MODULE
 * (ADR-0001) rather than transcribed from `invoiceEditPolicy.ts` as they were
 * until now. `linkInvoiceSessions` is the callable that returns both side by
 * side and un-widened, which is why its result is the source here.
 *
 *   InvoiceState      the 8 states the stamp can write, lowercase
 *   InvoiceEditScope  what an edit may still change
 *                       all           every field, line items and discounts
 *                       metadataOnly  the descriptive fields, money frozen
 *                       none          nothing
 *
 * Nothing in this app decides which member applies; it reads what the server
 * already decided.
 */
export type InvoiceState = LinkInvoiceSessionsResult['status'];
export type InvoiceEditScope = LinkInvoiceSessionsResult['editScope'];

/**
 * The same vocabulary as a RUNTIME value, which is the one thing the type above
 * cannot give `invoiceStamp`: it has to test a string it was handed against the
 * members, and a type erases.
 *
 * `satisfies` pins the list to the contract, so a member this array holds and
 * the server does not is a typecheck failure here. The reverse (a state added
 * server-side and not added here) is NOT a compile error. It lands as the
 * documented fail-soft below: an unrecognized stamp reads as no stamp, which
 * hides the money affordances rather than guessing at them.
 */
export const INVOICE_STATES = [
  'quote',
  'draft',
  'cancelled',
  'credit',
  'redeemed',
  'paid',
  'zero',
  'open',
] as const satisfies readonly InvoiceState[];

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
  /**
   * What has been collected against this invoice, in integer cents, written by
   * `markInvoicePaid` and by the partial-payment repair pass.
   *
   * ABSENT on every invoice that predates 2026-07-25, which is why it is
   * optional (an absent value is "no record of a payment", never a real
   * zero, see `invoicePartialPayment`). Deliberately NOT derived from
   * `total - amountDue`: those are float dollars, and on every invoice the old
   * partial-payment write touched `amountDue` reads 0 while a real balance is
   * owed, so that subtraction would report the whole total as collected on
   * exactly the invoices that are wrong.
   */
  paidCents?: number;
  /** Collected beyond the total, in integer cents. Present only after an overpayment. */
  overpaidCents?: number;
  /**
   * The persisted Invoice State Classifier verdict (ADR-0002), stamped by the
   * server in the same write as every money change. Typed as the union because
   * that is what the server writes; the interface is still a cast over raw
   * Firestore data, so read it through `invoiceStamp`, which verifies at
   * runtime instead of trusting the cast.
   */
  status: InvoiceState;
  /** The stamp's other half: how much of this invoice the server will let an edit change. */
  editScope: InvoiceEditScope;
  sessionIds: string[];
  creditTarget?: 'accountBalance' | 'originalPaymentMethod';
  creditRedeemedAt?: Timestamp;
  createdAt: Timestamp | null;
  /**
   * Stamped by Task 5.1's `archiveInvoice` callable, cleared by `unarchiveInvoice`.
   *
   * ABSENT ON EVERY INVOICE THAT PREDATES 5.1, and that does not change now that
   * the field is finally being written: writing it onto new archives does NOT
   * retroactively give it to the invoices already in the collection. That is
   * precisely why `isArchivedInvoice` below is a PRESENCE check applied to rows
   * already loaded, and not a `where('archivedAt', '==', null)` predicate.
   * Firestore's equality-to-null matches only documents that HAVE the field set
   * to null, so a server-side exclusion would return ZERO invoices, and it would
   * do it silently. The deployed `invoices (archivedAt ASC, date DESC)` index
   * stays unused for this purpose until a backfill runs, which is a migration
   * and not this task. `unarchiveInvoice` writes `archivedAt: null` rather than
   * deleting the field, so a restored invoice already carries the shape such a
   * backfill would converge on.
   */
  archivedAt?: Timestamp;
  /**
   * The itemization, written by `createInvoice` and `updateInvoice`.
   *
   * ABSENT IS NOT THE SAME AS EMPTY, and the distinction is load-bearing rather
   * than pedantic. Absent means nobody has ever itemized this invoice, which is
   * true of every invoice created before Task 5.1. Empty means somebody itemized
   * it as billing nothing. `updateInvoice` REFUSES to recompute an un-itemized
   * invoice for exactly this reason: "the sum of zero lines" is not the same
   * statement as "this invoice is worth nothing", and treating them alike would
   * rewrite a real $40 invoice to $0 the next time an operator corrected its due
   * date. Nothing in this app may flatten the two into `lineItems ?? []`; read
   * them through `invoiceLineItems` below.
   */
  lineItems?: InvoiceLineItem[];
  /** Whole-invoice reduction, integer cents. Only meaningful alongside `lineItems`. */
  invoiceDiscountCents?: number;
  /** Sum of the line amounts before the invoice discount, integer cents. Server-derived. */
  subtotalCents?: number;
  /** The exact total in integer cents. `total` above is its rounded dollar projection. */
  totalCents?: number;
  /** The exact balance in integer cents. `amountDue` above is its dollar projection. */
  amountDueCents?: number;
}

/**
 * One billed line: `description`, a `qty` that may be fractional (2.5 hours), a
 * `unitCents` that is an INTEGER count of cents, and an optional per-line
 * `discountCents`.
 *
 * AN ALIAS OF THE CONTRACT, not a transcription of it. The stored array is
 * whatever `createInvoice` was handed or whatever `updateInvoice`'s patch
 * replaced it with, written through verbatim (`updateInvoice.ts:253`), so the
 * request shape IS the stored shape and there is no second thing to describe.
 * `UpdateInvoiceArgsPatchLineItem` is the identical type on the edit side; the
 * codegen emits one per callable, and this app needs one name.
 *
 * There is NO stored per-line amount, deliberately. It is always derived through
 * `lib/invoiceMath.ts#lineAmountCents`, so the lines shown and the total shown
 * can only ever come from one rule.
 */
export type InvoiceLineItem = CreateInvoiceArgsLineItem;

/**
 * The stored lines, or null when this invoice has never been itemized.
 *
 * The single place the absent-versus-empty distinction above is read, so no
 * screen has to remember it. Returns null for absent, `[]` for empty, and drops
 * any row that is not a usable line: `InvoiceEntry` is a cast over raw Firestore
 * data rather than a validation of it, and `firestore.rules` grants
 * `allow update: if isAuntie()` over this collection, so a malformed row can
 * genuinely be sitting on a doc. Dropping one bad line beats letting it blank
 * the whole panel through the error boundary, which is the failure the
 * `normalizeInvoice` note below records happening twice on live data.
 */
export function invoiceLineItems(row: Pick<InvoiceEntry, 'lineItems'>): InvoiceLineItem[] | null {
  if (!Array.isArray(row.lineItems)) return null;
  const out: InvoiceLineItem[] = [];
  for (const entry of row.lineItems as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const li = entry as Record<string, unknown>;
    const qty = li['qty'];
    const unitCents = li['unitCents'];
    if (typeof qty !== 'number' || !Number.isFinite(qty)) continue;
    if (typeof unitCents !== 'number' || !Number.isFinite(unitCents)) continue;
    const discountCents = li['discountCents'];
    out.push({
      description: typeof li['description'] === 'string' ? li['description'] : '',
      qty,
      unitCents,
      ...(typeof discountCents === 'number' && Number.isFinite(discountCents) ? { discountCents } : {}),
    });
  }
  return out;
}

/**
 * The stamp as this doc actually carries it, verified rather than trusted.
 *
 * `state: null` means the doc carries NO recognizable stamp. Per ADR-0002 that
 * should be impossible now — every writer stamps, the backfill stamped the
 * backlog, and the rules deny every client write — so this is the deliberate
 * fail-soft for the impossible doc, NOT a second classifier:
 *
 *   - the state is null, never re-derived from the money fields. The screens
 *     render a neutral chip from the raw `status` text and say nothing they
 *     cannot prove;
 *   - the editScope is 'none', the SAFE affordance: no editing offered on an
 *     unknown state. This is the one place the old mirror's "fail toward
 *     offering the control" ruling inverts, on purpose: that ruling existed
 *     because the mirror was a courtesy in front of a server that would refuse;
 *     an unstamped doc means the write path itself is not what we think it is,
 *     and offering money controls against it would be a guess.
 *
 * Recognition is EXACT match against the stamp's own vocabulary (lowercase, no
 * padding), because that is what the server writes. A legacy spelling like
 * 'PAID' is not "obviously paid", it is evidence the doc was never stamped,
 * and normalizing it here would be re-classification through the back door.
 */
export interface InvoiceStamp {
  state: InvoiceState | null;
  editScope: InvoiceEditScope;
}

export function invoiceStamp(row: Pick<InvoiceEntry, 'status' | 'editScope'>): InvoiceStamp {
  const status: unknown = row.status;
  const state =
    typeof status === 'string' && (INVOICE_STATES as readonly string[]).includes(status)
      ? (status as InvoiceState)
      : null;
  if (state === null) return { state: null, editScope: 'none' };
  const scope: unknown = row.editScope;
  return {
    state,
    editScope:
      scope === 'all' || scope === 'metadataOnly' || scope === 'none' ? scope : 'none',
  };
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
 *     (in the since-deleted client classifier; `invoiceStamp` reads an absent
 *     or unrecognized `status` as "no stamp" without touching a method on it,
 *     so `status` no longer needs — or admits — a normalization default: ''
 *     is not a member of the stamped union, and inventing a member would be
 *     classification)
 *   - `test-kinfolk-001-invoice-1` has no `sessionIds` -> `.length` of undefined
 *
 * Normalize here, once, so no screen has to remember. Money fields are left
 * exactly as they arrive: coercing an absent `total` to 0 would invent a
 * financial fact the document never made.
 */
export function normalizeInvoice(row: InvoiceEntry): InvoiceEntry {
  return {
    ...row,
    client: row.client ?? '',
    kinfolkName: row.kinfolkName ?? '',
    invoiceNumber: row.invoiceNumber ?? '',
    date: row.date ?? '',
    dueDate: row.dueDate ?? '',
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
