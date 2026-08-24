import type { KinTaleEntry } from '../api/kinTales';
import type { SessionEntry } from '../api/sessions';
import type { InvoiceEntry } from '../api/invoices';
import { formatJoinDate } from './joinDate';
import { str } from './coerce';

/**
 * The three feed joins on the household profile: Recent KinTales, Upcoming
 * visits, Invoices.
 *
 * A PORT, not a new invention. `android/.../domain/KinfolkProfileFeeds.kt` has
 * shipped these exact joins since the Android profile got its feed cards, and
 * its header names a web twin that no longer exists (the wasm admin, deleted in
 * #481). The React admin lost the feeds with it, which is a good part of what
 * issue #407 marks: the mock shows all three and this screen showed none. The
 * function names, the filters, the sort keys and the default limit of 5 are
 * kept identical to the Kotlin so the two surfaces cannot drift into showing an
 * operator different rows for the same household.
 *
 * Lexical ISO-8601 compares throughout, which is this app's date convention:
 * `startTime`, `sentAt`, `visitDate` and friends are free-text ISO strings, not
 * Firestore Timestamps (see the caveats on `SessionEntry.startTime` and
 * `KinTaleEntry.visitDate`). Every field is read through `str`, because these
 * row types are CASTS over raw Firestore data and a legacy doc genuinely lacks
 * half of them.
 */

/** How many rows a profile feed card shows. The Kotlin default, kept in lockstep. */
export const PROFILE_FEED_LIMIT = 5;

/** SENT KinTales for this household, most recent first (`sentAt`, falling back to `visitDate`). */
export function recentTalesFor(
  reports: readonly KinTaleEntry[],
  kinfolkId: string,
  limit: number = PROFILE_FEED_LIMIT,
): KinTaleEntry[] {
  return reports
    .filter((r) => str(r.kinfolkId) === kinfolkId)
    .filter((r) => str(r.status).toUpperCase() === 'SENT')
    .slice()
    .sort((a, b) => taleSortKey(b).localeCompare(taleSortKey(a)))
    .slice(0, limit);
}

function taleSortKey(r: KinTaleEntry): string {
  const sent = str(r.sentAt);
  return sent !== '' ? sent : str(r.visitDate);
}

/**
 * SCHEDULED / CONFIRMED visits for this household dated at or after [nowIso],
 * soonest first.
 *
 * A positive test against the two states that qualify, never a negation of the
 * others: a session in any other state is not "upcoming" however its start time
 * compares, and a new state added later must be opted in rather than leaking
 * into this card by default.
 *
 * [throughIso] is the far edge of the window, and null means "no far edge". The
 * mock heads this card "next 7 days", so the profile passes a bound and the card
 * says what the bound is; a caller that wants everything ahead passes null and
 * gets the Kotlin's original behaviour unchanged.
 */
export function upcomingVisitsFor(
  sessions: readonly SessionEntry[],
  kinfolkId: string,
  nowIso: string,
  throughIso: string | null = null,
  limit: number = PROFILE_FEED_LIMIT,
): SessionEntry[] {
  return sessions
    .filter((s) => str(s.kinfolkId) === kinfolkId)
    .filter((s) => {
      const state = str(s.status).toLowerCase();
      return state === 'scheduled' || state === 'confirmed';
    })
    .filter((s) => {
      const start = str(s.startTime);
      if (start === '' || start < nowIso) return false;
      return throughIso === null || start <= throughIso;
    })
    .slice()
    .sort((a, b) => str(a.startTime).localeCompare(str(b.startTime)))
    .slice(0, limit);
}
/** The mock's "next 7 days" bound, as an ISO instant [days] out from [now]. */
export function horizonIso(now: Date, days: number): string {
  const end = new Date(now.getTime());
  end.setDate(end.getDate() + days);
  return end.toISOString();
}
/** How far ahead the profile's "Upcoming visits" card looks, per the mock's own header. */
export const UPCOMING_HORIZON_DAYS = 7;

/** Invoices for this household, most recent first. */
export function invoicesForKinfolk(
  invoices: readonly InvoiceEntry[],
  kinfolkId: string,
  limit: number = PROFILE_FEED_LIMIT,
): InvoiceEntry[] {
  return invoices
    .filter((inv) => str(inv.kinfolkId) === kinfolkId)
    .slice()
    .sort((a, b) => str(b.date).localeCompare(str(a.date)))
    .slice(0, limit);
}

/**
 * The left-hand line of one Invoices row: the invoice number, and the date it
 * carries when it carries one.
 *
 * `invoices.date` is FREE TEXT (PR #241 confirmed it in production), so it goes
 * through `formatJoinDate`, which formats what it can read and prints the rest
 * exactly as stored. A blank date drops the whole ` · ` segment, so the row is
 * the number alone rather than a number trailing a separator into nothing.
 */
export function kinfolkInvoiceFeedLabel(invoice: Pick<InvoiceEntry, 'invoiceNumber' | 'date'>): string {
  const number = str(invoice.invoiceNumber) !== '' ? str(invoice.invoiceNumber) : 'Invoice';
  const date = str(invoice.date) === '' ? '' : formatJoinDate(str(invoice.date));
  return date === '' ? number : `${number} · ${date}`;
}

/**
 * True when this invoice still owes money, i.e. it earns the "Unpaid" pill.
 *
 * A POSITIVE test against the one state that qualifies, never a negation of the
 * other seven (`INVOICE_STATES`: quote, draft, cancelled, credit, redeemed,
 * paid, zero, open). `open` is the only stamp that means "billed and not yet
 * settled"; a quote nobody has answered and a draft nobody has sent are not
 * debts, and a state added server-side later must be opted in here rather than
 * silently start appearing as money owed. The AO-12 convention
 * `lib/sessionFormat.ts` already documents.
 */
export function invoiceIsOutstanding(invoice: Pick<InvoiceEntry, 'status' | 'amountDue'>): boolean {
  if (str(invoice.status).toLowerCase() !== 'open') return false;
  return typeof invoice.amountDue === 'number' && invoice.amountDue > 0;
}

/** What one invoice row shows for money: the balance while one is owed, else the total. */
export function invoiceRowAmount(invoice: Pick<InvoiceEntry, 'total' | 'amountDue'>): number {
  const due = typeof invoice.amountDue === 'number' ? invoice.amountDue : 0;
  if (due > 0) return due;
  return typeof invoice.total === 'number' ? invoice.total : 0;
}

/** Sum of what this household still owes, over the rows actually loaded. */
export function outstandingTotal(invoices: readonly InvoiceEntry[]): number {
  return invoices
    .filter((inv) => invoiceIsOutstanding(inv))
    .reduce((sum, inv) => sum + (typeof inv.amountDue === 'number' ? inv.amountDue : 0), 0);
}

/**
 * A feed card's header meta, and the reason it is a function rather than
 * `` `${rows.length} total` ``.
 *
 * These feeds read a CAPPED query. While the cap is not reached, the row count
 * IS the household's total and may say so. Once the read comes back holding
 * exactly the cap, the collection may well hold more, and "N total" would be a
 * confident number nobody verified. This app already treats that as a lie: it
 * is why `StatCard` refuses a plain `value: string` (see its note about the
 * permission-denied read that rendered as "0" in production on 2026-07-15).
 * At the cap the label says "N+ loaded", which is exactly what is known.
 */
export function feedCountMeta(shown: number, loaded: number, cap: number): string {
  const total = loaded >= cap ? `${loaded}+ loaded` : `${loaded} total`;
  return shown < loaded ? `${shown} of ${total}` : total;
}

/**
 * The hero's tenure chip ("14 months"), or null when the stored join date is
 * not a date anybody can read.
 *
 * NEVER a fabricated "0 months": a household whose `joinDate` is blank, or is
 * one of the free-text shapes `lib/joinDate.ts` deliberately refuses to parse,
 * gets NO chip. A tenure is a claim about how long someone has been a client
 * and the profile does not make one it cannot back.
 */
export function tenureLabel(joinDate: string, now: Date): string | null {
  const raw = joinDate.trim();
  if (raw === '') return null;
  const head = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return null;
  if (raw.length > 10 && raw.charAt(10) !== 'T' && raw.charAt(10) !== ' ') return null;

  const year = Number(head.slice(0, 4));
  const month = Number(head.slice(5, 7));
  const day = Number(head.slice(8, 10));
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    return null;
  }
  // A join date in the future is a typo, not a negative tenure. Say nothing.
  if (start.getTime() > now.getTime()) return null;

  let months = (now.getFullYear() - year) * 12 + (now.getMonth() - (month - 1));
  if (now.getDate() < day) months -= 1;
  if (months < 1) return 'new';
  if (months < 24) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const years = Math.floor(months / 12);
  return `${years} years`;
}
