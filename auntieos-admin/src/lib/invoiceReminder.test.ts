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
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: true, lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY }, 1),
    ).toEqual({ sent: true, lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY });
  });
  it('passes an already-sent answer through', () => {
    expect(
      reminderOutcomeOf({ ok: true, invoiceId: 'i', sent: false, lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY }, 1),
    ).toEqual({ sent: false, lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY });
  });
  it('reads an answer with no `sent` (a pre-#832 function) as sent now, never as refused', () => {
    expect(reminderOutcomeOf({ ok: true, invoiceId: 'i' }, T)).toEqual({
      sent: true,
      lastReminderAtMs: T,
      nextReminderAllowedAtMs: T,
    });
  });
});

describe('reminder copy', () => {
  it('formats a time as month, day and clock time', () => {
    expect(formatReminderTime(T, 'UTC')).toBe('Sep 14, 3:05 PM');
  });
  it('a sent reminder says so plainly', () => {
    expect(reminderOutcomeMessage({ sent: true, lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY }, 'UTC')).toBe(
      'Reminder sent.',
    );
  });
  it('a refused reminder names when the earlier one went out and when the next can', () => {
    expect(reminderOutcomeMessage({ sent: false, lastReminderAtMs: T, nextReminderAllowedAtMs: T + DAY }, 'UTC')).toBe(
      'Not sent: a reminder already went out Sep 14, 3:05 PM. The next one can go out after Sep 15, 3:05 PM.',
    );
  });
  it('the last-reminder fact reads "none sent" for absent, null or junk stamps', () => {
    expect(lastReminderLabel(undefined)).toBe('none sent');
    expect(lastReminderLabel(null)).toBe('none sent');
    expect(lastReminderLabel('yesterday')).toBe('none sent');
    expect(lastReminderLabel(T, 'UTC')).toBe('Sep 14, 3:05 PM');
  });
});
