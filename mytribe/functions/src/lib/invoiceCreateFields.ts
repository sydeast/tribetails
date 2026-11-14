/**
 * The fields a new invoice does NOT have to be told (#408), worked out once for
 * both invoice-creating callables.
 *
 * `createInvoice` and `createQuote` are deliberately near-identical handlers,
 * and the two rules below have to be identical between them: a quote that dated
 * itself differently from the invoice it becomes would be a difference nobody
 * chose. So they live here, with the refusal text, rather than being typed
 * twice.
 *
 * THE SERVER OWNS THE DUE DATE WHENEVER THE TERMS ARE STRUCTURED, exactly as it
 * owns the total whenever the invoice is itemized. The client sends the date it
 * computed from the mirrored resolver; if that disagrees with the server's, the
 * write is REFUSED and both dates are named, rather than one being silently
 * substituted. Silently substituting would hide a client bug while changing
 * when a household is told their money is due.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  invoiceTermsWords,
  isCalendarDay,
  paymentTermsSettingOf,
  resolveDueDate,
  type InvoiceTermsCode,
} from './invoiceTerms';
import { BUSINESS_SETTINGS_DOC, FALLBACK_BUSINESS_TIME_ZONE, zonedNow } from './businessHours';

/** How many visits a new invoice's terms may be resolved from. */
export const MAX_TERMS_SESSIONS = 100;

/**
 * The `startTime` day of each linked visit, for service-relative terms.
 *
 * Read from the SESSIONS THEMSELVES, never from anything the caller sends: the
 * whole value of a resolved due date is that it comes from the work, and a
 * caller-supplied list of dates would just be the typed due date again with
 * extra steps. A session that no longer exists contributes nothing rather than
 * failing the create; the resolver then says there are no visits to count from,
 * which is the true state of that invoice.
 */
export async function serviceDaysForSessions(
  firestore: Firestore,
  sessionIds: readonly string[],
): Promise<string[]> {
  const ids = [...new Set(sessionIds.filter((id) => id.trim() !== ''))].slice(0, MAX_TERMS_SESSIONS);
  if (ids.length === 0) return [];
  const refs = ids.map((id) => firestore.collection('kin_care_sessions').doc(id));
  const snaps = await firestore.getAll(...refs);
  const days: string[] = [];
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const startTime = (snap.data() ?? {})['startTime'];
    if (typeof startTime === 'string' && startTime.trim() !== '') days.push(startTime);
  }
  return days;
}

export interface StructuredTermsInput {
  termsCode: InvoiceTermsCode;
  /** The invoice's own `date`, `YYYY-MM-DD` or blank. */
  date: string;
  /** What the caller says the due date is, `YYYY-MM-DD` or blank. */
  dueDate: string;
  /** ISO start times of the visits this invoice covers. */
  serviceDates: readonly string[];
  /** Today, `YYYY-MM-DD`. Passed in so this stays testable and timezone-free. */
  now: string;
  /**
   * #1966: the business's zone, so a visit's instant is counted on the
   * business's day. Omitted reads as America/Chicago.
   */
  timeZone?: string;
}

export type StructuredTermsOutcome =
  | {
      ok: true;
      /** What goes on the doc: the rule in words, and the day it resolves to. */
      fields: { terms: string; termsCode: InvoiceTermsCode; dueDate: string };
    }
  | { ok: false; message: string; code: string };

/**
 * The stored `terms` / `dueDate` / `termsCode` for an invoice created with
 * structured terms, or the refusal that stops it being written.
 */
export function resolveStructuredTerms(input: StructuredTermsInput): StructuredTermsOutcome {
  const resolution = resolveDueDate(
    { code: input.termsCode, invoiceDate: input.date },
    input.serviceDates,
    input.now,
    input.timeZone,
  );
  // #1966: a visit rule on an invoice with no visits is due on receipt, and the
  // invoice says so: it stores the rule that decided the date.
  const applied = resolution.appliedCode;
  const words = invoiceTermsWords(applied);
  const sent = input.dueDate.trim();

  // Custom terms resolve to nothing by design: the operator's typed date IS the
  // answer, and there is nothing to check it against.
  if (input.termsCode === 'custom') {
    return { ok: true, fields: { terms: words, termsCode: input.termsCode, dueDate: sent } };
  }

  if (resolution.dueDate === null) {
    return {
      ok: false,
      code: 'invoice_terms_unresolvable',
      // `problem` already names what is missing and what to do about it.
      message: resolution.problem ?? 'These terms cannot work out a due date for this invoice.',
    };
  }

  // #1966 review: an installed client from before the invoice-date floor
  // previews the earlier day these terms used to work out to. That preview is
  // stale, not a disagreement: the server's own date (the invoice date) is the
  // one stored, so the older Android build and a cached web bundle still save.
  const staleEarlierPreview =
    resolution.beforeInvoiceDate && isCalendarDay(sent) && resolution.dueDate !== null && sent < resolution.dueDate;
  if (sent !== '' && sent !== resolution.dueDate && !staleEarlierPreview) {
    return {
      ok: false,
      code: 'invoice_due_date_mismatch',
      message: `The due date sent (${sent}) is not the date these terms work out to (${resolution.dueDate}, counting from ${resolution.basisDay ?? 'the invoice'}). The terms decide the due date, so send that date, or choose the terms that let you pick one yourself.`,
    };
  }

  return {
    ok: true,
    fields: { terms: words, termsCode: applied, dueDate: resolution.dueDate },
  };
}

/** #1966: what a new invoice's terms need from `business_settings`. */
export interface InvoiceTermsSettings {
  /** The business's zone, resolved as every server reader resolves it (#1109). */
  timeZone: string;
  /** Settings > Invoices > Payment terms; absent reads as due on receipt. */
  paymentTerms: InvoiceTermsCode;
}

/**
 * #1966: the business's payment terms and zone, from one settings read.
 * Fail-soft: an unreadable document gives the defaults (due on receipt,
 * America/Chicago), which is what an unset business has.
 */
export async function readInvoiceTermsSettings(firestore: Firestore): Promise<InvoiceTermsSettings> {
  let data: unknown;
  try {
    data = (await firestore.doc(BUSINESS_SETTINGS_DOC).get()).data();
  } catch {
    data = undefined;
  }
  return invoiceTermsSettingsOf(data);
}

/** The pure half of {@link readInvoiceTermsSettings}, on a settings document already in hand. */
export function invoiceTermsSettingsOf(settings: unknown): InvoiceTermsSettings {
  const doc = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>;
  const stored = typeof doc['timeZone'] === 'string' ? (doc['timeZone'] as string).trim() : '';
  return {
    timeZone: stored !== '' && zonedNow(0, stored) !== null ? stored : FALLBACK_BUSINESS_TIME_ZONE,
    paymentTerms: paymentTermsSettingOf(doc['invoicePaymentTerms']),
  };
}

/** Today on the business's clock, `YYYY-MM-DD`. */
export function businessToday(timeZone: string, nowMs: number = Date.now()): string {
  return (
    zonedNow(nowMs, timeZone)?.dateIso ??
    zonedNow(nowMs, FALLBACK_BUSINESS_TIME_ZONE)?.dateIso ??
    new Date(nowMs).toISOString().slice(0, 10)
  );
}
