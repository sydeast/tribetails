/**
 * #1593: a typed due date that falls before the invoice date.
 *
 * The rule is the server's (`dueDateOrderProblem` in
 * `mytribe/functions/src/lib/invoiceDay.ts`), checked here so the operator sees
 * it beside the due date field while typing instead of after a refused save.
 * The server checks again, and its refusal carries this same sentence.
 *
 * Only a TYPED due date is judged: no terms code, or `custom`. Structured terms
 * work their own date out and the server is the authority on it. Both sides
 * must read as YYYY-MM-DD days; a blank, or an old free-text date, is not this
 * check's to judge.
 */
export const DUE_BEFORE_INVOICE_DATE = 'The due date has to be on or after the invoice date.';

const ISO_DAY_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function dayOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return ISO_DAY_PREFIX.test(s) ? s.slice(0, 10) : null;
}

export function dueDateOrderProblem(
  date: string | null | undefined,
  dueDate: string | null | undefined,
  termsCode: string | null | undefined,
): string | null {
  if (typeof termsCode === 'string' && termsCode !== '' && termsCode !== 'custom') return null;
  const day = dayOf(date);
  const due = dayOf(dueDate);
  if (day === null || due === null) return null;
  return due < day ? DUE_BEFORE_INVOICE_DATE : null;
}
