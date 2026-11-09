/**
 * What an invoice's `date` and `dueDate` are allowed to hold, said once.
 *
 * WHY THIS EXISTS. Firestore orders strings by UTF-8 byte, and every letter
 * (0x41 and up) outranks every digit (0x30-0x39). So a stored `"Feb 12, 2026"`
 * satisfies `where('date', '>=', '2026-07-05')`: 'F' beats '2' on the first
 * character and the comparison is over before either year is read. The admin's
 * "Last 30 days" window is exactly that predicate, and it was returning
 * six-month-old invoices while looking, from the console, like it worked.
 *
 * `updateInvoice` has enforced `YYYY-MM-DD` on its patch since W2-1. Creation
 * did not: `date` was `z.string().default('')`, so a caller could put any text
 * at all into a field that two deployed composite indexes range-query and order
 * on (`invoices (kinfolkId ASC, date DESC)` and `(archivedAt ASC, date DESC)`).
 * This module closes that half, so the three writers now state ONE rule.
 *
 * THE SHAPE CHECK IS THE ORDERING PROPERTY, and that is deliberately all it is.
 * A zero-padded `YYYY-MM-DD` sorts lexically exactly as it sorts chronologically,
 * which is the whole reason a string range on this field is defensible. It is
 * NOT a calendar check: `2026-02-30` is refused by both composers before it can
 * be sent (`isValidInvoiceDate` on the web, `isValidNewInvoiceIsoDate` on
 * Android) and, were it ever stored, it would still sort where it claims to.
 * Matching `updateInvoice`'s existing expression character for character
 * matters more here than being marginally stricter than it. A create rule and
 * an edit rule that disagree is how a field ends up holding two vocabularies in
 * the first place.
 *
 * BLANK IS STILL A REAL VALUE. `date` defaults to `''` and every legacy caller
 * relies on that: a draft raised before anyone has decided what to bill has no
 * date, and inventing "today" for it would be a fabricated fact on a bill. A
 * blank simply falls outside every dated window, which the Invoices screen says
 * out loud rather than letting the row quietly vanish.
 */
import { z } from 'zod';

/**
 * A stored invoice day, or the empty string.
 *
 * Written as a `.regex()` on a plain `ZodString` rather than a `.refine()` on
 * purpose: the contracts codegen (ADR-0001 decision 2) reads zod internals, and
 * it understands `.default()` on a string while deliberately ignoring `.regex()`
 * as a server-only rule. A `ZodEffects` wrapper would change the emitted client
 * types; this does not change a byte of them.
 */
export const INVOICE_DAY_OR_BLANK = /^(?:\d{4}-\d{2}-\d{2})?$/;

/** The shared `date` / `dueDate` argument for the two invoice-creating callables. */
export const InvoiceDayArg = z
  .string()
  .regex(INVOICE_DAY_OR_BLANK, 'must be a YYYY-MM-DD day, or omitted')
  .default('');
/**
 * #1570: which day a STORED `date`/`dueDate` names, as `YYYY-MM-DD`, or null.
 *
 * The write side above has refused free text since W2-1, but documents loaded
 * from the old system arrive with it: the walk's `#1018` is OPEN with
 * `dueDate: "July 14, 2026"`, four months past due, and every reader skipped it
 * because it was not `YYYY-MM-DD`. The overdue notice never went and the admin's
 * Overdue tile read 0.
 *
 * Two forms are read, and only two, because both name exactly one day:
 *   - a value that STARTS with `YYYY-MM-DD` (a stored day, or an ISO instant),
 *     taken by its day prefix as every reader always has;
 *   - an English month name, full or three letters, a day, an optional comma
 *     and a four-digit year ("July 14, 2026", "Jul 14 2026"), checked against
 *     the calendar so "February 30, 2026" is refused rather than rolled.
 *
 * `07/14/2026` is refused: a numeric date is two different days depending on
 * who typed it. So is `Net 14`. Those stay unreadable, and the clients flag
 * them on the row instead of dropping them.
 *
 * The same grammar as `mytribe/scripts/backfillInvoiceDateIso.ts`, which
 * rewrites these documents in place; this lets every reader answer correctly
 * before that backfill runs. Mirrored, with the same fixtures, in the admin
 * web (`lib/invoiceFormat.ts#invoiceDayOrNull`), admin Android
 * (`domain/InvoiceActions.kt#invoiceDayOrNull`) and the desktop console
 * (`screens/invoices/InvoiceFilters.kt#invoiceDayOrNull`).
 */
const ISO_DAY_PREFIX = /^\d{4}-\d{2}-\d{2}/;
const MONTH_NAME_DAY = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/;
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;
function monthIndexOf(name: string): number {
  const n = name.toLowerCase();
  const exact = MONTHS.indexOf(n as (typeof MONTHS)[number]);
  if (exact >= 0) return exact;
  if (n.length !== 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(n));
}
export function invoiceDayOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (ISO_DAY_PREFIX.test(s)) return s.slice(0, 10);
  const named = MONTH_NAME_DAY.exec(s);
  if (named === null) return null;
  const year = Number(named[3]);
  const month = monthIndexOf(named[1] as string);
  const day = Number(named[2]);
  if (month < 0 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}
/** #1593: the refusal, word for word what the admin web, Android and desktop show beside the due date. */
export const DUE_BEFORE_INVOICE_DATE = 'The due date has to be on or after the invoice date.';
export const DUE_BEFORE_INVOICE_DATE_CODE = 'invoice_due_before_date';
/**
 * #1593: a due date the operator TYPED that falls before the invoice date. The
 * QA walk saved one. Only a typed date is checked (no `termsCode`, or
 * `custom`): structured terms work their own date out, and the server is the
 * authority on it. Both sides must read as days; a blank, or a stored free-text
 * date from the old system, is not this check's to judge.
 */
export function dueDateOrderProblem(date: unknown, dueDate: unknown, termsCode: unknown): string | null {
  if (typeof termsCode === 'string' && termsCode !== '' && termsCode !== 'custom') return null;
  const day = invoiceDayOf(date);
  const due = invoiceDayOf(dueDate);
  if (day === null || due === null) return null;
  return due < day ? DUE_BEFORE_INVOICE_DATE : null;
}
