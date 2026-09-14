import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INVOICE_REMINDER_WINDOW_MS,
  findDuplicates,
  parseArgs,
  rowOf,
  windowMsFor,
  type NotificationRow,
} from '../reportDuplicateNotifications';
import { NOTIFICATION_DEDUPE_WINDOW_MS } from '../../functions/src/notifications/dispatcher';

/**
 * The reminder callable's window, read from its SOURCE rather than imported:
 * importing the callable module pulls `wrapCallable` into this scripts project,
 * whose resolution types `Request` differently and fails typecheck, and it
 * would register a Cloud Function at load. A literal change there fails here.
 */
const INVOICE_REMINDER_RESEND_WINDOW_MS = (() => {
  const src = readFileSync(join(__dirname, '..', '..', 'functions', 'src', 'admin', 'sendInvoiceReminder.ts'), 'utf8');
  const m = /export const INVOICE_REMINDER_RESEND_WINDOW_MS = ([\d\s*]+);/.exec(src);
  if (!m) throw new Error('INVOICE_REMINDER_RESEND_WINDOW_MS not found in sendInvoiceReminder.ts');
  return m[1].split('*').reduce((n, part) => n * Number(part.trim()), 1);
})();

const T = Date.UTC(2026, 7, 1, 12, 0, 0);
const MIN = 60_000;

function row(over: Partial<NotificationRow>): NotificationRow {
  return {
    path: 'notifications/x',
    collection: 'notifications',
    key: 'invoice.updated',
    recipientUid: 'client_1',
    identity: 'invoice:inv1',
    atMs: T,
    ...over,
  };
}

describe('the #832 duplicate report is read-only', () => {
  it('its source contains no write call of any kind', () => {
    const src = readFileSync(join(__dirname, '..', 'reportDuplicateNotifications.ts'), 'utf8');
    // None of these has a non-Firestore meaning in this file, so any occurrence fails.
    for (const call of ['.update(', '.delete(', '.create(', 'batch(', 'runTransaction', 'bulkWriter', 'recursiveDelete']) {
      expect(src.includes(call), `found ${call}`).toBe(false);
    }
    // `.set(` and `.add(` are also Map and Set methods, which the report uses to
    // count, so only the Firestore-shaped forms are forbidden: on a document
    // reference, a transaction, a batch or a writer, and add on a collection.
    const firestoreWrites: Array<[string, RegExp]> = [
      ['doc(...).set(', /\.doc\([^)]*\)\s*\.set\(/],
      ['ref/tx/batch/writer .set(', /\b(ref|tx|transaction|batch|writer)\.set\(/],
      ['collection(...).add(', /collection\([^)]*\)\s*\.add\(/],
    ];
    for (const [name, re] of firestoreWrites) {
      expect(re.test(src), `found ${name}`).toBe(false);
    }
  });

  it('accepts no flag that could turn it into a writer', () => {
    expect(() => parseArgs(['--allow-prod'])).toThrow('unknown arg');
    expect(parseArgs(['--project', 'p', '--samples', '5', '--window-minutes', '60'])).toEqual({
      projectId: 'p',
      samples: 5,
      windowMs: 60 * MIN,
    });
  });
});

describe('windows', () => {
  it('match the fix: the dispatcher window, and the reminder callable window for invoice.reminder', () => {
    expect(INVOICE_REMINDER_WINDOW_MS).toBe(INVOICE_REMINDER_RESEND_WINDOW_MS);
    expect(windowMsFor('invoice.updated', null)).toBe(NOTIFICATION_DEDUPE_WINDOW_MS);
    expect(windowMsFor('invoice.reminder', null)).toBe(INVOICE_REMINDER_RESEND_WINDOW_MS);
    expect(windowMsFor('invoice.reminder', 7)).toBe(7);
  });
});

describe('rowOf derives what the dispatcher dedupes on', () => {
  it('uses the stored target, plus a per-event id from data', () => {
    const r = rowOf('notifications/a', 'notifications', {
      key: 'message.received',
      recipientUid: 'staff_1',
      targetType: 'kinfolk',
      targetId: 'fam1',
      data: { kinfolkId: 'fam1', messageId: 'm7' },
      createdAt: { toMillis: () => T },
    });
    expect(r).toEqual({
      path: 'notifications/a',
      collection: 'notifications',
      key: 'message.received',
      recipientUid: 'staff_1',
      identity: 'kinfolk:fam1#messageId:m7',
      atMs: T,
    });
  });

  it('derives the target from data on a document written before targets were stamped', () => {
    const r = rowOf('scheduledNotifications/b', 'scheduledNotifications', {
      key: 'invoice.reminder',
      recipientUid: 'client_1',
      data: { kinfolkId: 'fam1', invoiceId: 'inv1' },
      fireAtMs: T,
    });
    expect(r.identity).toBe('invoice:inv1');
    expect(r.atMs).toBe(T);
  });
});

describe('findDuplicates', () => {
  it('reports two copies inside the window', () => {
    const groups = findDuplicates([row({ path: 'notifications/a' }), row({ path: 'notifications/b', atMs: T + MIN })], null);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: 'invoice.updated', recipientUid: 'client_1', extraCopies: 1, closestGapMs: MIN });
    expect(groups[0].rows.map((r) => r.path)).toEqual(['notifications/a', 'notifications/b']);
  });

  it('does not report two copies further apart than the window', () => {
    expect(findDuplicates([row({}), row({ path: 'notifications/b', atMs: T + NOTIFICATION_DEDUPE_WINDOW_MS })], null)).toEqual([]);
  });

  it('reports two reminders about one invoice twelve hours apart, the harm the issue names', () => {
    const groups = findDuplicates(
      [
        row({ key: 'invoice.reminder', collection: 'scheduledNotifications' }),
        row({ key: 'invoice.reminder', collection: 'scheduledNotifications', path: 'scheduledNotifications/b', atMs: T + 12 * 60 * MIN }),
      ],
      null,
    );
    expect(groups).toHaveLength(1);
  });

  it('never pairs different events, different recipients, or a queued row with its own promotion', () => {
    const rows = [
      row({ identity: 'kinfolk:fam1#messageId:m1' }),
      row({ identity: 'kinfolk:fam1#messageId:m2', atMs: T + 1000 }),
      row({ recipientUid: 'client_2', atMs: T + 2000 }),
      row({ collection: 'scheduledNotifications', atMs: T + 3000 }),
    ];
    expect(findDuplicates(rows, null)).toEqual([]);
  });

  it('skips rows nothing can identify: no identity or no time', () => {
    expect(findDuplicates([row({ identity: '' }), row({ identity: '', atMs: T + 1 })], null)).toEqual([]);
    expect(findDuplicates([row({ atMs: null }), row({ atMs: null })], null)).toEqual([]);
  });
});
