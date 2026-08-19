/**
 * Payment terms as a VALUE, and the one place a due date is worked out from
 * them.
 *
 * WHY THIS EXISTS. `terms` was free text on every invoice writer, and a free
 * text terms field cannot decide anything: "Net 14" is a sentence, not a rule,
 * so the due date beside it had to be typed by hand, and nothing could tell
 * whether the two agreed. The two are now one decision taken once: the operator
 * picks a TERMS CODE, and this module resolves the day that code means.
 *
 * THE RESOLVER IS PURE AND TAKES ITS `now`. It reads no clock and touches no
 * document, so the same three inputs always give the same day, in a test and in
 * production, in whatever timezone either happens to run in. Every date here is
 * a `YYYY-MM-DD` calendar day, never a timestamp: an invoice is due ON A DAY,
 * and a day plus a timezone is how "due the 14th" becomes "overdue since the
 * 13th" for a household one zone west.
 *
 * A DATE ALREADY IN THE PAST IS RESOLVED, REPORTED, AND NEVER MOVED. Terms
 * counted from the last visit routinely land behind today: work finished three
 * weeks ago on 14-day terms was due a week ago, and that is a true fact about
 * the money. Quietly bumping it to today would forgive a debt the household
 * already owes and would make the invoice disagree with its own stated rule.
 * `resolveDueDate` returns the real day plus `isPast`, and the surfaces say so
 * out loud.
 *
 * SERVICE-RELATIVE TERMS WITH NO VISITS RESOLVE TO NOTHING, deliberately. There
 * is no last visit to count from, so there is no date to state, and the honest
 * answer is a null plus a sentence naming what is missing. The alternative,
 * silently falling back to the invoice date, would print a due date derived
 * from a rule that was never applied.
 *
 * MIRRORED, NOT SHARED. `auntieos-admin/src/lib/invoiceTerms.ts` is a full copy
 * (there is no shared build between the two trees, same situation as
 * `invoiceMath.ts`), so the composer can show the resolved due date while the
 * operator is still choosing. The server resolves again on write and REFUSES a
 * due date that disagrees, so the copy is a preview, never an authority.
 * `invoiceTerms.parity.test.ts` in the admin tree pins the two export sets
 * together and both trees run the same fixture table.
 */
import { z } from 'zod';

/**
 * Every terms rule the product offers. Ordered as the operator reads them:
 * invoice-relative first (the common case), then visit-relative, then the
 * escape hatch.
 */
export const INVOICE_TERMS_CODES = [
  'due_on_receipt',
  'net_7',
  'net_14',
  'net_30',
  'due_on_last_visit',
  'net_7_after_last_visit',
  'net_14_after_last_visit',
  'custom',
] as const;

export type InvoiceTermsCode = (typeof INVOICE_TERMS_CODES)[number];

/**
 * The terms argument shared by the invoice-creating callables.
 *
 * A plain `z.enum`, so the contracts codegen (ADR-0001 decision 2) can project
 * it into all three clients as a closed set rather than as a bare string.
 */
export const InvoiceTermsCodeArg = z.enum(INVOICE_TERMS_CODES);

/** What a terms code counts from. */
export type InvoiceTermsBasis = 'invoice' | 'service' | 'none';

export interface InvoiceTermsDef {
  code: InvoiceTermsCode;
  /** Which day the count starts from, or `none` when the code decides nothing. */
  basis: InvoiceTermsBasis;
  /** Days added to the basis day. Zero means the basis day itself. */
  days: number;
  /** How the operator picks it, in the composer's select. */
  label: string;
  /**
   * How the household reads it on the invoice, as a sentence.
   *
   * Stated in words BESIDE the due date, never instead of it, so a household
   * sees the rule and its output and can check one against the other.
   */
  words: string;
}

const DEFS: Readonly<Record<InvoiceTermsCode, InvoiceTermsDef>> = {
  due_on_receipt: {
    code: 'due_on_receipt',
    basis: 'invoice',
    days: 0,
    label: 'Due on receipt',
    words: 'Due on receipt',
  },
  net_7: {
    code: 'net_7',
    basis: 'invoice',
    days: 7,
    label: 'Due 7 days after the invoice date',
    words: 'Due 7 days after the invoice date',
  },
  net_14: {
    code: 'net_14',
    basis: 'invoice',
    days: 14,
    label: 'Due 14 days after the invoice date',
    words: 'Due 14 days after the invoice date',
  },
  net_30: {
    code: 'net_30',
    basis: 'invoice',
    days: 30,
    label: 'Due 30 days after the invoice date',
    words: 'Due 30 days after the invoice date',
  },
  due_on_last_visit: {
    code: 'due_on_last_visit',
    basis: 'service',
    days: 0,
    label: 'Due on the day of the last visit',
    words: 'Due on the day of the last visit',
  },
  net_7_after_last_visit: {
    code: 'net_7_after_last_visit',
    basis: 'service',
    days: 7,
    label: 'Due 7 days after the last visit',
    words: 'Due 7 days after the last visit',
  },
  net_14_after_last_visit: {
    code: 'net_14_after_last_visit',
    basis: 'service',
    days: 14,
    label: 'Due 14 days after the last visit',
    words: 'Due 14 days after the last visit',
  },
  custom: {
    code: 'custom',
    basis: 'none',
    days: 0,
    label: 'A date I pick myself',
    words: 'Due by the date shown on this invoice',
  },
};

/** The rule behind one code. */
export function invoiceTermsDef(code: InvoiceTermsCode): InvoiceTermsDef {
  return DEFS[code];
}

/** Every rule, in the order the composer offers them. */
export function invoiceTermsDefs(): readonly InvoiceTermsDef[] {
  return INVOICE_TERMS_CODES.map((code) => DEFS[code]);
}

/**
 * The sentence the household reads. Empty string for a value that is not one of
 * ours, so a caller never writes the literal "undefined" onto a bill.
 */
export function invoiceTermsWords(code: InvoiceTermsCode): string {
  return DEFS[code].words;
}

/**
 * A stored or transported value read back as a code, or null.
 *
 * Null rather than a default: an invoice carrying legacy free-text terms has no
 * code, and inventing one would claim a rule nobody chose.
 */
export function parseInvoiceTermsCode(value: unknown): InvoiceTermsCode | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return (INVOICE_TERMS_CODES as readonly string[]).includes(trimmed)
    ? (trimmed as InvoiceTermsCode)
    : null;
}

/** A `YYYY-MM-DD` that is also a real calendar day (so 2026-02-30 is not one). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Round-trip check: Date rolls 2026-02-30 forward to 2026-03-02 rather than
  // refusing it, so the only way to catch an impossible day is to ask what the
  // date it produced actually is.
  return parsed.toISOString().slice(0, 10) === value;
}

/** `day` plus `days` calendar days, as `YYYY-MM-DD`. UTC arithmetic, no zone drift. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * The LAST day work was done, out of whatever dates the caller has.
 *
 * Accepts full ISO timestamps as well as bare days, because a visit's
 * `startTime` is an ISO-8601 string and truncating it here means no caller has
 * to remember to. Unreadable entries are skipped rather than sorted as text:
 * '' would otherwise win a max() against nothing and lose one against
 * everything, silently, in a function that decides when money is owed.
 */
export function lastServiceDay(serviceDates: readonly string[]): string | null {
  let latest: string | null = null;
  for (const raw of serviceDates) {
    if (typeof raw !== 'string') continue;
    const day = raw.trim().slice(0, 10);
    if (!isCalendarDay(day)) continue;
    if (latest === null || day > latest) latest = day;
  }
  return latest;
}

export interface InvoiceTermsInput {
  code: InvoiceTermsCode;
  /**
   * The invoice's own date, `YYYY-MM-DD`, or blank on an invoice that has none.
   * Only read by invoice-relative codes.
   */
  invoiceDate: string;
}

export interface DueDateResolution {
  /** The day this invoice is due, or null when the terms cannot decide one. */
  dueDate: string | null;
  /** True when `dueDate` is strictly before `now`. Never causes a shift; see the header. */
  isPast: boolean;
  /** Which day the count ran from, or null when nothing was counted. */
  basisDay: string | null;
  /**
   * Why there is no date, as operator-facing text, or null when there is one.
   * Names what is missing and what to do, never a bare "invalid".
   */
  problem: string | null;
}

/**
 * The due date these terms mean, given the work on the invoice and today.
 *
 * `(terms, serviceDates, now) => dueDate`, the resolver the composer and the
 * settings screen both call, and the one the server re-runs before it writes.
 */
export function resolveDueDate(
  terms: InvoiceTermsInput,
  serviceDates: readonly string[],
  now: string,
): DueDateResolution {
  const def = DEFS[terms.code];

  if (def.basis === 'none') {
    return {
      dueDate: null,
      isPast: false,
      basisDay: null,
      problem: 'These terms let you pick the due date, so there is nothing to work out. Choose the date yourself.',
    };
  }

  const basisDay =
    def.basis === 'invoice'
      ? isCalendarDay(terms.invoiceDate.trim())
        ? terms.invoiceDate.trim()
        : null
      : lastServiceDay(serviceDates);

  if (basisDay === null) {
    return {
      dueDate: null,
      isPast: false,
      basisDay: null,
      problem:
        def.basis === 'invoice'
          ? 'These terms count from the invoice date, and this invoice has no date on it yet. Set the date, or pick the date yourself.'
          : 'These terms count from the last visit, and there are no visits on this invoice yet. Add the visits it covers, or pick the date yourself.',
    };
  }

  const dueDate = addDays(basisDay, def.days);
  return {
    dueDate,
    // Strictly before: due today is due, not overdue.
    isPast: isCalendarDay(now) && dueDate < now,
    basisDay,
    problem: null,
  };
}
