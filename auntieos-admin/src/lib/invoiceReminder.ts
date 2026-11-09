/**
 * What happened when the admin asked for an invoice reminder, and how to say it
 * (#832).
 *
 * `sendInvoiceReminder` answers every press with `sent` and a `reason`. Only
 * `sent` means a reminder went out now. The other three are not errors, and
 * the panel says each one in a sentence instead of claiming "Reminder sent.":
 *   - `recent`: one already went out inside the window (with when);
 *   - `in-progress`: another press is sending one right now;
 *   - `suppressed`: the household's notification settings block reminders.
 *
 * #1507: `sent` with `appOnly` means the reminder reached the household in the
 * app only. Since #1505 a household that turned off every delivery channel
 * still gets the record in their notifications list, and nothing is emailed or
 * texted. "Reminder sent." alone would read as an email that does not exist,
 * so the sentence says where it went.
 */
import type { SendInvoiceReminderResult } from '../contracts/invoiceContracts.generated';

export type ReminderReason = SendInvoiceReminderResult['reason'];

export interface ReminderOutcome {
  /** True when THIS call sent a reminder. */
  sent: boolean;
  reason: ReminderReason;
  /** When a reminder last actually went out (ms epoch), or null if none ever did. */
  lastReminderAtMs: number | null;
  /** The earliest moment a press can send again (ms epoch), or null when waiting would not help. */
  nextReminderAllowedAtMs: number | null;
  /** With `sent`: the reminder reached the household in the app only (#1507). */
  appOnly: boolean;
}

/** #1507: the clause every app-only send carries, on every admin surface. */
export const APP_ONLY_NOTE = 'Email and text are off for this household.';

const REASONS: readonly ReminderReason[] = ['sent', 'recent', 'in-progress', 'suppressed'];

function msOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Decodes the callable's answer.
 *
 * A response WITHOUT `sent` comes from a function deployed before #832, which
 * only ever answered after sending. Reading that as "not sent" would tell the
 * admin a reminder was refused when it went out, so it reads as sent, now.
 */
export function reminderOutcomeOf(
  res: Partial<SendInvoiceReminderResult> | null | undefined,
  nowMs: number,
): ReminderOutcome {
  if (typeof res?.sent !== 'boolean') {
    return { sent: true, reason: 'sent', lastReminderAtMs: nowMs, nextReminderAllowedAtMs: null, appOnly: false };
  }
  const reason = REASONS.includes(res.reason as ReminderReason)
    ? (res.reason as ReminderReason)
    : res.sent
      ? 'sent'
      : 'recent';
  return {
    sent: res.sent,
    reason,
    lastReminderAtMs: msOrNull(res.lastReminderAtMs),
    nextReminderAllowedAtMs: msOrNull(res.nextReminderAllowedAtMs),
    // #1507: only an explicit true counts. A function deployed before #1507
    // omits the key, and so does every non-send; both read as a channel send.
    appOnly: res.appOnly === true,
  };
}

/** "Sep 14, 3:05 PM", or "Sep 14, 2025, 3:05 PM" outside [now]'s year. `timeZone` and `now` are for tests; the panel uses the viewer's zone. */
export function formatReminderTime(ms: number, timeZone?: string, now: Date = new Date()): string {
  const yearIn = (d: Date) =>
    d.toLocaleString('en-US', { year: 'numeric', ...(timeZone ? { timeZone } : {}) });
  const sameYear = yearIn(new Date(ms)) === yearIn(now);
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The notice after a press. */
export function reminderOutcomeMessage(outcome: ReminderOutcome, timeZone?: string): string {
  const at = (ms: number) => formatReminderTime(ms, timeZone);
  switch (outcome.reason) {
    case 'sent':
      return outcome.appOnly ? `Reminder sent in the app only. ${APP_ONLY_NOTE}` : 'Reminder sent.';
    case 'recent':
      return (
        (outcome.lastReminderAtMs !== null
          ? `Not sent: a reminder already went out ${at(outcome.lastReminderAtMs)}.`
          : 'Not sent: a reminder already went out recently.') +
        (outcome.nextReminderAllowedAtMs !== null
          ? ` The next one can go out after ${at(outcome.nextReminderAllowedAtMs)}.`
          : '')
      );
    case 'in-progress':
      return (
        'Not sent: a reminder for this invoice is already being sent.' +
        (outcome.nextReminderAllowedAtMs !== null
          ? ` If it does not arrive, try again after ${at(outcome.nextReminderAllowedAtMs)}.`
          : '')
      );
    case 'suppressed':
      return "Not sent: this household's notification settings block payment reminders, so no reminder went out.";
  }
}

/**
 * The value of the "Last reminder" fact. The stored stamp may be absent, null,
 * or not a number on a doc written outside the callables; all of those mean no
 * reminder is on record.
 *
 * #1507: `appOnly` is the companion flag the server writes beside the stamp
 * (`reminderNotifiedAppOnly`). Only an explicit true adds "app only"; a stamp
 * from before the flag existed, or one copied from the dedupe ledger, has none.
 */
export function lastReminderLabel(stamp: unknown, timeZone?: string, appOnly?: unknown): string {
  if (!(typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0)) return 'none sent';
  return formatReminderTime(stamp, timeZone) + (appOnly === true ? ', app only' : '');
}
