/**
 * #1567: what to tell the operator when a send got no answer.
 *
 * A send from the invoice panel (review and send, reminder, receipt, quote
 * resend) can run out of client budget while the server goes on to finish it.
 * The walk that found this saw "Action failed" on screen while the invoice
 * went to the household by email. The error alone cannot say which happened,
 * so the panel re-reads the invoice and compares the mark each send leaves on
 * it with the mark the invoice carried when the button was pressed:
 *
 *   reviewSend  status leaves `draft` (the server flips it to `open`)
 *   reminder    `reminderNotifiedAtMs` moves (sendInvoiceReminder's settle)
 *   receipt     `receiptIssuedAt` moves (generateReceipt)
 *   resendQuote `quoteResentAt` moves (resendQuote)
 *
 * Comparing before with after, rather than with the device clock, keeps a
 * skewed laptop clock out of the answer.
 *
 * The client budget for these callables (70s, `fns.ts`) is longer than the
 * server's 60s function timeout, so by the time the panel re-reads, the server
 * has finished or been stopped and the invoice says what really happened.
 *
 * Mirrored on Android (`domain/InvoiceSendCheck.kt`) and the desktop console
 * (`screens/invoices/InvoiceSendCheck.kt`); the sentences match word for word.
 */

export type SendCheckAction = 'reviewSend' | 'reminder' | 'receipt' | 'resendQuote';

/** The marks a send leaves on an invoice doc, read from the raw document. */
export interface SendMarks {
  status: string;
  reminderNotifiedAtMs: number | null;
  receiptIssuedAtMs: number | null;
  quoteResentAtMs: number | null;
}

function millisOf(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (raw !== null && typeof raw === 'object') {
    const t = raw as { toMillis?: () => number; seconds?: number; nanoseconds?: number };
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000 + Math.floor((t.nanoseconds ?? 0) / 1e6);
  }
  return null;
}

/** Reads the send marks off a raw invoice document (or a row spread from one). */
export function sendMarksOf(raw: Record<string, unknown>): SendMarks {
  const status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : '';
  return {
    status,
    reminderNotifiedAtMs: millisOf(raw.reminderNotifiedAtMs),
    receiptIssuedAtMs: millisOf(raw.receiptIssuedAt),
    quoteResentAtMs: millisOf(raw.quoteResentAt),
  };
}

/** True when [after] carries the mark [action] leaves and [before] did not. */
export function sendLanded(action: SendCheckAction, before: SendMarks, after: SendMarks): boolean {
  switch (action) {
    case 'reviewSend':
      return before.status === 'draft' && after.status !== '' && after.status !== 'draft';
    case 'reminder':
      return after.reminderNotifiedAtMs !== null && after.reminderNotifiedAtMs !== before.reminderNotifiedAtMs;
    case 'receipt':
      return after.receiptIssuedAtMs !== null && after.receiptIssuedAtMs !== before.receiptIssuedAtMs;
    case 'resendQuote':
      return after.quoteResentAtMs !== null && after.quoteResentAtMs !== before.quoteResentAtMs;
  }
}

const WHAT: Record<SendCheckAction, { sent: string; thing: string; notSent: string; check: string }> = {
  reviewSend: {
    sent: 'Draft sent.',
    thing: 'the draft',
    notSent: 'The invoice is still a draft, so it has not gone out. Send it again.',
    check: 'Reopen the invoice: Open means it went, Draft means it did not.',
  },
  reminder: {
    sent: 'Reminder sent.',
    thing: 'the reminder',
    notSent: 'No new reminder is on the invoice, so it has not gone out. Send it again.',
    check: 'Check Last reminder on the invoice before sending another.',
  },
  receipt: {
    sent: 'Receipt issued.',
    thing: 'the receipt',
    notSent: 'No new receipt is on the invoice, so it has not gone out. Issue it again.',
    check: 'Reopen the invoice and check for the receipt before issuing another.',
  },
  resendQuote: {
    sent: 'Quote sent again. The household can accept or decline it now.',
    thing: 'the quote',
    notSent: 'The quote has not been sent again. Send it again.',
    check: 'Reopen the quote and check whether it is waiting on the household before sending it again.',
  },
};

export interface SilenceOutcome {
  /** `sent` is a notice; the other two are errors the operator must act on. */
  kind: 'sent' | 'not-sent' | 'unknown';
  message: string;
}

/**
 * The sentence after a send got no answer. [after] is null when the re-read
 * itself failed, which is the one case where the panel honestly cannot tell.
 */
export function sendOutcomeAfterSilence(
  action: SendCheckAction,
  seconds: number,
  before: SendMarks,
  after: SendMarks | null,
): SilenceOutcome {
  const what = WHAT[action];
  const late = `Tribe Tails did not answer within ${seconds} seconds`;
  if (after === null) {
    return {
      kind: 'unknown',
      message: `${late}, and the invoice could not be re-read, so there is no way to tell from here whether ${what.thing} went. ${what.check}`,
    };
  }
  if (sendLanded(action, before, after)) {
    return {
      kind: 'sent',
      message: `${what.sent} The answer came late, so this was confirmed by re-reading the invoice.`,
    };
  }
  return { kind: 'not-sent', message: `${late}. ${what.notSent}` };
}
