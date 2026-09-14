/**
 * What happened when the admin asked for an invoice reminder, and how to say it
 * (#832).
 *
 * `sendInvoiceReminder` refuses a second reminder inside its window and answers
 * `sent: false` with the time of the one that already went out. That answer is a
 * success, not an error: the household has been reminded. The panel says so in a
 * sentence and shows when, instead of claiming "Reminder sent." for a send that
 * did not happen.
 */
import type { SendInvoiceReminderResult } from '../contracts/invoiceContracts.generated';

export interface ReminderOutcome {
  /** True when THIS call sent a reminder. */
  sent: boolean;
  /** When the most recent reminder went out (ms epoch). */
  lastReminderAtMs: number;
  /** The earliest moment another reminder will be accepted (ms epoch). */
  nextReminderAllowedAtMs: number;
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
    return { sent: true, lastReminderAtMs: nowMs, nextReminderAllowedAtMs: nowMs };
  }
  const last = typeof res.lastReminderAtMs === 'number' ? res.lastReminderAtMs : nowMs;
  const next = typeof res.nextReminderAllowedAtMs === 'number' ? res.nextReminderAllowedAtMs : last;
  return { sent: res.sent, lastReminderAtMs: last, nextReminderAllowedAtMs: next };
}

/** "Sep 14, 3:05 PM". `timeZone` is for tests; the panel uses the viewer's zone. */
export function formatReminderTime(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The notice after a press. */
export function reminderOutcomeMessage(outcome: ReminderOutcome, timeZone?: string): string {
  if (outcome.sent) return 'Reminder sent.';
  return `Not sent: a reminder already went out ${formatReminderTime(outcome.lastReminderAtMs, timeZone)}. The next one can go out after ${formatReminderTime(outcome.nextReminderAllowedAtMs, timeZone)}.`;
}

/**
 * The value of the "Last reminder" fact. The stored stamp may be absent, null
 * (a released claim), or not a number on a doc written outside the callables;
 * all of those mean no reminder is on record.
 */
export function lastReminderLabel(stamp: unknown, timeZone?: string): string {
  return typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0
    ? formatReminderTime(stamp, timeZone)
    : 'none sent';
}
