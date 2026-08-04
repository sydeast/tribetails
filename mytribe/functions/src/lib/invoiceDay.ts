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
