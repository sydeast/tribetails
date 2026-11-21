/**
 * #2246: A BILL IS DATED THE DAY THE HOUSEHOLD GETS IT, and its due date is
 * worked out from that day.
 *
 * WHAT WENT WRONG. A draft kept the date it was made on, and its due date was
 * worked out from that date when it was saved. Sent days later, it went out
 * with both unchanged: on "Due on receipt" (the starting Payment terms) the
 * due day was the draft's creation day, so the bill arrived already overdue
 * and the overdue notice went to the household at the next daily notice hour.
 * A quote accepted in MyTribe days after it was made became a bill the same
 * way.
 *
 * THE RULE. At the moment a draft becomes a bill (`reviewAndSendDraftInvoice`)
 * or a quote is accepted (`portal/quoteDecision.ts`):
 *
 *   - the invoice date moves up to that business day when it is earlier (or
 *     missing). A date later than that day was set on purpose and is kept;
 *   - coded terms (`termsCode`, anything but `custom`) are worked out again
 *     from the visits and that date, with the #1966 floor, so the stored due
 *     date, terms code and words agree;
 *   - a due date picked by hand (`custom`, or a typed date with no code) is
 *     never moved by the office's send: one that falls before the new invoice
 *     date refuses the send (`invoice_due_before_send`), saying what to do. A
 *     quote the household accepts cannot be sent back to the office, so there
 *     such a date is brought up to the acceptance day (`mode: 'accept'`): a
 *     bill is never overdue on the day it arrives.
 *
 * `issueDayFields` is PURE: the caller reads the visits (`readVisitStartTimes`,
 * inside its transaction, before any write) and the business day, and writes
 * the fields it returns in the same write that makes the invoice open.
 */
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { invoiceDayOf } from './invoiceDay';
import { MAX_TERMS_SESSIONS, resolveStructuredTerms } from './invoiceCreateFields';
import { boundSessionIds, storedSessionIds } from './invoiceSessionLinks';
import { isCalendarDay, parseInvoiceTermsCode } from './invoiceTerms';

/** `details.code` when a hand-picked due date has already passed on the send day. */
export const DUE_BEFORE_SEND_CODE = 'invoice_due_before_send';

/** The refusal, word for word what the admin clients show. */
export const DUE_BEFORE_SEND_MESSAGE =
  'The due date picked for this invoice is before today, and the invoice goes out dated today. Change the due date in Edit, then send it.';

export interface IssueDayInput {
  /** The invoice as stored. */
  doc: Record<string, unknown>;
  /** The business day it goes out (`businessToday(timeZone)`), `YYYY-MM-DD`. */
  issueDay: string;
  /** The `startTime` of every visit it bills. */
  serviceDates: readonly string[];
  /** The business's zone. */
  timeZone: string;
  /** `send`: the office's send, which may refuse. `accept`: the household's accept, which never refuses. */
  mode: 'send' | 'accept';
}

export type IssueDayOutcome =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; code: typeof DUE_BEFORE_SEND_CODE; message: string };

export function issueDayFields(input: IssueDayInput): IssueDayOutcome {
  const { doc, issueDay, serviceDates, timeZone, mode } = input;
  if (!isCalendarDay(issueDay)) return { ok: true, fields: {} };
  const stored = invoiceDayOf(doc['date']);
  const date = stored !== null && stored > issueDay ? stored : issueDay;
  const fields: Record<string, unknown> = date === stored ? {} : { date };

  const code = parseInvoiceTermsCode(doc['termsCode']);
  if (code !== null && code !== 'custom') {
    const outcome = resolveStructuredTerms({
      termsCode: code,
      date,
      dueDate: '',
      serviceDates,
      now: issueDay,
      timeZone,
    });
    if (outcome.ok) return { ok: true, fields: { ...fields, ...withLegacyDue(doc, outcome.fields) } };
    return { ok: true, fields };
  }

  const due = invoiceDayOf(doc['dueDate']) ?? invoiceDayOf(doc['invoiceDueDate']);
  if (due === null || due >= date) return { ok: true, fields };
  if (mode === 'send') return { ok: false, code: DUE_BEFORE_SEND_CODE, message: DUE_BEFORE_SEND_MESSAGE };
  return { ok: true, fields: { ...fields, ...withLegacyDue(doc, { dueDate: date }) } };
}

/**
 * The older `invoiceDueDate` spelling follows the new due date when the doc
 * carries it, so a notice that reads it never names the old day.
 */
function withLegacyDue(doc: Record<string, unknown>, fields: Record<string, unknown>): Record<string, unknown> {
  if (typeof doc['invoiceDueDate'] !== 'string' || !('dueDate' in fields)) return fields;
  return { ...fields, invoiceDueDate: fields['dueDate'] };
}

/**
 * The start time of every visit the invoice bills (its linked visits and its
 * lines' visits), read in the caller's transaction, for its terms.
 */
export async function readVisitStartTimes(
  tx: Transaction,
  firestore: Firestore,
  doc: Record<string, unknown>,
): Promise<string[]> {
  const ids = Array.from(
    new Set([...storedSessionIds(doc), ...boundSessionIds(doc['lineItems'])].map((id) => id.trim())),
  )
    .filter((id) => id !== '')
    .slice(0, MAX_TERMS_SESSIONS);
  const snaps = await Promise.all(ids.map((id) => tx.get(firestore.collection('kin_care_sessions').doc(id))));
  const out: string[] = [];
  for (const snap of snaps) {
    const startTime = snap.exists ? (snap.data() ?? {})['startTime'] : undefined;
    if (typeof startTime === 'string' && startTime.trim() !== '') out.push(startTime);
  }
  return out;
}
