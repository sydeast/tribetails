/**
 * The three questions the billing surface asks a `kin_care_sessions` document,
 * answered in one place.
 *
 * These predicates were private to `listUninvoicedSessions`, which was fine
 * while it was the only reader. `setSessionDoNotInvoice` now has to agree with
 * it exactly: a visit the callable is willing to exclude and a visit the list
 * shows must be the same set, or an operator marks a row that does not go away.
 * Two copies of a definition that has to match is how that stops being true.
 *
 * WHY EACH ONE IS DEFENSIVE. Nothing validates this collection on write. The
 * fields these read are produced by four different writers and by hand in the
 * console, so absence, casing and whitespace are all real, and every one of
 * them fails SILENTLY rather than loudly if it is read naively. The long form
 * of each hazard is on `listUninvoicedSessions`'s header; the short form is on
 * each function here.
 */

/**
 * True when this visit is done.
 *
 * `status` is a raw string with no validator, and the repo normalizes it at
 * every read site, so `completed`, `COMPLETED` and ` Completed ` are one state.
 */
export function isSessionCompleted(status: unknown): boolean {
  return typeof status === 'string' && status.trim().toUpperCase() === 'COMPLETED';
}

/**
 * True when no invoice has claimed this visit.
 *
 * Absent, null, empty and whitespace are ONE state: unclaimed. `createKinCareSession`
 * and `approveBookingSeriesCore` never write the field at all, while unlinking
 * writes `''`, so a naive equality on `''` silently misses most of the
 * collection.
 */
export function isSessionUnclaimed(invoiceId: unknown): boolean {
  if (invoiceId === undefined || invoiceId === null) return true;
  return typeof invoiceId === 'string' && invoiceId.trim() === '';
}

/** The inverse, named, so a caller does not have to read a negation as a claim. */
export function isSessionClaimed(invoiceId: unknown): boolean {
  return !isSessionUnclaimed(invoiceId);
}

/**
 * True when the operator has said this visit will never be billed.
 *
 * Strictly `true`, not truthiness: the field is cleared to `false` rather than
 * deleted (so "never excluded" and "excluded and put back" stay
 * distinguishable), and a stray string in it is not a decision anybody made.
 */
export function isSessionDoNotInvoice(data: Record<string, unknown>): boolean {
  return data['doNotInvoice'] === true;
}

/** The operator's note on an excluded visit, or '' when there is none. */
export function sessionDoNotInvoiceReason(data: Record<string, unknown>): string {
  const raw = data['doNotInvoiceReason'];
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * True when this visit is work that still needs billing: done, unclaimed, and
 * not deliberately excluded. The composer's whole queue is this predicate.
 */
export function isSessionBillable(data: Record<string, unknown>): boolean {
  return (
    isSessionCompleted(data['status']) &&
    isSessionUnclaimed(data['invoiceId']) &&
    !isSessionDoNotInvoice(data)
  );
}
