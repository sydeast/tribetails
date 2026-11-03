import { describe, it, expect } from 'vitest';
import {
  formatReminderTime,
  lastReminderLabel,
  reminderOutcomeMessage,
  reminderOutcomeOf,
} from './invoiceReminder';

const T = Date.UTC(2026, 8, 14, 15, 5, 0);
const DAY = 24 * 60 * 60 * 1000;

describe('reminderOutcomeOf', () => {
  it('passes a sent answer through', () => {
    expect(
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: true, reason: 'sent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY, appOnly: false }, 1),
    ).toEqual({ sent: true, reason: 'sent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY, appOnly: false });
  });
  it('passes each non-send through with its reason and nullable times', () => {
    expect(
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: false, reason: 'suppressed', lastReminderAtMs: null, nextReminderAllowedAtMs: null }, 1),
    ).toEqual({ sent: false, reason: 'suppressed', lastReminderAtMs: null, nextReminderAllowedAtMs: null, appOnly: false });
    expect(
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: false, reason: 'in-progress', lastReminderAtMs: null, nextReminderAllowedAtMs: T }, 1),
    ).toMatchObject({ reason: 'in-progress', nextReminderAllowedAtMs: T });
  });
  it('reads an answer with no `sent` (a pre-#832 function) as sent now, never as refused', () => {
    expect(reminderOutcomeOf({ ok: true, invoiceId: 'i' }, T)).toEqual({
      sent: true,
      reason: 'sent',
      lastReminderAtMs: T,
      nextReminderAllowedAtMs: null,
      appOnly: false,
    });
  });
  it('#1507: reads an app-only send, and only an explicit true', () => {
    expect(
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: true, reason: 'sent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY, appOnly: true }, 1),
    ).toMatchObject({ sent: true, appOnly: true });
    // A function deployed before #1507 omits the key: a channel send, as always.
    expect(
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: true, reason: 'sent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY }, 1),
    ).toMatchObject({ sent: true, appOnly: false });
  });
});

describe('reminder copy', () => {
  it('formats a time as month, day and clock time', () => {
    expect(formatReminderTime(T, 'UTC')).toBe('Sep 14, 3:05 PM');
  });
  it('a sent reminder says so plainly', () => {
    expect(reminderOutcomeMessage({ sent: true, reason: 'sent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY, appOnly: false }, 'UTC')).toBe(
      'Reminder sent.',
    );
  });
  it('#1507: an app-only send says where it went and what is off', () => {
    expect(reminderOutcomeMessage({ sent: true, reason: 'sent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY, appOnly: true }, 'UTC')).toBe(
      'Reminder sent in the app only. Email and text are off for this household.',
    );
  });
  it('a refused reminder names when the earlier one went out and when the next can', () => {
    expect(reminderOutcomeMessage({ sent: false, reason: 'recent', lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY, appOnly: false }, 'UTC')).toBe(
      'Not sent: a reminder already went out Sep 14, 3:05 PM. The next one can go out after Sep 15, 3:05 PM.',
    );
  });
  it('a press already in flight says so, and when to try again', () => {
    expect(reminderOutcomeMessage({ sent: false, reason: 'in-progress', lastReminderAtMs: null, nextReminderAllowedAtMs: T, appOnly: false }, 'UTC')).toBe(
      'Not sent: a reminder for this invoice is already being sent. If it does not arrive, try again after Sep 14, 3:05 PM.',
    );
  });
  it('a suppressed reminder says nothing went out, and why', () => {
    expect(reminderOutcomeMessage({ sent: false, reason: 'suppressed', lastReminderAtMs: null, nextReminderAllowedAtMs: null, appOnly: false })).toBe(
      "Not sent: this household's notification settings block payment reminders, so no reminder went out.",
    );
  });
  it('the last-reminder fact reads "none sent" for absent, null or junk stamps', () => {
    expect(lastReminderLabel(undefined)).toBe('none sent');
    expect(lastReminderLabel(null)).toBe('none sent');
    expect(lastReminderLabel('yesterday')).toBe('none sent');
    expect(lastReminderLabel(T, 'UTC')).toBe('Sep 14, 3:05 PM');
  });
  it('#1507: the last-reminder fact says "app only" for an explicit true flag alone', () => {
    expect(lastReminderLabel(T, 'UTC', true)).toBe('Sep 14, 3:05 PM, app only');
    expect(lastReminderLabel(T, 'UTC', false)).toBe('Sep 14, 3:05 PM');
    expect(lastReminderLabel(T, 'UTC', undefined)).toBe('Sep 14, 3:05 PM');
    expect(lastReminderLabel(T, 'UTC', 'yes')).toBe('Sep 14, 3:05 PM');
    // No stamp, no time to qualify.
    expect(lastReminderLabel(null, 'UTC', true)).toBe('none sent');
  });
});
