import type {
  ListUnappliedPaymentsResultOpenInvoice,
  ListUnappliedPaymentsResultPayment,
  ResolveUnappliedPaymentResult,
} from '../contracts/invoiceContracts.generated';
import { MAX_CREDIT_REASON_LENGTH, formatCreditDate } from './accountCreditFormat';
import { parseDollarsToCents } from './invoiceMoneyInput';
import { formatCentsUsd } from './invoiceReconcile';

/**
 * #1003: the pure half of "Payments needing a decision" and its Decide dialog.
 * The same rules and wording ship on admin Android and the desktop console.
 *
 * A card payment the Stripe webhook could not apply to its invoice waits here
 * for the owner. There are no refunds (operator ruling 2026-08-06), so the
 * decision splits the payment three ways: account credit, applied to an open
 * invoice, or kept on the payment as recorded. All three may be zero.
 */

export const UNAPPLIED_SECTION_TITLE = 'Payments needing a decision';
export const UNAPPLIED_EMPTY_FROM_NOTICE = 'No card payments are waiting for a decision.';
export const UNAPPLIED_LOAD_FAILED = 'Could not load payments needing a decision.';
export const DECIDE_DIALOG_TITLE = 'Decide what this payment becomes';
export const NO_OPEN_INVOICES = 'No open invoices for this household.';

export const ERR_OVER_PAYMENT = 'The credit and the applied amount add up to more than this payment.';
export const ERR_REASON_REQUIRED = 'Enter a reason for the credit.';
export const ERR_CHOOSE_INVOICE = 'Choose an invoice for the applied amount.';
export const ERR_BAD_AMOUNT = 'Enter an amount in dollars, like 12.50.';
export const ERR_REASON_TOO_LONG = 'Keep the reason to 1,000 characters or fewer.';

export { MAX_CREDIT_REASON_LENGTH };

/** "INV-1042", or the invoice id when the number is missing. */
function invoiceLabel(p: ListUnappliedPaymentsResultPayment): string {
  return p.invoiceNumber.trim() || p.invoiceId;
}

/** Row line one: "$25.00 card payment on invoice INV-1042". */
export function unappliedPaymentTitle(p: ListUnappliedPaymentsResultPayment): string {
  return `${formatCentsUsd(p.amountCents)} card payment on invoice ${invoiceLabel(p)}`;
}

/** Row line two: "Sep 27, 2026. Not applied because the invoice was already marked paid." */
export function unappliedPaymentDetail(p: ListUnappliedPaymentsResultPayment): string {
  const reason = p.reason.trim().replace(/\.+$/, '');
  return `${formatCreditDate(p.receivedAtMs)}. Not applied because ${reason}.`;
}

/** The dialog's lead line. */
export function decideLeadLine(p: ListUnappliedPaymentsResultPayment): string {
  return `Card payment of ${formatCentsUsd(p.amountCents)} on invoice ${invoiceLabel(p)}. There are no refunds. Anything you do not credit or apply stays recorded on the payment.`;
}

/** A picker option: "INV-1050, $40.00 due". */
export function openInvoiceOptionLabel(inv: ListUnappliedPaymentsResultOpenInvoice): string {
  return `${inv.invoiceNumber.trim() || inv.invoiceId}, ${formatCentsUsd(inv.amountDueCents)} due`;
}

export interface DecisionFormInput {
  creditText: string;
  reasonText: string;
  /** '' for None. */
  applyInvoiceId: string;
  applyText: string;
}

export interface DecisionPayload {
  creditCents: number;
  creditReason: string;
  applyInvoiceId: string;
  applyCents: number;
}

export type DecisionForm =
  | { ok: true; payload: DecisionPayload; keptCents: number }
  | { ok: false; error: string };

/** An empty box means zero; anything else must be a plain dollar amount. */
function readCents(text: string): number | null {
  if (text.trim() === '') return 0;
  return parseDollarsToCents(text);
}

/**
 * The live summary: "Credit $10.00, apply $15.00, keep $0.00." Null while an
 * amount does not read, or when the two add up to more than the payment.
 */
export function decisionSummaryLine(
  payment: ListUnappliedPaymentsResultPayment,
  creditText: string,
  applyText: string,
): string | null {
  const credit = readCents(creditText);
  const apply = readCents(applyText);
  if (credit === null || apply === null) return null;
  const kept = payment.amountCents - credit - apply;
  if (kept < 0) return null;
  return `Credit ${formatCentsUsd(credit)}, apply ${formatCentsUsd(apply)}, keep ${formatCentsUsd(kept)}.`;
}

/**
 * Reads the dialog. Refuses before any call what the server would refuse, and
 * builds the request from the form fields only: the reason is sent only with a
 * credit, the invoice only with an applied amount.
 */
export function parseDecisionForm(
  payment: ListUnappliedPaymentsResultPayment,
  openInvoices: readonly ListUnappliedPaymentsResultOpenInvoice[],
  form: DecisionFormInput,
): DecisionForm {
  const creditCents = readCents(form.creditText);
  const applyCents = readCents(form.applyText);
  if (creditCents === null || applyCents === null) return { ok: false, error: ERR_BAD_AMOUNT };

  const invoiceId = form.applyInvoiceId.trim();
  if (applyCents > 0) {
    if (invoiceId === '') return { ok: false, error: ERR_CHOOSE_INVOICE };
    const inv = openInvoices.find((i) => i.invoiceId === invoiceId);
    if (!inv) return { ok: false, error: ERR_CHOOSE_INVOICE };
    if (applyCents > inv.amountDueCents) {
      return { ok: false, error: `That invoice owes only ${formatCentsUsd(inv.amountDueCents)}.` };
    }
  }
  if (creditCents + applyCents > payment.amountCents) return { ok: false, error: ERR_OVER_PAYMENT };

  const reason = form.reasonText.trim();
  if (creditCents > 0) {
    if (reason === '') return { ok: false, error: ERR_REASON_REQUIRED };
    if (reason.length > MAX_CREDIT_REASON_LENGTH) return { ok: false, error: ERR_REASON_TOO_LONG };
  }

  return {
    ok: true,
    payload: {
      creditCents,
      creditReason: creditCents > 0 ? reason : '',
      applyInvoiceId: applyCents > 0 ? invoiceId : '',
      applyCents,
    },
    keptCents: payment.amountCents - creditCents - applyCents,
  };
}

/**
 * The note after a save, from the server's response only:
 * "Decision saved. $10.00 to account credit (balance now $37.00). $15.00 on
 * invoice INV-1050 (paid in full). $0.00 kept on the payment."
 */
export function decisionSavedNote(res: ResolveUnappliedPaymentResult): string {
  const parts = ['Decision saved.'];
  if (res.creditedCents > 0) {
    parts.push(
      `${formatCentsUsd(res.creditedCents)} to account credit (balance now ${formatCentsUsd(res.newAccountBalanceCents)}).`,
    );
  }
  if (res.appliedCents > 0) {
    const state =
      res.appliedInvoiceState === 'settled'
        ? '(paid in full)'
        : `(${formatCentsUsd(res.appliedInvoiceAmountDueCents)} still due)`;
    const number = res.appliedInvoiceNumber.trim() || res.appliedInvoiceId;
    parts.push(`${formatCentsUsd(res.appliedCents)} on invoice ${number} ${state}.`);
  }
  parts.push(`${formatCentsUsd(res.keptCents)} kept on the payment.`);
  return parts.join(' ');
}
