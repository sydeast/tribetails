import { type CollectionSpec } from '../lib/firestore';
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
