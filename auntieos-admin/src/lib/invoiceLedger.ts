import type {
  GetInvoiceLedgerResultLedgerPayment,
  GetInvoiceLedgerResultPayment,
  GetInvoiceLedgerResultSession,
} from '../contracts/invoiceContracts.generated';

/**
 * The pure reading rules for `getInvoiceLedger`'s answer.
 *
 * Kept out of the panel so each one is testable on its own, same split as
 * `invoiceFormat.ts` and `invoiceReconcile.ts`. Nothing here classifies, derives
 * money, or repairs anything: every figure the panel shows arrives computed from
 * the server (ADR-0002), and these functions only decide how to SAY it.
 */

/**
 * The day a payment landed, from an ISO instant.
 *
 * The first ten characters, not a parsed and re-formatted date. `paidAt` is
 * written by `markInvoicePaid` as `new Date().toISOString()` and by the caller
 * as whatever ISO string it sent, so a slice is exact where a re-format would
 * shift the day across a timezone. Same rule Android's row uses.
 */
export function paymentDayLabel(paidAt: string | null): string {
  const day = (paidAt ?? '').slice(0, 10);
  return day === '' ? 'no date recorded' : day;
}

/**
 * How a payment describes itself in one line: its method, or the honest absence
 * of one.
 *
 * NOT "unknown" and not blank. `markInvoicePaid` stores `null` when the operator
 * left the method empty, which is a real and common state (a payment recorded in
 * a hurry is still a payment), and a row that renders as an empty cell reads as
 * a rendering bug rather than as a fact about the record.
 */
export function paymentMethodLabel(method: string | null): string {
  const trimmed = (method ?? '').trim();
  return trimmed === '' ? 'no method recorded' : trimmed;
}

/**
 * The day a visit happened.
 *
 * `completedAt` wins over `startTime` because it is when the work finished,
 * which is what an invoice bills for; `startTime` is the fallback, and a session
 * with neither is the `unplaceable` shape `listUninvoicedSessions` reports (an
 * empty `startTime` sorts before every real date, so no window can reach it).
 * Said plainly rather than shown as a blank.
 */
export function sessionDayLabel(
  session: Pick<GetInvoiceLedgerResultSession, 'completedAt' | 'startTime'>,
): string {
  const day = (session.completedAt ?? '').slice(0, 10) || session.startTime.slice(0, 10);
  return day === '' ? 'no date on the visit' : day;
}

/**
 * A stored session status as a human reads it: lowercased, underscores opened
 * out. `ON_MY_WAY` becomes `on my way`.
 *
 * Casing on `kin_care_sessions.status` is unenforced and every reader in this
 * repo normalizes at the point of use, so this normalizes for DISPLAY only. It
 * deliberately does not map spellings onto each other (`CANCELED` stays
 * `canceled`): folding them would be classification, and this panel reports what
 * the visit doc says.
 */
export function sessionStatusLabel(status: string): string {
  const trimmed = status.trim();
  return trimmed === '' ? 'no status' : trimmed.toLowerCase().replace(/_/g, ' ');
}

/** What a visit is called, or a neutral stand-in when the field is blank. */
export function sessionServiceLabel(serviceType: string): string {
  const trimmed = serviceType.trim();
  return trimmed === '' ? 'Visit' : trimmed;
}

/**
 * A payment row's amount including its gratuity. Integer cents, added once.
 *
 * KEPT, AND NO LONGER WHAT THE TABLE RENDERS. Read the note on
 * `ledgerRowAppliedCents` below for why: on the operator's real data `amount`
 * ALREADY CONTAINS the tip, so adding them counts the gratuity twice. This
 * function survives because `ledgerCoversBalance` has always used it and
 * changing what that banner fires on is a separate decision from fixing the
 * table, but nothing new should reach for it.
 */
export function ledgerRowTotalCents(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'amountCents' | 'tipCents'>,
): number {
  return row.amountCents + row.tipCents;
}
/**
 * ── THE OPERATOR'S PAYMENT HISTORY COLUMNS ────────────────────────────────
 *
 * Her production screen shows, per row:
 *
 *   Transaction Date | Method | Reference # | Amount | Applied to #n | Tip | Balance
 *
 * and this tranche adds Fee between Tip and Balance. Invoice #1029 is the row
 * that made all of it necessary:
 *
 *   Amount $137.50 | Applied $127.50 | Tip $7.29 | Balance $0.00
 *
 * Those four do not reconcile ($2.71 is missing) because the tip shown was
 * the NET one and the fee it was net of was dropped during the migration. With
 * the GROSS tip ($10.00) and the fee ($2.71) both stored, the row closes:
 *
 *   amount(137.50) = applied(127.50) + tipGross(10.00) + balance(0.00)
 *
 * `amount` INCLUDES the tip. That is the shape of the operator's real data and
 * it is why `ledgerRowTotalCents` above must not be what a row renders.
 */
/** The "Balance" column: what is left of the payment after the bill and the tip. */
export function ledgerRowBalanceCents(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'unappliedCents'>,
): number {
  return row.unappliedCents;
}
/** The "Applied to #n" cell: the invoice number, the id, or the honest absence. */
export function ledgerRowAppliedLabel(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'appliedInvoiceId' | 'appliedInvoiceNumber'>,
): string {
  if (row.appliedInvoiceNumber.trim() !== '') return `#${row.appliedInvoiceNumber.trim()}`;
  if (row.appliedInvoiceId.trim() !== '') return row.appliedInvoiceId.trim();
  return '';
}
/**
 * The caveat a row has to carry when its figures CANNOT be checked, or `''`
 * when they can.
 *
 * THIS IS THE WHOLE DEFECT, stated on screen. A migrated row carries a tip
 * whose convention nobody recorded and a fee that was thrown away, so
 * `amount = applied + tipGross + balance` is not a statement anyone can
 * evaluate about it. Printing the numbers anyway is what left the operator
 * staring at $2.71 she could not account for.
 *
 * NO BACK-COMPUTED GROSS. The gross tip cannot be recovered from a net tip
 * whose deduction is unknown, and a plausible guess here would put a number
 * that was never collected onto a tax return.
 */
export function ledgerRowCaveat(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'reconciles' | 'tipCents' | 'unappliedCents'>,
): string {
  if (!row.reconciles) {
    return 'This row was migrated without its processor fee, so whether the tip shown is before or after that fee was never recorded. It cannot be reconciled, and no gross tip has been guessed for it.';
  }
  // An over-application cannot be created any more, but a row already carrying
  // one must not render as though it balanced.
  if (row.unappliedCents < 0) {
    return 'More was applied to invoices than this payment covers, so this row does not balance.';
  }
  return '';
}

/**
 * The sessions whose own `invoiceId` does not point back at this invoice.
 *
 * Half a link. `linkInvoiceSessions` writes both directions in one transaction,
 * but Android's pre-ADR-0002 loop wrote them separately and logged-and-continued
 * on a failure, so this is a shape live data can carry. Surfaced, never fixed
 * here: which side is right decides which invoice a visit is billed on, and only
 * the operator knows.
 */
export function sessionsWithBrokenBacklink(
  sessions: readonly GetInvoiceLedgerResultSession[],
): GetInvoiceLedgerResultSession[] {
  return sessions.filter((s) => !s.linkedBack);
}

/**
 * Does the money the panel is about to show account for the whole balance?
 *
 * `paidCents` is the sum of the SUBCOLLECTION alone, because that is what
 * settles an invoice. A Stripe card payment lands only in the root ledger, so an
 * invoice can sit with a real outstanding balance beside a ledger row that
 * covers it. That is not a contradiction to resolve on the client; it is the
 * disagreement the panel has to name, so the operator does not either chase a
 * paid invoice or write off an unpaid one.
 */
export function ledgerCoversBalance(input: {
  amountDueCents: number;
  ledgerPayments: readonly Pick<GetInvoiceLedgerResultLedgerPayment, 'amountCents' | 'tipCents'>[];
}): boolean {
  if (input.amountDueCents <= 0) return false;
  if (input.ledgerPayments.length === 0) return false;
  const ledgerTotal = input.ledgerPayments.reduce((sum, r) => sum + ledgerRowTotalCents(r), 0);
  return ledgerTotal >= input.amountDueCents;
}

/** Sum of the subcollection rows, for the panel's own footer. */
export function paymentsTotalCents(
  payments: readonly Pick<GetInvoiceLedgerResultPayment, 'amountCents'>[],
): number {
  return payments.reduce((sum, p) => sum + p.amountCents, 0);
}
