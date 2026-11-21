import type {
  GetInvoiceLedgerResultLedgerPayment,
  GetInvoiceLedgerResultPayment,
  GetInvoiceLedgerResultSession,
} from '../contracts/invoiceContracts.generated';
import { bookingServiceName, EMPTY_BOOKING_CATALOG, type BookingCatalog } from './bookingFormat';

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

/** The stored method word for a checkout payment. Never shown. */
const STORED_CHECKOUT_METHOD = 'stripe';

/** #2334: what a checkout payment with no stored method reads as, the server's own words. */
export const ONLINE_PAYMENT_LABEL = 'Online payment';

/**
 * How a payment describes itself in one line: its method, or the honest absence
 * of one.
 *
 * NOT "unknown" and not blank. `markInvoicePaid` stores `null` when the operator
 * left the method empty, which is a real and common state (a payment recorded in
 * a hurry is still a payment), and a row that renders as an empty cell reads as
 * a rendering bug rather than as a fact about the record.
 */
export function paymentMethodLabel(method: string | null, methodLabel?: string | null): string {
  // #2334: the server's plain words win (Card, Klarna, Affirm, "Online
  // payment"). A server older than the field sends none, and the stored word
  // for a checkout payment is never shown: it reads "Online payment".
  const label = (methodLabel ?? '').trim();
  if (label !== '') return label;
  const trimmed = (method ?? '').trim();
  if (trimmed.toLowerCase() === STORED_CHECKOUT_METHOD) return ONLINE_PAYMENT_LABEL;
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

/**
 * What a visit is called: the KinCare's name off the catalog, never the stored
 * `visit_60` (#1744), or a neutral stand-in when the field is blank.
 */
export function sessionServiceLabel(serviceType: string, catalog: BookingCatalog = EMPTY_BOOKING_CATALOG): string {
  return bookingServiceName(serviceType, catalog);
}

/**
 * A payment row's amount including its gratuity. Integer cents, added once.
 *
 * KEPT, AND NOTHING ON SCREEN USES IT. On the operator's real data `amount`
 * ALREADY CONTAINS the tip, so adding them counts the gratuity twice. The
 * table stopped rendering it first, and `ledgerCoversBalance` stopped summing
 * it in #2413 (it takes `ledgerRowTowardBillCents` now). It stays because
 * payment code is not deleted here, but nothing new should reach for it.
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
/**
 * The "Balance" column: what is left of the payment after the bill and the tip.
 *
 * IT MEANS NOTHING ON A ROW WHOSE `amountResolved` IS FALSE, and the caller is
 * what has to know that. The server derived it from an amount it could not
 * read, falling back to the schema's floor of 0, so what comes out is
 * arithmetic over a non-number rather than a leftover. Kept pure here and
 * guarded at the point of display in `InvoiceLedger.tsx`, the same split
 * Android's `PaymentRow` uses.
 */
export function ledgerRowBalanceCents(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'unappliedCents'>,
): number {
  return row.unappliedCents;
}
/**
 * #2417, #2420: how an invoice that has no number is named wherever its number
 * would stand. Never its stored id. The same words ship on admin Android and
 * the desktop console.
 */
export const INVOICE_WITH_NO_NUMBER = 'an invoice with no number';
/** The same, where it opens a line. */
export const INVOICE_WITH_NO_NUMBER_LEAD = 'Invoice with no number';
/**
 * The "Applied to #n" cell: the invoice number, the words for an invoice that
 * has none, or `''` when the payment touched no balance at all.
 */
export function ledgerRowAppliedLabel(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'appliedInvoiceId' | 'appliedInvoiceNumber'>,
): string {
  if (row.appliedInvoiceNumber.trim() !== '') return `#${row.appliedInvoiceNumber.trim()}`;
  if (row.appliedInvoiceId.trim() !== '') return INVOICE_WITH_NO_NUMBER;
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
 *
 * THE UNREADABLE AMOUNT IS TESTED FIRST, and it has to be. A row the server
 * could not read carries `reconciles: true` and a zero balance perfectly often,
 * so it fell through both branches below and produced no caveat at all. Order
 * also decides which sentence such a row gets, and "the fee was dropped" is the
 * wrong one: it invites the operator to trust the amount beside it, which is
 * the single figure on that row nobody can vouch for.
 */
export function ledgerRowCaveat(
  row: Pick<
    GetInvoiceLedgerResultLedgerPayment,
    'amountResolved' | 'reconciles' | 'tipCents' | 'unappliedCents'
  >,
): string {
  if (!row.amountResolved) {
    return 'The amount on this row could not be read: either no figure was ever resolved for the payment, or what was stored is not a usable number. Nothing is shown in its place, and the $0.00 that used to appear here was never a reading.';
  }
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
 *
 * #2413: WHAT A ROW CAN PUT TOWARD THE BILL IS ITS AMOUNT LESS ITS TIP. The
 * amount is gross and the tip is inside it, and a tip is never applied to a
 * bill (an overpayment is all tip). So a $100.00 payment carrying a $10.00 tip
 * covers $90.00 of an invoice, and against $100.00 owed it raises no warning.
 */
export function ledgerCoversBalance(input: {
  amountDueCents: number;
  ledgerPayments: readonly (Pick<GetInvoiceLedgerResultLedgerPayment, 'amountCents' | 'tipCents'> &
    Partial<Pick<GetInvoiceLedgerResultLedgerPayment, 'appliedCents'>>)[];
}): boolean {
  if (input.amountDueCents <= 0) return false;
  // #2467: only money no balance has seen. A row that applied money already
  // came off a balance (this invoice's, or the one it names), and what was left
  // of it was decided then: tip, or the credit the admin entered. Counting it
  // raised the warning on a properly recorded part payment ($60 of $100 left
  // $40 owed beside a $60 row). The ledger's `amountDueCents` already counts
  // what was paid before the invoice was brought over (#2486).
  const unseen = input.ledgerPayments.filter((r) => !ledgerRowCameOffABalance(r));
  if (unseen.length === 0) return false;
  const towardBill = unseen.reduce((sum, r) => sum + ledgerRowTowardBillCents(r), 0);
  return towardBill >= input.amountDueCents;
}
/**
 * #2467: did this history row already come off a balance? It did when it
 * applied money. Since #1971 the ledger names the invoice on every such row,
 * including the older two-step ones. A card payment written to the history
 * only applied nothing, and is exactly the row the warning is for.
 */
export function ledgerRowCameOffABalance(
  row: Partial<Pick<GetInvoiceLedgerResultLedgerPayment, 'appliedCents'>>,
): boolean {
  return typeof row.appliedCents === 'number' && row.appliedCents > 0;
}
/**
 * #2413: the part of a payment row that can go toward a bill: its gross amount
 * less the tip inside it, and never below zero.
 *
 * NOT THE ROW'S `appliedCents`, though the row carries one. That field is what
 * the payment DID settle, and it is zero on exactly the rows the warning above
 * exists for: a card payment written to the history without settling the
 * invoice stores no applied amount at all. Summing it would silence the
 * warning on every invoice it was written to catch.
 *
 * FLOORED PER ROW, not on the sum. A row whose stored tip is larger than its
 * amount puts nothing toward the bill; it must not take money away from the
 * rows beside it.
 */
export function ledgerRowTowardBillCents(
  row: Pick<GetInvoiceLedgerResultLedgerPayment, 'amountCents' | 'tipCents'>,
): number {
  return Math.max(0, row.amountCents - row.tipCents);
}

/**
 * #1568: IS THERE NO PAYMENT AT ALL TO SHOW? Only when BOTH sources are empty.
 *
 * The panel lists two collections: the `invoices/{id}/payments` settlement rows
 * and, beneath them, the root `payments` history. The empty sentence used to
 * read the first alone, so an invoice whose only payment is in the history (a
 * Stripe card payment, a migrated row) said "No payment has been recorded"
 * directly above a table listing one. Invoices #1018 and #1010 on the live
 * admin. A sentence that the same panel contradicts is worse than none.
 */
export function paymentsPanelIsEmpty(input: {
  payments: readonly unknown[];
  ledgerPayments: readonly unknown[];
  /** #2470: paid before the invoice was brought over. A payment, with no row. */
  broughtOverPaidCents?: number;
}): boolean {
  return input.payments.length === 0 && input.ledgerPayments.length === 0 && broughtOverCents(input) === 0;
}
/** #2470: the brought-over amount the ledger reports, or 0 on an older response. */
export function broughtOverCents(input: { broughtOverPaidCents?: number }): number {
  const v = input.broughtOverPaidCents;
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0;
}
/** #2470: the line the payments table shows for it. */
export const BROUGHT_OVER_LINE = 'Paid in the old system';
/**
 * Sum of the subcollection rows, for the panel's own footer. #2470: plus what
 * was paid before the invoice was brought over, when the caller passes it, so
 * the footer agrees with the ledger's `paidCents`.
 */
export function paymentsTotalCents(
  payments: readonly Pick<GetInvoiceLedgerResultPayment, 'amountCents'>[],
  broughtOverPaidCents = 0,
): number {
  return payments.reduce((sum, p) => sum + p.amountCents, 0) + broughtOverCents({ broughtOverPaidCents });
}
