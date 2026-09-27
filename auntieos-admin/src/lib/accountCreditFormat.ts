import type {
  GetAccountCreditHistoryResultCredit,
  GetAccountCreditHistoryResultUse,
} from '../contracts/invoiceContracts.generated';
import { parseDollarsToCents } from './invoiceMoneyInput';
import { formatCentsUsd } from './invoiceReconcile';

/**
 * Q6: the pure half of the household "Give credit" dialog and the credit
 * history list. The same rules and wording ship on Android and the desktop
 * console.
 */

/** The server's cap, `MAX_GIVEN_CREDIT_CENTS` in `lib/creditLedger.ts`: $5,000.00. */
export const MAX_GIVEN_CREDIT_CENTS = 500_000;
/** The server's longest reason. */
export const MAX_CREDIT_REASON_LENGTH = 1000;

export type GiveCreditForm =
  | { ok: true; amountCents: number; reason: string }
  | { ok: false; error: string };

/** Reads the two boxes. Refuses before any call what the server would refuse. */
export function parseGiveCreditForm(amountText: string, reasonText: string): GiveCreditForm {
  const cents = parseDollarsToCents(amountText);
  if (cents === null) return { ok: false, error: 'Enter an amount in dollars, like 25.00.' };
  if (cents <= 0) return { ok: false, error: 'Enter an amount above $0.00.' };
  if (cents > MAX_GIVEN_CREDIT_CENTS) {
    return { ok: false, error: 'The most one credit can be is $5,000.00.' };
  }
  const reason = reasonText.trim();
  if (reason === '') return { ok: false, error: 'Enter a reason. The household sees it.' };
  if (reason.length > MAX_CREDIT_REASON_LENGTH) {
    return { ok: false, error: 'Keep the reason to 1,000 characters or fewer.' };
  }
  return { ok: true, amountCents: cents, reason };
}

/** "Sep 27, 2026", local time. */
export function formatCreditDate(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The confirmation line: what she is about to do, and what it does to the balance. */
export function giveCreditConfirmLine(amountCents: number, balanceCents: number): string {
  return `Give ${formatCentsUsd(amountCents)} credit? Balance goes from ${formatCentsUsd(balanceCents)} to ${formatCentsUsd(balanceCents + amountCents)}.`;
}

/** After the save, from the server's own figure only. */
export function creditGivenNotice(newBalanceCents: number): string {
  return `Credit given. Balance is now ${formatCentsUsd(newBalanceCents)}.`;
}

/** "Applied Oct 3, 2026", "$10.00 of $25.00 applied", or "Not used yet". */
export function creditStatusLine(credit: GetAccountCreditHistoryResultCredit): string {
  if (credit.fullyAppliedAtMs !== null) return `Applied ${formatCreditDate(credit.fullyAppliedAtMs)}`;
  const used = credit.amountCents - credit.remainingCents;
  if (used > 0) return `${formatCentsUsd(used)} of ${formatCentsUsd(credit.amountCents)} applied`;
  return 'Not used yet';
}

/** One line per partial use: "$10.00 on INV-1009, Oct 1, 2026". Empty once fully applied. */
export function creditApplicationLines(credit: GetAccountCreditHistoryResultCredit): string[] {
  if (credit.fullyAppliedAtMs !== null && credit.applications.length <= 1) return [];
  return credit.applications.map(
    (a) => `${formatCentsUsd(a.amountCents)} on ${a.invoiceNumber ?? 'an invoice'}, ${formatCreditDate(a.appliedAtMs)}`,
  );
}

/** "$25.00 on INV-1009, Oct 3, 2026". */
export function creditUseLine(use: GetAccountCreditHistoryResultUse): string {
  return `${formatCentsUsd(use.amountCents)} on ${use.invoiceNumber ?? 'an invoice'}, ${formatCreditDate(use.usedAtMs)}`;
}
