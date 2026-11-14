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
 * A DATE ALREADY IN THE PAST IS RESOLVED, REPORTED, AND NEVER MOVED TO TODAY.
 * `resolveDueDate` returns the day plus `isPast`, and the surfaces say so out
 * loud (an invoice dated last week is due from last week, whenever it is sent).
 *
 * A BILL IS NEVER DUE BEFORE ITS OWN DATE (#1966 review, the #1593 and #1977
 * rule). Visit-relative terms can work out to a day before the invoice date:
 * "3 days before the first visit" on an invoice raised the day before that
 * visit, or "due on the last visit" on an invoice for work already done. Sent
 * as it stood, such an invoice is open with its due day already behind it,
 * and the overdue cron chases the household at its next daily scan, the day
 * the bill arrived. So the invoice date is the floor: the invoice is due on
 * receipt, `appliedCode` says `due_on_receipt` (the stored words match the
 * date), and `beforeInvoiceDate` tells the composer why. An invoice with no
 * date has no floor.
 *
 * VISIT-RELATIVE TERMS WITH NO VISITS ARE DUE ON RECEIPT (#1966, operator
 * ruling 2026-11-12). There is no visit to count from, so the rule that applies
 * is "due on receipt", and the resolution says so in `appliedCode`: the server
 * stores THAT code and its words on the invoice, never the visit rule beside a
 * date it did not produce.
 *
 * VISIT DAYS ARE BUSINESS DAYS (#1966). A visit's `startTime` is an instant
 * ("...Z"), and its UTC date is the next day for every evening visit in
 * Chicago. `serviceDayOf` reads an instant on the business's clock; a bare
 * local time is already that clock and keeps its own date. Day arithmetic
 * after that is on calendar days, so a DST change moves nothing.
 *
 * THE BUSINESS PICKS THE STARTING TERMS (#1966). `business_settings.
 * invoicePaymentTerms` is one of `PAYMENT_TERMS_SETTING_CODES`, absent reads
 * as `due_on_receipt`, and every new invoice starts from it. The invoice-date
 * `net_*` codes and `custom` stay in the table for invoices that carry them and
 * for the composer, and are not offered as the business's setting.
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
 * Every terms rule the product offers. Ordered as the operator reads them: the
 * business setting's options first, in the ruled order (#1966), then the
 * invoice-date counts, then the escape hatch.
 */
export const INVOICE_TERMS_CODES = [
  'due_on_receipt',
  'due_on_first_visit',
  'due_on_last_visit',
  'net_1_after_last_visit',
  'net_2_after_last_visit',
  'net_3_after_last_visit',
  'net_4_after_last_visit',
  'net_5_after_last_visit',
  'net_6_after_last_visit',
  'net_7_after_last_visit',
  'net_14_after_last_visit',
  'net_30_after_last_visit',
  'net_1_before_first_visit',
  'net_2_before_first_visit',
  'net_3_before_first_visit',
  'net_4_before_first_visit',
  'net_5_before_first_visit',
  'net_6_before_first_visit',
  'net_7_before_first_visit',
  'net_14_before_first_visit',
  'net_30_before_first_visit',
  'net_7',
  'net_14',
  'net_30',
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

/**
 * #1966: the options of Settings > Invoices > Payment terms, in the ruled
 * order: due on receipt, the first visit, the last visit, then 1 to 7, 14 and
 * 30 days after the last visit, then the same counts before the first visit.
 */
export const PAYMENT_TERMS_SETTING_CODES: readonly InvoiceTermsCode[] = INVOICE_TERMS_CODES.filter(
  (code) => code !== 'net_7' && code !== 'net_14' && code !== 'net_30' && code !== 'custom',
);

/** #1966: what every business starts on, and what an absent setting reads as. */
export const DEFAULT_PAYMENT_TERMS: InvoiceTermsCode = 'due_on_receipt';

/** The business's zone when none is given or the given one cannot be read (#1109). */
export const TERMS_FALLBACK_TIME_ZONE = 'America/Chicago';

/**
 * #1966: the stored `invoicePaymentTerms` setting as a code. Absent, blank or
 * not one of the setting's options reads as {@link DEFAULT_PAYMENT_TERMS}.
 */
export function paymentTermsSettingOf(raw: unknown): InvoiceTermsCode {
  const code = parseInvoiceTermsCode(raw);
  return code !== null && PAYMENT_TERMS_SETTING_CODES.includes(code) ? code : DEFAULT_PAYMENT_TERMS;
}

/**
 * What a terms code counts from: the invoice's own date, the LAST visit
 * (`service`), the FIRST visit, or nothing.
 */
export type InvoiceTermsBasis = 'invoice' | 'service' | 'first_visit' | 'none';

export interface InvoiceTermsDef {
  code: InvoiceTermsCode;
  /** Which day the count starts from, or `none` when the code decides nothing. */
  basis: InvoiceTermsBasis;
  /** Days added to the basis day. Zero means the basis day itself; negative is before it. */
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
  due_on_first_visit: {
    code: 'due_on_first_visit',
    basis: 'first_visit',
    days: 0,
    label: 'Due on the day of the first visit',
    words: 'Due on the day of the first visit',
  },
  due_on_last_visit: {
    code: 'due_on_last_visit',
    basis: 'service',
    days: 0,
    label: 'Due on the day of the last visit',
    words: 'Due on the day of the last visit',
  },
  net_1_after_last_visit: {
    code: 'net_1_after_last_visit',
    basis: 'service',
    days: 1,
    label: 'Due 1 day after the last visit',
    words: 'Due 1 day after the last visit',
  },
  net_2_after_last_visit: {
    code: 'net_2_after_last_visit',
    basis: 'service',
    days: 2,
    label: 'Due 2 days after the last visit',
    words: 'Due 2 days after the last visit',
  },
  net_3_after_last_visit: {
    code: 'net_3_after_last_visit',
    basis: 'service',
    days: 3,
    label: 'Due 3 days after the last visit',
    words: 'Due 3 days after the last visit',
  },
  net_4_after_last_visit: {
    code: 'net_4_after_last_visit',
    basis: 'service',
    days: 4,
    label: 'Due 4 days after the last visit',
    words: 'Due 4 days after the last visit',
  },
  net_5_after_last_visit: {
    code: 'net_5_after_last_visit',
    basis: 'service',
    days: 5,
    label: 'Due 5 days after the last visit',
    words: 'Due 5 days after the last visit',
  },
  net_6_after_last_visit: {
    code: 'net_6_after_last_visit',
    basis: 'service',
    days: 6,
    label: 'Due 6 days after the last visit',
    words: 'Due 6 days after the last visit',
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
  net_30_after_last_visit: {
    code: 'net_30_after_last_visit',
    basis: 'service',
    days: 30,
    label: 'Due 30 days after the last visit',
    words: 'Due 30 days after the last visit',
  },
  net_1_before_first_visit: {
    code: 'net_1_before_first_visit',
    basis: 'first_visit',
    days: -1,
    label: 'Due 1 day before the first visit',
    words: 'Due 1 day before the first visit',
  },
  net_2_before_first_visit: {
    code: 'net_2_before_first_visit',
    basis: 'first_visit',
    days: -2,
    label: 'Due 2 days before the first visit',
    words: 'Due 2 days before the first visit',
  },
  net_3_before_first_visit: {
    code: 'net_3_before_first_visit',
    basis: 'first_visit',
    days: -3,
    label: 'Due 3 days before the first visit',
    words: 'Due 3 days before the first visit',
  },
  net_4_before_first_visit: {
    code: 'net_4_before_first_visit',
    basis: 'first_visit',
    days: -4,
    label: 'Due 4 days before the first visit',
    words: 'Due 4 days before the first visit',
  },
  net_5_before_first_visit: {
    code: 'net_5_before_first_visit',
    basis: 'first_visit',
    days: -5,
    label: 'Due 5 days before the first visit',
    words: 'Due 5 days before the first visit',
  },
  net_6_before_first_visit: {
    code: 'net_6_before_first_visit',
    basis: 'first_visit',
    days: -6,
    label: 'Due 6 days before the first visit',
    words: 'Due 6 days before the first visit',
  },
  net_7_before_first_visit: {
    code: 'net_7_before_first_visit',
    basis: 'first_visit',
    days: -7,
    label: 'Due 7 days before the first visit',
    words: 'Due 7 days before the first visit',
  },
  net_14_before_first_visit: {
    code: 'net_14_before_first_visit',
    basis: 'first_visit',
    days: -14,
    label: 'Due 14 days before the first visit',
    words: 'Due 14 days before the first visit',
  },
  net_30_before_first_visit: {
    code: 'net_30_before_first_visit',
    basis: 'first_visit',
    days: -30,
    label: 'Due 30 days before the first visit',
    words: 'Due 30 days before the first visit',
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

/** A bare local date-time: no `Z`, no offset. It is already the business's wall clock. */
const BARE_LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
/** An instant: a date-time ending in `Z` or a UTC offset. */
const ZONED_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

/** The calendar day an instant falls on in `timeZone`, or null when the zone cannot be read. */
function dayInZone(ms: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(ms));
    const pick = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
    const day = `${pick('year')}-${pick('month')}-${pick('day')}`;
    return isCalendarDay(day) ? day : null;
  } catch {
    return null;
  }
}

/**
 * #1966: the BUSINESS day a visit's `startTime` falls on, or null when it
 * cannot be read.
 *
 *   - a bare day (`2026-11-30`) is that day;
 *   - a bare local time (`2026-11-30T19:00`) is the business's wall clock
 *     already, so its own date is the day;
 *   - an instant (`2026-12-01T01:00:00.000Z`, `...-06:00`) is read on the
 *     business's clock in `timeZone`, falling back to America/Chicago when the
 *     zone cannot be read. That instant is Nov 30 in Chicago.
 */
export function serviceDayOf(raw: string, timeZone: string = TERMS_FALLBACK_TIME_ZONE): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (isCalendarDay(s)) return s;
  const bare = BARE_LOCAL_TIME.exec(s);
  if (bare) return isCalendarDay(bare[1]!) ? bare[1]! : null;
  if (!ZONED_INSTANT.test(s)) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  return dayInZone(ms, timeZone) ?? dayInZone(ms, TERMS_FALLBACK_TIME_ZONE);
}

/** Every readable visit day, on the business's clock. Unreadable entries are skipped. */
function serviceDaysOf(serviceDates: readonly string[], timeZone: string): string[] {
  const days: string[] = [];
  for (const raw of serviceDates) {
    const day = serviceDayOf(raw, timeZone);
    if (day !== null) days.push(day);
  }
  return days;
}

/**
 * The LAST day work was done, out of whatever dates the caller has.
 *
 * Accepts full ISO timestamps as well as bare days, read as business days by
 * {@link serviceDayOf}. Unreadable entries are skipped rather than sorted as
 * text: '' would otherwise win a max() against nothing and lose one against
 * everything, silently, in a function that decides when money is owed.
 */
export function lastServiceDay(
  serviceDates: readonly string[],
  timeZone: string = TERMS_FALLBACK_TIME_ZONE,
): string | null {
  let latest: string | null = null;
  for (const day of serviceDaysOf(serviceDates, timeZone)) {
    if (latest === null || day > latest) latest = day;
  }
  return latest;
}

/** #1966: the FIRST day work was done, by the same reading as {@link lastServiceDay}. */
export function firstServiceDay(
  serviceDates: readonly string[],
  timeZone: string = TERMS_FALLBACK_TIME_ZONE,
): string | null {
  let earliest: string | null = null;
  for (const day of serviceDaysOf(serviceDates, timeZone)) {
    if (earliest === null || day < earliest) earliest = day;
  }
  return earliest;
}

export interface InvoiceTermsInput {
  code: InvoiceTermsCode;
  /**
   * The invoice's own date, `YYYY-MM-DD`, or blank on an invoice that has none.
   * Read by invoice-relative codes, and by visit-relative ones on an invoice
   * with no visits (due on receipt).
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
   * The rule that produced `dueDate`: the code asked for, or `due_on_receipt`
   * when a visit-relative code found no visits to count from (#1966).
   */
  appliedCode: InvoiceTermsCode;
  /**
   * True when the terms worked out to a day before the invoice date, so the
   * invoice is due on receipt instead (#1966 review). `appliedCode` is then
   * `due_on_receipt` and `basisDay` the invoice date.
   */
  beforeInvoiceDate: boolean;
  /**
   * Why there is no date, as operator-facing text, or null when there is one.
   * Names what is missing and what to do, never a bare "invalid".
   */
  problem: string | null;
}

/**
 * The due date these terms mean, given the work on the invoice and today.
 *
 * `(terms, serviceDates, now, timeZone) => dueDate`, the resolver the composer
 * and the settings screen both call, and the one the server re-runs before it
 * writes. `timeZone` is the business's (`business_settings.timeZone`).
 */
export function resolveDueDate(
  terms: InvoiceTermsInput,
  serviceDates: readonly string[],
  now: string,
  timeZone: string = TERMS_FALLBACK_TIME_ZONE,
): DueDateResolution {
  const def = DEFS[terms.code];

  if (def.basis === 'none') {
    return {
      dueDate: null,
      isPast: false,
      basisDay: null,
      appliedCode: def.code,
      beforeInvoiceDate: false,
      problem: 'These terms let you pick the due date, so there is nothing to work out. Choose the date yourself.',
    };
  }

  const visitDay =
    def.basis === 'service'
      ? lastServiceDay(serviceDates, timeZone)
      : def.basis === 'first_visit'
        ? firstServiceDay(serviceDates, timeZone)
        : null;
  // A visit-relative code with no visits to count from is due on receipt.
  const applied: InvoiceTermsDef = def.basis !== 'invoice' && visitDay === null ? DEFS.due_on_receipt : def;
  const invoiceDay = isCalendarDay(terms.invoiceDate.trim()) ? terms.invoiceDate.trim() : null;
  const basisDay = applied.basis === 'invoice' ? invoiceDay : visitDay;

  if (basisDay === null) {
    return {
      dueDate: null,
      isPast: false,
      basisDay: null,
      appliedCode: applied.code,
      beforeInvoiceDate: false,
      problem:
        'These terms count from the invoice date, and this invoice has no date on it yet. Set the date, or pick the date yourself.',
    };
  }

  const counted = addDays(basisDay, applied.days);
  // #1966 review: a bill is never due before its own date. Visit-relative
  // terms that land there make the invoice due on receipt (see the header).
  if (applied.basis !== 'invoice' && invoiceDay !== null && counted < invoiceDay) {
    return {
      dueDate: invoiceDay,
      isPast: isCalendarDay(now) && invoiceDay < now,
      basisDay: invoiceDay,
      appliedCode: 'due_on_receipt',
      beforeInvoiceDate: true,
      problem: null,
    };
  }
  return {
    dueDate: counted,
    // Strictly before: due today is due, not overdue.
    isPast: isCalendarDay(now) && counted < now,
    basisDay,
    appliedCode: applied.code,
    beforeInvoiceDate: false,
    problem: null,
  };
}
