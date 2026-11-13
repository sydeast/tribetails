import { parseDollarsToCents } from './invoiceMoneyInput';
import { formatCentsUsd } from './invoiceReconcile';

/**
 * #1872 (operator ruling 2026-11-11): account credit goes onto an invoice only
 * as an amount the admin enters. The words and the checks for that one box,
 * kept pure so they are tested without a screen. The server makes every check
 * again (`mytribe/functions/src/admin/applyAccountCredit.ts`); these exist so
 * she hears the refusal beside the field before the round trip.
 */

export type ApplyCreditForm = { ok: true; amountCents: number } | { ok: false; error: string };

/** Reads the amount box against what the household holds and what the invoice owes. */
export function parseApplyCreditAmount(
  amountText: string,
  limits: { availableCents: number; dueCents: number | null },
): ApplyCreditForm {
  const cents = parseDollarsToCents(amountText);
  if (cents === null) return { ok: false, error: 'Enter an amount in dollars, like 25.00.' };
  if (cents <= 0) return { ok: false, error: 'Enter an amount above $0.00.' };
  if (cents > limits.availableCents) {
    return {
      ok: false,
      error: `This household has ${formatCentsUsd(limits.availableCents)} of account credit. Enter that much or less.`,
    };
  }
  if (limits.dueCents !== null && cents > limits.dueCents) {
    return {
      ok: false,
      error: `This invoice has ${formatCentsUsd(limits.dueCents)} left to pay. Enter that much or less.`,
    };
  }
  return { ok: true, amountCents: cents };
}

/** "invoice 1026", or "this invoice" when it has no number. Never a stored id. */
export function invoiceWords(invoiceNumber: string | null | undefined): string {
  const n = (invoiceNumber ?? '').trim();
  return n === '' ? 'this invoice' : `invoice ${n}`;
}

/** The confirmation: the amount, the invoice, and what both balances become. */
export function applyCreditConfirmLine(input: {
  amountCents: number;
  invoiceNumber: string | null | undefined;
  availableCents: number;
  dueCents: number | null;
}): string {
  const lead = `Apply ${formatCentsUsd(input.amountCents)} of account credit to ${invoiceWords(input.invoiceNumber)}?`;
  const credit = `The household keeps ${formatCentsUsd(input.availableCents - input.amountCents)} of credit.`;
  if (input.dueCents === null) return `${lead} ${credit}`;
  const left = input.dueCents - input.amountCents;
  const invoice = left === 0 ? 'The invoice will be paid.' : `The invoice will have ${formatCentsUsd(left)} left to pay.`;
  return `${lead} ${invoice} ${credit}`;
}

/** After the save, from the server's own figures only. */
export function creditAppliedNotice(input: {
  appliedCents: number;
  amountDueCents: number;
  accountBalanceCents: number;
  invoiceNumber: string | null | undefined;
}): string {
  const lead = `Applied ${formatCentsUsd(input.appliedCents)} of account credit to ${invoiceWords(input.invoiceNumber)}.`;
  const invoice =
    input.amountDueCents === 0
      ? 'The invoice is paid.'
      : `${formatCentsUsd(input.amountDueCents)} is left to pay.`;
  return `${lead} ${invoice} The household has ${formatCentsUsd(input.accountBalanceCents)} of credit left.`;
}

/** The line above the box: what the household holds. */
export function availableCreditLine(availableCents: number): string {
  return availableCents > 0
    ? `${formatCentsUsd(availableCents)} available`
    : 'This household has no account credit.';
}
