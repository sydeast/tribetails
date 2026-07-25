/**
 * The shared reading of `archivedAt`, used by both archiveInvoice and
 * unarchiveInvoice so the two can never disagree about what "archived" means.
 *
 * WHY PRESENCE, NOT TRUTHINESS, AND WHY THIS IS NOT A FIRESTORE PREDICATE.
 *
 * Every invoice that exists today lacks this field entirely: nothing wrote it
 * before Task 5.1. Firestore's `== null` matches ONLY documents that HAVE the
 * field set to null, so `where('archivedAt', '==', null)` would return zero
 * invoices, and it would do it silently rather than erroring. This task starts
 * writing the field, which does NOT retroactively give it to the invoices
 * already in the collection.
 *
 * So the admin list keeps excluding archived rows with a presence check over the
 * rows it has already loaded (`auntieos-admin/src/api/invoices.ts#isArchivedInvoice`),
 * and the deployed `invoices (archivedAt ASC, date DESC)` index stays unused for
 * that purpose. Converting the exclusion to a server-side predicate needs a
 * backfill stamping `archivedAt: null` onto every legacy invoice FIRST. That is
 * a migration, and it is deliberately not part of this task.
 *
 * `unarchiveInvoice` writes `archivedAt: null` rather than deleting the field,
 * for two reasons: a restored invoice then carries the same shape a backfill
 * would give it, and the admin's reader already treats null as "not archived".
 */

export interface ArchivableInvoice {
  kinfolkId?: string;
  invoiceNumber?: string;
  status?: unknown;
  amountDue?: unknown;
  amountDueCents?: unknown;
  total?: unknown;
  archivedAt?: unknown;
  [k: string]: unknown;
}

/** Archived iff `archivedAt` is present AND not null. */
export function isArchived(doc: ArchivableInvoice): boolean {
  return doc.archivedAt !== undefined && doc.archivedAt !== null;
}

/**
 * What is still owed, in DOLLARS.
 *
 * Prefers `amountDueCents` when the invoice has been itemized (it is the exact
 * figure), and falls back to the legacy dollar scalar otherwise. A non-finite or
 * absent value reads as 0, which means "no evidence of a debt" rather than a
 * fabricated one: refusing to archive on the strength of a number we could not
 * read would block the operator over a field that is not there.
 */
export function amountStillOwed(doc: ArchivableInvoice): number {
  if (typeof doc.amountDueCents === 'number' && Number.isFinite(doc.amountDueCents)) {
    return doc.amountDueCents / 100;
  }
  if (typeof doc.amountDue === 'number' && Number.isFinite(doc.amountDue)) {
    return doc.amountDue;
  }
  return 0;
}

/** "$40.00" from a dollar amount, for the refusal message. */
export function formatOwed(dollars: number): string {
  return `$${Math.abs(dollars).toFixed(2)}`;
}
